// M51 — boleto do Asaas no aceite da proposta B2B e aviso de pagamento.
// As regras que estes testes travam: aceite gera UM boleto de 7 dias (aceite repetido não
// gera outro); sem CNPJ nada sai e o humano é avisado; o aviso "pago" do Asaas abre o PV
// pelo mesmo trilho do pedido do site, uma vez só; webhook sem o token certo não entra.
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB_FILE = path.join('/tmp', `nexxus-cobranca-${process.pid}.json`);
process.env.DB_FILE = DB_FILE;
process.env.AGENT_AUTOPILOT = 'off';
delete process.env.FLUXO_POS_PAGAMENTO;
process.env.ASAAS_API_KEY = '$aact_hmlg_chave_de_teste';
process.env.ASAAS_AMBIENTE = 'sandbox';
process.env.ASAAS_WEBHOOK_TOKEN = 'token-do-webhook-de-teste';

let emails = [];
const mailerPath = require.resolve('./mailer');
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: { sendEmail: async (m) => { emails.push(m); return { sent: true, status: 200, id: 'msg-1' }; }, isConfigured: () => true,
    remetenteDe: () => 'veridiana.vendas@nexxus.ia.br', caixasConfiguradas: () => ({}), CAIXAS: {}, HEADERS_AUTOMATICO: {},
    encaminharPorGraph: async () => ({ sent: true }) },
};

// O Asaas de mentira: guarda cada chamada e responde como a API real.
let chamadas = [];
let falharPagamento = null;
let seqPagamento = 0;
let perderResposta = false;
let clienteExistente = null;
const boletosNoAsaas = new Map(); // externalReference -> pagamento
global.fetch = async (url, opts) => {
  const u = new URL(url);
  const corpo = opts && opts.body ? JSON.parse(opts.body) : null;
  chamadas.push({ metodo: opts.method, caminho: u.pathname + u.search, corpo, chave: opts.headers.access_token, host: u.host });
  const ok = (j) => ({ ok: true, status: 200, json: async () => j });
  if (u.pathname === '/v3/customers' && opts.method === 'GET') return ok({ data: clienteExistente ? [clienteExistente] : [] });
  if (u.pathname.startsWith('/v3/customers/')) return ok(Object.assign({}, clienteExistente, corpo));
  if (u.pathname === '/v3/customers') return ok({ id: 'cus_000001', name: corpo.name });
  if (u.pathname === '/v3/payments' && opts.method === 'GET') {
    const b = boletosNoAsaas.get(u.searchParams.get('externalReference'));
    return ok({ data: b ? [b] : [] });
  }
  if (u.pathname === '/v3/payments') {
    if (falharPagamento) return { ok: false, status: 400, json: async () => ({ errors: [{ description: falharPagamento }] }) };
    const pag = { id: 'pay_' + (++seqPagamento), status: 'PENDING', dueDate: corpo.dueDate, invoiceUrl: 'https://sandbox.asaas.com/i/abc', bankSlipUrl: 'https://sandbox.asaas.com/b/pdf/abc' };
    boletosNoAsaas.set(corpo.externalReference, pag);
    // O Asaas criou, mas a resposta não chegou (rede caiu no meio).
    if (perderResposta) throw new Error('fetch failed');
    return ok(pag);
  }
  throw new Error('rota inesperada no Asaas de teste: ' + u.pathname);
};

const store = require('./store');
const { seedIfEmpty } = require('./seed');
const docs = require('./documentos');
const cobranca = require('./cobranca');
const asaas = require('./asaas');
const api = require('./api');
const { handle } = api;

seedIfEmpty();
after(async () => { await new Promise(r => setTimeout(r, 60)); try { fs.unlinkSync(DB_FILE); } catch {} });
beforeEach(() => { chamadas = []; emails = []; falharPagamento = null; perderResposta = false; clienteExistente = null; delete process.env.FLUXO_POS_PAGAMENTO; });

