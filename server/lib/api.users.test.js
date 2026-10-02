// Login seguro: senha forte, usuário desativado perde o acesso na hora, troca de senha derruba sessões antigas.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { rm, readFile } = require('node:fs/promises');
const path = require('node:path');

const PORT = 3207;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join('/tmp', `nexxus-users-${process.pid}.json`);
let server = null;
let admin = null;

async function waitForServer() {
  for (let i = 0; i < 40; i += 1) {
    try { if ((await fetch(`${BASE_URL}/healthz`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Servidor de teste não iniciou no prazo esperado');
}
async function api(method, url, body, token) {
  const res = await fetch(BASE_URL + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const login = (email, password) => api('POST', '/api/auth/admin/login', { email, password });
const SENHA_BOA = 'cavalo-azul-bateria-grampo';

before(async () => {
  await rm(DB_FILE, { force: true });
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', DB_FILE, JWT_SECRET: 'jwt-users-test',
      SUPABASE_URL_CRM: '', SUPABASE_SERVICE_KEY_CRM: '', NODE_ENV: 'test' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer();
  admin = (await login('joao@nexxustech.one', 'senha123')).body.data.token;
});
after(async () => { if (server) server.kill('SIGTERM'); await rm(DB_FILE, { force: true }); });

test('criar usuário exige senha de 10+ caracteres e não aceita senha123', async () => {
  for (const password of [undefined, '', 'curta', 'senha123456', '1234567890']) {
    const r = await api('POST', '/api/users', { name: 'Fraca', email: 'fraca@nexxus.ia.br', password }, admin);
    assert.equal(r.status, 400, 'deveria recusar: ' + password);
  }
  const ok = await api('POST', '/api/users', { name: 'Sara', email: 'Sara@Nexxus.ia.br', password: SENHA_BOA, area: 'financeiro' }, admin);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.email, 'sara@nexxus.ia.br');
  const dup = await api('POST', '/api/users', { name: 'Sara 2', email: 'sara@nexxus.ia.br', password: SENHA_BOA }, admin);
  assert.equal(dup.status, 400, 'e-mail repetido');
});

test('só admin lista, cria e altera usuários', async () => {
  const carla = (await login('carla@nexxustech.one', 'senha123')).body.data.token;
  assert.equal((await api('GET', '/api/users', undefined, carla)).status, 403);
  assert.equal((await api('POST', '/api/users', { name: 'X', email: 'x@x.com', password: SENHA_BOA }, carla)).status, 403);
  assert.equal((await api('PATCH', '/api/users/1', { active: false }, carla)).status, 403);
});

test('desativar derruba o token na hora e bloqueia novo login', async () => {
  const marina = (await login('marina@nexxustech.one', 'senha123')).body.data.token;
  assert.equal((await api('GET', '/api/auth/me', undefined, marina)).status, 200);
  const lista = (await api('GET', '/api/users', undefined, admin)).body.data;
  const id = (lista.items || lista).find(u => u.email === 'marina@nexxustech.one').id;
  assert.equal((await api('PATCH', '/api/users/' + id, { active: false }, admin)).status, 200);
  assert.equal((await api('GET', '/api/auth/me', undefined, marina)).status, 401, 'token antigo morreu');
  assert.equal((await login('marina@nexxustech.one', 'senha123')).status, 401, 'não entra mais');
  assert.equal((await api('PATCH', '/api/users/' + id, { active: true }, admin)).status, 200);
  assert.equal((await login('marina@nexxustech.one', 'senha123')).status, 200, 'reativada volta a entrar');
});

test('admin não se desativa nem some o último admin', async () => {
  assert.equal((await api('PATCH', '/api/users/1', { active: false }, admin)).status, 400);
  assert.equal((await api('PATCH', '/api/users/1', { role: 'user' }, admin)).status, 400);
});

test('trocar a própria senha: confere a atual, derruba sessões antigas e devolve token novo', async () => {
  const t1 = (await login('felipe@nexxustech.one', 'senha123')).body.data.token;
  const t2 = (await login('felipe@nexxustech.one', 'senha123')).body.data.token;
  assert.equal((await api('POST', '/api/auth/password', { current: 'errada', password: SENHA_BOA }, t1)).status, 400);
  const r = await api('POST', '/api/auth/password', { current: 'senha123', password: SENHA_BOA }, t1);
  assert.equal(r.status, 200);
  assert.equal((await api('GET', '/api/auth/me', undefined, t2)).status, 401, 'a outra sessão caiu');
  assert.equal((await api('GET', '/api/auth/me', undefined, r.body.data.token)).status, 200, 'token novo vale');
  assert.equal((await login('felipe@nexxustech.one', 'senha123')).status, 401);
  assert.equal((await login('felipe@nexxustech.one', SENHA_BOA)).status, 200);
});

test('a tela de login não traz e-mail nem senha de exemplo', async () => {
  const raiz = path.resolve(__dirname, '..', '..', 'client', 'js');
  for (const f of ['app.js', 'template.js']) {
    const txt = await readFile(path.join(raiz, f), 'utf8');
    assert.ok(!txt.includes('senha123'), f + ' ainda cita senha123');
    assert.ok(!txt.includes('joao@nexxustech.one'), f + ' ainda cita o login de exemplo');
  }
});
