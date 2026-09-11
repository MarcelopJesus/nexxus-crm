// O fluxo das 7 etapas pós-pagamento ("a nossa Bíblia", 09/09/2026).
// Estes testes existem para travar duas coisas: nada sai para o fornecedor sem alguém
// ligar o freio, e divergência não entrega.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB_FILE = path.join('/tmp', `nexxus-fluxo-${process.pid}.json`);
process.env.DB_FILE = DB_FILE;
process.env.AGENT_AUTOPILOT = 'off';
process.env.INTAKE_KEY = 'chave-de-teste';
delete process.env.FLUXO_POS_PAGAMENTO;   // o padrão é DESLIGADO

const store = require('./store');
const { seedIfEmpty } = require('./seed');
const fluxo = require('./fluxoPedido');
const docs = require('./documentos');
const docnum = require('./docnum');
const api = require('./api');
const { handle } = api;

seedIfEmpty();
after(async () => { await new Promise(r => setTimeout(r, 60)); try { fs.unlinkSync(DB_FILE); } catch {} });

function intake(body) {
  return handle({ method:'POST', path:'/api/public/leads', headers:{ 'x-intake-key':'chave-de-teste' }, body });
}
async function pedidoPago(nome) {
  const r = await intake({ contactName:nome, email:`${nome.replace(/\W/g,'')}@cli.com`, value:765.9,
    productSlug:'ampler', quantity:3,
    customFields:{ origem:'nexxustech.ia.br/checkout', nome, itens:'3x Ampler' } });
  return r.body.data.id;
}

// ---- o freio ----

test('desligado é o padrão: nada é enviado ao fornecedor', () => {
  assert.equal(fluxo.ligado(), false, 'FLUXO_POS_PAGAMENTO tem que ser opt-in');
});

test('com o freio desligado, o pedido de compra vira RASCUNHO e avisa um humano', async () => {
  const id = await pedidoPago('Freio Desligado');
  const rascunhos = store.find('activities', a => a.lead_id === id && a.type === 'email_rascunho');
  assert.equal(rascunhos.length, 1, 'o e-mail ao fornecedor fica escrito, não enviado');
  assert.match(rascunhos[0].message, /Pedido de compra NXT-PC-/);
  const aviso = store.find('notifications', n => n.lead_id === id && n.type === 'fluxo_rascunho');
  assert.equal(aviso.length, 1, 'alguém precisa ser avisado de que há pedido esperando');
  assert.match(aviso[0].message, /nada foi enviado ao fornecedor/i);
});

test('a timeline registra as etapas com o agente dono de cada uma', async () => {
  const id = await pedidoPago('Timeline Cheia');
  const etapas = store.find('activities', a => a.lead_id === id && a.type === 'fluxo');
  assert.ok(etapas.length >= 4, `esperava as 4 primeiras etapas, vieram ${etapas.length}`);
  const texto = etapas.map(e => e.message).join('\n');
  assert.match(texto, /\[vendas\]/);
  assert.match(texto, /\[compras\]/);
  assert.match(texto, /RASCUNHO, não enviado/);
});

// ---- o double-check (etapa 6) ----

