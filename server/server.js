// server.js — HTTP server (Node puro), serve a API e o frontend estático.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { verify } = require('./lib/auth');
const { seedIfEmpty } = require('./lib/seed');
const { handle } = require('./lib/api');
const catalog = require('./lib/catalogSync');
const { runFollowupSweep, autoLostDays } = require('./lib/followups');
const agent = require('./lib/agentNexus');

const PORT = process.env.PORT || 3001;
const CLIENT_DIR = path.join(__dirname, '..', 'client');

const store = require('./lib/store');
// Snapshot do Supabase antes de tudo: se houver dados remotos, eles mandam.
const ready = (store.initRemote ? store.initRemote() : Promise.resolve()).then(() => { seedIfEmpty(); });

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml',
  '.png':'image/png', '.jpg':'image/jpeg', '.ico':'image/x-icon', '.woff2':'font/woff2' };

function sendJson(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Content-Length':Buffer.byteLength(s) });
  res.end(s);
}
// Devolve o JSON E o corpo cru. A assinatura do webhook de e-mail (Svix) é calculada
// sobre os BYTES originais: reserializar o JSON muda espaços e ordem, e a conta não bate.
// Rota pública é porta aberta na internet: 1 MB de teto (o resto do CRM, autenticado,
// continua com 5 MB). Nunca deixa a promise pendurada — 'error' e 'aborted' resolvem.
const LIMITE_PUBLICO = 1 * 1024 * 1024;
const LIMITE_INTERNO = 5 * 1024 * 1024;
function readBody(req, limite) {
  return new Promise((resolve) => {
    const partes = []; let tam = 0, terminou = false;
    const fim = (r) => { if (!terminou) { terminou = true; resolve(r); } };
    req.on('data', c => {
      if (terminou) return;      // já estourou: descarta o resto sem acumular memória
      partes.push(c); tam += c.length;
      // Não derruba o socket aqui: matar a conexão agora faria o cliente ver "connection
      // reset" em vez do 413. Quem responde e só então encerra é o handler.
      if (tam > limite) { partes.length = 0; fim({ json:{}, raw:'', tooLarge:true }); }
    });
    req.on('end', () => {
      const raw = Buffer.concat(partes).toString('utf8');
      let json = {}; try { json = raw ? JSON.parse(raw) : {}; } catch { json = {}; }
      fim({ json, raw });
    });
    // Conexão caiu no meio do upload: sem isto o handler ficava esperando para sempre.
    req.on('error', () => fim({ json:{}, raw:'', aborted:true }));
    req.on('aborted', () => fim({ json:{}, raw:'', aborted:true }));
  });
}
function serveFile(res, file) {
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let file = path.join(CLIENT_DIR, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(CLIENT_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // SPA fallback -> index.html
      file = path.join(CLIENT_DIR, 'index.html');
    }
    fs.readFile(file, (e, buf) => {
      if (e) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (pathname === '/healthz' || pathname === '/api/health') { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ ok:true, ts:Date.now() })); }
  if (pathname === '/p' || pathname.startsWith('/p/')) { return serveFile(res, path.join(CLIENT_DIR, 'proposta.html')); }
  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  // CORS (útil se o front for servido de outra porta durante o dev)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const user = token ? verify(token) : null;
    const publica = pathname.startsWith('/api/public/') || pathname.startsWith('/api/webhooks/');
    const lido = ['POST','PUT','PATCH','DELETE'].includes(req.method)
      ? await readBody(req, publica ? LIMITE_PUBLICO : LIMITE_INTERNO)
      : { json:{}, raw:'' };
    if (lido.tooLarge) {
      // Responde primeiro, encerra a conexão depois — senão o cliente recebe reset no
      // lugar do 413 e não sabe o que aconteceu.
      const corpo = JSON.stringify({ success:false, error:{ message:'Corpo da requisição grande demais.' } });
      res.writeHead(413, { 'Content-Type':'application/json; charset=utf-8',
        'Content-Length':Buffer.byteLength(corpo), 'Connection':'close' });
      return res.end(corpo, () => req.destroy());
    }
    if (lido.aborted) return; // cliente desistiu no meio: não há para quem responder
    // Webhook que não se identifica como JSON é chamada errada (ou sonda): recusa antes
    // de gastar HMAC e banco com ela. Só nas rotas de webhook — o /api/public/leads que
    // o site já usa em produção segue aceitando como está.
    const WEBHOOKS = ['/api/public/email/inbound', '/api/webhooks/lead'];
    if (req.method === 'POST' && WEBHOOKS.includes(pathname)) {
      const ct = String(req.headers['content-type'] || '').toLowerCase();
      if (!ct.includes('application/json'))
        return sendJson(res, 415, { success:false, error:{ message:'Content-Type deve ser application/json.' } });
    }
    const result = await handle({ method:req.method, path:pathname, query:parsed.query,
      body:lido.json, rawBody:lido.raw, user, headers:req.headers });
    sendJson(res, result.status, result.body);
  } catch (err) {
    console.error('API error:', err);
    sendJson(res, 500, { success:false, error:{ message:'Erro interno: '+err.message } });
  }
});

