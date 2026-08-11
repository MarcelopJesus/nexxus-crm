// remote.js — persistência durável no Supabase (Postgres) via REST, sem dependências.
// O store continua operando em memória (síncrono); este módulo baixa o snapshot no
// boot e sobe cada alteração com debounce. Sem as envs, o CRM funciona como antes
// (arquivo local) — degradação graciosa, nunca quebra.
'use strict';
const SB_URL = (process.env.SUPABASE_URL_CRM || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY_CRM || '';
const ENABLED = !!(SB_URL && SB_KEY);
const TABLE = 'crm_store';

async function sb(pathname, opts = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${pathname}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Baixa o snapshot inteiro; devolve null se a tabela estiver vazia.
async function pull() {
  if (!ENABLED) return null;
  const rows = await sb(`${TABLE}?select=name,data`);
  if (!rows || !rows.length) return null;
  const snap = {};
  for (const r of rows) snap[r.name] = r.data;
  return snap;
}

// Sobe o snapshot inteiro (upsert por coleção). Chamado com debounce pelo store.
async function push(data, collections) {
  if (!ENABLED) return;
  const payload = collections.map(c => ({ name: c, data: data[c] || [] }));
  payload.push({ name: '_meta', data: { seq: data.seq || {}, config: data.config || null } });
  await sb(`${TABLE}?on_conflict=name`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(payload),
  });
}

module.exports = { ENABLED, pull, push };
