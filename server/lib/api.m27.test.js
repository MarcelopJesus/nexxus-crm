// M27 — a proposta emitida pelo botão humano TEM de sair por e-mail.
//
// O defeito visto ao vivo em 02/09/2026: o botão "Enviar proposta & agendar follow-up"
// criava a proposta, marcava o card como "Proposta Enviada" e agendava os follow-ups sem
// nunca chamar o envio. A V2 das 13h15 nunca saiu, e o funil dizia que sim.
//
// A regra que estes testes trancam: o card só avança quando o e-mail sai de verdade.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB_FILE = path.join('/tmp', `nexxus-m27-${process.pid}.json`);
process.env.DB_FILE = DB_FILE;
process.env.EMAIL_API_KEY = 'chave-de-teste';
process.env.EMAIL_FROM = 'Nexxus CRM <crm@example.com>';

// O stub decide, teste a teste, se o provedor entrega ou cai.
let resultadoDoEnvio = { sent: true, status: 200, id: 'msg-1' };
const enviados = [];
const mailerPath = require.resolve('./mailer');
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: {
    sendEmail: async (m) => { enviados.push(m); return resultadoDoEnvio; },
    isConfigured: () => true,
    HEADERS_AUTOMATICO: {},
  },
};

const store = require('./store');
const { seedIfEmpty } = require('./seed');
const { handle } = require('./api');

seedIfEmpty();
const admin = store.findOne('users', u => u.role === 'admin');
const user = { id: admin.id, email: admin.email, area: admin.area, role: admin.role };
const call = (method, p, body, opts = {}) =>
  handle(Object.assign({ method, path: p, body: body || {}, user, query: {}, headers: { host: 'localhost:3001' } }, opts));

async function leadComEmail(titulo) {
  const acc = await call('POST', '/api/accounts', { name: titulo + ' Ltda' });
  const ct = await call('POST', '/api/contacts', { account_id: acc.body.data.id, name: 'Contato', email: 'cliente@example.com' });
  const lead = await call('POST', '/api/leads', { title: titulo, account_id: acc.body.data.id, contact_id: ct.body.data.id });
  return lead.body.data.id;
}
const followups = (leadId) => store.find('tasks', t => t.lead_id === leadId && t.type === 'followup');
const propostas = (leadId) => store.find('proposals', p => p.lead_id === leadId);

after(async () => {
  await new Promise(r => setTimeout(r, 60));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

test('e-mail sai: proposta vira enviada, card avança e follow-ups entram na agenda', async () => {
  resultadoDoEnvio = { sent: true, status: 200, id: 'msg-ok' };
  const leadId = await leadComEmail('Envio feliz');
  const antes = enviados.length;

  const r = await call('POST', '/api/proposals', { lead_id: leadId, final_price: 30000 });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.send_failed, null, 'nada falhou');
  assert.equal(r.body.data.email_sent, true);
  assert.equal(enviados.length, antes + 1, 'o botão precisa ter chamado o envio UMA vez');

  assert.equal(propostas(leadId)[0].status, 'sent');
  assert.equal(store.get('leads', leadId).stage, 'proposta_enviada');
  assert.equal(followups(leadId).length, 4, 'D+1, D+2, D+7 e D+15');
});

test('e-mail falha: proposta fica RASCUNHO, o card NÃO avança e ninguém agenda follow-up', async () => {
  resultadoDoEnvio = { sent: false, status: 502, reason: 'provedor fora do ar' };
  const leadId = await leadComEmail('Provedor caiu');
  const etapaAntes = store.get('leads', leadId).stage;

  const r = await call('POST', '/api/proposals', { lead_id: leadId, final_price: 30000 });
  assert.equal(r.status, 201, 'a proposta existe — como rascunho');
  assert.ok(r.body.data.send_failed, 'a resposta precisa contar que o envio falhou');
  assert.equal(r.body.data.email_sent, false);

  assert.equal(propostas(leadId)[0].status, 'draft', 'rascunho: o cliente não recebeu nada');
  assert.equal(store.get('leads', leadId).stage, etapaAntes, 'o funil não pode mentir');
  assert.equal(followups(leadId).length, 0, 'não se cobra resposta de e-mail que não saiu');
  assert.ok(store.find('notifications', n => n.type === 'proposal_send_failed' && n.lead_id === leadId).length,
    'o vendedor precisa ser avisado na hora');
});

test('reenvio do rascunho que falhou promove a proposta e destrava o card', async () => {
  resultadoDoEnvio = { sent: false, status: 502, reason: 'provedor fora do ar' };
  const leadId = await leadComEmail('Reenvio destrava');
  await call('POST', '/api/proposals', { lead_id: leadId, final_price: 25000 });
  const prop = propostas(leadId)[0];
  assert.equal(prop.status, 'draft');

  resultadoDoEnvio = { sent: true, status: 200, id: 'msg-retry' };
  const envio = await call('POST', `/api/proposals/${prop.id}/send-email`, {});
  assert.equal(envio.status, 200);
  assert.equal(envio.body.data.promovida, true);

  assert.equal(store.get('proposals', prop.id).status, 'sent');
  assert.equal(store.get('leads', leadId).stage, 'proposta_enviada');
  assert.equal(followups(leadId).length, 4);
});

test('lead sem e-mail cadastrado não gera proposta "enviada"', async () => {
  resultadoDoEnvio = { sent: true, status: 200, id: 'msg-x' };
  const lead = await call('POST', '/api/leads', { title: 'Sem contato' });
  const leadId = lead.body.data.id;
  const antes = enviados.length;

  const r = await call('POST', '/api/proposals', { lead_id: leadId, final_price: 12000 });
  assert.equal(r.status, 201);
  assert.match(String(r.body.data.send_failed), /e-mail/i);
  assert.equal(enviados.length, antes, 'sem destinatário não se chama o provedor');
  assert.equal(propostas(leadId)[0].status, 'draft');
  assert.equal(store.get('leads', leadId).stage, 'novo_lead');
});

test('destinatário informado na hora do envio é respeitado', async () => {
  resultadoDoEnvio = { sent: true, status: 200, id: 'msg-to' };
  const lead = await call('POST', '/api/leads', { title: 'Destinatário manual' });
  const leadId = lead.body.data.id;

  const r = await call('POST', '/api/proposals', { lead_id: leadId, final_price: 9000, to: 'compras@cliente.com' });
  assert.equal(r.body.data.send_failed, null);
  assert.equal(enviados[enviados.length - 1].to, 'compras@cliente.com');
  assert.equal(store.get('leads', leadId).stage, 'proposta_enviada');
});
