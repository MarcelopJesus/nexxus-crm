// M30 — três níveis de preço e desconto resolvido sem BDR.
//
// Ítalo, 02/09: "o BDR é pra parar e pensar; desconto eu não preciso parar pra pensar."
// Isto DESFAZ o caminho que estava em produção (lead #20, 25/08): pedido de desconto
// deixa de subir para a fila do BDR e vira três respostas prontas, uma por nível de
// preço, com um humano escolhendo qual mandar neste primeiro momento.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB_FILE = path.join('/tmp', `nexxus-m30-${process.pid}.json`);
process.env.DB_FILE = DB_FILE;
process.env.EMAIL_API_KEY = 'chave-de-teste';
process.env.EMAIL_FROM = 'Patricia <patricia@example.com>';

let resultadoDoEnvio = { sent: true, status: 200, id: 'msg-1' };
const enviados = [];
const mailerPath = require.resolve('./mailer');
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: { sendEmail: async (m) => { enviados.push(m); return resultadoDoEnvio; },
    isConfigured: () => true, HEADERS_AUTOMATICO: {} },
};

const store = require('./store');
const { seedIfEmpty } = require('./seed');
const api = require('./api');
const { calculatePricing } = require('./pricing');

seedIfEmpty();
const admin = store.findOne('users', u => u.role === 'admin');
const user = { id: admin.id, email: admin.email, area: admin.area, role: admin.role };
const call = (method, p, body) => api.handle({ method, path:p, body: body||{}, user, query:{}, headers:{ host:'localhost:3001' } });

