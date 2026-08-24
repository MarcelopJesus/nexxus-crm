// catalogSync.js — espelha o catálogo do site na coleção `products` do CRM.
// O SITE é a fonte da verdade: o CRM só copia. Produto que some do site nunca é
// apagado (histórico de leads/cotações depende dele) — vira site_active:false.
'use strict';
const https = require('https');
const http = require('http');
const { URL } = require('url');
const S = require('./store');

const TIMEOUT_MS = 10000;

function siteUrl() { return (process.env.SITE_CATALOG_URL || '').replace(/\/$/, ''); }
function siteKey() { return process.env.SITE_CATALOG_KEY || ''; }
function isConfigured() { return !!(siteUrl() && siteKey()); }
function norm(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

// GET no endpoint do site com a chave do catálogo. https nativo (http só sai em
// dev/localhost, quando a URL configurada é http://).
function fetchCatalog() {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(siteUrl() + '/api/public/catalog'); }
    catch (e) { return reject(new Error('SITE_CATALOG_URL inválida: ' + siteUrl())); }
    const mod = url.protocol === 'http:' ? http : https;
    const req = mod.request(url, { method: 'GET',
      headers: { 'x-catalog-key': siteKey(), 'Accept': 'application/json' } }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; if (raw.length > 5e6) req.destroy(new Error('catálogo grande demais')); });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('resposta não é JSON válido')); }
      });
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout de ' + TIMEOUT_MS + 'ms no catálogo do site')));
    req.on('error', reject);
    req.end();
  });
}

// Só USD entra na conta de custo: o motor de precificação trabalha em dólar. Tiers em
// outra moeda continuam gravados em cost_tiers, mas fora do pré-preenchimento.
function tiersUsd(costs) {
  return (Array.isArray(costs) ? costs : []).filter(c => c && Number(c.unitCostUsd) > 0
    && String(c.currency || 'USD').toUpperCase() === 'USD');
}
// Extremo da lista por quantidade. Empate de `quantity` fica com o MAIOR custo
// unitário — conservador, nunca superestima a margem.
function tierPorQuantidade(list, modo) {
  return list.reduce((melhor, t) => {
    const q = Number(t.quantity) || 1, mq = Number(melhor.quantity) || 1;
    if (q === mq) return Number(t.unitCostUsd) > Number(melhor.unitCostUsd) ? t : melhor;
    return (modo === 'max' ? q > mq : q < mq) ? t : melhor;
  });
}
// Custo de tabela = unitário da faixa de ENTRADA (menor quantity). Pegar o menor custo
// global daria o preço de atacado para quem compra uma licença só.
function entryCostUsd(costs) {
  const usd = tiersUsd(costs);
  return usd.length ? Number(tierPorQuantidade(usd, 'min').unitCostUsd) : null;
}

// Tier de custo para uma quantidade: a maior faixa que ainda caiba em qty. Quantidade
// menor que a menor faixa cai na faixa de entrada — nunca no custo de atacado.
function pickCostTier(product, qty) {
  const usd = tiersUsd(product && product.cost_tiers);
  if (!usd.length) return null;
  const q = Number(qty) > 0 ? Number(qty) : 1;
  const cabe = usd.filter(t => (Number(t.quantity) || 1) <= q);
  return cabe.length ? tierPorQuantidade(cabe, 'max') : tierPorQuantidade(usd, 'min');
}

// Nota de sistema (sem lead). Não dá para reusar o log() do api.js: é ele que
// depende deste módulo, não o contrário.
function logSistema(message) {
  S.insert('activities', { lead_id: null, user_id: null, type: 'catalog', message });
  console.log('[catalogo] ' + message);
}

// Fornecedor pelo nome do fabricante (cria se ainda não existir).
function supplierIdFor(manufacturer) {
  const nome = String(manufacturer || '').trim();
  if (!nome) return null;
  const achado = S.findOne('suppliers', s => norm(s.name) === norm(nome));
  if (achado) return achado.id;
  return S.insert('suppliers', { name: nome, country: null, currency: 'USD' }).id;
}

// Roda a sync. opts.fetchCatalog permite injetar o transporte nos testes.
async function syncCatalog(opts) {
  opts = opts || {};
  const buscar = opts.fetchCatalog || fetchCatalog;
  if (!opts.fetchCatalog && !isConfigured())
    return { disabled: true, imported: 0, updated: 0, deactivated: 0, generatedAt: null };

  const payload = await buscar();
  // Validação ANTES de tocar em qualquer produto: resposta estranha (erro de deploy,
  // HTML de página de login, JSON de outra rota) não pode desativar o catálogo inteiro.
  const bloco = (payload && payload.data) || {};
  if (!payload || payload.success !== true || !Array.isArray(bloco.products))
    throw new Error('catálogo do site em formato inesperado — nenhum produto foi alterado');
  const lista = bloco.products;
  const at = S.now();
  let imported = 0, updated = 0, deactivated = 0, adopted = 0;
  const vistos = new Set();

  // Catálogo válido porém vazio quase sempre é site quebrado, não loja fechada:
  // avisa e sai sem desativar ninguém.
  if (!lista.length) {
    console.warn('[catalogo] o site respondeu com catálogo VAZIO — nada foi desativado');
    return { imported: 0, updated: 0, deactivated: 0, adopted: 0, generatedAt: bloco.generatedAt || null, total: 0, empty: true };
  }

  for (const sp of lista) {
    const slug = String((sp && sp.slug) || '').trim();
    if (!slug) continue;
    vistos.add(norm(slug));
    const ativo = sp.isActive !== false;
    const patch = {
      name: sp.name || slug,
      price_tiers: Array.isArray(sp.prices) ? sp.prices : [],
      cost_tiers: Array.isArray(sp.costs) ? sp.costs : [],
      site_active: ativo,
      synced_at: at,
    };
    // Custo só é sobrescrito quando o site publicou algum em USD — não zera o que já havia.
    const custo = entryCostUsd(sp.costs);
    if (custo != null) patch.list_cost_usd = custo;
    const supId = supplierIdFor(sp.manufacturer);
    if (supId) patch.supplier_id = supId;

    const existente = S.findOne('products', p => norm(p.sku) === norm(slug));
    if (existente) {
      // Produto cadastrado à mão cujo sku bate com o slug: a partir daqui o site manda
      // nele. Fica registrado, senão o custo mudaria sozinho sem ninguém entender.
      if (!existente.synced_at) {
        logSistema(`"${existente.name}" (sku ${existente.sku}) passou a ser gerido pelo catálogo do site.`);
        adopted++;
      }
      if (existente.site_active !== false && !ativo) deactivated++;
      S.update('products', existente.id, patch);
      updated++;
    } else {
      S.insert('products', Object.assign({ sku: slug, supplier_id: supId || null, currency: 'USD' }, patch));
      imported++;
      if (!ativo) deactivated++;
    }
  }

  // Sumiu do site: desativa, nunca apaga. Só mexe em produto que veio de uma sync
  // (tem synced_at) — cadastro manual do time não é afetado pelo catálogo.
  S.find('products', p => p.synced_at && p.site_active !== false && !vistos.has(norm(p.sku)))
    .forEach(p => { S.update('products', p.id, { site_active: false, synced_at: at }); deactivated++; });

  return { imported, updated, deactivated, adopted, generatedAt: bloco.generatedAt || null, total: lista.length };
}

module.exports = { syncCatalog, isConfigured, pickCostTier, entryCostUsd, fetchCatalog };
