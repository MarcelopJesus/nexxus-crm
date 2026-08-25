// llm.js — camada única de chamada ao modelo de IA. Dois providers, escolhidos por
// LLM_PROVIDER:
//   openai (default) — OPENAI_API_BASE + OPENAI_API_KEY (Bearer estático).
//   vertex           — Vertex AI da Google no endpoint compatível com OpenAI. Autentica
//                      com Service Account (GOOGLE_VERTEX_SA = JSON inteiro da SA):
//                      assina um JWT RS256 e troca por access token OAuth (cache 55 min).
// Modelo: LLM_MODEL (default gpt-5-mini no openai, google/gemini-3.7-flash no vertex).
'use strict';
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_TTL_MS = 55 * 60 * 1000; // token vale 1h; renova aos 55 min

function provider() { return String(process.env.LLM_PROVIDER || 'openai').trim().toLowerCase(); }
function model() {
  if (process.env.LLM_MODEL) return process.env.LLM_MODEL;
  if (provider() === 'vertex') return 'google/gemini-3.7-flash';
  return process.env.SDR_MODEL || 'gpt-5-mini';
}

// ---------- Service Account ----------
// Aceita o JSON cru ou em base64 (alguns painéis de deploy não guardam quebra de linha).
function loadSA() {
  const raw = String(process.env.GOOGLE_VERTEX_SA || '').trim();
  if (!raw) throw new Error('GOOGLE_VERTEX_SA ausente — sem Service Account não há como falar com o Vertex.');
  let texto = raw;
  if (texto[0] !== '{') {
    try { texto = Buffer.from(raw, 'base64').toString('utf8'); } catch (e) { /* segue com o cru */ }
  }
  let sa;
  try { sa = JSON.parse(texto); } catch (e) { throw new Error('GOOGLE_VERTEX_SA não é JSON válido.'); }
  if (!sa.client_email || !sa.private_key || !sa.project_id)
    throw new Error('GOOGLE_VERTEX_SA incompleta — faltam client_email, private_key ou project_id.');
  // Chave colada em painel de env costuma vir com \n literal em vez de quebra de linha.
  if (sa.private_key.indexOf('\\n') >= 0) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  return sa;
}

function isConfigured() {
  if (provider() === 'vertex') { try { loadSA(); return true; } catch (e) { return false; } }
  return !!process.env.OPENAI_API_KEY;
}

// ---------- JWT RS256 em Node puro ----------
function b64url(v) {
  return Buffer.from(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function buildJwt(sa, nowSec) {
  const iat = nowSec || Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = { iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 };
  const unsigned = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claims));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key);
  return unsigned + '.' + b64url(sig);
}

const TOKEN_TIMEOUT_MS = 10000;

let tokenCache = { token: null, exp: 0, chave: null };
// Só para os testes: zera o cache entre casos.
function _resetTokenCache() { tokenCache = { token: null, exp: 0, chave: null }; }

// A chave do cache é o hash da SA INTEIRA, não só o client_email: trocar a chave privada
// (rotação) mantendo o mesmo e-mail precisa invalidar o token igual.
function impressaoSA(sa) {
  return crypto.createHash('sha256').update(JSON.stringify(sa)).digest('hex');
}

async function vertexToken() {
  const sa = loadSA();
  const agora = Date.now();
  const chave = impressaoSA(sa);
  if (tokenCache.token && tokenCache.exp > agora && tokenCache.chave === chave) return tokenCache.token;
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: buildJwt(sa),
  }).toString();
  // Sem timeout, um oauth2.googleapis.com pendurado seguraria a varredura inteira.
  const ac = new AbortController();
  const alarme = setTimeout(() => ac.abort(), TOKEN_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body, signal: ac.signal,
    });
  } catch (e) {
    throw new Error(e && e.name === 'AbortError'
      ? 'Timeout de ' + TOKEN_TIMEOUT_MS + 'ms ao autenticar no Google.'
      : 'Falha de rede ao autenticar no Google: ' + (e && e.message));
  } finally { clearTimeout(alarme); }
  let json = null;
  try { json = await res.json(); } catch (e) { /* resposta não-JSON vira erro abaixo */ }
  if (!res.ok || !json || !json.access_token)
    throw new Error('Falha ao autenticar no Google: ' + ((json && (json.error_description || json.error)) || ('HTTP ' + res.status)));
  tokenCache = { token: json.access_token, exp: agora + TOKEN_TTL_MS, chave };
  return tokenCache.token;
}

