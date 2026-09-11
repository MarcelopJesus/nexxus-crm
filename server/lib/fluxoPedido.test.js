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

// ---- etapas 5 a 7: a volta do fornecedor ----

test('a chave só é aceita quando vem rotulada', () => {
  // Conservador de propósito: e-mail de fornecedor tem nota, CNPJ e código de produto no
  // meio do texto. Adivinhar qual é a licença entregaria lixo ao cliente.
  assert.equal(fluxo.extrairChave('Segue a chave de licença: AMPL-4F2X-99KQ-2210. Abraços'), 'AMPL-4F2X-99KQ-2210');
  assert.equal(fluxo.extrairChave('License Key: XKCD-1234-ABCD'), 'XKCD-1234-ABCD');
  assert.equal(fluxo.extrairChave('serial - ABC123456'), 'ABC123456');
  // sem rótulo, não chuta
  assert.equal(fluxo.extrairChave('o número da nota é 88213 e o CNPJ 12345678000199'), null);
  assert.equal(fluxo.extrairChave('segue em anexo'), null);
  assert.equal(fluxo.extrairChave(''), null);
});

// Fornecedor com e-mail cadastrado — sem isso nenhuma resposta é aceita (fail-closed).
function cadastraFornecedorDoLead(leadId, dominio) {
  const lead = store.get('leads', leadId);
  let prod = lead.product_id ? store.get('products', lead.product_id) : null;
  if (!prod) {
    // O seed não traz o Ampler; monta o par produto+fornecedor que o fluxo exige.
    const sup = store.insert('suppliers', { name: 'Ampler Software', country: 'EUA', currency: 'USD' });
    prod = store.insert('products', { name: 'Ampler', sku: 'ampler', supplier_id: sup.id });
    store.update('leads', leadId, { product_id: prod.id });
  }
  store.update('suppliers', prod.supplier_id, { dominio });
  return `vendas@${dominio}`;
}

test('e-mail do fornecedor sem chave reconhecível NÃO entrega e NÃO fecha o PC', async () => {
  const id = await pedidoPago('Fornecedor Confuso');
  const from = cadastraFornecedorDoLead(id, 'ampler.com');
  const r = fluxo.aoReceberDoFornecedor({ log: api.log, notify: api.notify }, id, { texto: 'recebemos seu pedido, obrigado', from });
  assert.equal(r.ok, false);
  assert.match(r.problemas.join(' '), /não veio chave/);
  assert.equal(docs.achar(id, 'PC').status, 'open', 'o PC continua aberto');
  assert.equal(docs.achar(id, 'PV').status, 'open', 'e o cliente não recebeu nada');
  const aviso = store.find('notifications', n => n.lead_id === id && n.type === 'fluxo_divergencia');
  assert.equal(aviso.length, 1, 'divergência chama gente');
});

test('chave conferida fecha o PC, mas o PV continua aberto até a entrega sair', async () => {
  const id = await pedidoPago('Fornecedor Certo');
  const from = cadastraFornecedorDoLead(id, 'ampler.com');
  const r = fluxo.aoReceberDoFornecedor({ log: api.log, notify: api.notify }, id,
    { texto: 'Chave de licença: AMPL-0001-2222-3333', from });
  assert.equal(r.ok, true);
  assert.equal(r.chave, 'AMPL-0001-2222-3333');
  assert.equal(docs.achar(id, 'PC').status, 'close', 'o PC cumpriu o papel dele');
  assert.equal(docs.achar(id, 'PV').status, 'open', 'pagar não é receber: falta a entrega');
  assert.equal(docs.entregue(id), false);
});

test('quantidade divergente do fornecedor não entrega, mesmo com chave boa', async () => {
  const id = await pedidoPago('Veio Menos');
  const from = cadastraFornecedorDoLead(id, 'ampler.com');
  const r = fluxo.aoReceberDoFornecedor({ log: api.log, notify: api.notify }, id,
    { texto: 'Chave: OK-1234-5678', qty: 1, from });   // o pedido é de 3
  assert.equal(r.ok, false);
  assert.match(r.problemas.join(' '), /pedimos 3, veio 1/);
  assert.equal(docs.achar(id, 'PC').status, 'open');
});

