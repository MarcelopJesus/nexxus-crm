// Colunas de ganhos e perdidos no funil (decidido em 21/08, seção 9 do DECISOES).
//
// O estado JÁ existia: aceite do cliente vira won sozinho (f622626, 24/08) e o lost
// automático por inatividade também. O que faltava era a coluna — e o que estes testes
// garantem é que a API entrega o que ela precisa, sem campo novo nenhum.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB_FILE = path.join('/tmp', `nexxus-funil-${process.pid}.json`);
process.env.DB_FILE = DB_FILE;

const store = require('./store');
const { seedIfEmpty } = require('./seed');
const api = require('./api');

seedIfEmpty();
const admin = store.findOne('users', u => u.role === 'admin');
const user = { id: admin.id, email: admin.email, area: admin.area, role: admin.role };
const call = (method, p, body) => api.handle({ method, path:p, body: body||{}, user, query:{}, headers:{ host:'localhost:3001' } });

after(async () => {
  await new Promise(r => setTimeout(r, 60));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

async function novoLead(titulo) {
  const r = await call('POST', '/api/leads', { title: titulo });
  return r.body.data.id;
}
const listar = async () => (await call('GET', '/api/leads')).body.data;

test('a lista de leads continua trazendo ganhos e perdidos — a coluna só precisa mostrá-los', async () => {
  const ganho = await novoLead('Vai ser ganho');
  const perdido = await novoLead('Vai ser perdido');
  await call('POST', `/api/leads/${ganho}/close`, { result:'won' });
  await call('POST', `/api/leads/${perdido}/close`, { result:'lost', lost_reason:'Preço' });

  const rows = await listar();
  const g = rows.find(l => l.id === ganho), p = rows.find(l => l.id === perdido);
  assert.equal(g.status, 'won');
  assert.equal(p.status, 'lost');
  assert.equal(p.lost_reason, 'Preço', 'a coluna Perdidos mostra o motivo');
});

test('negócio ganho carrega o estado do trâmite — won de verdade só com o contrato fechado', async () => {
  const leadId = await novoLead('Trâmite');
  await call('POST', `/api/leads/${leadId}/close`, { result:'won' });

  let lead = (await listar()).find(l => l.id === leadId);
  assert.equal(lead.contract_status, 'pending', 'aceite não é fechamento: o trâmite ainda corre');

  const contrato = store.find('contracts', c => c.lead_id === leadId)[0];
  await call('PATCH', `/api/contracts/${contrato.id}`, { status:'signed' });
  lead = (await listar()).find(l => l.id === leadId);
  assert.equal(lead.contract_status, 'signed', 'nota emitida / licença liberada: agora fechou');
});

test('lead aberto não tem estado de trâmite (a marca é só das colunas de fechamento)', async () => {
  const leadId = await novoLead('Ainda aberto');
  const lead = (await listar()).find(l => l.id === leadId);
  assert.equal(lead.status, 'open');
  assert.equal(lead.contract_status, null);
});