let n = 0;
function negocioB2B({ cnpj = '11.222.333/0001-81', valor = 7213.9, semNumero = false } = {}) {
  n++;
  const conta = store.insert('accounts', { name: `Cliente B2B ${n}`, cnpj, segment: null, city: null });
  const ct = store.insert('contacts', { account_id: conta.id, name: 'Fulana', email: `compras${n}@cliente.com.br` });
  const lead = store.insert('leads', { title: `Cliente B2B ${n} — Ampler`, account_id: conta.id, contact_id: ct.id,
    source: 'site', stage: 'negociacao', status: 'open', estimated_value: valor, qty: 10, doc_seq: semNumero ? null : 500 + n,
    requested_software: 'Ampler', kind: 'b2b' });
  const token = require('crypto').randomBytes(16).toString('hex');
  const prop = store.insert('proposals', { lead_id: lead.id, version: 1, final_price: valor, status: 'sent', token });
  return { conta, lead, prop, token };
}
const aceitar = (token) => handle({ method: 'POST', path: `/api/public/proposals/${token}/accept`, headers: {}, body: {} });
const webhook = (body, token = 'token-do-webhook-de-teste') =>
  handle({ method: 'POST', path: '/api/webhooks/asaas', headers: { 'asaas-access-token': token }, body });
const atividades = (leadId, tipo) => store.find('activities', a => a.lead_id === leadId && (!tipo || a.type === tipo));

test('aceite da proposta gera um boleto de 7 dias no Asaas, no valor da proposta', async () => {
  const { lead, token } = negocioB2B();
  const r = await aceitar(token);
  assert.equal(r.status, 200);
  await api.aguardarDespachosDoFluxo();

  const pag = chamadas.find(c => c.caminho === '/v3/payments' && c.metodo === 'POST');
  assert.ok(pag, 'chamou o Asaas para criar o boleto');
  assert.equal(pag.host, 'api-sandbox.asaas.com');
  assert.equal(pag.corpo.billingType, 'BOLETO');
  assert.equal(pag.corpo.value, 7213.9);
  assert.equal(pag.corpo.dueDate, cobranca.vencimento(7));
  const cli = chamadas.find(c => c.caminho === '/v3/customers' && c.metodo === 'POST');
  assert.equal(cli.corpo.cpfCnpj, '11222333000181');
  assert.equal(cli.corpo.notificationDisabled, true, 'quem avisa o cliente é a Veridiana, não o Asaas');

  const cob = store.findOne('cobrancas', c => c.lead_id === lead.id);
  assert.equal(cob.status, 'pendente');
  assert.equal(cob.link, 'https://sandbox.asaas.com/i/abc');
  assert.equal(store.get('leads', lead.id).status, 'won');
  assert.ok(atividades(lead.id, 'cobranca').some(a => /SANDBOX/.test(a.message)), 'timeline diz que é sandbox');
});

test('com o fluxo desligado o e-mail do boleto vira rascunho — nada sai', async () => {
  const { lead, token } = negocioB2B();
  await aceitar(token); await api.aguardarDespachosDoFluxo();
  assert.equal(emails.length, 0);
  assert.ok(atividades(lead.id, 'email_rascunho').some(a => a.message.includes('https://sandbox.asaas.com/i/abc')));
});

test('modo teste: a Veridiana manda o link do boleto pela caixa de vendas', async () => {
  process.env.FLUXO_POS_PAGAMENTO = 'teste';
  process.env.FLUXO_EMAIL_PERMITIDOS = `compras${n + 1}@cliente.com.br`;
  const { lead, token } = negocioB2B();
  await aceitar(token); await api.aguardarDespachosDoFluxo();
  assert.equal(emails.length, 1);
  assert.equal(emails[0].area, 'vendas');
  assert.match(emails[0].subject, /NXT-OP/);
  assert.match(emails[0].html, /sandbox\.asaas\.com\/i\/abc/);
  assert.equal(atividades(lead.id, 'email_out').length, 1);
});

test('aceite repetido não gera segundo boleto', async () => {
  const { lead, token } = negocioB2B();
  await aceitar(token); await api.aguardarDespachosDoFluxo();
  await aceitar(token); await api.aguardarDespachosDoFluxo();
  assert.equal(chamadas.filter(c => c.caminho === '/v3/payments' && c.metodo === 'POST').length, 1);
  assert.equal(store.find('cobrancas', c => c.lead_id === lead.id).length, 1);
});

