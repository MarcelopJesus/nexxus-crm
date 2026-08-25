// llm.js — JWT do Service Account e cache do access token.
// A Service Account REAL nunca entra aqui: o par de chaves é gerado na hora e o fetch
// do Google é stubado.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const llm = require('./llm');

// Par RSA de mentira, só para assinar e conferir a assinatura dentro do teste.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA_FAKE = {
  type: 'service_account',
  project_id: 'projeto-de-teste',
  client_email: 'robo@projeto-de-teste.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
};

function b64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

const fetchOriginal = global.fetch;
beforeEach(() => {
  llm._resetTokenCache();
  global.fetch = fetchOriginal;
  delete process.env.GOOGLE_VERTEX_SA;
  delete process.env.LLM_PROVIDER;
  delete process.env.LLM_MODEL;
  delete process.env.SDR_MODEL; // senão o ambiente da máquina muda o resultado
});

test('buildJwt monta um JWT RS256 válido com as claims que o Google espera', () => {
  const agora = 1770000000;
  const jwt = llm.buildJwt(SA_FAKE, agora);
  const partes = jwt.split('.');
  assert.equal(partes.length, 3, 'header.payload.assinatura');

  const header = JSON.parse(b64urlDecode(partes[0]));
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });

  const claims = JSON.parse(b64urlDecode(partes[1]));
  assert.equal(claims.iss, SA_FAKE.client_email);
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/cloud-platform');
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.iat, agora);
  assert.equal(claims.exp, agora + 3600, 'expira em 1h, como manda o fluxo jwt-bearer');

  // A assinatura tem que fechar com a chave pública do par.
  const assinatura = Buffer.from(partes[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(partes[0] + '.' + partes[1]), publicKey, assinatura);
  assert.equal(ok, true, 'assinatura confere com a chave pública');
  assert.ok(!/[+/=]/.test(partes[2]), 'base64url: sem +, / ou = ');
});

test('o access token é buscado uma vez e reaproveitado do cache', async () => {
  process.env.LLM_PROVIDER = 'vertex';
  process.env.GOOGLE_VERTEX_SA = JSON.stringify(SA_FAKE);
  let chamadas = 0;
  global.fetch = async (url, opts) => {
    chamadas++;
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.match(opts.body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
    assert.match(opts.body, /assertion=/);
    return { ok: true, json: async () => ({ access_token: 'token-abc', expires_in: 3600 }) };
  };

  assert.equal(await llm.vertexToken(), 'token-abc');
  assert.equal(await llm.vertexToken(), 'token-abc');
  assert.equal(await llm.vertexToken(), 'token-abc');
  assert.equal(chamadas, 1, 'três pedidos, uma ida só ao Google');

  llm._resetTokenCache();
  assert.equal(await llm.vertexToken(), 'token-abc');
  assert.equal(chamadas, 2, 'cache limpo volta a buscar');
});

test('rotacionar a chave privada da SA invalida o token em cache', async () => {
  process.env.LLM_PROVIDER = 'vertex';
  process.env.GOOGLE_VERTEX_SA = JSON.stringify(SA_FAKE);
  let n = 0;
  global.fetch = async () => ({ ok: true, json: async () => ({ access_token: 'token-' + (++n) }) });

  assert.equal(await llm.vertexToken(), 'token-1');
  assert.equal(await llm.vertexToken(), 'token-1', 'mesma SA usa o cache');

  // Mesma conta, chave nova (rotação): o token velho não vale mais.
  const outraChave = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  process.env.GOOGLE_VERTEX_SA = JSON.stringify(Object.assign({}, SA_FAKE, {
    private_key: outraChave.export({ type: 'pkcs8', format: 'pem' }),
  }));
  assert.equal(await llm.vertexToken(), 'token-2', 'SA diferente, token novo');
});

test('erro do Google vira mensagem legível em vez de token vazio', async () => {
  process.env.LLM_PROVIDER = 'vertex';
  process.env.GOOGLE_VERTEX_SA = JSON.stringify(SA_FAKE);
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error_description: 'Invalid JWT Signature.' }) });
  await assert.rejects(() => llm.vertexToken(), /Invalid JWT Signature/);
});

test('sem GOOGLE_VERTEX_SA o provider vertex fica desconfigurado (não estoura)', () => {
  process.env.LLM_PROVIDER = 'vertex';
  assert.equal(llm.isConfigured(), false);
  process.env.GOOGLE_VERTEX_SA = '{ isso não é json';
  assert.equal(llm.isConfigured(), false, 'JSON quebrado não derruba o servidor');
  process.env.GOOGLE_VERTEX_SA = JSON.stringify(SA_FAKE);
  assert.equal(llm.isConfigured(), true);
});

test('SA em base64 também é aceita (painel de deploy que come quebra de linha)', () => {
  process.env.LLM_PROVIDER = 'vertex';
  process.env.GOOGLE_VERTEX_SA = Buffer.from(JSON.stringify(SA_FAKE)).toString('base64');
  assert.equal(llm.isConfigured(), true);
});

