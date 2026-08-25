// Limites da porta de entrada HTTP. Estes só se provam com o server.js de verdade no ar:
// os testes de rota chamam handle() direto e pulam a leitura do corpo.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const PORTA = 3391;
const BASE = 'http://127.0.0.1:' + PORTA;
const DB_FILE = path.join('/tmp', `nexxus-http-${process.pid}.json`);
let servidor;

before(async () => {
  servidor = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORTA), DB_FILE, HOST: '127.0.0.1',
      AGENT_AUTOPILOT: 'off', EMAIL_WEBHOOK_SECRET: 'whsec_' + Buffer.from('segredo').toString('base64'),
      EMAIL_INBOUND_ADDRESS: 'patricia@nexxustech.ia.br',
    }),
    stdio: 'ignore',
  });
  // Espera o /healthz responder.
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.ok) return; } catch (e) { /* ainda subindo */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('o servidor não subiu a tempo');
});

after(async () => {
  if (servidor) servidor.kill();
  await new Promise(r => setTimeout(r, 100));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

const postar = (caminho, corpo, headers) => fetch(BASE + caminho, {
  method: 'POST',
  headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
  body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
});

test('corpo acima de 1 MB numa rota pública é recusado com 413', async () => {
  const gigante = JSON.stringify({ type: 'email.received', data: { text: 'x'.repeat(1.5 * 1024 * 1024) } });
  const r = await postar('/api/public/email/inbound', gigante, {
    'svix-id': 'msg_grande', 'svix-timestamp': String(Math.floor(Date.now() / 1000)), 'svix-signature': 'v1,x',
  });
  assert.equal(r.status, 413);
  const j = await r.json();
  assert.match(j.error.message, /grande demais/);
});

test('corpo dentro do limite passa da leitura (chega a validar assinatura)', async () => {
  const r = await postar('/api/public/email/inbound', { type: 'email.received', data: {} }, {
    'svix-id': 'msg_pequeno', 'svix-timestamp': String(Math.floor(Date.now() / 1000)), 'svix-signature': 'v1,assinatura-errada',
  });
  assert.equal(r.status, 401, 'passou do tamanho e morreu na assinatura, que é o esperado');
});

test('webhook sem Content-Type application/json é recusado com 415', async () => {
  const r = await postar('/api/public/email/inbound', 'texto solto', {
    'Content-Type': 'text/plain',
    'svix-id': 'msg_ct', 'svix-timestamp': String(Math.floor(Date.now() / 1000)), 'svix-signature': 'v1,x',
  });
  assert.equal(r.status, 415);
});

test('o intake do site (/api/public/leads) não foi afetado pela regra de Content-Type', async () => {
  const r = await postar('/api/public/leads', { companyName: 'X' }, { 'x-intake-key': 'chave-errada' });
  assert.equal(r.status, 401, 'chega na validação da chave, não é barrado antes');
});

test('servidor continua de pé e respondendo depois de tudo isso', async () => {
  const r = await fetch(BASE + '/healthz');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});
