// M28 — o e-mail que ENTRA vira evento legível na timeline, com resumo da IA.
//
// Ítalo, 02/09: sem isso ele vê a V2 saindo no dia 2 e não sabe que o cliente pediu no
// dia 10 — perde a régua de quanto o time demorou. O evento já era gravado; o que faltava
// era o resumo grudado nele, para a timeline dizer O QUE o cliente pediu.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB_FILE = path.join('/tmp', `nexxus-m28-${process.pid}.json`);
process.env.DB_FILE = DB_FILE;

const store = require('./store');
const { seedIfEmpty } = require('./seed');
const api = require('./api');

seedIfEmpty();
const admin = store.findOne('users', u => u.role === 'admin');
const user = { id: admin.id, email: admin.email, area: admin.area, role: admin.role };
const call = (method, p, body) =>
  api.handle({ method, path: p, body: body || {}, user, query: {}, headers: { host: 'localhost:3001' } });

after(async () => {
  await new Promise(r => setTimeout(r, 60));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

async function leadNovo(titulo) {
  const r = await call('POST', '/api/leads', { title: titulo });
  return r.body.data.id;
}
const emailsIn = (leadId) => store.find('activities', a => a.lead_id === leadId && a.type === 'email_in');

test('o resumo da IA gruda no evento email_in, sem criar um segundo registro', async () => {
  const leadId = await leadNovo('Resumo na timeline');
  api.logEmailIn(leadId, 'cliente@example.com', 'Re: proposta', 'Podem refazer com 30 mil? Preciso de nota fiscal.');

  const ent = api.anotarResumoEmail(leadId, 'Cliente solicitou V2 da proposta por R$ 30 mil.', 'duvida');
  assert.equal(ent.ai_summary, 'Cliente solicitou V2 da proposta por R$ 30 mil.');
  assert.equal(ent.ai_intent, 'duvida');
  assert.equal(emailsIn(leadId).length, 1, 'o resumo enriquece o evento, não duplica a timeline');
  assert.match(ent.email_body, /30 mil/, 'o e-mail inteiro continua guardado para quem quiser abrir');
});

test('resumo já gravado não é sobrescrito por uma segunda passada do agente', async () => {
  const leadId = await leadNovo('Idempotente');
  api.logEmailIn(leadId, 'cliente@example.com', 'Re: proposta', 'texto');
  api.anotarResumoEmail(leadId, 'primeiro resumo', 'duvida');
  api.anotarResumoEmail(leadId, 'segundo resumo', 'parar');
  assert.equal(emailsIn(leadId)[0].ai_summary, 'primeiro resumo');
});

test('o resumo vai para o e-mail MAIS RECENTE do cliente', async () => {
  const leadId = await leadNovo('Vários e-mails');
  api.logEmailIn(leadId, 'cliente@example.com', 'Primeiro', 'oi');
  await new Promise(r => setTimeout(r, 1100));   // created_at tem resolução de segundo
  api.logEmailIn(leadId, 'cliente@example.com', 'Segundo', 'e aí?');
  api.anotarResumoEmail(leadId, 'resumo do segundo', 'duvida');

  const [a, b] = emailsIn(leadId).sort((x, y) => x.id - y.id);
  assert.equal(a.ai_summary, null, 'o e-mail antigo não é tocado');
  assert.equal(b.ai_summary, 'resumo do segundo');
});

test('sem resumo (IA desligada) nada quebra e o evento continua na timeline', async () => {
  const leadId = await leadNovo('Sem IA');
  api.logEmailIn(leadId, 'cliente@example.com', 'Assunto que vira o rótulo', 'corpo');
  assert.equal(api.anotarResumoEmail(leadId, '', null), null);
  assert.equal(emailsIn(leadId).length, 1);
  assert.equal(emailsIn(leadId)[0].email_subject, 'Assunto que vira o rótulo');
});