test('fatura no e-mail abre o ciclo financeiro, que não segura a entrega', async () => {
  const id = await pedidoPago('Com Fatura');
  const from = cadastraFornecedorDoLead(id, 'ampler.com');
  fluxo.aoReceberDoFornecedor({ log: api.log, notify: api.notify }, id,
    { texto: 'Chave de licença: FIN-1111-2222. Segue a fatura em anexo.', from });
  const fin = docs.achar(id, 'FIN');
  assert.ok(fin, 'a fatura abre o NXT-FIN');
  assert.equal(fin.status, 'open');
  assert.equal(docs.achar(id, 'PC').status, 'close', 'e o financeiro não impediu o PC de fechar');
});

test('só a entrega confirmada fecha o PV', async () => {
  const id = await pedidoPago('Entrega Final');
  const from = cadastraFornecedorDoLead(id, 'ampler.com');
  fluxo.aoReceberDoFornecedor({ log: api.log, notify: api.notify }, id, { texto: 'Chave: ENT-9999-0000', from });
  // sem prova, não fecha
  assert.equal(fluxo.confirmarEntregaAoCliente({ log: api.log, notify: api.notify }, id, null).ok, false);
  // querer enviar não é ter enviado: sem o id do provedor, não fecha
  assert.equal(fluxo.confirmarEntregaAoCliente({ log: api.log, notify: api.notify }, id, { chave:'ENT-9999-0000', book:true }).ok, false);
  // com a prova de que o e-mail saiu, fecha
  const r = fluxo.confirmarEntregaAoCliente({ log: api.log, notify: api.notify }, id, { chave:'ENT-9999-0000', book:true, messageId:'msg_abc123' });
  assert.equal(r.ok, true);
  assert.equal(docs.entregue(id), true);
  assert.equal(store.find('notifications', n => n.lead_id === id && n.type === 'pedido_entregue').length, 1);
});

