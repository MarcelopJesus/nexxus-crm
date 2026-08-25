// store.js — Persistência em arquivo JSON, zero dependências e sem recursos
// experimentais. Roda em qualquer Node >= 18. Substitui o SQLite embutido.
'use strict';
const fs = require('fs');
const path = require('path');
const remote = require('./remote');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'nexxus.json');

const COLLECTIONS = ['users','accounts','contacts','suppliers','products','leads',
  'quotes','pricings','proposals','tasks','contracts','activities','notifications',
  'prospects','outreaches','qualifications','webhook_events'];

let data = { seq: {}, config: null };
COLLECTIONS.forEach(c => data[c] = []);

function load() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      data = Object.assign(data, parsed);
      COLLECTIONS.forEach(c => { if (!Array.isArray(data[c])) data[c] = []; });
      if (!data.seq) data.seq = {};
    }
  } catch (e) { console.error('Falha ao ler o banco, iniciando vazio:', e.message); }
}
let remoteTimer = null;
function pushRemote() {
  if (!remote.ENABLED) return;
  if (remoteTimer) return;
  remoteTimer = setTimeout(() => {
    remoteTimer = null;
    remote.push(data, COLLECTIONS).catch(e => console.error('[remote] falha ao salvar no Supabase:', e.message));
  }, 400);
}
// Baixa o snapshot do Supabase no boot; se vazio, sobe o estado local (seed).
async function initRemote() {
  if (!remote.ENABLED) { console.log('[remote] Supabase desligado (envs ausentes) — usando arquivo local'); return; }
  try {
    const snap = await remote.pull();
    if (snap) {
      COLLECTIONS.forEach(c => { if (Array.isArray(snap[c])) data[c] = snap[c]; });
      if (snap._meta) { data.seq = snap._meta.seq || {}; data.config = snap._meta.config ?? data.config; }
      console.log('[remote] snapshot carregado do Supabase');
    } else {
      await remote.push(data, COLLECTIONS);
      console.log('[remote] Supabase vazio — snapshot inicial enviado');
    }
  } catch (e) { console.error('[remote] indisponivel, seguindo com arquivo local:', e.message); }
}
let saveTimer = null;
function save() {
  pushRemote();
  // grava de forma atômica (tmp + rename) e com debounce leve
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 0));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) { console.error('Falha ao salvar o banco:', e.message); }
  }, 15);
}
function saveNow() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 0)); } catch (e) {}
  if (remote.ENABLED) remote.push(data, COLLECTIONS).catch(() => {});
}
function now() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
function nextId(coll) { data.seq[coll] = (data.seq[coll] || 0) + 1; return data.seq[coll]; }

// CRUD genérico
function insert(coll, obj) {
  const row = Object.assign({ id: nextId(coll) }, obj);
  if (row.created_at === undefined) row.created_at = now();
  data[coll].push(row); save();
  return row;
}
function all(coll) { return data[coll].slice(); }
function find(coll, pred) { return data[coll].filter(pred); }
function findOne(coll, pred) { return data[coll].find(pred) || null; }
function get(coll, id) { return data[coll].find(r => r.id === Number(id)) || null; }
function update(coll, id, patch) {
  const row = get(coll, id); if (!row) return null;
  Object.assign(row, patch); save(); return row;
}
function remove(coll, id) {
  const i = data[coll].findIndex(r => r.id === Number(id));
  if (i >= 0) { data[coll].splice(i, 1); save(); return true; }
  return false;
}
function isEmpty() { return data.users.length === 0; }

load();

module.exports = { data, DB_FILE, load, save, saveNow, now, nextId, initRemote,
  insert, all, find, findOne, get, update, remove, isEmpty, COLLECTIONS };
