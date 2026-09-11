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
const api = require('./api');
const { handle } = api;

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

test('a API devolve os códigos junto do lead, para a tela poder mostrar', async () => {
  const r = await intake({ companyName:'Mostra Na Tela Ltda', contactName:'D', email:'d@mostra.com',
    productSlug:'ampler', quantity:5 });
  const admin = store.findOne('users', u => u.active);
  const lista = await handle({ method:'GET', path:'/api/leads', user:admin });
  const naLista = lista.body.data.find(l => l.id === r.body.data.id);
  assert.ok(naLista.doc, 'o lead vai para a tela com os códigos calculados');
  assert.match(naLista.doc.op, /^NXT-OP-\d{4}$/);
  // derivados na saída, nunca gravados prontos: OP e PV não podem divergir
  assert.equal(naLista.doc.seq, store.get('leads', r.body.data.id).doc_seq);
});

// ---- achados da revisão do Codex (10/09), cada um travado por um teste ----

test('adotar um número futuro empurra o contador — senão o próximo pedido colide', async () => {
  // Cenário do Codex: contador em N, site manda N+1, contador não anda, e o pedido
  // SEGUINTE recebe N+1 também. Dois leads com o mesmo código = e-mail no card errado.
  const r1 = await intake({ companyName:'Salta Numero Ltda', contactName:'E', email:'e@salta.com',
    doc:'NXT-OP-8800' });
  assert.equal(store.get('leads', r1.body.data.id).doc_seq, 8800);
  const r2 = await intake({ companyName:'Depois Dele SA', contactName:'F', email:'f@depois.com' });
  const seq2 = store.get('leads', r2.body.data.id).doc_seq;
  assert.ok(seq2 > 8800, `o próximo número tem que passar de 8800, veio ${seq2}`);
});

test('número já usado não é adotado — abre um novo em vez de duplicar', async () => {
  // O intake é público. Sem isto, mandar o código de outro cliente criaria dois leads com
  // o mesmo número, e a resposta do cliente cairia em qualquer um dos dois.
  const r1 = await intake({ companyName:'Dona Do Numero SA', contactName:'G', email:'g@dona.com',
    doc:'NXT-OP-7700' });
  const r2 = await intake({ companyName:'Tentou Roubar ME', contactName:'H', email:'h@roubar.com',
    doc:'NXT-OP-7700' });
  const l1 = store.get('leads', r1.body.data.id), l2 = store.get('leads', r2.body.data.id);
  assert.equal(l1.doc_seq, 7700);
  assert.notEqual(l2.doc_seq, 7700, 'o segundo não pode ficar com o número do primeiro');
  const comEsse = store.find('leads', l => Number(l.doc_seq) === 7700);
  assert.equal(comEsse.length, 1, 'só um lead pode responder por um número');
});

test('e-mail que cita dois pedidos diferentes não casa com nenhum', async () => {
  // Encaminhamento cita o pedido antigo e o atual. Pegar o primeiro é chute; melhor cair
  // no message-id/remetente do que anexar a conversa ao pedido errado.
  const a = await intake({ companyName:'Citada A', contactName:'I', email:'i@a.com' });
  const b = await intake({ companyName:'Citada B', contactName:'J', email:'j@b.com' });
  const ca = docnum.formatar('OP', store.get('leads', a.body.data.id).doc_seq);
  const cb = docnum.formatar('OP', store.get('leads', b.body.data.id).doc_seq);
  assert.equal(api.leadPorCodigo(`encaminhado: ${ca} ... e agora sobre o ${cb}`), null);
  // um código só continua casando normalmente
  assert.equal(api.leadPorCodigo(`sobre o ${ca}`), a.body.data.id);
  // o mesmo código repetido não conta como dois
  assert.equal(api.leadPorCodigo(`${ca} e de novo ${ca}`), a.body.data.id);
});

test('pedido pago recebe e-mail por código; pedido perdido não', async () => {
  const r = await intake({ contactName:'Pos Venda', email:'pos@venda.com', value:100,
    customFields:{ origem:'nexxustech.ia.br/checkout', nome:'Pos Venda' } });
  const lead = store.get('leads', r.body.data.id);
  const cod = docnum.formatar('PV', lead.doc_seq, lead.doc_sku);
  // 'won' recebe: é o pós-venda do pedido, exatamente o que a numeração veio permitir
  assert.equal(api.leadPorCodigo(`sobre o ${cod}`), lead.id);
  // 'lost' não: ressuscitar negócio morto em silêncio esconde o que está acontecendo
  store.update('leads', lead.id, { status:'lost' });
  assert.equal(api.leadPorCodigo(`sobre o ${cod}`), null);
  store.update('leads', lead.id, { status:'won' });
});