test('sem CNPJ não chama o Asaas e avisa; depois de cadastrar, o botão gera o boleto', async () => {
  const { conta, lead, token } = negocioB2B({ cnpj: null });
  await aceitar(token); await api.aguardarDespachosDoFluxo();
  assert.equal(chamadas.length, 0);
  assert.ok(store.find('notifications', x => x.lead_id === lead.id && x.type === 'cobranca_sem_cnpj').length);

  store.update('accounts', conta.id, { cnpj: '11.222.333/0001-81' });
  const r = await handle({ method: 'POST', path: `/api/leads/${lead.id}/cobranca`, user: { id: 1, area: 'admin' }, headers: {}, body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'pendente');
});

test('Asaas recusa: cobrança fica em erro com o motivo, e o botão tenta de novo', async () => {
  falharPagamento = 'O campo dueDate é inválido.';
  const { lead, token } = negocioB2B();
  await aceitar(token); await api.aguardarDespachosDoFluxo();
  const cob = store.findOne('cobrancas', c => c.lead_id === lead.id);
  assert.equal(cob.status, 'erro');
  assert.match(cob.erro, /dueDate/);
  assert.ok(store.find('notifications', x => x.lead_id === lead.id && x.type === 'cobranca_falha').length);

  falharPagamento = null;
  const r = await handle({ method: 'POST', path: `/api/leads/${lead.id}/cobranca`, user: { id: 1, area: 'admin' }, headers: {}, body: {} });
  assert.equal(r.body.data.status, 'pendente');
  assert.equal(store.find('cobrancas', c => c.lead_id === lead.id).length, 1, 'reaproveita a mesma cobrança');
});

test('webhook sem o token certo é recusado e não mexe em nada', async () => {
  const { lead, token } = negocioB2B();
  await aceitar(token); await api.aguardarDespachosDoFluxo();
  const cob = store.findOne('cobrancas', c => c.lead_id === lead.id);
  const r = await webhook({ id: 'evt_x', event: 'PAYMENT_RECEIVED', payment: { id: cob.asaas_id, value: cob.valor } }, 'errado');
  assert.equal(r.status, 401);
  assert.equal(store.get('cobrancas', cob.id).status, 'pendente');
});

test('boleto pago abre o PV pelo fluxo pós-pagamento — uma vez só, mesmo com aviso repetido', async () => {
  const { lead, token } = negocioB2B();
  await aceitar(token); await api.aguardarDespachosDoFluxo();
  const cob = store.findOne('cobrancas', c => c.lead_id === lead.id);

  const r1 = await webhook({ id: 'evt_conf_1', event: 'PAYMENT_CONFIRMED', payment: { id: cob.asaas_id, value: cob.valor } });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.data.pago, true);
  // O mesmo evento reenviado e o RECEIVED que vem depois do CONFIRMED:
  await webhook({ id: 'evt_conf_1', event: 'PAYMENT_CONFIRMED', payment: { id: cob.asaas_id } });
  const r3 = await webhook({ id: 'evt_rec_1', event: 'PAYMENT_RECEIVED', payment: { id: cob.asaas_id } });
  assert.equal(r3.body.data.repetido, true);
  await api.aguardarDespachosDoFluxo();

  assert.equal(store.get('cobrancas', cob.id).status, 'pago');
  assert.equal(docs.doTipo(lead.id, 'PV').length, 1, 'um PV, não três');
  assert.ok(store.get('leads', lead.id).doc_pago_em);
  assert.ok(atividades(lead.id, 'fluxo').some(a => /Pagamento confirmado/.test(a.message)));
});

