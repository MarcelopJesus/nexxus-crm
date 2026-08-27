// Recusa de proposta — o "não" do cliente não morre no log: vira decisão na fila do BDR.
// Decisão da reunião: "recusou com motivo, eu respondo; sem motivo, lost direto" — e o
// lost continua sendo um clique humano.
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB_FILE = path.join('/tmp', `nexxus-recusa-${process.pid}.json`);
process.env.DB_FILE = DB_FILE;
process.env.AGENT_AUTOPILOT = 'off';   // o assunto aqui é a fila, não a varredura
process.env.BASE_URL = 'https://crm.teste.local';

// ---- stub do LLM (antes de qualquer require que o capture) ----
const llmPath = require.resolve('./llm');
let respostaLLM = null;   // objeto, função(args) ou Error
let llmLigado = false;    // por padrão a IA está OFF: é o caminho do fallback
let promptsLLM = [];
require.cache[llmPath] = {
  id: llmPath, filename: llmPath, loaded: true,
  exports: {
    chatJSON: async (args) => {
      promptsLLM.push(args);
      if (respostaLLM instanceof Error) throw respostaLLM;
      return typeof respostaLLM === 'function' ? respostaLLM(args) : respostaLLM;
    },
    isConfigured: () => llmLigado,
    provider: () => 'stub', model: () => 'modelo-de-teste',
  },
};
// ---- stub do mailer ----
const mailerPath = require.resolve('./mailer');
let enviados = [];
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: { sendEmail: async (m) => { enviados.push(m); return { sent: true, status: 200, id: 'msg-1' }; }, isConfigured: () => true },
};

const store = require('./store');
const { seedIfEmpty } = require('./seed');
const api = require('./api');
const { handle } = api;

seedIfEmpty();
const admin = store.findOne('users', u => u.role === 'admin');
const user = { id: admin.id, email: admin.email, area: admin.area, role: admin.role };
const call = (method, p, body, opts = {}) =>
  handle(Object.assign({ method, path: p, body: body || {}, user, query: {}, headers: { host: 'localhost:3001' } }, opts));
// A página da proposta é pública: nada de usuário logado.
const recusar = (token, reason) =>
  handle({ method: 'POST', path: `/api/public/proposals/${token}/reject`,
    body: reason === undefined ? {} : { reason }, user: null, query: {}, headers: {} });
const tique = () => new Promise(r => setTimeout(r, 30));

after(async () => { await tique(); try { fs.unlinkSync(DB_FILE); } catch {} });
beforeEach(() => { enviados = []; promptsLLM = []; respostaLLM = null; llmLigado = false; });

// Lead com proposta enviada e aberta pelo cliente — o estado real de quem vai recusar.
function leadComProposta(empresa, preco) {
  const acc = store.insert('accounts', { name: empresa, cnpj: null, segment: null, city: null });
  const ct = store.insert('contacts', { account_id: acc.id, name: 'Contato', email: 'cliente@example.com', phone: null, role_title: null });
  const lead = store.insert('leads', { title: empresa + ' — teste', account_id: acc.id, contact_id: ct.id,
    product_id: null, requested_software: 'Jira Software', source: 'site', stage: 'negociacao', owner_id: null,
    hot: 0, status: 'open', lost_reason: null, estimated_value: preco || 30000, qty: 5, kind: 'b2b',
    notes: null, updated_at: store.now() });
  const prop = store.insert('proposals', { lead_id: lead.id, version: 1, final_price: preco || 30000,
    min_price: null, suggested_price: null, below_floor: 0, approved_by: null, status: 'viewed',
    token: require('crypto').randomBytes(16).toString('hex'), viewed_at: store.now(), accepted_at: null,
    rejected_at: null, reject_reason: null, view_count: 1, last_viewed_at: store.now(), created_by: null });
  return { lead, prop };
}
const naFila = async () => (await call('GET', '/api/bdr')).body.data.items;

