const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { rm } = require('node:fs/promises');
const path = require('node:path');

const PORT = 3199;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join('/tmp', `nexxus-idempotency-${process.pid}.json`);
const INTAKE_KEY = 'idempotency-test-key';

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Servidor de teste não iniciou no prazo esperado');
}

test('reutiliza o lead existente quando o protocolo é reenviado', async t => {
  await rm(DB_FILE, { force: true });

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DB_FILE,
      INTAKE_KEY,
      JWT_SECRET: 'jwt-secret-for-idempotency-test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    server.kill('SIGTERM');
    await rm(DB_FILE, { force: true });
  });

  await waitForServer();

  const payload = {
    companyName: 'Empresa Idempotente',
    contactName: 'Contato Teste',
    email: 'idempotencia@example.com',
    message: 'Teste de reprocessamento seguro',
    protocol: 'NXT-TEST-IDEMPOTENT',
    origem: 'nexxustech.one/b2b',
  };

  const first = await fetch(`${BASE_URL}/api/public/leads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-intake-key': INTAKE_KEY,
    },
    body: JSON.stringify(payload),
  });
  const firstBody = await first.json();

  const second = await fetch(`${BASE_URL}/api/public/leads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-intake-key': INTAKE_KEY,
    },
    body: JSON.stringify(payload),
  });
  const secondBody = await second.json();

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(firstBody.data.id, secondBody.data.id);
  assert.equal(secondBody.data.deduplicated, true);
});
