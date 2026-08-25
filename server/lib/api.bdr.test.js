// Painel BDR — as três decisões (sim / não / hold) sobre o que o agente escalou.
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB_FILE = path.join('/tmp', `nexxus-bdr-${process.pid}.json`);
process.env.DB_FILE = DB_FILE;
process.env.AGENT_AUTOPILOT = 'off'; // o painel é o assunto aqui, não a varredura

const mailerPath = require.resolve('./mailer');
let enviados = [];
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: { sendEmail: async (m) => { enviados.push(m); return { sent: true, status: 200 }; }, isConfigured: () => true },
};

const store = require('./store');
const { seedIfEmpty } = require('./seed');
const { handle } = require('./api');

seedIfEmpty();
const admin = store.findOne('users', u => u.role === 'admin');
const user = { id: admin.id, email: admin.email, area: admin.area, role: admin.role };
const call = (method, p, body, opts = {}) =>
  handle(Object.assign({ method, path: p, body: body || {}, user, query: {}, headers: { host: 'localhost:3001' } }, opts));

after(async () => { await new Promise(r => setTimeout(r, 60)); try { fs.unlinkSync(DB_FILE); } catch {} });
beforeEach(() => { enviados = []; });

// Lead já escalado pelo agente, como a máscara SDR deixaria.
function leadEscalado(empresa, comEmail) {
  const acc = store.insert('accounts', { name: empresa, cnpj: null, segment: null, city: null });
  const ct = store.insert('contacts', { account_id: acc.id, name: 'Contato', email: comEmail === false ? null : 'cliente@example.com', phone: null, role_title: null });
  const lead = store.insert('leads', { title: empresa + ' — teste', account_id: acc.id, contact_id: ct.id,
    product_id: null, requested_software: 'Jira', source: 'site', stage: 'novo_lead', owner_id: null, hot: 0,
    status: 'open', lost_reason: null, estimated_value: null, qty: 5, kind: 'b2b', notes: null, updated_at: store.now() });
  store.update('leads', lead.id, { needs_bdr: 1, bdr_summary: 'Cliente pede desconto fora da faixa.',
    bdr_options: ['Resposta A', 'Resposta B', 'Resposta C'], bdr_mask: 'sdr', bdr_at: store.now(),
    agent_mask: 'sdr', agent_done_stage: 'novo_lead' });
  return lead;
}

test('GET /api/bdr lista os leads escalados com resumo e respostas prontas', async () => {
  const lead = leadEscalado('Alfa BDR');
  const r = await call('GET', '/api/bdr');
  assert.equal(r.status, 200);
  const item = r.body.data.items.find(i => i.id === lead.id);
  assert.ok(item, 'o lead escalado aparece na fila');
  assert.equal(item.bdr_summary, 'Cliente pede desconto fora da faixa.');
  assert.equal(item.bdr_options.length, 3);
  assert.equal(item.contact_email, 'cliente@example.com');
  assert.equal(item.bdr_mask, 'sdr');
  assert.equal(r.body.data.count, r.body.data.items.length);
});

test('SIM envia a resposta escolhida e devolve o lead ao trilho do agente', async () => {
  const lead = leadEscalado('Beta BDR');
  const r = await call('POST', `/api/bdr/${lead.id}/resolve`, { decision: 'yes', message: 'Resposta B, editada pelo BDR.' });

  assert.equal(r.status, 200);
  assert.equal(r.body.data.emailed, true);
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].to, 'cliente@example.com');
  assert.ok(enviados[0].html.includes('Resposta B, editada pelo BDR.'));
  assert.ok(enviados[0].html.includes('Patrícia — Assistente Comercial · Nexxus Tech'));

  const d = store.get('leads', lead.id);
  assert.equal(d.needs_bdr, 0, 'saiu da fila');
  assert.equal(d.status, 'open');
  assert.equal(d.agent_done_stage, null, 'a próxima varredura retoma a etapa atual');
  const acts = store.find('activities', a => a.lead_id === lead.id);
  assert.ok(acts.some(a => a.type === 'bdr'), 'a decisão fica na timeline');
  assert.ok(acts.some(a => a.type === 'email_out'), 'a resposta entra na thread de e-mail');
});

test('NÃO fecha o negócio como perdido com o motivo informado', async () => {
  const lead = leadEscalado('Gama BDR');
  const r = await call('POST', `/api/bdr/${lead.id}/resolve`, { decision: 'no', lost_reason: 'Fora do nosso escopo' });

  assert.equal(r.status, 200);
  const d = store.get('leads', lead.id);
  assert.equal(d.status, 'lost');
  assert.equal(d.lost_reason, 'Fora do nosso escopo');
  assert.equal(d.needs_bdr, 0, 'lead perdido some da fila');
  assert.equal(enviados.length, 0, 'recusar não manda e-mail ao cliente');
  assert.ok(store.find('activities', a => a.lead_id === lead.id).some(a => a.type === 'close'));
});

test('HOLD segura o caso na fila e o agente não volta a escalar', async () => {
  const lead = leadEscalado('Delta BDR');
  const r = await call('POST', `/api/bdr/${lead.id}/resolve`, { decision: 'hold' });

  assert.equal(r.status, 200);
  const d = store.get('leads', lead.id);
  assert.equal(d.needs_bdr, 1, 'continua na fila');
  assert.equal(d.bdr_hold, 1);
  assert.equal(enviados.length, 0);

  const agent = require('./agentNexus');
  assert.equal(agent.elegivel(d), false, 'com needs_bdr de pé, a varredura nem olha o lead');

  const lista = await call('GET', '/api/bdr');
  assert.equal(lista.body.data.items.find(i => i.id === lead.id).bdr_hold, 1);
});