// ---- Rotinas de fundo ----
// Sync do catálogo do site: nunca é fatal — se o site estiver fora, o CRM sobe igual
// com o último catálogo que já tinha.
const SYNC_MS = 30 * 60 * 1000;
function syncCatalogoSeguro() {
  if (!catalog.isConfigured()) return;
  catalog.syncCatalog()
    .then(r => console.log(`[catalogo] sync: ${r.imported} novos, ${r.updated} atualizados, ${r.deactivated} desativados`))
    .catch(e => console.error('[catalogo] sync falhou (segue com o catálogo atual):', e.message));
}
const SWEEP_MS = 60 * 60 * 1000;
function varreduraSegura() {
  try {
    const r = runFollowupSweep();
    if (r.lost) console.log(`[followup] ${r.lost} lead(s) sem resposta há ${r.days} dias marcados como perdidos`);
  } catch (e) { console.error('[followup] varredura falhou:', e.message); }
}
// Agente Nexus: passa o funil de 5 em 5 minutos. Falha aqui nunca derruba o servidor —
// o funil continua andando na mão.
const AGENT_MS = 5 * 60 * 1000;
function agenteSeguro() {
  agent.runAgentSweep()
    .then(r => { if (r && r.processed) console.log(`[agente] ${r.processed} lead(s) trabalhados, ${r.escalated} para o BDR, ${r.errors} com erro`); })
    .catch(e => console.error('[agente] varredura falhou:', e.message));
}

const HOST = process.env.HOST || '0.0.0.0';
ready.then(() => server.listen(PORT, HOST, () => {
  console.log(`\n  Nexxus CRM rodando em http://localhost:${PORT}`);
  console.log(`  Login demo: joao@nexxustech.one / senha123\n`);
  if (catalog.isConfigured()) {
    syncCatalogoSeguro();
    setInterval(syncCatalogoSeguro, SYNC_MS).unref();
  } else {
    console.log('[catalogo] sync desligada — defina SITE_CATALOG_URL e SITE_CATALOG_KEY para ligar');
  }
  console.log(`[followup] varredura ativa — lead sem resposta vira perdido em ${autoLostDays()} dias`);
  varreduraSegura();
  setInterval(varreduraSegura, SWEEP_MS).unref();
  const off = agent.motivoDesligado();
  if (off) {
    console.log(`[agente] piloto automático DESLIGADO — ${off}. Para ligar: AGENT_AUTOPILOT=on`);
  } else {
    console.log('[agente] Nexus ativo (máscaras SDR/Comprador/Vendedor) — varredura a cada 5 min');
    agenteSeguro();
    setInterval(agenteSeguro, AGENT_MS).unref();
  }
}));