test('recusa COM motivo cai na fila do BDR, com resumo e as 3 respostas de fallback', async () => {
  const { lead, prop } = leadComProposta('Alfa Recusa');
  const r = await recusar(prop.token, 'O preço ficou acima do orçamento aprovado para este ano.');
  await tique();

  assert.equal(r.status, 200);
  const d = store.get('leads', lead.id);
  assert.equal(d.needs_bdr, 1, 'a recusa vira decisão de gente');
  assert.equal(d.bdr_mask, 'recusa');
  assert.match(d.bdr_summary, /^Cliente recusou a proposta v1: O preço ficou acima/);
  assert.deepEqual(d.bdr_options, api.OPCOES_RECUSA_PADRAO,
    'IA desligada não pode impedir a fila — ficam as 3 opções fixas');
  assert.equal(d.bdr_suggest_lost, 0, 'com motivo não se recomenda perder');
  assert.equal(d.stage, 'negociacao', 'a recusa não mexe no estágio');
  assert.equal(d.status, 'open', 'e não perde o negócio sozinha');

  const item = (await naFila()).find(i => i.id === lead.id);
  assert.ok(item, 'aparece na fila do BDR');
  assert.equal(item.bdr_options.length, 3);
  assert.ok(store.all('notifications').some(n => n.type === 'bdr_action' && n.lead_id === lead.id));
});

test('recusa SEM motivo entra na fila com a ação "marcar como perdido" pronta', async () => {
  const { lead, prop } = leadComProposta('Beta Recusa');
  await recusar(prop.token);
  await tique();

  const d = store.get('leads', lead.id);
  assert.equal(d.needs_bdr, 1);
  assert.equal(d.bdr_summary, 'Cliente recusou a proposta v1 sem informar motivo');
  assert.equal(d.bdr_suggest_lost, 1);
  assert.equal(d.bdr_lost_hint, 'Proposta recusada sem motivo');
  assert.equal(d.status, 'open', 'lost automático não existe — quem clica é gente');

  const item = (await naFila()).find(i => i.id === lead.id);
  assert.equal(item.bdr_suggest_lost, 1);
  assert.equal(item.bdr_lost_hint, 'Proposta recusada sem motivo');
  assert.equal(promptsLLM.length, 0, 'sem motivo não há objeção a contornar: nem chama a IA');

  // Um clique no "Não" com o motivo já preenchido fecha o negócio.
  const perda = await call('POST', `/api/bdr/${lead.id}/resolve`, { decision: 'no', lost_reason: item.bdr_lost_hint });
  assert.equal(perda.status, 200);
  const dep = store.get('leads', lead.id);
  assert.equal(dep.status, 'lost');
  assert.equal(dep.lost_reason, 'Proposta recusada sem motivo');
  assert.equal(dep.needs_bdr, 0);
  assert.equal(dep.bdr_suggest_lost, 0);
});

test('re-recusar a mesma proposta não duplica a entrada na fila', async () => {
  const { lead, prop } = leadComProposta('Gama Recusa');
  await recusar(prop.token, 'Vamos ficar com o fornecedor atual.');
  await tique();
  const primeira = store.get('leads', lead.id).bdr_at;

  // O BDR já tinha escolhido a resposta e o cliente clicou de novo no link antigo.
  store.update('leads', lead.id, { bdr_summary: 'editado pelo BDR' });
  const r = await recusar(prop.token, 'motivo diferente');
  await tique();

  assert.equal(r.status, 200);
  const d = store.get('leads', lead.id);
  assert.equal(d.bdr_summary, 'editado pelo BDR', 'a segunda recusa não sobrescreve a fila');
  assert.equal(d.bdr_at, primeira);
  assert.equal(store.find('notifications', n => n.type === 'bdr_action' && n.lead_id === lead.id).length, 1);
  assert.equal(store.find('activities', a => a.lead_id === lead.id && a.type === 'bdr').length, 1);
  assert.equal((await naFila()).filter(i => i.id === lead.id).length, 1);
});

