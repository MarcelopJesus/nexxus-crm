// server.js — HTTP server (Node puro), serve a API e o frontend estático.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { verify } = require('./lib/auth');
const { seedIfEmpty } = require('./lib/seed');
const { handle } = require('./lib/api');

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
function readBody(req) {
  return new Promise((resolve) => {
    let data=''; req.on('data', c=>{ data+=c; if (data.length>5e6) req.destroy(); });
    req.on('end', ()=>{ try { resolve(data?JSON.parse(data):{}); } catch { resolve({}); } });
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
    const body = ['POST','PUT','PATCH','DELETE'].includes(req.method) ? await readBody(req) : {};
    const result = await handle({ method:req.method, path:pathname, query:parsed.query, body, user, headers:req.headers });
    sendJson(res, result.status, result.body);
  } catch (err) {
    console.error('API error:', err);
    sendJson(res, 500, { success:false, error:{ message:'Erro interno: '+err.message } });
  }
});

const HOST = process.env.HOST || '0.0.0.0';
ready.then(() => server.listen(PORT, HOST, () => {
  console.log(`\n  Nexxus CRM rodando em http://localhost:${PORT}`);
  console.log(`  Login demo: joao@nexxustech.one / senha123\n`);
}));
