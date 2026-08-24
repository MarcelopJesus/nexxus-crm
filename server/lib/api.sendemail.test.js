// Reenvio de e-mail da proposta. Roda em processo (sem subir servidor) com o mailer
// stubado: só assim o caminho "e-mail enviado de verdade" é exercitado sem tocar em rede.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB_FILE = path.join('/tmp', `nexxus-sendemail-${process.pid}.json`);
process.env.DB_FILE = DB_FILE;
process.env.EMAIL_API_KEY = 'chave-de-teste';
process.env.EMAIL_FROM = 'Nexxus CRM <crm@example.com>';

// Stub do mailer antes de carregar a api.js (que o captura no require).
const mailerPath = require.resolve('./mailer');
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: { sendEmail: async () => ({ sent: true, status: 200 }), isConfigured: () => true },
};

const store = require('./store');
const { seedIfEmpty } = require('./seed');
const { handle } = require('./api');

seedIfEmpty();
const admin = store.findOne('users', u => u.role === 'admin');
const user = { id: admin.id, email: admin.email, area: admin.area, role: admin.role };

const call = (method, path, body, opts = {}) =>
  handle(Object.assign({ method, path, body: body || {}, user, query: {}, headers: { host: 'localhost:3001' } }, opts));

async function propostaEnviada(titulo, price) {
  const lead = await call('POST', '/api/leads', { title: titulo });
  const leadId = lead.body.data.id;
  const prop = await call('POST', '/api/proposals', { lead_id: leadId, final_price: price });
  assert.equal(prop.status, 201);
  return prop.body.data;
}

// O store grava com debounce (15 ms): esperar antes de apagar, senão o arquivo renasce.
after(async () => {
  await new Promise(resolve => setTimeout(resolve, 60));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

test('reenvio de e-mail preserva proposta recusada', async () => {
  const prop = await propostaEnviada('Reenvio — recusada', 10000);
  await call('POST', `/api/public/proposals/${prop.token}/reject`, { reason: 'Fora do orçamento' }, { user: null });
  assert.equal(store.get('proposals', prop.id).status, 'rejected');

  const envio = await call('POST', `/api/proposals/${prop.id}/send-email`, { to: 'cliente@example.com' });
  assert.equal(envio.status, 200);
  assert.equal(envio.body.data.email.sent, true, 'o stub confirma que o caminho de envio rodou');
  assert.equal(store.get('proposals', prop.id).status, 'rejected', 'reenvio não ressuscita a proposta recusada');
});

test('reenvio de e-mail preserva proposta aceita', async () => {
  const prop = await propostaEnviada('Reenvio — aceita', 12000);
  await call('POST', `/api/public/proposals/${prop.token}/accept`, {}, { user: null });
  assert.equal(store.get('proposals', prop.id).status, 'accepted');

  await call('POST', `/api/proposals/${prop.id}/send-email`, { to: 'cliente@example.com' });
  assert.equal(store.get('proposals', prop.id).status, 'accepted');
});

test('reenvio de proposta pendente volta para enviada', async () => {
  const prop = await propostaEnviada('Reenvio — pendente', 14000);
  await call('GET', `/api/public/proposals/${prop.token}`, null, { user: null, method: 'GET' });
  assert.equal(store.get('proposals', prop.id).status, 'viewed');

  await call('POST', `/api/proposals/${prop.id}/send-email`, { to: 'cliente@example.com' });
  assert.equal(store.get('proposals', prop.id).status, 'sent');
});
