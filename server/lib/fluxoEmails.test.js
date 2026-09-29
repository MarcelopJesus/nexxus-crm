// Fluxo pós-pagamento com o freio ligado (29/09): as etapas viram e-mails de verdade entre
// cliente, caixa de vendas (Veridiana), caixa de compras (Cora) e fabricante.
// O que estes testes travam:
//   - no modo "teste" só recebe e-mail quem está na lista (e as nossas caixas)
//   - e-mail que não sai vira rascunho + aviso, nunca "enviado" de mentira
//   - a chave de licença vai ao cliente, mas não fica repetida na timeline
//   - o PV só fecha com chave + book + id do provedor
//   - e-mail vindo das nossas caixas não é tratado como cliente nem fornecedor
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DB_FILE = path.join('/tmp', `nexxus-fluxoemails-${process.pid}.json`);
process.env.DB_FILE = DB_FILE;
process.env.AGENT_AUTOPILOT = 'off';
process.env.INTAKE_KEY = 'chave-de-teste';
process.env.FLUXO_POS_PAGAMENTO = 'teste';
process.env.FLUXO_EMAIL_PERMITIDOS = 'cliente.teste@exemplo.com, Italo <italo.fabricante@exemplo.com>';
process.env.EMAIL_FROM = 'Patrícia <patricia.atendimento@nexxus.ia.br>';
process.env.EMAIL_FROM_VENDAS = 'Veridiana | Vendas <veridiana.vendas@nexxus.ia.br>';
process.env.EMAIL_FROM_COMPRAS = 'cora.compras@nexxus.ia.br';
const SEGREDO_BRUTO = crypto.randomBytes(24).toString('base64');
process.env.EMAIL_WEBHOOK_SECRET = 'whsec_' + SEGREDO_BRUTO;
process.env.EMAIL_INBOUND_ADDRESS = 'patricia.atendimento@nexxus.ia.br';

// Mailer falso: registra cada envio e deixa o teste escolher a resposta do provedor.
let enviados = [];
let respostaDoProvedor = () => ({ sent: true, status: 202, id: 'msg-' + (enviados.length) });
const mailerPath = require.resolve('./mailer');
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: {
    sendEmail: async (m) => { enviados.push(m); return respostaDoProvedor(m); },
    isConfigured: () => true,
    remetenteDe: (a) => a === 'compras' ? process.env.EMAIL_FROM_COMPRAS : process.env.EMAIL_FROM_VENDAS,
    caixasConfiguradas: () => ({
      vendas: { propria: true, endereco: process.env.EMAIL_FROM_VENDAS },
      compras: { propria: true, endereco: process.env.EMAIL_FROM_COMPRAS },
      financeiro: { propria: false, endereco: null },
    }),
    CAIXAS: {}, HEADERS_AUTOMATICO: {},
  },
};

const store = require('./store');
const { seedIfEmpty } = require('./seed');
const docs = require('./documentos');
const fluxo = require('./fluxoPedido');
const api = require('./api');
const { handle } = api;

seedIfEmpty();
after(async () => { await new Promise(r => setTimeout(r, 60)); try { fs.unlinkSync(DB_FILE); } catch {} });
beforeEach(() => {
  enviados = [];
  respostaDoProvedor = () => ({ sent: true, status: 202, id: 'msg-' + enviados.length });
});

const supTeste = store.insert('suppliers', { name: 'Fabricante Teste', currency: 'USD', email: 'italo.fabricante@exemplo.com' });
const supReal = store.insert('suppliers', { name: 'Fornecedor Real', currency: 'USD', email: 'pedidos@fornecedor-real.com' });
const supSemEmail = store.insert('suppliers', { name: 'Sem Email', currency: 'USD' });
const prodComBook = store.insert('products', { name: 'Produto Teste', sku: 'teste-fluxo', supplier_id: supTeste.id,
  book_url: 'https://nexxustech.ia.br/books/teste.pdf' });