after(async () => {
  await new Promise(r => setTimeout(r, 60));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

async function leadPrecificado(titulo) {
  const acc = await call('POST', '/api/accounts', { name: titulo });
  const ct = await call('POST', '/api/contacts', { account_id: acc.body.data.id, name:'Contato', email:'cliente@example.com' });
  const lead = await call('POST', '/api/leads', { title: titulo, account_id: acc.body.data.id, contact_id: ct.body.data.id });
  const leadId = lead.body.data.id;
  const q = await call('POST', '/api/quotes', { lead_id: leadId, cost_amount: 1000, cost_currency:'USD', qty: 1 });
  await call('POST', '/api/pricing', { lead_id: leadId, quote_id: q.body.data.id, cost_usd: 1000, qty: 1 });
  return leadId;
}
const precos = (leadId) => store.find('pricings', p => p.lead_id === leadId).sort((a,b)=>b.id-a.id)[0];

test('a precificação passa a ter três níveis, e o aceitável fica entre sugerido e piso', async () => {
  const leadId = await leadPrecificado('Três níveis');
  const p = precos(leadId);
  assert.ok(p.suggested_price > p.acceptable_price, 'sugerido é o maior');
  assert.ok(p.acceptable_price > p.min_price, 'piso é o menor');
});

test('a margem aceitável é configurável e muda o preço do meio', async () => {
  const antes = calculatePricing({ costUsd:1000, qty:1, fxBase:5, fxSpreadPct:0.04,
    importTaxPct:0.15, invoiceTaxPct:0.10, targetMarginPct:0.20, okMarginPct:0.15, minMarginPct:0.10 });
  const depois = calculatePricing({ costUsd:1000, qty:1, fxBase:5, fxSpreadPct:0.04,
    importTaxPct:0.15, invoiceTaxPct:0.10, targetMarginPct:0.20, okMarginPct:0.18, minMarginPct:0.10 });
  assert.ok(depois.acceptablePrice > antes.acceptablePrice, 'margem aceitável maior, preço aceitável maior');
  assert.equal(depois.suggestedPrice, antes.suggestedPrice, 'os outros dois níveis não se mexem');
  assert.equal(depois.minPrice, antes.minPrice);
});

test('instalação sem a margem aceitável não fica sem o nível do meio', () => {
  const r = calculatePricing({ costUsd:1000, qty:1, fxBase:5, fxSpreadPct:0.04,
    importTaxPct:0.15, invoiceTaxPct:0.10, targetMarginPct:0.20, minMarginPct:0.10 });
  assert.ok(r.acceptablePrice > r.minPrice && r.acceptablePrice < r.suggestedPrice);
});

test('pendência de desconto NÃO manda o lead para a fila do BDR', async () => {
  const leadId = await leadPrecificado('Sem BDR');
  const p = precos(leadId);
  api.abrirPendenciaDeEmail(leadId, 'Cliente pediu 20% de desconto.', [
    { nivel:'Preço sugerido', price:p.suggested_price, subject:'Sobre sua proposta', body:'Mantemos a condição.' },
    { nivel:'Preço aceitável', price:p.acceptable_price, subject:'Sobre sua proposta', body:'Consigo ajustar assim.' },
    { nivel:'Piso', price:p.min_price, subject:'Sobre sua proposta', body:'É o nosso limite.' },
  ]);
  const lead = store.get('leads', leadId);
  assert.equal(lead.needs_bdr, undefined, 'desconto não é caso de BDR');
  assert.equal(lead.email_pending_options.length, 3);
  assert.ok(store.find('notifications', n => n.type === 'email_pendente' && n.lead_id === leadId).length,
    'o vendedor precisa ver o indicador de e-mail pendente');
});

test('a resposta escolhida vira proposta V2 e vai no mesmo e-mail', async () => {
  resultadoDoEnvio = { sent: true, status: 200, id: 'msg-v2' };
  const leadId = await leadPrecificado('Vira V2');
  const p = precos(leadId);
  await call('POST', '/api/proposals', { lead_id: leadId, final_price: p.suggested_price });
  const antes = enviados.length;

  api.abrirPendenciaDeEmail(leadId, 'Cliente achou caro.', [
    { nivel:'Preço sugerido', price:p.suggested_price, subject:'S', body:'Mantemos.' },
    { nivel:'Preço aceitável', price:p.acceptable_price, subject:'Nova condição', body:'Consigo fechar nesta condição:' },
  ]);
  const r = await call('POST', `/api/leads/${leadId}/negociacao/responder`, { indice: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.sent, true);

  const props = store.find('proposals', x => x.lead_id === leadId).sort((a,b)=>a.version-b.version);
  assert.equal(props.length, 2, 'preço novo gera proposta V2, não e-mail avulso');
  assert.equal(props[1].final_price, p.acceptable_price);
  assert.equal(props[1].status, 'sent', 'o e-mail saiu, então a V2 está enviada');
  assert.equal(enviados.length, antes + 1);
  assert.match(enviados[enviados.length-1].html, /Consigo fechar nesta condição/, 'o texto escolhido é o corpo do e-mail');
  assert.equal(store.get('leads', leadId).email_pending_options.length, 0, 'a pendência se fecha ao responder');
});

test('e-mail que não sai não altera nada — a pendência continua lá', async () => {
  const leadId = await leadPrecificado('Envio falho');
  const p = precos(leadId);
  api.abrirPendenciaDeEmail(leadId, 'Cliente pediu desconto.', [
    { nivel:'Piso', price:p.min_price, subject:'S', body:'É o limite.' },
  ]);
  resultadoDoEnvio = { sent: false, status: 502, reason: 'provedor fora do ar' };
  const r = await call('POST', `/api/leads/${leadId}/negociacao/responder`, { indice: 0 });
  resultadoDoEnvio = { sent: true, status: 200, id: 'msg-ok' };

  assert.ok(r.body.data.send_failed);
  const props = store.find('proposals', x => x.lead_id === leadId);
  assert.equal(props[0].status, 'draft', 'a V2 fica em rascunho — o cliente não recebeu');
  assert.equal(store.get('leads', leadId).email_pending_options.length, 1, 'a pendência continua para o vendedor tentar de novo');
});

test('o vendedor pode editar o texto antes de mandar', async () => {
  const leadId = await leadPrecificado('Texto editado');
  api.abrirPendenciaDeEmail(leadId, 'Cliente pediu desconto.', [
    { nivel:'Preço sugerido', price:null, subject:'S', body:'Texto original da IA.' },
  ]);
  const antes = enviados.length;
  await call('POST', `/api/leads/${leadId}/negociacao/responder`, { indice: 0, texto: 'Texto que o vendedor reescreveu.' });
  assert.equal(enviados.length, antes + 1);
  assert.match(enviados[enviados.length-1].html, /reescreveu/);
});

test('descartar limpa a pendência sem mandar nada', async () => {
  const leadId = await leadPrecificado('Descartada');
  api.abrirPendenciaDeEmail(leadId, 'x', [{ nivel:'Piso', price:null, subject:'S', body:'b' }]);
  const antes = enviados.length;
  await call('POST', `/api/leads/${leadId}/negociacao/descartar`, {});
  assert.equal(store.get('leads', leadId).email_pending_options.length, 0);
  assert.equal(enviados.length, antes, 'descartar não manda e-mail');
});