test('evento de cobrança que não é nossa é ignorado com 200 (senão o Asaas pausa a fila)', async () => {
  const r = await webhook({ id: 'evt_alheio', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_de_outro_sistema' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.tratado, false);
});

test('boleto vencido avisa e marca a cobrança', async () => {
  const { lead, token } = negocioB2B();
  await aceitar(token); await api.aguardarDespachosDoFluxo();
  const cob = store.findOne('cobrancas', c => c.lead_id === lead.id);
  await webhook({ id: 'evt_venc_1', event: 'PAYMENT_OVERDUE', payment: { id: cob.asaas_id } });
  assert.equal(store.get('cobrancas', cob.id).status, 'vencido');
  assert.ok(store.find('notifications', x => x.lead_id === lead.id && x.type === 'cobranca_vencida').length);
});

test('freio de ambiente: chave de produção com ASAAS_AMBIENTE=sandbox (e vice-versa) não roda', () => {
  const antes = process.env.ASAAS_API_KEY;
  process.env.ASAAS_API_KEY = '$aact_prod_xyz';
  assert.match(asaas.motivoDesligado(), /PRODUÇÃO/);
  process.env.ASAAS_AMBIENTE = 'producao';
  assert.equal(asaas.motivoDesligado(), null);
  process.env.ASAAS_API_KEY = '$aact_hmlg_xyz';
  assert.match(asaas.motivoDesligado(), /SANDBOX/);
  process.env.ASAAS_AMBIENTE = 'sandbox';
  process.env.ASAAS_API_KEY = antes;
});

test('vencimento conta o dia de São Paulo, não o de UTC', () => {
  // 23h de 01/10 em Brasília já é 02/10 em UTC.
  assert.equal(cobranca.vencimento(7, new Date('2026-10-02T02:00:00Z')), '2026-10-08');
  assert.equal(cobranca.vencimento(7, new Date('2026-10-02T15:00:00Z')), '2026-10-09');
});

test('boleto criado mas resposta perdida: o "tentar de novo" reaproveita o boleto, não cria outro', async () => {
  perderResposta = true;
  const { lead, token } = negocioB2B();
  await aceitar(token); await api.aguardarDespachosDoFluxo();
  assert.equal(store.findOne('cobrancas', c => c.lead_id === lead.id).status, 'erro');

  perderResposta = false;
  const r = await handle({ method: 'POST', path: `/api/leads/${lead.id}/cobranca`, user: { id: 1, area: 'admin' }, headers: {}, body: {} });
  assert.equal(r.body.data.status, 'pendente');
  assert.equal(chamadas.filter(c => c.caminho === '/v3/payments' && c.metodo === 'POST').length, 1, 'um POST só no Asaas');
});

test('lead criado à mão, sem número NXT, ganha o número antes do boleto — e o PV abre no pagamento', async () => {
  const { lead, token } = negocioB2B({ semNumero: true });
  await aceitar(token); await api.aguardarDespachosDoFluxo();
  assert.ok(Number(store.get('leads', lead.id).doc_seq) > 0);
  const cob = store.findOne('cobrancas', c => c.lead_id === lead.id);
  const r = await webhook({ id: 'evt_semnum', event: 'PAYMENT_RECEIVED', payment: { id: cob.asaas_id } });
  assert.equal(r.status, 200);
  await api.aguardarDespachosDoFluxo();
  assert.equal(docs.doTipo(lead.id, 'PV').length, 1);
});

test('"pago" atrasado depois do estorno não reabre o pedido', async () => {
  const { lead, token } = negocioB2B();
  await aceitar(token); await api.aguardarDespachosDoFluxo();
  const cob = store.findOne('cobrancas', c => c.lead_id === lead.id);
  await webhook({ id: 'evt_est', event: 'PAYMENT_REFUNDED', payment: { id: cob.asaas_id } });
  const r = await webhook({ id: 'evt_tardio', event: 'PAYMENT_RECEIVED', payment: { id: cob.asaas_id } });
  assert.equal(r.body.data.ignorado, 'cancelada');
  assert.equal(store.get('cobrancas', cob.id).status, 'cancelado');
  assert.equal(docs.doTipo(lead.id, 'PV').length, 0);
});

test('se abrir o pedido falhar, a cobrança continua pendente e a retentativa do Asaas resolve', async () => {
  const { lead, token } = negocioB2B();
  await aceitar(token); await api.aguardarDespachosDoFluxo();
  const cob = store.findOne('cobrancas', c => c.lead_id === lead.id);
  const fluxo = require('./fluxoPedido');
  const original = fluxo.aoConfirmarPagamento;
  fluxo.aoConfirmarPagamento = () => { throw new Error('banco indisponível'); };
  const r1 = await webhook({ id: 'evt_falha', event: 'PAYMENT_RECEIVED', payment: { id: cob.asaas_id } });
  fluxo.aoConfirmarPagamento = original;
  assert.equal(r1.status, 500);
  assert.equal(store.get('cobrancas', cob.id).status, 'pendente');

  const r2 = await webhook({ id: 'evt_falha', event: 'PAYMENT_RECEIVED', payment: { id: cob.asaas_id } });
  assert.equal(r2.status, 200);
  assert.equal(store.get('cobrancas', cob.id).status, 'pago');
  await api.aguardarDespachosDoFluxo();
  assert.equal(docs.doTipo(lead.id, 'PV').length, 1);
});

test('cliente que já existia no Asaas com avisos ligados tem os avisos desligados antes do boleto', async () => {
  clienteExistente = { id: 'cus_antigo', name: 'Antigo', notificationDisabled: false };
  const { token } = negocioB2B();
  await aceitar(token); await api.aguardarDespachosDoFluxo();
  const upd = chamadas.find(c => c.caminho === '/v3/customers/cus_antigo');
  assert.ok(upd, 'atualizou o cliente');
  assert.equal(upd.corpo.notificationDisabled, true);
  assert.equal(chamadas.find(c => c.caminho === '/v3/payments' && c.metodo === 'POST').corpo.customer, 'cus_antigo');
});