store.insert('products', { name: 'Produto Sem Book', sku: 'teste-sem-book', supplier_id: supTeste.id });
store.insert('products', { name: 'Produto Real', sku: 'produto-real', supplier_id: supReal.id });
store.insert('products', { name: 'Produto Sem Email', sku: 'produto-sem-email', supplier_id: supSemEmail.id });

const admin = store.findOne('users', u => u.role === 'admin');
const vendedor = store.findOne('users', u => u.role !== 'admin' && u.area !== 'admin');

let numPedido = 500;
async function pedidoPago(slug, email) {
  const n = ++numPedido;
  const cliente = email || 'cliente.teste@exemplo.com';
  const r = await handle({ method: 'POST', path: '/api/public/leads', headers: { 'x-intake-key': 'chave-de-teste' }, body: {
    title: `Pedido #${n}`, value: '100.00', protocol: `NXT-20260929-${n}TEST`,
    items: [{ productSlug: slug, quantity: 1, name: slug }],
    customFields: { pedido_id: String(n), nome: 'Cliente Teste', email: cliente, valor: 'R$ 100,00', itens: '1x ' + slug,
      origem: 'nexxustech.ia.br/checkout' },
  } });
  assert.equal(r.status, 201);
  await api.aguardarDespachosDoFluxo();
  return r.body.data.id;
}