// ---------- transporte ----------
function postJson(urlStr, headers, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'http:' ? http : https;
    const body = JSON.stringify(payload);
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, headers),
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, json: null, raw: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 120000, () => { req.destroy(new Error('Timeout na chamada de IA.')); });
    req.write(body); req.end();
  });
}

// ---------- resposta ----------
// O Vertex devolve message.extra_content.google.thought_signature junto do texto:
// campo de raciocínio interno, ignorado de propósito — só message.content interessa.
function extractContent(json) {
  const ch = json && json.choices && json.choices[0];
  const msg = ch && ch.message;
  if (!msg) return null;
  if (typeof msg.content === 'string') return msg.content;
  // Alguns compat devolvem content como lista de partes.
  if (Array.isArray(msg.content)) return msg.content.map(p => (p && (p.text || p.content)) || '').join('');
  return null;
}
// Modelo em modo json_object às vezes embrulha em ```json … ```.
function parseJson(texto) {
  let s = String(texto || '').trim();
  if (s.startsWith('```')) s = s.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(s);
}

// ---------- validador local mínimo ----------
// Nem "strict" garante contrato: no modo json_object o schema é só texto no prompt, e o
// modelo pode devolver enum inventado ou campo faltando. Quem consome (o agente) toma
// decisão de negócio com isso, então a resposta é conferida AQUI, nos dois modos.
// Cobre o que os schemas do projeto usam: type, required, enum, properties, items.
function validaContra(schema, valor, caminho) {
  caminho = caminho || 'raiz';
  if (!schema || typeof schema !== 'object') return null;
  const t = schema.type;
  if (t === 'object') {
    if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return caminho + ' deveria ser objeto';
    for (const req of (schema.required || []))
      if (valor[req] === undefined) return caminho + ' sem o campo obrigatório "' + req + '"';
    for (const k of Object.keys(schema.properties || {})) {
      if (valor[k] === undefined) continue;
      const err = validaContra(schema.properties[k], valor[k], caminho + '.' + k);
      if (err) return err;
    }
    return null;
  }
  if (t === 'array') {
    if (!Array.isArray(valor)) return caminho + ' deveria ser lista';
    if (schema.items) {
      for (let i = 0; i < valor.length; i++) {
        const err = validaContra(schema.items, valor[i], caminho + '[' + i + ']');
        if (err) return err;
      }
    }
    return null;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(valor))
    return caminho + ' = ' + JSON.stringify(valor) + ' fora dos valores aceitos (' + schema.enum.join(', ') + ')';
  if (t === 'string' && typeof valor !== 'string') return caminho + ' deveria ser texto';
  if (t === 'integer' && !Number.isInteger(valor)) return caminho + ' deveria ser inteiro';
  if (t === 'number' && typeof valor !== 'number') return caminho + ' deveria ser número';
  if (t === 'boolean' && typeof valor !== 'boolean') return caminho + ' deveria ser booleano';
  return null;
}
// Extrai + parseia + valida numa tacada. Devolve { ok, valor } ou { ok:false, erro }.
function extraiValidado(r, schema) {
  const content = extractContent(r && r.json);
  if (!content) return { ok: false, erro: 'resposta vazia' };
  let valor;
  try { valor = parseJson(content); } catch (e) { return { ok: false, erro: 'JSON inválido (' + e.message + ')' }; }
  const err = validaContra(schema, valor);
  return err ? { ok: false, erro: 'fora do schema: ' + err } : { ok: true, valor };
}

function maxTokensField(payload, mdl, maxTokens) {
  if (!maxTokens) return;
  // GPT usa max_completion_tokens; Claude/Gemini usam max_tokens.
  if (/^gpt/i.test(mdl)) payload.max_completion_tokens = maxTokens;
  else payload.max_tokens = maxTokens;
}

function basePayload(mdl, system, user, maxTokens) {
  const p = { model: mdl, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  maxTokensField(p, mdl, maxTokens);
  return p;
}

// Modo json_object: o schema não é imposto pela API, então vai descrito no prompt.
function systemComSchema(system, schema) {
  return system + '\n\nResponda SOMENTE com um objeto JSON válido (sem markdown, sem comentários) que obedeça exatamente a este JSON Schema:\n'
    + JSON.stringify(schema);
}

async function openaiChat({ system, user, schemaName, schema, maxTokens }) {
  const base = (process.env.OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '');
  const mdl = model();
  const payload = basePayload(mdl, system, user, maxTokens);
  payload.response_format = { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } };
  const r = await postJson(base + '/chat/completions', { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY }, payload);
  if (r.status !== 200 || !r.json) {
    const msg = (r.json && r.json.error && r.json.error.message) || ('HTTP ' + r.status);
    throw new Error('Erro na IA: ' + msg);
  }
  const out = extraiValidado(r, schema);
  if (!out.ok) throw new Error('IA retornou resposta imprestável — ' + out.erro);
  return out.valor;
}

