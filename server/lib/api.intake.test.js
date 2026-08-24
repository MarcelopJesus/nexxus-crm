// Intake do site com os campos novos (produto, quantidade, canal) e a varredura que
// mata por prazo o negócio parado. Roda em processo — nada aqui depende de rede.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB_FILE = path.join('/tmp', `nexxus-intake-${process.pid}.json`);
try { fs.unlinkSync(DB_FILE); } catch {}
process.env.DB_FILE = DB_FILE;
process.env.INTAKE_KEY = 'intake-test-key';

const store = require('./store');
const { seedIfEmpty } = require('./seed');
const { handle } = require('./api');
const { runFollowupSweep } = require('./followups');

seedIfEmpty();
const admin = store.findOne('users', u => u.role === 'admin');
const user = { id: admin.id, email: admin.email, area: admin.area, role: admin.role };

const call = (method, path, body, opts = {}) =>
  handle(Object.assign({ method, path, body: body || {}, user, query: {}, headers: { host: 'localhost:3001' } }, opts));
// Intake é rota pública: sem usuário e com a chave no header.
const intake = (body) =>
  call('POST', '/api/public/leads', body, { user: null, headers: { host: 'localhost:3001', 'x-intake-key': 'intake-test-key' } });

const produto = store.insert('products', { supplier_id: null, name: 'Jira Cloud', sku: 'jira-cloud',
  list_cost_usd: 60, currency: 'USD', cost_tiers: [], price_tiers: [], site_active: true, synced_at: store.now() });

// Data no formato do store ("YYYY-MM-DD HH:MM:SS", UTC).
const diasAtras = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 19).replace('T', ' ');
// Lead com proposta e TODOS os sinais de vida envelhecidos — é o silêncio total que a
// varredura procura; envelhecer só a proposta não basta mais.
async function propostaEnviada(titulo, dias) {
  const lead = await call('POST', '/api/leads', { title: titulo });
  const leadId = lead.body.data.id;
  const prop = await call('POST', '/api/proposals', { lead_id: leadId, final_price: 10000 });
  assert.equal(prop.status, 201);
  envelhecer(leadId, dias);
  return { leadId, prop: prop.body.data };
}
function envelhecer(leadId, dias) {
  const quando = diasAtras(dias);
  store.find('proposals', p => p.lead_id === leadId).forEach(p => store.update('proposals', p.id, { created_at: quando }));
  store.find('activities', a => a.lead_id === leadId).forEach(a => store.update('activities', a.id, { created_at: quando }));
}

