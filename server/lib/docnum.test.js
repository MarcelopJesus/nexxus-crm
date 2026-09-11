// Numeração de documentos NXT (presencial de 09/09/2026): um número sequencial que
// atravessa oportunidade → pedido de venda → pedido de compra, e que é a chave para a
// resposta do cliente cair no card certo.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB_FILE = path.join('/tmp', `nexxus-docnum-${process.pid}.json`);
process.env.DB_FILE = DB_FILE;
process.env.AGENT_AUTOPILOT = 'off';
process.env.INTAKE_KEY = 'chave-de-teste';

const store = require('./store');
const { seedIfEmpty } = require('./seed');
const docnum = require('./docnum');
const { handle } = require('./api');

seedIfEmpty();
after(async () => { await new Promise(r => setTimeout(r, 60)); try { fs.unlinkSync(DB_FILE); } catch {} });

// ---- formatação ----

test('formata o código com quatro dígitos', () => {
  assert.equal(docnum.formatar('OP', 7), 'NXT-OP-0007');
  assert.equal(docnum.formatar('PV', 12), 'NXT-PV-0012');
  assert.equal(docnum.formatar('PC', 1234), 'NXT-PC-1234');
});

test('passando de 9.999 o número cresce em vez de reiniciar', () => {
  // Reiniciar colidiria com um pedido antigo — o número tem que continuar único.
  assert.equal(docnum.formatar('OP', 10000), 'NXT-OP-10000');
});

test('o SKU entra no sufixo, normalizado', () => {
  assert.equal(docnum.formatar('PV', 7, '1Password'), 'NXT-PV-0007-1PASSWORD');
  assert.equal(docnum.formatar('PV', 7, 'ampler'), 'NXT-PV-0007-AMPLER');
  // hífen no SKU criaria ambiguidade com o separador do próprio código
  assert.equal(docnum.formatar('PV', 7, 'sigma-xl'), 'NXT-PV-0007-SIGMAXL');
  assert.equal(docnum.formatar('PV', 7, 'Ampére'), 'NXT-PV-0007-AMPERE');
});

test('tipo e sequencial inválidos são recusados na hora', () => {
  assert.throws(() => docnum.formatar('XX', 1), /Tipo de documento inválido/);
  assert.throws(() => docnum.formatar('OP', 0), /Sequencial inválido/);
  assert.throws(() => docnum.formatar('OP', -3), /Sequencial inválido/);
  assert.throws(() => docnum.formatar('OP', 1.5), /Sequencial inválido/);
});

// ---- leitura de dentro de texto ----

test('acha o código no assunto de uma resposta de e-mail', () => {
  const r = docnum.extrair('Re: Proposta comercial [NXT-PV-0007-AMPLER]');
  assert.equal(r.tipo, 'PV');
  assert.equal(r.seq, 7);
  assert.equal(r.sku, 'AMPLER');
});

test('acha o código em minúsculas e no meio do corpo', () => {
  const r = docnum.extrair('bom dia, sobre o nxt-op-0031 que voces mandaram ontem');
  assert.equal(r.seq, 31);
  assert.equal(r.tipo, 'OP');
});

test('texto sem código devolve null em vez de chutar', () => {
  assert.equal(docnum.extrair('bom dia, tudo bem?'), null);
  assert.equal(docnum.extrair(''), null);
  assert.equal(docnum.extrair(null), null);
  // parecido não basta: sem o prefixo NXT não é código nosso
  assert.equal(docnum.extrair('pedido OP-0007'), null);
});

test('e-mail encaminhado citando vários códigos devolve todos, sem repetir', () => {
  const r = docnum.extrairTodos('segue NXT-OP-0012, o NXT-PC-0012 e de novo NXT-OP-0012');
  assert.equal(r.length, 2);
  assert.deepEqual(r.map(x => x.codigo), ['NXT-OP-0012', 'NXT-PC-0012']);
});

// ---- os códigos derivam do lead ----

test('o mesmo número atravessa os três documentos', () => {
  const c = docnum.codigosDoLead({ doc_seq: 7, doc_sku: 'AMPLER' });
  assert.equal(c.op, 'NXT-OP-0007');
  assert.equal(c.pv, 'NXT-PV-0007-AMPLER');
  assert.equal(c.pc, 'NXT-PC-0007-AMPLER');
  // é o MESMO pedido andando: o número não muda de tipo para tipo
  assert.equal(c.seq, 7);
});

test('lead sem número não inventa código', () => {
  assert.equal(docnum.codigosDoLead({}), null);
  assert.equal(docnum.codigosDoLead(null), null);
  assert.equal(docnum.codigosDoLead({ doc_seq: 0 }), null);
});

// ---- ponta a ponta pelo intake ----

function intake(body) {
  return handle({ method:'POST', path:'/api/public/leads',
    headers:{ 'x-intake-key':'chave-de-teste' }, body });
}

test('lead do formulário B2B nasce com número de oportunidade', async () => {
  const r = await intake({ companyName:'Empresa Teste NXT', contactName:'Fulano',
    email:'fulano@empresateste.com.br', message:'quero 10 licenças', productSlug:'ampler', quantity:10 });
  assert.equal(r.status, 201);
  const lead = store.get('leads', r.body.data.id);
  assert.ok(lead.doc_seq > 0, 'o lead tem que nascer com número');
  assert.match(docnum.codigosDoLead(lead).op, /^NXT-OP-\d{4}$/);
});

test('pedido pago nasce com o mesmo número servindo de OP e de PV', async () => {
  const r = await intake({ contactName:'Cliente Pago', email:'pago@cliente.com', value:765.9,
    customFields:{ origem:'nexxustech.ia.br/checkout', nome:'Cliente Pago', pedido_id:'11', itens:'1x Ampler' } });
  assert.equal(r.status, 201);
  const lead = store.get('leads', r.body.data.id);
  assert.equal(lead.status, 'won', 'compra direta continua virando ganho');
  const c = docnum.codigosDoLead(lead);
  assert.ok(c, 'pedido pago precisa de número');
  // o PV é o MESMO número da oportunidade — a transição é o pagamento, não um número novo
  assert.equal(c.pv.replace('-PV-', '-OP-').split('-').slice(0,3).join('-'), c.op);
  assert.ok(lead.doc_pago_em, 'a hora do pagamento fica registrada');
});

test('dois leads seguidos recebem números diferentes', async () => {
  const a = await intake({ companyName:'Alfa Ltda', contactName:'A', email:'a@alfa.com' });
  const b = await intake({ companyName:'Beta Ltda', contactName:'B', email:'b@beta.com' });
  const la = store.get('leads', a.body.data.id), lb = store.get('leads', b.body.data.id);
  assert.notEqual(la.doc_seq, lb.doc_seq);
});

test('código que o site já gerou é adotado, em vez de abrir outro', async () => {
  // Senão o mesmo pedido teria um número no site e outro no CRM — o defeito que a
  // numeração veio resolver.
  const r = await intake({ companyName:'Reaproveita SA', contactName:'C', email:'c@reaproveita.com',
    doc:'NXT-OP-4242' });
  const lead = store.get('leads', r.body.data.id);
  assert.equal(lead.doc_seq, 4242);
});

test('newsletter não consome número de oportunidade', async () => {
  const r = await intake({ email:'curioso@gmail.com', customFields:{ origem:'site/newsletter' } });
  const lead = store.get('leads', r.body.data.id);
  assert.equal(lead.doc_seq, null, 'inscrito em newsletter não é oportunidade comercial');
});