test('o que o fornecedor mandou bate com o pedido: passa', () => {
  const lead = { qty: 3, doc_sku: 'AMPLER', doc_seq: 12 };
  const r = fluxo.conferir(lead, { qty: 3, sku: 'ampler', seq: 12, chave: 'ABC-123' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.problemas, []);
});

test('quantidade diferente NÃO passa — é a razão de o compras não falar com o cliente', () => {
  const lead = { qty: 50, doc_sku: 'AMPLER', doc_seq: 12 };
  const r = fluxo.conferir(lead, { qty: 5, sku: 'ampler', seq: 12, chave: 'ABC' });
  assert.equal(r.ok, false);
  assert.match(r.problemas.join(' '), /pedimos 50, veio 5/);
});

test('produto trocado e número de pedido trocado são pegos', () => {
  const lead = { qty: 3, doc_sku: 'AMPLER', doc_seq: 12 };
  const r = fluxo.conferir(lead, { qty: 3, sku: '1Password', seq: 99, chave: 'ABC' });
  assert.equal(r.ok, false);
  assert.equal(r.problemas.length, 2);
});

test('chave vazia é divergência, não entrega', () => {
  const lead = { qty: 1, doc_sku: null, doc_seq: 5 };
  const r = fluxo.conferir(lead, { chave: '   ' });
  assert.equal(r.ok, false);
  assert.match(r.problemas.join(' '), /não veio chave/);
});

test('resposta SEM chave nenhuma não passa — era falso ok', () => {
  // Achado do Codex: {qty, sku, seq} batendo e chave ausente devolvia ok. Entregaria ao
  // cliente um e-mail sem licença dentro, que é o pior erro possível neste fluxo.
  const lead = { qty: 3, doc_sku: 'AMPLER', doc_seq: 12 };
  assert.equal(fluxo.conferir(lead, { qty: 3, sku: 'AMPLER', seq: 12 }).ok, false);
  assert.equal(fluxo.conferir(lead, {}).ok, false);
  assert.equal(fluxo.conferir(lead, null).ok, false);
});

test('o que o fornecedor não informou além da chave não vira divergência inventada', () => {
  // Fornecedor que responde só com a chave não pode ser tratado como erro.
  const lead = { qty: 3, doc_sku: 'AMPLER', doc_seq: 12 };
  assert.equal(fluxo.conferir(lead, { chave: 'ABC-123' }).ok, true);
});

// ---- o e-mail de pedido de compra (M40) ----

test('o e-mail ao fornecedor pede a chave e a fatura nos endereços certos', async () => {
  const id = await pedidoPago('Texto Do Email');
  const lead = store.get('leads', id);
  const e = fluxo.textoPedidoDeCompra(lead, { name:'Ampler' }, { name:'Ampler Software' });
  assert.match(e.assunto, /^Pedido de compra NXT-PC-\d{4}/);
  assert.match(e.corpo, /chave de licença/i);
  assert.match(e.corpo, /fatura/i);
  // o número no corpo é o que permite conciliar a resposta depois
  assert.ok(e.corpo.includes(e.codigo));
  assert.match(e.corpo, /cite o número/i);
});

test('o código do e-mail é o mesmo número do pedido, com prefixo de compra', async () => {
  const id = await pedidoPago('Mesmo Numero');
  const lead = store.get('leads', id);
  const e = fluxo.textoPedidoDeCompra(lead, null, null);
  assert.equal(e.codigo, docnum.formatar('PC', lead.doc_seq, lead.doc_sku));
  assert.equal(docnum.extrair(e.codigo).seq, lead.doc_seq);
});

// ---- achados da revisão do Codex sobre a fase 2 ----

test('rodar o fluxo duas vezes não duplica rascunho nem notificação', async () => {
  // O webhook do Stripe repete. Abrir PV/PC já era idempotente; os efeitos colaterais não.
  const id = await pedidoPago('Webhook Repetido');
  const r = fluxo.aoConfirmarPagamento({ log: api.log, notify: api.notify }, id);
  assert.equal(r.repetido, true);
  assert.equal(store.find('activities', a => a.lead_id === id && a.type === 'email_rascunho').length, 1);
  assert.equal(store.find('notifications', n => n.lead_id === id && n.type === 'fluxo_rascunho').length, 1);
});

test('chamador sem deps completo é recusado na porta, antes de abrir documento', () => {
  const lead = store.insert('leads', { title:'Deps incompleto', status:'won', doc_seq: docnum.proximoSeq(), qty:1 });
  assert.throws(() => fluxo.aoConfirmarPagamento({ log: api.log }, lead.id), /exige deps.log e deps.notify/);
  assert.equal(docs.achar(lead.id, 'PV'), null, 'não pode abrir documento e quebrar depois');
});

test('o fluxo nunca afirma que enviou — a caixa @compras ainda não existe', async () => {
  const lead = store.insert('leads', { title:'Nao Mente', status:'won', doc_seq: docnum.proximoSeq(), qty:1 });
  const r = fluxo.aoConfirmarPagamento({ log: api.log, notify: api.notify }, lead.id);
  assert.equal(r.enviado, false, 'dizer enviado sem enviar faria alguém parar de cobrar o fornecedor');
});

test('webhook de pagamento repetido com o mesmo protocolo não cria segundo pedido', async () => {
  const corpo = { contactName:'Stripe Repetiu', email:'repetiu@cli.com', value:100, protocol:'stripe_evt_777',
    customFields:{ origem:'nexxustech.ia.br/checkout', nome:'Stripe Repetiu' } };
  const a = await intake(corpo);
  const b = await intake(corpo);
  assert.equal(b.body.data.id, a.body.data.id, 'o segundo evento tem que cair no mesmo lead');
  assert.equal(b.body.data.deduplicated, true);
  const id = a.body.data.id;
  assert.equal(store.find('documents', d => d.lead_id === id && d.tipo === 'PV').length, 1);
  assert.equal(store.find('notifications', n => n.lead_id === id && n.type === 'order_paid').length, 1);
});