test('SIM numa recusa responde ao cliente e deixa o lead no estágio em que está', async () => {
  const { lead, prop } = leadComProposta('Delta Recusa');
  await recusar(prop.token, 'Achamos caro comparado ao concorrente.');
  await tique();

  const r = await call('POST', `/api/bdr/${lead.id}/resolve`,
    { decision: 'yes', message: 'Entendo. Posso revisar o escopo e mandar uma segunda versão?' });
  await tique();

  assert.equal(r.status, 200);
  assert.equal(r.body.data.emailed, true);
  assert.equal(enviados.length, 1);
  assert.equal(r.body.data.advanced, null, 'negociação não tem avanço automático');
  assert.match(r.body.data.advanceReason, /não tem avanço automático/);

  const d = store.get('leads', lead.id);
  assert.equal(d.stage, 'negociacao', 'o lead continua onde estava');
  assert.equal(d.status, 'open');
  assert.equal(d.needs_bdr, 0, 'mas saiu da fila');
  assert.match(d.bdr_last_pendencia, /recusou a proposta v1/, 'a pendência fica registrada para o agente');
});

test('com IA ligada, as 3 respostas fixas são trocadas pelas geradas', async () => {
  llmLigado = true;
  respostaLLM = { options: [
    'Entendo o ponto do orçamento. Posso mostrar o que está incluído no licenciamento oficial e no suporte em português?',
    'Consigo revisar o escopo: dá para ajustar o número de licenças ou o período e eu mando uma nova versão.',
    'Sem problema, obrigado pelo retorno. Fico à disposição se o cenário mudar.',
  ] };
  const { lead, prop } = leadComProposta('Epsilon Recusa');

  const r = await recusar(prop.token, 'Orçamento apertado neste trimestre.');
  await tique();

  assert.equal(r.status, 200, 'a rota pública responde na hora, sem esperar a IA');
  const d = store.get('leads', lead.id);
  assert.equal(d.bdr_options.length, 3);
  assert.match(d.bdr_options[0], /licenciamento oficial/);
  assert.notDeepEqual(d.bdr_options, api.OPCOES_RECUSA_PADRAO);
  const usado = promptsLLM.find(p => p.schemaName === 'respostas_recusa');
  assert.ok(usado, 'o motivo do cliente vai para o modelo');
  assert.match(usado.user, /<<<DADOS_DO_CLIENTE>>>[\s\S]*Orçamento apertado/, 'e vai cercado, como dado');
});

test('IA que falha ou devolve lixo deixa as opções fixas de pé — a rota nunca quebra', async () => {
  llmLigado = true;
  respostaLLM = new Error('502 do provedor');
  const { lead, prop } = leadComProposta('Zeta Recusa');

  const r = await recusar(prop.token, 'Preferimos adiar a compra.');
  await tique();

  assert.equal(r.status, 200);
  const d = store.get('leads', lead.id);
  assert.equal(d.needs_bdr, 1);
  assert.deepEqual(d.bdr_options, api.OPCOES_RECUSA_PADRAO);
});

test('o BDR que resolve antes da IA chegar não tem as opções trocadas debaixo do pé', async () => {
  llmLigado = true;
  const { lead, prop } = leadComProposta('Eta Recusa');
  // O modelo demora; o humano resolve no meio.
  respostaLLM = async () => { await new Promise(r => setTimeout(r, 25)); return { options: ['A', 'B', 'C'] }; };

  await recusar(prop.token, 'Vamos avaliar outras opções.');
  await call('POST', `/api/bdr/${lead.id}/resolve`, { decision: 'yes', message: 'Combinado, obrigado.' });
  await new Promise(r => setTimeout(r, 60));

  const d = store.get('leads', lead.id);
  assert.equal(d.needs_bdr, 0);
  assert.deepEqual(d.bdr_options, [], 'a resposta atrasada da IA não ressuscita a fila');
});