test('as caixas por função caem na caixa única enquanto não existirem', () => {
  const mailer = require('./mailer');
  const antes = process.env.EMAIL_FROM;
  process.env.EMAIL_FROM = 'patricia@nexxustech.ia.br';
  delete process.env.EMAIL_FROM_COMPRAS;
  assert.equal(mailer.remetenteDe('compras'), 'patricia@nexxustech.ia.br', 'sem caixa própria, usa a de hoje');
  process.env.EMAIL_FROM_COMPRAS = 'compras@nexxustech.ia.br';
  assert.equal(mailer.remetenteDe('compras'), 'compras@nexxustech.ia.br', 'com a caixa criada, passa a usar');
  assert.equal(mailer.remetenteDe('vendas'), 'patricia@nexxustech.ia.br', 'e as outras não mudam junto');
  assert.equal(mailer.caixasConfiguradas().compras.propria, true);
  assert.equal(mailer.caixasConfiguradas().vendas.propria, false);
  delete process.env.EMAIL_FROM_COMPRAS;
  if (antes === undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM = antes;
});

// ---- achados da revisão do Codex sobre as etapas 5 a 7 ----

test('remetente que não é o fornecedor NÃO fecha o pedido de compra', async () => {
  // Era o furo mais grave: qualquer um com domínio próprio e SPF/DKIM em ordem podia
  // mandar "NXT-PC-0042 — license key: FALSA" e o CRM entregaria a chave falsa ao cliente.
  const id = await pedidoPago('Golpista Tentou');
  cadastraFornecedorDoLead(id, 'ampler.com');
  const r = fluxo.aoReceberDoFornecedor({ log: api.log, notify: api.notify }, id,
    { texto: 'License key: ATACANTE-1234', from: 'vendas@dominio-do-atacante.com' });
  assert.equal(r.ok, false);
  assert.equal(r.remetenteRecusado, true);
  assert.equal(docs.achar(id, 'PC').status, 'open', 'o pedido de compra continua aberto');
  assert.equal(store.find('notifications', n => n.lead_id === id && n.type === 'fluxo_remetente').length, 1);
});

test('fornecedor sem e-mail cadastrado não tem resposta aceita (fail-closed)', async () => {
  const id = await pedidoPago('Fornecedor Sem Cadastro');
  // Fornecedor próprio, deliberadamente SEM domínio: é o estado real de hoje, em que a
  // tabela de fornecedores não tem campo de contato preenchido.
  const sup = store.insert('suppliers', { name: 'Fornecedor Mudo', country: 'EUA', currency: 'USD' });
  const prod = store.insert('products', { name: 'Produto Mudo', sku: 'mudo', supplier_id: sup.id });
  store.update('leads', id, { product_id: prod.id });
  const r = fluxo.aoReceberDoFornecedor({ log: api.log, notify: api.notify }, id,
    { texto: 'License key: QUALQUER-1234', from: 'alguem@fornecedormudo.com' });
  assert.equal(r.ok, false);
  assert.match(r.razao, /sem e-mail\/domínio cadastrado/);
});

test('subdomínio do fornecedor é aceito; domínio parecido não', async () => {
  const id = await pedidoPago('Subdominio');
  cadastraFornecedorDoLead(id, 'ampler.com');
  assert.equal(fluxo.remetenteEhDoFornecedor(store.get('leads', id), 'nf@mail.ampler.com').ok, true);
  // "ampler.com.br" não é subdomínio de "ampler.com" — e sim outro domínio
  assert.equal(fluxo.remetenteEhDoFornecedor(store.get('leads', id), 'nf@ampler.com.br').ok, false);
  assert.equal(fluxo.remetenteEhDoFornecedor(store.get('leads', id), 'nf@naoampler.com').ok, false);
});

test('chave partida por linha ou marcação é remontada; duas chaves viram ambiguidade', () => {
  assert.equal(fluxo.extrairChave('License key: ABCDEF-\nGHIJKL'), 'ABCDEF-GHIJKL');
  assert.equal(fluxo.extrairChave('License key: ABCDEF-<strong>GHIJKL</strong>'), 'ABCDEF-GHIJKL');
  assert.equal(fluxo.extrairChave('Serial: ABCD 1234 EFGH'), 'ABCD1234EFGH');
  // a despedida não entra na chave
  assert.equal(fluxo.extrairChave('chave: XKCD-9090 obrigado pela compra'), 'XKCD-9090');
  // duas chaves não se resolvem no chute
  assert.equal(fluxo.extrairChave('License key: OLDKEY-1111 (cancelada). Replacement license key: NEWKEY-2222'), null);
});

test('rodapé jurídico não abre ciclo financeiro', () => {
  assert.equal(fluxo.pareceFatura('Esta mensagem não constitui fatura nem cobrança'), false);
  assert.equal(fluxo.pareceFatura('Este e-mail não é uma fatura'), false);
  assert.equal(fluxo.pareceFatura('Segue a fatura em anexo'), true);
});

test('configurar só as caixas novas não derruba o envio', () => {
  const mailer = require('./mailer');
  const antesFrom = process.env.EMAIL_FROM, antesKey = process.env.EMAIL_API_KEY;
  process.env.EMAIL_API_KEY = 'chave';
  delete process.env.EMAIL_FROM;
  process.env.EMAIL_FROM_VENDAS = 'vendas@nexxustech.ia.br';
  assert.equal(mailer.isConfigured(), true, 'exigir EMAIL_FROM derrubava tudo');
  // e uma área sem caixa própria usa a que existe, em vez de não enviar
  assert.equal(mailer.remetenteDe('compras'), 'vendas@nexxustech.ia.br');
  delete process.env.EMAIL_FROM_VENDAS;
  if (antesFrom === undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM = antesFrom;
  if (antesKey === undefined) delete process.env.EMAIL_API_KEY; else process.env.EMAIL_API_KEY = antesKey;
});