after(async () => {
  await new Promise(resolve => setTimeout(resolve, 60));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

test('intake casa productSlug, quantidade e canal preferido', async () => {
  const r = await intake({ companyName: 'Alfa Engenharia', contactName: 'Ricardo', email: 'ricardo@alfa.com',
    message: 'Quero Jira para o time', productSlug: 'jira-cloud', quantity: 12, preferredChannel: 'whatsapp' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.kind, 'b2b');

  const lead = store.get('leads', r.body.data.id);
  assert.equal(lead.product_id, produto.id, 'productSlug casou com o sku do produto');
  assert.equal(lead.qty, 12);
  assert.equal(lead.preferred_channel, 'whatsapp');
  assert.equal(lead.kind, 'b2b', 'kind fica gravado no lead, não só na resposta');
  assert.equal(lead.source, 'site');
});

test('intake sem os campos novos continua funcionando como antes', async () => {
  const r = await intake({ companyName: 'Beta Fintech', contactName: 'Patrícia', email: 'p@beta.com', message: 'Contato' });
  assert.equal(r.status, 201);
  const lead = store.get('leads', r.body.data.id);
  assert.equal(lead.product_id, null);
  assert.equal(lead.qty, 1);
  assert.equal(lead.preferred_channel, null);
  assert.equal(lead.kind, 'b2b');
});

test('slug desconhecido, canal fora da lista e quantidade inválida não sujam o lead', async () => {
  const r = await intake({ companyName: 'Gamma', contactName: 'Lucas', email: 'l@gamma.com',
    productSlug: 'nao-existe', quantity: 0, preferredChannel: 'pombo-correio' });
  const lead = store.get('leads', r.body.data.id);
  assert.equal(lead.product_id, null);
  assert.equal(lead.qty, 1, 'quantidade inválida cai no mínimo 1');
  assert.equal(lead.preferred_channel, null, 'canal fora do contrato é ignorado');
});

test("o site manda 'phone' e o CRM guarda 'telefone'", async () => {
  const r = await intake({ companyName: 'Delta Telecom', contactName: 'Ana', email: 'ana@delta.com', preferredChannel: 'Phone' });
  assert.equal(store.get('leads', r.body.data.id).preferred_channel, 'telefone', 'um canal, um nome só dentro do CRM');

  const jaEmPt = await intake({ companyName: 'Epsilon', contactName: 'Caio', email: 'c@eps.com', preferredChannel: 'telefone' });
  assert.equal(store.get('leads', jaEmPt.body.data.id).preferred_channel, 'telefone');
});

test('quantidade só aceita inteiro positivo', async () => {
  const casos = [['12abc', 1], [3.9, 1], ['3.9', 1], [-5, 1], ['', 1], [null, 1], ['7', 7], [7, 7]];
  for (const [entrada, esperado] of casos) {
    const r = await intake({ companyName: 'Zeta ' + String(entrada), contactName: 'Q', email: 'q@zeta.com', quantity: entrada });
    assert.equal(store.get('leads', r.body.data.id).qty, esperado, `quantity ${JSON.stringify(entrada)} deveria virar ${esperado}`);
  }
});

test('pedido do checkout também guarda produto, quantidade e canal', async () => {
  const r = await intake({ origem: 'checkout', value: 15000, preferredChannel: 'email',
    productSlug: 'JIRA-CLOUD', quantity: 3, customFields: { nome: 'Marina', empresa: 'Delta', pedido_id: 'P-77' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.kind, 'order');
  const lead = store.get('leads', r.body.data.id);
  assert.equal(lead.status, 'won');
  assert.equal(lead.kind, 'order');
  assert.equal(lead.source, 'checkout');
  assert.equal(lead.product_id, produto.id, 'slug casa sem depender de maiúsculas');
  assert.equal(lead.qty, 3);
  assert.equal(lead.preferred_channel, 'email');
});

test('proposta nova agenda follow-up em D+1, D+2, D+7 e D+15 no fuso de Brasília', async () => {
  const { leadId } = await propostaEnviada('Follow-ups 24h/48h', 0);
  // Hoje em Brasília — é o "hoje" que o vendedor vê na tela de tarefas.
  const hojeBR = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const dias = store.find('tasks', t => t.lead_id === leadId && t.type === 'followup')
    .map(t => Math.round((Date.parse(t.due_date) - Date.parse(hojeBR)) / 86400000))
    .sort((a, b) => a - b);
  assert.deepEqual(dias, [1, 2, 7, 15], 'depois das 21h o UTC já virou o dia e o D+1 saía como D+2');
});

test('varredura marca como perdido o lead sem resposta há mais de 60 dias', async () => {
  const velho = await propostaEnviada('Sumiu — 61 dias', 61);
  const recente = await propostaEnviada('Ainda vivo — 59 dias', 59);

  const r = runFollowupSweep();
  assert.equal(r.days, 60);
  assert.equal(r.lost, 1, 'só o de 61 dias morre');

  const perdido = store.get('leads', velho.leadId);
  assert.equal(perdido.status, 'lost');
  assert.equal(perdido.lost_reason, 'Sem resposta após 60 dias (automático)');
  assert.equal(store.get('leads', recente.leadId).status, 'open');

  const acts = store.find('activities', a => a.lead_id === velho.leadId && a.type === 'close');
  assert.equal(acts.length, 1);
  assert.match(acts[0].message, /PERDIDO automaticamente/);
  assert.equal(store.find('notifications', n => n.type === 'lost_auto' && n.lead_id === velho.leadId).length, 1);

  const denovo = runFollowupSweep();
  assert.equal(denovo.lost, 0, 'varredura é idempotente — não repete quem já está perdido');
});

test('varredura não toca em negócio ganho, proposta aceita nem estágio anterior à proposta', async () => {
  // Ganho pelo aceite do cliente, e depois envelhecido.
  const ganho = await propostaEnviada('Aceito e ganho', 0);
  await call('POST', `/api/public/proposals/${ganho.prop.token}/accept`, {}, { user: null });
  envelhecer(ganho.leadId, 90);
  assert.equal(store.get('leads', ganho.leadId).status, 'won');

  // Lead reaberto cuja proposta MAIS RECENTE está aceita: estado inconsistente, humano resolve.
  const reaberto = await propostaEnviada('Aceito e reaberto', 90);
  store.update('proposals', reaberto.prop.id, { status: 'accepted', accepted_at: store.now() });
  store.update('leads', reaberto.leadId, { status: 'open', stage: 'negociacao' });

  // Voltou para triagem: estágio anterior à proposta está fora do alcance.
  const cedo = await propostaEnviada('Voltou para triagem', 90);
  await call('PATCH', `/api/leads/${cedo.leadId}/stage`, { stage: 'triagem' });
  envelhecer(cedo.leadId, 90);

  const r = runFollowupSweep();
  assert.equal(r.lost, 0);
  assert.equal(store.get('leads', ganho.leadId).status, 'won');
  assert.equal(store.get('leads', reaberto.leadId).status, 'open');
  assert.equal(store.get('leads', cedo.leadId).status, 'open');
  assert.equal(store.get('leads', cedo.leadId).stage, 'triagem');
});

test('sinal de vida recente segura o lead, mesmo com proposta antiga', async () => {
  // Negociação real: proposta de 90 dias, mas o cliente abriu a proposta ontem.
  const abriu = await propostaEnviada('Proposta velha, cliente ativo', 90);
  store.update('proposals', abriu.prop.id, { last_viewed_at: diasAtras(1) });

  // Negociação real: proposta de 90 dias, mas o vendedor anotou a ligação ontem.
  const anotou = await propostaEnviada('Proposta velha, vendedor ativo', 90);
  await call('POST', '/api/activities', { lead_id: anotou.leadId, message: 'Liguei, cliente pediu para retomar em janeiro.' });

  // Silêncio total: nada aconteceu em 90 dias.
  const morto = await propostaEnviada('Silêncio total', 90);

  const r = runFollowupSweep();
  assert.equal(r.lost, 1, 'só morre quem não deu nenhum sinal de vida');
  assert.equal(store.get('leads', abriu.leadId).status, 'open', 'abertura da proposta zera o relógio');
  assert.equal(store.get('leads', anotou.leadId).status, 'open', 'atividade na timeline zera o relógio');
  assert.equal(store.get('leads', morto.leadId).status, 'lost');
});

test('aceite antigo não blinda para sempre: versão nova sem resposta perde', async () => {
  const lead = await propostaEnviada('Aceitou, voltou atrás e sumiu', 200);
  store.update('proposals', lead.prop.id, { status: 'accepted', accepted_at: diasAtras(200) });
  // Negócio reaberto e proposta v2 enviada — que ficou 90 dias sem resposta nenhuma.
  store.update('leads', lead.leadId, { status: 'open', stage: 'negociacao' });
  const v2 = await call('POST', '/api/proposals', { lead_id: lead.leadId, final_price: 9000 });
  assert.equal(v2.body.data.version, 2);
  envelhecer(lead.leadId, 90);

  const r = runFollowupSweep();
  assert.equal(r.lost, 1);
  assert.equal(store.get('leads', lead.leadId).status, 'lost', 'o que vale é a proposta mais recente, não o aceite histórico');
});

test('AUTO_LOST_DAYS muda o prazo e o motivo registrado', async () => {
  process.env.AUTO_LOST_DAYS = '10';
  const lead = await propostaEnviada('Prazo curto', 11);
  const r = runFollowupSweep();
  delete process.env.AUTO_LOST_DAYS;
  assert.equal(r.days, 10);
  // Com prazo menor, o lead de 59 dias do teste anterior também cai — o que importa
  // é que o prazo curto valeu e o motivo saiu com o número certo.
  assert.ok(r.lost >= 1);
  assert.equal(store.get('leads', lead.leadId).status, 'lost');
  assert.equal(store.get('leads', lead.leadId).lost_reason, 'Sem resposta após 10 dias (automático)');
});

test('sync manual do catálogo responde 503 sem as envs do site', async () => {
  delete process.env.SITE_CATALOG_URL;
  delete process.env.SITE_CATALOG_KEY;
  const r = await call('POST', '/api/catalog/sync', {});
  assert.equal(r.status, 503);
  assert.match(r.body.error.message, /SITE_CATALOG_URL/);

  const semLogin = await call('POST', '/api/catalog/sync', {}, { user: null });
  assert.equal(semLogin.status, 401, 'rota manual exige usuário logado');
});