let svix = 0;
const AUTENTICADO = [{ name: 'Authentication-Results', value: 'spf=pass smtp.mailfrom=exemplo.com; dkim=pass header.d=exemplo.com; dmarc=pass action=none header.from=exemplo.com' }];
async function emailEntrando(from, subject, text, headers) {
  const payload = { type: 'email.received', data: { from, to: ['patricia.atendimento@nexxus.ia.br'], subject, text, headers: headers || AUTENTICADO } };
  const corpoCru = JSON.stringify(payload);
  const id = 'msg_fluxo_' + (++svix);
  const ts = Math.floor(Date.now() / 1000);
  const sig = 'v1,' + crypto.createHmac('sha256', Buffer.from(SEGREDO_BRUTO, 'base64')).update(`${id}.${ts}.${corpoCru}`).digest('base64');
  const r = await handle({ method: 'POST', path: '/api/public/email/inbound', body: payload, rawBody: corpoCru,
    user: null, query: {}, headers: { host: 'localhost:3001', 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': sig } });
  await api.aguardarDespachosDoFluxo();
  return r;
}

const atividades = (id, tipo) => store.find('activities', a => a.lead_id === id && (!tipo || a.type === tipo));

// ---- a ida: pagamento → cliente, vendas → compras, compras → fabricante ----

test('o freio tem três posições e "teste" conta como ligado', () => {
  assert.equal(fluxo.modo(), 'teste');
  assert.equal(fluxo.ligado(), true);
  assert.equal(fluxo.motivoParaNaoEnviar('cliente.teste@exemplo.com'), null);
  assert.equal(fluxo.motivoParaNaoEnviar('Italo <ITALO.fabricante@exemplo.com>'), null, 'nome e maiúsculas não atrapalham');
  assert.equal(fluxo.motivoParaNaoEnviar('cora.compras@nexxus.ia.br'), null, 'as nossas caixas sempre recebem');
  assert.match(fluxo.motivoParaNaoEnviar('pedidos@fornecedor-real.com'), /FLUXO_EMAIL_PERMITIDOS/);
});

test('pagamento confirmado: saem os três e-mails da ida, cada um pela caixa certa', async () => {
  const id = await pedidoPago('teste-fluxo');
  assert.equal(enviados.length, 3);
  const [aviso, interno, pedido] = enviados;

  assert.equal(aviso.to, 'cliente.teste@exemplo.com');
  assert.equal(aviso.area, 'vendas');
  assert.match(aviso.subject, /Pagamento confirmado — pedido NXT-PV-\d{4}-TESTEFLUXO/);

  assert.equal(interno.to, 'cora.compras@nexxus.ia.br');
  assert.equal(interno.area, 'vendas');
  assert.match(interno.html, /Favor solicitar a licença/);

  assert.equal(pedido.to, 'italo.fabricante@exemplo.com');
  assert.equal(pedido.area, 'compras');
  assert.match(pedido.subject, /Pedido de compra NXT-PC-\d{4}-TESTEFLUXO/);

  assert.equal(atividades(id, 'email_rascunho').length, 0, 'nada ficou como rascunho');
  assert.equal(atividades(id, 'email_out').length, 3, 'os três aparecem na conversa do card');
  const etapas = atividades(id, 'fluxo').map(a => a.message).join('\n');
  assert.match(etapas, /\[vendas\] Vendas avisou o cliente.*e-mail enviado para cliente/);
  assert.match(etapas, /\[vendas\] Vendas repassou.*e-mail enviado para compras/);
  assert.match(etapas, /\[compras\] Compras abriu.*e-mail enviado para fornecedor \(Fabricante Teste\)/);
});

test('o HTML do e-mail escapa o que vem do pedido (nome do cliente não vira marcação)', async () => {
  const n = ++numPedido;
  await handle({ method: 'POST', path: '/api/public/leads', headers: { 'x-intake-key': 'chave-de-teste' }, body: {
    title: `Pedido #${n}`, value: '100.00', protocol: `NXT-20260929-${n}HTML`,
    items: [{ productSlug: 'teste-fluxo', quantity: 1, name: 'x' }],
    customFields: { pedido_id: String(n), nome: '<img src=x onerror=alert(1)>', email: 'cliente.teste@exemplo.com',
      valor: 'R$ 1', itens: 'x', origem: 'nexxustech.ia.br/checkout' } } });
  await api.aguardarDespachosDoFluxo();
  assert.ok(enviados.length >= 1);
  for (const e of enviados) assert.doesNotMatch(e.html, /<img/);
});

test('modo teste: fornecedor fora da lista NÃO recebe — vira rascunho e avisa', async () => {
  const id = await pedidoPago('produto-real');
  assert.ok(!enviados.some(e => e.to === 'pedidos@fornecedor-real.com'), 'o fornecedor de verdade não pode receber no ensaio');
  assert.equal(enviados.length, 2, 'cliente e caixa de compras recebem normalmente');
  const rascunho = atividades(id, 'email_rascunho');
  assert.equal(rascunho.length, 1);
  assert.match(rascunho[0].message, /Pedido de compra NXT-PC-/);
  const aviso = store.find('notifications', n => n.lead_id === id && n.type === 'fluxo_rascunho');
  assert.match(aviso[0].message, /FLUXO_EMAIL_PERMITIDOS/);
  assert.match(atividades(id, 'fluxo').map(a => a.message).join('\n'), /RASCUNHO, não enviado — modo teste/);
});

test('fornecedor sem e-mail cadastrado: o pedido de compra fica em rascunho dizendo o porquê', async () => {
  const id = await pedidoPago('produto-sem-email');
  assert.equal(enviados.length, 2);
  const aviso = store.find('notifications', n => n.lead_id === id && n.type === 'fluxo_rascunho');
  assert.match(aviso[0].message, /Sem Email sem e-mail cadastrado/);
});

test('provedor recusa o envio: vira rascunho + alerta de falha, e os outros seguem', async () => {
  respostaDoProvedor = (m) => m.area === 'compras' ? { sent: false, status: 403, reason: 'ErrorAccessDenied' }
    : { sent: true, status: 202, id: 'ok-' + enviados.length };
  const id = await pedidoPago('teste-fluxo');
  assert.equal(enviados.length, 3, 'tentou os três');
  assert.equal(atividades(id, 'email_out').length, 2);
  const falha = store.find('notifications', n => n.lead_id === id && n.type === 'fluxo_falha_envio');
  assert.equal(falha.length, 1);
  assert.match(falha[0].message, /ErrorAccessDenied/);
  assert.match(atividades(id, 'fluxo').map(a => a.message).join('\n'), /Compras abriu.*RASCUNHO, não enviado — o envio falhou/);
});

test('webhook repetido não manda os e-mails de novo', async () => {
  const n = ++numPedido;
  const corpo = { title: `Pedido #${n}`, value: '100.00', protocol: `NXT-20260929-${n}REPE`,
    items: [{ productSlug: 'teste-fluxo', quantity: 1, name: 'x' }],
    customFields: { pedido_id: String(n), nome: 'Repetido', email: 'cliente.teste@exemplo.com', valor: 'R$ 1', itens: 'x',
      origem: 'nexxustech.ia.br/checkout' } };
  const req = () => handle({ method: 'POST', path: '/api/public/leads', headers: { 'x-intake-key': 'chave-de-teste' }, body: corpo });
  await req(); await api.aguardarDespachosDoFluxo();
  assert.equal(enviados.length, 3);
  await req(); await api.aguardarDespachosDoFluxo();
  assert.equal(enviados.length, 3, 'o Stripe repete o webhook; o cliente não pode receber dois avisos');
});

// ---- a volta: fabricante → compras → vendas → cliente ----

function codigoPC(id) { return docs.achar(id, 'PC').codigo; }

test('fabricante responde com a chave: compras avisa vendas, vendas entrega e o PV fecha', async () => {
  const id = await pedidoPago('teste-fluxo');
  const pc = codigoPC(id);
  enviados = [];
  const r = await emailEntrando('italo.fabricante@exemplo.com', `RE: Pedido de compra ${pc}`,
    `Segue a licença.\nChave de licença: ABCD-1234-EFGH-5678\n\n> Por favor, cite o número ${pc} na resposta`);
  assert.equal(r.body.data.fornecedor, true);
  assert.equal(r.body.data.conferido, true);

  assert.equal(enviados.length, 2);
  const [interno, entrega] = enviados;
  assert.equal(interno.to, 'veridiana.vendas@nexxus.ia.br');
  assert.equal(interno.area, 'compras');
  assert.doesNotMatch(interno.html, /ABCD-1234/, 'a chave não passa pelo e-mail interno');

  assert.equal(entrega.to, 'cliente.teste@exemplo.com');
  assert.equal(entrega.area, 'vendas');
  assert.match(entrega.html, /ABCD-1234-EFGH-5678/);
  assert.match(entrega.html, /https:\/\/nexxustech\.ia\.br\/books\/teste\.pdf/);

  assert.equal(docs.achar(id, 'PC').status, docs.FECHADO);
  assert.equal(docs.achar(id, 'PV').status, docs.FECHADO, 'chave + book + id do provedor = pedido entregue');
  // O e-mail do fabricante (email_in) fica como veio — é o registro original. O que o CRM
  // escreve por conta própria é que não pode repetir a chave.
  const tudo = store.find('activities', a => a.lead_id === id && a.type !== 'email_in')
    .map(a => a.message + (a.email_body || '')).join('\n');
  assert.doesNotMatch(tudo, /ABCD-1234-EFGH-5678/, 'a chave não fica repetida no histórico');
  const fila = JSON.stringify(store.find('fluxo_envios', r => r.lead_id === id));
  assert.doesNotMatch(fila, /ABCD-1234-EFGH-5678/, 'nem na fila de e-mails');
  assert.match(tudo, /Vendas entregou chave e book/);
});

test('produto sem book: a entrega é segurada (rascunho) até o book ser cadastrado; o reenvio entrega e fecha', async () => {
  const id = await pedidoPago('teste-sem-book');
  const pc = codigoPC(id);
  enviados = [];
  await emailEntrando('italo.fabricante@exemplo.com', `RE: ${pc}`, 'Chave de licença: ZZZZ-9999-YYYY');
  assert.equal(enviados.length, 1, 'só o interno compras → vendas sai');
  assert.ok(!enviados.some(e => /ZZZZ-9999/.test(e.html)));
  assert.equal(docs.achar(id, 'PV').status, docs.ABERTO);
  const aviso = store.find('notifications', n => n.lead_id === id && n.type === 'fluxo_rascunho');
  assert.match(aviso[aviso.length - 1].message, /sem o link do book/);

  // Cadastra o book e manda reenviar: agora a chave vai e o PV fecha.
  const prod = store.findOne('products', p => p.sku === 'teste-sem-book');
  assert.equal((await patch(admin, `/api/products/${prod.id}`, { book_url: 'https://exemplo.com/book.pdf' })).status, 200);
  enviados = [];
  const r = await handle({ method: 'POST', path: `/api/leads/${id}/fluxo/reenviar`, user: admin, body: {}, headers: {}, query: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.reenviados, 1);
  assert.equal(enviados.length, 1);
  assert.match(enviados[0].html, /ZZZZ-9999-YYYY/);
  assert.match(enviados[0].html, /exemplo\.com\/book\.pdf/);
  assert.equal(docs.achar(id, 'PV').status, docs.FECHADO);
});

test('reenviar é só do admin e não repete o que já saiu', async () => {
  const id = await pedidoPago('teste-fluxo');
  if (vendedor) {
    const negado = await handle({ method: 'POST', path: `/api/leads/${id}/fluxo/reenviar`, user: vendedor, body: {}, headers: {}, query: {} });
    assert.equal(negado.status, 403);
  }
  enviados = [];
  const r = await handle({ method: 'POST', path: `/api/leads/${id}/fluxo/reenviar`, user: admin, body: {}, headers: {}, query: {} });
  assert.equal(r.body.data.reenviados, 0);
  assert.equal(enviados.length, 0);
});

test('resposta do fornecedor sem autenticação aprovada não fecha nada', async () => {
  const id = await pedidoPago('teste-fluxo');
  const pc = codigoPC(id);
  enviados = [];
  // Forjado: sem carimbo, e com um "dmarc=pass" escrito pelo próprio remetente ABAIXO do
  // carimbo real (que diz fail). Vale o primeiro, o do nosso servidor.
  const forjado = [
    { name: 'Authentication-Results', value: 'spf=softfail; dkim=none; dmarc=fail action=none header.from=exemplo.com' },
    { name: 'Authentication-Results', value: 'dmarc=pass' },
  ];
  const r = await emailEntrando('italo.fabricante@exemplo.com', `RE: ${pc}`, 'Chave de licença: FAKE-0000-1111', forjado);
  assert.equal(r.body.data.conferido, false);
  assert.equal(docs.achar(id, 'PC').status, docs.ABERTO);
  assert.equal(enviados.length, 0);
  const sem = await emailEntrando('italo.fabricante@exemplo.com', `RE: ${pc}`, 'Chave de licença: FAKE-0000-1111', []);
  assert.equal(sem.body.data.conferido, false);
  assert.equal(store.find('notifications', n => n.lead_id === id && n.type === 'fluxo_remetente').length, 2);
});

test('fatura antes da chave não é divergência: abre o FIN e espera', async () => {
  const id = await pedidoPago('teste-fluxo');
  const pc = codigoPC(id);
  enviados = [];
  await emailEntrando('italo.fabricante@exemplo.com', `Fatura ${pc}`, 'Segue a fatura referente ao pedido.');
  assert.equal(enviados.length, 0);
  assert.equal(docs.achar(id, 'PC').status, docs.ABERTO);
  assert.equal(store.find('notifications', n => n.lead_id === id && n.type === 'fluxo_divergencia').length, 0);
  assert.ok(docs.achar(id, 'FIN'), 'o ciclo financeiro abriu');
});

test('servidor reiniciou no meio: "enviando" vira rascunho com aviso, "pendente" é retomado', async () => {
  const id = await pedidoPago('teste-fluxo');
  const [a, b] = fluxo.enfileirar(id, [
    { etapa: 'vendas_avisa', area: 'vendas', para: 'cliente.teste@exemplo.com', destino: 'cliente', assunto: 'A', corpo: 'a' },
    { etapa: 'vendas_avisa', area: 'vendas', para: 'cliente.teste@exemplo.com', destino: 'cliente', assunto: 'B', corpo: 'b' },
  ]);
  store.update('fluxo_envios', a.id, { status: 'enviando' });
  enviados = [];
  const n = api.retomarFluxoPendente();
  assert.ok(n >= 1);
  await api.aguardarDespachosDoFluxo();
  assert.equal(store.get('fluxo_envios', a.id).status, 'rascunho', 'pode ter saído: não reenvia às cegas');
  assert.equal(store.get('fluxo_envios', b.id).status, 'enviado');
  assert.deepEqual(enviados.map(e => e.subject), ['B']);
});

test('a entrega não sai: PV aberto, rascunho sem a chave e alerta', async () => {
  const id = await pedidoPago('teste-fluxo');
  const pc = codigoPC(id);
  respostaDoProvedor = (m) => m.area === 'vendas' ? { sent: false, status: 500, reason: 'caiu' } : { sent: true, status: 202, id: 'x' };
  await emailEntrando('italo.fabricante@exemplo.com', `RE: ${pc}`, 'Chave de licença: QQQQ-1111-WWWW');
  assert.equal(docs.achar(id, 'PV').status, docs.ABERTO);
  const rascunho = atividades(id, 'email_rascunho').map(a => a.message).join('\n');
  assert.match(rascunho, /Sua licença/);
  assert.doesNotMatch(rascunho, /QQQQ-1111-WWWW/);
  assert.equal(store.find('notifications', n => n.lead_id === id && n.type === 'fluxo_falha_envio').length, 1);
});

test('divergência na volta (sem chave) não manda nada ao cliente', async () => {
  const id = await pedidoPago('teste-fluxo');
  const pc = codigoPC(id);
  enviados = [];
  await emailEntrando('italo.fabricante@exemplo.com', `RE: ${pc}`, 'Recebemos o pedido, a chave sai amanhã.');
  assert.equal(enviados.length, 0);
  assert.equal(docs.achar(id, 'PC').status, docs.ABERTO);
});

// ---- as caixas conversando entre si ----

test('e-mail vindo de uma caixa nossa é ignorado: não vira lead nem resposta de fornecedor', async () => {
  const id = await pedidoPago('teste-fluxo');
  const pc = codigoPC(id);
  enviados = [];
  const antes = store.all('leads').length;
  const r = await emailEntrando('Veridiana | Vendas <veridiana.vendas@nexxus.ia.br>', `Pedido pago ${pc}`, 'Chave de licença: FALSA-0000-0000');
  assert.equal(r.status, 200);
  assert.equal(store.all('leads').length, antes);
  assert.equal(docs.achar(id, 'PC').status, docs.ABERTO, 'a caixa de vendas não fecha pedido de compra');
  assert.equal(enviados.length, 0);
});

// ---- cadastro do e-mail do fornecedor ----

function patch(user, p, body) { return handle({ method: 'PATCH', path: p, user, body, headers: {}, query: {} }); }

test('só o admin cadastra e muda o e-mail do fornecedor, e e-mail inválido é recusado', async () => {
  if (vendedor) {
    const r = await handle({ method: 'POST', path: '/api/suppliers', user: vendedor, body: { name: 'X', email: 'x@x.com' }, headers: {}, query: {} });
    assert.equal(r.status, 403);
  }
  const sup = store.insert('suppliers', { name: 'Novo', currency: 'USD' });
  if (vendedor) assert.equal((await patch(vendedor, `/api/suppliers/${sup.id}`, { email: 'a@b.com' })).status, 403);
  assert.equal((await patch(admin, `/api/suppliers/${sup.id}`, { email: 'não é email' })).status, 400);
  const ok = await patch(admin, `/api/suppliers/${sup.id}`, { email: ' Pedidos@Novo.com ' });
  assert.equal(ok.status, 200);
  assert.equal(store.get('suppliers', sup.id).email, 'pedidos@novo.com');
});

test('o link do book no produto só aceita https', async () => {
  assert.equal((await patch(admin, `/api/products/${prodComBook.id}`, { book_url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await patch(admin, `/api/products/${prodComBook.id}`, { book_url: 'https://exemplo.com/b.pdf' })).status, 200);
  assert.equal(store.get('products', prodComBook.id).book_url, 'https://exemplo.com/b.pdf');
});
