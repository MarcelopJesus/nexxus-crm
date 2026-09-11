// Fluxo pós-pagamento PV/PC/FIN — "a nossa Bíblia" (presencial de 09/09/2026).
// A regra que estes testes existem para travar: pedido pago NÃO é pedido entregue.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB_FILE = path.join('/tmp', `nexxus-docs-${process.pid}.json`);
process.env.DB_FILE = DB_FILE;
process.env.AGENT_AUTOPILOT = 'off';
process.env.INTAKE_KEY = 'chave-de-teste';

const store = require('./store');
const { seedIfEmpty } = require('./seed');
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
    customFields:{ origem:'nexxustech.ia.br/checkout', nome, itens:'1x Ampler' } });
  return r.body.data.id;
}

test('pagamento confirmado abre o pedido de venda, já aberto', async () => {
  const id = await pedidoPago('Cliente Um');
  const pv = docs.achar(id, 'PV');
  assert.ok(pv, 'o PV nasce no pagamento');
  assert.equal(pv.status, 'open');
  assert.match(pv.codigo, /^NXT-PV-\d{4}/);
});

test('o PV NÃO fecha enquanto o pedido de compra estiver aberto', async () => {
  // É a chave voltando do fornecedor que destrava o ciclo de vendas.
  const id = await pedidoPago('Cliente Dois');
  docs.abrir(id, 'PC');
  const r = docs.fechar(id, 'PV', 'chave e book enviados', { chave:'ABC-123', book:true, messageId:'msg_test_1' });
  assert.equal(r.ok, false);
  assert.match(r.razao, /pedido de compra ainda está aberto/);
  assert.equal(docs.achar(id, 'PV').status, 'open');
});

test('o PC fecha antes; só então o PV pode fechar', async () => {
  const id = await pedidoPago('Cliente Tres');
  docs.abrir(id, 'PC');
  assert.equal(docs.fechar(id, 'PC', 'chave recebida da Ampler').ok, true);
  const r = docs.fechar(id, 'PV', 'chave e book enviados ao cliente', { chave:'ABC-123', book:true, messageId:'msg_test_1' });
  assert.equal(r.ok, true);
  assert.equal(docs.achar(id, 'PV').status, 'close');
  assert.equal(docs.entregue(id), true);
});

test('o PV não fecha sem a entrega registrada, mesmo sem PC nenhum', async () => {
  // Fechar "no silêncio" faria um pedido aparecer concluído com o cliente sem a chave.
  // Cenário montado à mão: pelo intake o PC hoje já nasce junto (o fluxo das 7 etapas),
  // então a única forma de exercitar ESTA regra é um pedido sem pedido de compra.
  const lead = store.insert('leads', { title:'Sem PC', status:'won', stage:'proposta_enviada',
    doc_seq: docnum.proximoSeq(), doc_sku: null, qty:1 });
  docs.abrir(lead.id, 'PV');
  const r = docs.fechar(lead.id, 'PV', null, null);
  assert.equal(r.ok, false);
  assert.match(r.razao, /chave de licença registrada/);
  assert.equal(docs.entregue(lead.id), false);
});

test('o pagamento abre PV e PC juntos — compras já tem trabalho na mão', async () => {
  // Etapas 1 a 4 do fluxo de 09/09 acontecem na confirmação do pagamento.
  const id = await pedidoPago('Cliente Quatro');
  assert.equal(docs.achar(id, 'PV').status, 'open');
  assert.ok(docs.achar(id, 'PC'), 'o pedido de compra nasce junto');
  assert.equal(docs.achar(id, 'PC').status, 'open');
});

test('abrir o mesmo documento duas vezes não cria dois', async () => {
  // O webhook do Stripe repete, e o agente de compras pode ser reacionado depois de falha.
  const id = await pedidoPago('Cliente Cinco');
  const a = docs.abrir(id, 'PV');
  const b = docs.abrir(id, 'PV');
  assert.equal(a.id, b.id);
  assert.equal(store.find('documents', d => d.lead_id === id && d.tipo === 'PV').length, 1);
});

test('o financeiro corre por fora: fecha sozinho, sem depender do PV', async () => {
  // A Nexxus entrega ao cliente ANTES de pagar a fatura do fornecedor (45 dias).
  const id = await pedidoPago('Cliente Seis');
  docs.abrir(id, 'FIN');
  const r = docs.fechar(id, 'FIN', 'fatura da Ampler paga e comprovante enviado');
  assert.equal(r.ok, true);
  assert.equal(docs.achar(id, 'PV').status, 'open', 'fechar o financeiro não entrega o pedido');
  assert.equal(docs.entregue(id), false);
});

test('fechar duas vezes não quebra e não reescreve a data', async () => {
  const id = await pedidoPago('Cliente Sete');
  docs.abrir(id, 'PC');
  docs.fechar(id, 'PC', 'chave recebida');
  const quando = docs.achar(id, 'PC').closed_at;
  const r = docs.fechar(id, 'PC', 'de novo');
  assert.equal(r.ok, true);
  assert.equal(r.jaEstava, true);
  assert.equal(docs.achar(id, 'PC').closed_at, quando);
});

test('documento sem número de pedido é recusado na hora', () => {
  const orfao = store.insert('leads', { title:'Sem número', status:'open', stage:'novo_lead' });
  assert.throws(() => docs.abrir(orfao.id, 'PV'), /não tem número/);
});

test('o resumo entrega o verde/vermelho que a tela precisa', async () => {
  const id = await pedidoPago('Cliente Oito');
  docs.abrir(id, 'PC');
  docs.fechar(id, 'PC', 'chave recebida');
  const r = docs.resumo(id);
  const porTipo = Object.fromEntries(r.map(d => [d.tipo, d]));
  assert.equal(porTipo.PV.aberto, true);
  assert.equal(porTipo.PC.aberto, false);
  assert.ok(porTipo.PC.closed_at);
});

test('a API entrega os documentos junto do lead', async () => {
  const id = await pedidoPago('Cliente Nove');
  const admin = store.findOne('users', u => u.active);
  const lista = await handle({ method:'GET', path:'/api/leads', user:admin });
  const naLista = lista.body.data.find(l => l.id === id);
  assert.ok(Array.isArray(naLista.documentos));
  assert.equal(naLista.documentos[0].tipo, 'PV');
});

test('o PV não fecha sem a prova de que o e-mail de entrega saiu', async () => {
  // Achado do Codex: qualquer chamador fechava com {chave, book:true} — querer enviar não
  // é ter enviado, e o cliente continuaria sem receber nada.
  const id = await pedidoPago('Sem Prova De Envio');
  docs.abrir(id, 'PC');
  docs.fechar(id, 'PC', 'chave recebida');
  const semId = docs.fechar(id, 'PV', 'entreguei', { chave:'X1-2345-6789', book:true });
  assert.equal(semId.ok, false);
  assert.match(semId.razao, /sem id do provedor/);
  const comId = docs.fechar(id, 'PV', 'entreguei', { chave:'X1-2345-6789', book:true, messageId:'msg_prov_99' });
  assert.equal(comId.ok, true);
  assert.equal(docs.achar(id, 'PV').entrega.message_id, 'msg_prov_99', 'a prova fica registrada');
});
