// M44 — pedido pago no site entra no CRM andando pelo fluxo de 09/09, produto a produto.
// A regra que estes testes travam: carrinho com dois produtos = UM OP e DOIS PV (e dois PC),
// com o SKU no sufixo; a resposta de um fornecedor fecha só o PC do produto dele.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DB_FILE = path.join('/tmp', `nexxus-pedidosite-${process.pid}.json`);
process.env.DB_FILE = DB_FILE;
process.env.AGENT_AUTOPILOT = 'off';
process.env.INTAKE_KEY = 'chave-de-teste';
delete process.env.FLUXO_POS_PAGAMENTO;
const SEGREDO_BRUTO = crypto.randomBytes(24).toString('base64');
process.env.EMAIL_WEBHOOK_SECRET = 'whsec_' + SEGREDO_BRUTO;
process.env.EMAIL_INBOUND_ADDRESS = 'patricia@nexxustech.ia.br';

// Mailer stubado antes de carregar a api.js: nada deste fluxo pode sair para a rede, e o
// contador prova que nada tentou.
let enviados = 0;
const mailerPath = require.resolve('./mailer');
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: { sendEmail: async () => { enviados++; return { sent: true, status: 200 }; }, isConfigured: () => true,
    remetenteDe: () => 'teste@example.com', caixasConfiguradas: () => ({}), CAIXAS: {}, HEADERS_AUTOMATICO: {} },
};

const store = require('./store');
const { seedIfEmpty } = require('./seed');
const docs = require('./documentos');
const fluxo = require('./fluxoPedido');
const api = require('./api');
const { handle } = api;

seedIfEmpty();
after(async () => { await new Promise(r => setTimeout(r, 60)); try { fs.unlinkSync(DB_FILE); } catch {} });

// Dois produtos com fornecedores diferentes, como no carrinho real (Ampler + 1Password).
const supAmpler = store.insert('suppliers', { name: 'Ampler Software', country: 'EUA', currency: 'USD', dominio: 'ampler.com' });
const supOnePass = store.insert('suppliers', { name: 'AgileBits', country: 'CA', currency: 'USD', dominio: '1password.com' });
store.insert('products', { name: 'Ampler', sku: 'ampler', supplier_id: supAmpler.id });
store.insert('products', { name: '1Password Business', sku: '1password-business', supplier_id: supOnePass.id });

function intake(body) {
  return handle({ method:'POST', path:'/api/public/leads', headers:{ 'x-intake-key':'chave-de-teste' }, body });
}
let numPedido = 100;
// Exatamente o que o site manda depois do M44 (server/crm.ts → sendOrderToCRM).
function pedidoDoSite(items, extra) {
  const n = ++numPedido;
  return Object.assign({
    title: `Pedido #${n} - cliente${n}@cli.com`, value: '2511.80', protocol: `NXT-20260923-${n}ABCD`,
    summary: 'Itens: ...', items,
    customFields: { pedido_id: String(n), cliente: `cliente${n}@cli.com`, email: `cliente${n}@cli.com`,
      valor: 'R$ 2511.80', itens: '...', origem: 'nexxustech.ia.br/checkout' },
  }, extra || {});
}