test('modelo default por provider, com LLM_MODEL mandando quando existe', () => {
  assert.equal(llm.model(), 'gpt-5-mini', 'openai é o default');
  process.env.LLM_PROVIDER = 'vertex';
  assert.equal(llm.model(), 'google/gemini-3.7-flash');
  process.env.LLM_MODEL = 'google/gemini-3.7-pro';
  assert.equal(llm.model(), 'google/gemini-3.7-pro');
});

test('extractContent lê message.content e ignora o thought_signature do Vertex', () => {
  const respostaVertex = {
    choices: [{ message: {
      role: 'assistant',
      content: '{"decision":"advance"}',
      extra_content: { google: { thought_signature: 'CiQAd3...==' } },
    } }],
  };
  assert.equal(llm.extractContent(respostaVertex), '{"decision":"advance"}');
  assert.deepEqual(llm.parseJson(llm.extractContent(respostaVertex)), { decision: 'advance' });
  assert.equal(llm.extractContent({ choices: [] }), null);
});

test('parseJson aguenta a resposta embrulhada em cerca de markdown', () => {
  assert.deepEqual(llm.parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(llm.parseJson('  {"a":2}  '), { a: 2 });
});

// ====================================================================
// Validação local — nem "strict" garante contrato no modo json_object
// ====================================================================
const SCHEMA_DECISAO = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['advance', 'escalate'] },
    confidence: { type: 'integer' },
    options: { type: 'array', items: { type: 'string' } },
  },
  required: ['decision', 'confidence', 'options'],
  additionalProperties: false,
};

test('validador aceita o objeto certo', () => {
  assert.equal(llm.validaContra(SCHEMA_DECISAO, { decision: 'advance', confidence: 90, options: ['a'] }), null);
});

test('validador pega campo obrigatório faltando', () => {
  const err = llm.validaContra(SCHEMA_DECISAO, { decision: 'advance', options: [] });
  assert.match(err, /confidence/);
});

test('validador pega enum inventado — o risco real do modo json_object', () => {
  const err = llm.validaContra(SCHEMA_DECISAO, { decision: 'aprovar_desconto', confidence: 90, options: [] });
  assert.match(err, /fora dos valores aceitos/);
});

test('validador pega tipo errado, inclusive dentro de lista', () => {
  assert.match(llm.validaContra(SCHEMA_DECISAO, { decision: 'advance', confidence: '90', options: [] }), /inteiro/);
  assert.match(llm.validaContra(SCHEMA_DECISAO, { decision: 'advance', confidence: 9.5, options: [] }), /inteiro/);
  assert.match(llm.validaContra(SCHEMA_DECISAO, { decision: 'advance', confidence: 90, options: 'a' }), /lista/);
  assert.match(llm.validaContra(SCHEMA_DECISAO, { decision: 'advance', confidence: 90, options: [1] }), /options\[0\].*texto/);
});

test('extraiValidado junta parse e validação, e explica o que deu errado', () => {
  const resp = (txt) => ({ json: { choices: [{ message: { content: txt } }] } });
  assert.deepEqual(llm.extraiValidado(resp('{"decision":"advance","confidence":90,"options":[]}'), SCHEMA_DECISAO),
    { ok: true, valor: { decision: 'advance', confidence: 90, options: [] } });

  const cortado = llm.extraiValidado(resp('{"decision":"adv'), SCHEMA_DECISAO);
  assert.equal(cortado.ok, false);
  assert.match(cortado.erro, /JSON inválido/);

  const foraDoSchema = llm.extraiValidado(resp('{"decision":"talvez","confidence":90,"options":[]}'), SCHEMA_DECISAO);
  assert.equal(foraDoSchema.ok, false);
  assert.match(foraDoSchema.erro, /fora do schema/);

  assert.equal(llm.extraiValidado({ json: { choices: [] } }, SCHEMA_DECISAO).ok, false);
});

test('só 400 sobre formato rebaixa o modo — 400 por outro motivo, não', () => {
  assert.equal(llm.erroDeFormato({ error: { message: "Invalid value for 'response_format'" } }), true);
  assert.equal(llm.erroDeFormato({ error: { message: 'json_schema is not supported for this model' } }), true);
  assert.equal(llm.erroDeFormato({ error: { message: 'The input token count exceeds the maximum' } }), false);
  assert.equal(llm.erroDeFormato({ error: { message: 'Invalid temperature' } }), false);
  assert.equal(llm.erroDeFormato(null), false);
});

test('o modo estruturado é lembrado por MODELO, não globalmente', () => {
  process.env.LLM_PROVIDER = 'vertex';
  process.env.LLM_MODEL = 'google/gemini-3.7-flash';
  assert.equal(llm.vertexSchemaMode(), 'json_schema', 'default é o modo estrito');

  llm._setVertexSchemaMode(false, 'modelo-antigo');
  assert.equal(llm.vertexSchemaMode('modelo-antigo'), 'json_object', 'o modelo problemático foi rebaixado');
  assert.equal(llm.vertexSchemaMode('google/gemini-3.7-flash'), 'json_schema', 'e não levou os outros junto');

  llm._setVertexSchemaMode(true, 'modelo-antigo');
  assert.equal(llm.vertexSchemaMode('modelo-antigo'), 'json_schema');
});
