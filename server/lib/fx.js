// fx.js — Taxa de câmbio USD->BRL em tempo real via API pública (AwesomeAPI),
// com fallback para o Banco Central e cache em memória (10 min).
'use strict';

let cache = { rate: null, ts: 0, source: null };
const TTL_MS = 10 * 60 * 1000;

async function fetchJson(url, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

async function getUsdBrl() {
  const now = Date.now();
  if (cache.rate && now - cache.ts < TTL_MS) return { ...cache, cached: true };

  // 1) AwesomeAPI
  try {
    const d = await fetchJson('https://economia.awesomeapi.com.br/last/USD-BRL');
    const rate = parseFloat(d.USDBRL.bid);
    if (rate > 0) {
      cache = { rate, ts: now, source: 'awesomeapi' };
      return { ...cache, cached: false };
    }
  } catch (e) { /* tenta fallback */ }

  // 2) Banco Central (PTAX) — dólar de venda mais recente
  try {
    const today = new Date();
    const fmt = (dt) => `${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}-${dt.getFullYear()}`;
    const start = new Date(now - 10 * 86400000);
    const url = `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@d1,dataFinalCotacao=@d2)?@d1='${fmt(start)}'&@d2='${fmt(today)}'&$top=1&$orderby=dataHoraCotacao%20desc&$format=json`;
    const d = await fetchJson(url);
    const rate = d.value && d.value[0] && d.value[0].cotacaoVenda;
    if (rate > 0) {
      cache = { rate, ts: now, source: 'bcb-ptax' };
      return { ...cache, cached: false };
    }
  } catch (e) { /* usa último valor conhecido */ }

  // 3) Fallback: último valor em cache ou default
  if (cache.rate) return { ...cache, cached: true, stale: true };
  return { rate: 5.20, ts: now, source: 'fallback-default', cached: false };
}

module.exports = { getUsdBrl };