// json_schema x json_object no compat do Vertex. O modo é lembrado POR MODELO: um
// modelo novo que não aceite json_schema não pode rebaixar os outros que aceitam.
const modoPorModelo = new Map();
function vertexSchemaMode(mdl) { return modoPorModelo.get(mdl || model()) || 'json_schema'; }
function _setVertexSchemaMode(v, mdl) {
  if (v === true || v === 'json_schema') modoPorModelo.delete(mdl || model());
  else modoPorModelo.set(mdl || model(), 'json_object');
}
// Só rebaixa o modo quando o 400 fala DE FORMATO. Um 400 por prompt grande ou parâmetro
// inválido não pode desligar a saída estruturada do modelo para sempre.
function erroDeFormato(json) {
  const msg = String((json && json.error && (json.error.message || json.error)) || '');
  return /response_format|json_schema|schema/i.test(msg);
}

async function vertexChat({ system, user, schemaName, schema, maxTokens }) {
  const sa = loadSA();
  const mdl = model();
  const url = 'https://aiplatform.googleapis.com/v1/projects/' + sa.project_id
    + '/locations/global/endpoints/openapi/chat/completions';
  let token = await vertexToken();

  async function tentativa(modo, teto) {
    const usarSchema = modo === 'json_schema';
    const sys = usarSchema ? system : systemComSchema(system, schema);
    const payload = basePayload(mdl, sys, user, teto);
    payload.response_format = usarSchema
      ? { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } }
      : { type: 'json_object' };
    return postJson(url, { Authorization: 'Bearer ' + token }, payload);
  }

  let modo = vertexSchemaMode(mdl);
  let r = await tentativa(modo, maxTokens);

  // Token revogado ou expirado cedo do lado do Google: joga fora o cache e tenta 1x.
  if (r.status === 401 || r.status === 403) {
    _resetTokenCache();
    token = await vertexToken();
    r = await tentativa(modo, maxTokens);
  }
  if (r.status === 400 && modo === 'json_schema' && erroDeFormato(r.json)) {
    modo = 'json_object';
    modoPorModelo.set(mdl, modo);
    r = await tentativa(modo, maxTokens);
  }
  if (r.status !== 200 || !r.json) {
    const msg = (r.json && r.json.error && (r.json.error.message || r.json.error)) || ('HTTP ' + r.status);
    throw new Error('Erro na IA (Vertex): ' + msg);
  }

  const primeira = extraiValidado(r, schema);
  if (primeira.ok) return primeira.valor;
  // Resposta imprestável quase sempre é JSON CORTADO: o Gemini gasta parte do orçamento
  // pensando antes de escrever. A segunda (e única) chance vai com o dobro do teto.
  const r2 = await tentativa('json_object', maxTokens ? maxTokens * 2 : 4000);
  if (r2.status !== 200 || !r2.json) {
    const msg = (r2.json && r2.json.error && (r2.json.error.message || r2.json.error)) || ('HTTP ' + r2.status);
    throw new Error('Erro na IA (Vertex) na segunda tentativa: ' + msg);
  }
  const segunda = extraiValidado(r2, schema);
  if (!segunda.ok) throw new Error('IA retornou resposta imprestável duas vezes — ' + segunda.erro);
  return segunda.valor;
}

async function chatJSON(args) {
  if (!isConfigured())
    throw new Error(provider() === 'vertex'
      ? 'IA não configurada. Defina GOOGLE_VERTEX_SA no ambiente.'
      : 'IA não configurada. Defina OPENAI_API_KEY no ambiente.');
  return provider() === 'vertex' ? vertexChat(args) : openaiChat(args);
}

module.exports = { chatJSON, isConfigured, provider, model, buildJwt, vertexToken,
  extractContent, parseJson, validaContra, extraiValidado, erroDeFormato,
  _resetTokenCache, _setVertexSchemaMode, vertexSchemaMode };