test('SIM sem texto é recusado — não dá para mandar e-mail vazio ao cliente', async () => {
  const lead = leadEscalado('Epsilon BDR');
  const r = await call('POST', `/api/bdr/${lead.id}/resolve`, { decision: 'yes', message: '   ' });
  assert.equal(r.status, 400);
  assert.equal(store.get('leads', lead.id).needs_bdr, 1, 'segue na fila');
});

test('resolver lead que não está na fila devolve 409', async () => {
  const lead = leadEscalado('Zeta BDR');
  await call('POST', `/api/bdr/${lead.id}/resolve`, { decision: 'yes', message: 'ok' });
  const segunda = await call('POST', `/api/bdr/${lead.id}/resolve`, { decision: 'yes', message: 'de novo' });
  assert.equal(segunda.status, 409);
});

test('SIM sem e-mail no contato resolve mesmo assim, avisando que nada saiu', async () => {
  const lead = leadEscalado('Eta BDR', false);
  const r = await call('POST', `/api/bdr/${lead.id}/resolve`, { decision: 'yes', message: 'Resposta A' });

  assert.equal(r.status, 200);
  assert.equal(r.body.data.emailed, false, 'o BDR precisa saber que tem de enviar na mão');
  assert.equal(enviados.length, 0);
  assert.equal(store.get('leads', lead.id).needs_bdr, 0, 'mesmo assim sai da fila');
});

test('decisão inválida é rejeitada', async () => {
  const lead = leadEscalado('Theta BDR');
  const r = await call('POST', `/api/bdr/${lead.id}/resolve`, { decision: 'talvez' });
  assert.equal(r.status, 400);
});

test('SIM com as tentativas do agente esgotadas entrega o lead para um humano', async () => {
  const lead = leadEscalado('Kappa BDR');
  // O agente já escalou 2x nesta etapa: devolver ao trilho só faria voltar para a fila.
  store.update('leads', lead.id, { agent_escal: { novo_lead: 2 }, owner_id: admin.id });

  const r = await call('POST', `/api/bdr/${lead.id}/resolve`, { decision: 'yes', message: 'Resposta final.' });

  assert.equal(r.status, 200);
  assert.equal(r.body.data.handedToHuman, true);
  const d = store.get('leads', lead.id);
  assert.equal(d.needs_bdr, 0);
  assert.notEqual(d.agent_done_stage, null, 'NÃO volta para o agente');
  const tarefa = store.find('tasks', t => t.lead_id === lead.id && t.type === 'manual_takeover');
  assert.equal(tarefa.length, 1, 'vira tarefa do responsável');
  assert.equal(tarefa[0].assignee_id, admin.id);
});

test('SIM dentro do limite continua devolvendo o lead ao agente', async () => {
  const lead = leadEscalado('Lambda BDR');
  store.update('leads', lead.id, { agent_escal: { novo_lead: 1 } });
  const r = await call('POST', `/api/bdr/${lead.id}/resolve`, { decision: 'yes', message: 'Resposta.' });
  assert.equal(r.body.data.handedToHuman, false);
  assert.equal(store.get('leads', lead.id).agent_done_stage, null);
  assert.equal(store.find('tasks', t => t.lead_id === lead.id && t.type === 'manual_takeover').length, 0);
});

test('a fila do BDR continua mostrando os casos em hold', async () => {
  const lead = leadEscalado('Mu BDR');
  await call('POST', `/api/bdr/${lead.id}/resolve`, { decision: 'hold' });
  const lista = await call('GET', '/api/bdr');
  const item = lista.body.data.items.find(i => i.id === lead.id);
  assert.ok(item, 'hold não some da fila');
  assert.equal(item.bdr_hold, 1);
});

test('quem não é de Vendas nem Admin não mexe na fila do BDR', async () => {
  const lead = leadEscalado('Nu BDR');
  const juridico = store.findOne('users', u => u.area === 'juridico')
    || store.insert('users', { name: 'Jur', email: 'jur@x.com', password_hash: 'x', area: 'juridico', role: 'user', active: 1 });
  const outro = { id: juridico.id, email: juridico.email, area: 'juridico', role: 'user' };

  const lista = await call('GET', '/api/bdr', null, { user: outro });
  assert.equal(lista.status, 403);
  const res = await call('POST', `/api/bdr/${lead.id}/resolve`, { decision: 'yes', message: 'oi' }, { user: outro });
  assert.equal(res.status, 403);
  const pausa = await call('POST', `/api/leads/${lead.id}/agent-pause`, {}, { user: outro });
  assert.equal(pausa.status, 403);
  assert.equal(store.get('leads', lead.id).needs_bdr, 1, 'nada mudou');
});

test('vendedor (área vendas) acessa a fila normalmente', async () => {
  const vend = store.findOne('users', u => u.area === 'vendas' && u.active);
  const r = await call('GET', '/api/bdr', null, { user: { id: vend.id, email: vend.email, area: 'vendas', role: 'user' } });
  assert.equal(r.status, 200);
});

test('pausar e retomar o agente num lead específico', async () => {
  const lead = leadEscalado('Iota BDR');
  const p1 = await call('POST', `/api/leads/${lead.id}/agent-pause`, {});
  assert.equal(p1.body.data.agent_paused, 1);
  assert.equal(store.get('leads', lead.id).agent_paused, 1);

  const p2 = await call('POST', `/api/leads/${lead.id}/agent-pause`, {});
  assert.equal(p2.body.data.agent_paused, 0);
  assert.ok(store.find('activities', a => a.lead_id === lead.id).some(a => /PAUSADO/.test(a.message)));
});