let svix = 0;
function emailEntrando(from, subject, text) {
  const payload = { type: 'email.received', data: { from, to: ['patricia@nexxustech.ia.br'], subject, text } };
  const corpoCru = JSON.stringify(payload);
  const id = 'msg_m44_' + (++svix);
  const ts = Math.floor(Date.now() / 1000);
  const chave = Buffer.from(SEGREDO_BRUTO, 'base64');
  const sig = 'v1,' + crypto.createHmac('sha256', chave).update(`${id}.${ts}.${corpoCru}`).digest('base64');
  return handle({ method: 'POST', path: '/api/public/email/inbound', body: payload, rawBody: corpoCru,
    user: null, query: {}, headers: { host: 'localhost:3001', 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': sig } });
}

test('o domínio novo continua caindo na regra do CRM que procura "checkout"', async () => {
  const r = await intake(pedidoDoSite([{ productSlug: 'ampler', quantity: 1, name: 'Ampler' }]));
  assert.equal(r.status, 201);
  assert.equal(r.body.data.kind, 'order');
  assert.equal(store.get('leads', r.body.data.id).status, 'won');
});

test('carrinho com dois produtos: um lead (OP), dois PV e dois PC com o SKU no sufixo', async () => {
  const r = await intake(pedidoDoSite([
    { productSlug: 'ampler', quantity: 2, name: 'Ampler' },
    { productSlug: '1password-business', quantity: 1, name: '1Password Business' },
  ]));
  const id = r.body.data.id;
  const lead = store.get('leads', id);
  assert.equal(store.find('leads', l => l.doc_seq === lead.doc_seq).length, 1, 'é UM lead só — a oportunidade');
  assert.equal(lead.doc_sku, null, 'o OP não tem SKU; o SKU vai em cada PV');
  assert.equal(lead.qty, 3);

  const seq = String(lead.doc_seq).padStart(4, '0');
  const pvs = docs.doTipo(id, 'PV').map(d => d.codigo).sort();
  const pcs = docs.doTipo(id, 'PC').map(d => d.codigo).sort();
  assert.deepEqual(pvs, [`NXT-PV-${seq}-1PASSWORDBUSINESS`, `NXT-PV-${seq}-AMPLER`]);
  assert.deepEqual(pcs, [`NXT-PC-${seq}-1PASSWORDBUSINESS`, `NXT-PC-${seq}-AMPLER`]);

  // Timeline: o pagamento aparece uma vez citando os dois PV; compras pede um PC por produto.
  const etapas = store.find('activities', a => a.lead_id === id && a.type === 'fluxo').map(a => a.message);
  assert.equal(etapas.filter(m => m.includes('Pagamento confirmado')).length, 1);
  assert.match(etapas.find(m => m.includes('Pagamento confirmado')), /AMPLER.*1PASSWORDBUSINESS|1PASSWORDBUSINESS.*AMPLER/);
  assert.equal(etapas.filter(m => m.includes('[compras] Compras abriu')).length, 2);

  // Um rascunho por fornecedor, cada um com a quantidade e o fornecedor do próprio produto.
  const rascunhos = store.find('activities', a => a.lead_id === id && a.type === 'email_rascunho').map(a => a.message);
  assert.equal(rascunhos.length, 2);
  assert.ok(rascunhos.some(m => m.includes('Ampler Software') && m.includes(`NXT-PC-${seq}-AMPLER`) && m.includes('2 licença(s)')));
  assert.ok(rascunhos.some(m => m.includes('AgileBits') && m.includes(`NXT-PC-${seq}-1PASSWORDBUSINESS`) && m.includes('1 licença(s)')));
  assert.equal(enviados, 0, 'nada sai para fora com o freio desligado');
});

test('um produto só pela lista de itens: produto, fornecedor e SKU ficam no lead, como antes', async () => {
  const r = await intake(pedidoDoSite([{ productSlug: 'ampler', quantity: 3, name: 'Ampler' }]));
  const lead = store.get('leads', r.body.data.id);
  assert.ok(lead.product_id, 'o slug casou com o produto do CRM');
  assert.equal(lead.doc_sku, 'AMPLER');
  assert.equal(lead.qty, 3);
  assert.match(docs.achar(lead.id, 'PV').codigo, /-AMPLER$/);
  const aviso = store.find('notifications', n => n.lead_id === lead.id && n.type === 'fluxo_rascunho');
  assert.equal(aviso.length, 1);
  assert.doesNotMatch(aviso[0].message, /sem fornecedor/, 'o fornecedor foi achado pelo produto');
});

test('o mesmo produto em duas linhas vira um PV só, com a quantidade somada', async () => {
  const r = await intake(pedidoDoSite([
    { productSlug: 'ampler', quantity: 1, name: 'Ampler' },
    { productSlug: 'AMPLER', quantity: 2, name: 'Ampler' },
  ]));
  const id = r.body.data.id;
  assert.equal(docs.doTipo(id, 'PV').length, 1);
  assert.equal(store.get('leads', id).qty, 3);
});

test('produto que o CRM não conhece ainda anda, mas avisa que falta o fornecedor', async () => {
  const r = await intake(pedidoDoSite([{ productSlug: 'produto-novo', quantity: 1, name: 'Produto Novo' }]));
  const id = r.body.data.id;
  assert.match(docs.achar(id, 'PV').codigo, /-PRODUTONOVO$/);
  const aviso = store.find('notifications', n => n.lead_id === id && n.type === 'fluxo_rascunho');
  assert.match(aviso[0].message, /sem fornecedor cadastrado/);
});

test('webhook repetido do site (mesmo protocolo) não abre um segundo pedido', async () => {
  const corpo = pedidoDoSite([{ productSlug: 'ampler', quantity: 1, name: 'Ampler' }]);
  const a = await intake(corpo);
  const b = await intake(corpo);
  assert.equal(b.body.data.deduplicated, true);
  assert.equal(b.body.data.id, a.body.data.id);
  assert.equal(docs.doTipo(a.body.data.id, 'PV').length, 1);
});

test('resposta de um fornecedor fecha só o PC do produto dele; o PV só fecha com a entrega', async () => {
  const r = await intake(pedidoDoSite([
    { productSlug: 'ampler', quantity: 2, name: 'Ampler' },
    { productSlug: '1password-business', quantity: 1, name: '1Password Business' },
  ]));
  const id = r.body.data.id;
  const pcAmpler = docs.achar(id, 'PC', 'AMPLER');

  // Pelo caminho real: o e-mail entra pela Patrícia e é roteado ao fluxo do fornecedor.
  const resp = await emailEntrando('licencas@ampler.com', `RE: Pedido de compra ${pcAmpler.codigo}`,
    'Segue sua licença.\nLicense key: AMPL-7788-XYZ9\nAtenciosamente');
  assert.equal(resp.body.data.fornecedor, true);
  assert.equal(resp.body.data.conferido, true);

  assert.equal(docs.achar(id, 'PC', 'AMPLER').status, 'close');
  assert.equal(docs.achar(id, 'PC', '1PASSWORDBUSINESS').status, 'open', 'o outro produto segue esperando o fornecedor dele');
  assert.equal(docs.achar(id, 'PV', 'AMPLER').status, 'open', 'chave recebida não é chave entregue');

  const deps = { log: api.log, notify: api.notify };
  const prova = { chave: 'AMPL-7788-XYZ9', book: true, messageId: 'msg_entrega_1' };
  // O PV do 1Password não fecha com a entrega do Ampler: o PC dele ainda está aberto.
  assert.equal(fluxo.confirmarEntregaAoCliente(deps, id, prova, '1PASSWORDBUSINESS').ok, false);
  assert.equal(fluxo.confirmarEntregaAoCliente(deps, id, prova, 'AMPLER').ok, true);
  assert.equal(docs.achar(id, 'PV', 'AMPLER').status, 'close');
  assert.equal(docs.entregue(id), false, 'pedido só está entregue quando os dois PV fecharam');
});

test('e-mail do fornecedor sem o SKU num carrinho de dois produtos não chuta: chama gente', async () => {
  const r = await intake(pedidoDoSite([
    { productSlug: 'ampler', quantity: 1, name: 'Ampler' },
    { productSlug: '1password-business', quantity: 1, name: '1Password Business' },
  ]));
  const id = r.body.data.id;
  const seq = String(store.get('leads', id).doc_seq).padStart(4, '0');
  const resp = await emailEntrando('licencas@ampler.com', `RE: NXT-PC-${seq}`, 'License key: AMPL-0000-AAAA');
  assert.equal(resp.body.data.conferido, false);
  assert.equal(docs.doTipo(id, 'PC').filter(d => d.status === 'open').length, 2, 'nenhum PC fechou');
  const aviso = store.find('notifications', n => n.lead_id === id && n.type === 'fluxo_divergencia');
  assert.equal(aviso.length, 1);
  assert.match(aviso[0].message, /não cita o código com o produto/);
});

test('fornecedor do outro produto não fecha o PC que não é dele', async () => {
  const r = await intake(pedidoDoSite([
    { productSlug: 'ampler', quantity: 1, name: 'Ampler' },
    { productSlug: '1password-business', quantity: 1, name: '1Password Business' },
  ]));
  const id = r.body.data.id;
  const pcAmpler = docs.achar(id, 'PC', 'AMPLER');
  const resp = await emailEntrando('vendas@1password.com', `RE: ${pcAmpler.codigo}`, 'License key: FALSA-1234-5678');
  assert.equal(resp.body.data.conferido, false);
  assert.equal(docs.achar(id, 'PC', 'AMPLER').status, 'open');
});

test('site antigo (sem lista de itens) segue funcionando como antes', async () => {
  const r = await intake({ contactName: 'Legado', value: 765.9, productSlug: 'ampler', quantity: 2,
    customFields: { origem: 'nexxustech.ia.br/checkout', nome: 'Legado', itens: '2x Ampler' } });
  const lead = store.get('leads', r.body.data.id);
  assert.equal(lead.itens, null);
  assert.equal(lead.doc_sku, 'AMPLER');
  assert.equal(docs.doTipo(lead.id, 'PV').length, 1);
  assert.equal(docs.doTipo(lead.id, 'PC').length, 1);
});

// ---- achados da revisão do Codex (GPT) sobre o M44 ----

test('dois produtos cujo SKU normalizado colide NÃO viram um PV só', async () => {
  store.insert('products', { name: 'Suite Anual', sku: 'suite-professional-annual' });
  store.insert('products', { name: 'Suite Anual Plus', sku: 'suite-professional-annually' });
  const r = await intake(pedidoDoSite([
    { productSlug: 'suite-professional-annual', quantity: 1, name: 'Suite Anual' },
    { productSlug: 'suite-professional-annually', quantity: 1, name: 'Suite Anual Plus' },
  ]));
  const id = r.body.data.id;
  const pvs = docs.doTipo(id, 'PV').map(d => d.codigo);
  assert.equal(pvs.length, 2, 'cada produto pago tem o próprio PV');
  assert.equal(new Set(pvs).size, 2, 'e os códigos não podem ser iguais');
  assert.equal(store.get('leads', id).itens.length, 2);
});

test('e-mail citando dois produtos não fecha o único PC que sobrou aberto', async () => {
  // Mesmo fornecedor para os dois produtos: o remetente passa na conferência.
  const sup = store.insert('suppliers', { name: 'Mesmo Fornecedor', dominio: 'mesmo.com' });
  store.insert('products', { name: 'Prod A', sku: 'prod-a', supplier_id: sup.id });
  store.insert('products', { name: 'Prod B', sku: 'prod-b', supplier_id: sup.id });
  const r = await intake(pedidoDoSite([
    { productSlug: 'prod-a', quantity: 1, name: 'Prod A' },
    { productSlug: 'prod-b', quantity: 1, name: 'Prod B' },
  ]));
  const id = r.body.data.id;
  const pcA = docs.achar(id, 'PC', 'PRODA');
  const pcB = docs.achar(id, 'PC', 'PRODB');
  const ok = await emailEntrando('lic@mesmo.com', `RE: ${pcA.codigo}`, 'License key: AAAA-1111-ZZZZ');
  assert.equal(ok.body.data.conferido, true);
  assert.equal(docs.achar(id, 'PC', 'PRODA').status, 'close');

  // A conversa continua citando os dois pedidos; a chave é de novo a do A.
  const resp = await emailEntrando('lic@mesmo.com', `RE: ${pcA.codigo} e ${pcB.codigo}`, 'License key: AAAA-2222-ZZZZ');
  assert.equal(resp.body.data.conferido, false);
  assert.equal(docs.achar(id, 'PC', 'PRODB').status, 'open', 'o PC do B não pode fechar com chave de outro produto');
});

test('código NXT na linha de baixo da chave não é colado na chave', () => {
  assert.equal(fluxo.extrairChave('License key: AAAA-1234-5678\nNXT-PC-0001-A\nNXT-PC-0001-B'), 'AAAA-1234-5678');
});
