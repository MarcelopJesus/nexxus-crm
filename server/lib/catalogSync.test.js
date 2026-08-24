// Sync do catálogo do site. Roda em processo com o transporte HTTP injetado: o que
// interessa aqui é o upsert por slug, não a rede.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB_FILE = path.join('/tmp', `nexxus-catalog-${process.pid}.json`);
try { fs.unlinkSync(DB_FILE); } catch {}
process.env.DB_FILE = DB_FILE;

const store = require('./store');
const { syncCatalog, pickCostTier, entryCostUsd } = require('./catalogSync');

// Fábrica do stub: devolve o mesmo envelope que o site publica.
const catalogo = (products) => () => Promise.resolve({
  success: true, data: { generatedAt: '2026-08-24T12:00:00.000Z', products },
});
const sync = (products) => syncCatalog({ fetchCatalog: catalogo(products) });

const JIRA = {
  slug: 'jira-cloud', name: 'Jira Cloud', manufacturer: 'Atlassian', type: 'software', isActive: true,
  prices: [{ planName: 'Standard', minSeats: 1, maxSeats: 5, billingPeriod: 'annual', priceBrl: 1255.00 }],
  costs: [
    { planName: 'Standard', quantity: 1,  unitCostUsd: 100.00, currency: 'USD', status: 'published' },
    { planName: 'Standard', quantity: 10, unitCostUsd: 80.00,  currency: 'USD', status: 'published' },
    { planName: 'Standard', quantity: 50, unitCostUsd: 60.00,  currency: 'USD', status: 'published' },
  ],
};
// Segundo produto: serve para o catálogo continuar de pé quando o Jira sai dele.
const OUTRO = { slug: 'curso-ia', name: 'Curso de IA aplicada', manufacturer: 'Nexxus Tech', type: 'course', isActive: true,
  prices: [], costs: [{ planName: 'Turma', quantity: 1, unitCostUsd: 300, currency: 'USD', status: 'published' }] };
// Terceiro produto: nasce como cadastro manual e é adotado pelo catálogo no meio do arquivo.
const CONF = { slug: 'confluence', name: 'Confluence', manufacturer: 'Atlassian', type: 'software', isActive: true,
  prices: [], costs: [{ quantity: 1, unitCostUsd: 42, currency: 'USD', status: 'published' }] };
const prodBySku = (sku) => store.findOne('products', p => p.sku === sku);

// O store grava com debounce (15 ms): esperar antes de apagar, senão o arquivo renasce.
after(async () => {
  await new Promise(resolve => setTimeout(resolve, 60));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

test('produto novo entra com sku=slug, tiers e fornecedor pelo fabricante', async () => {
  const r = await sync([JIRA]);
  assert.equal(r.imported, 1);
  assert.equal(r.updated, 0);
  assert.equal(r.deactivated, 0);
  assert.equal(r.generatedAt, '2026-08-24T12:00:00.000Z');

  const p = prodBySku('jira-cloud');
  assert.ok(p, 'produto deveria ter sido criado');
  assert.equal(p.name, 'Jira Cloud');
  assert.equal(p.list_cost_usd, 100, 'list_cost_usd é o unitário da faixa de ENTRADA, não o custo de atacado');
  assert.equal(p.price_tiers.length, 1);
  assert.equal(p.cost_tiers.length, 3);
  assert.equal(p.site_active, true);
  assert.ok(p.synced_at);

  const sup = store.get('suppliers', p.supplier_id);
  assert.equal(sup.name, 'Atlassian', 'fabricante virou fornecedor associado');
});

test('segunda sync atualiza o mesmo produto em vez de duplicar', async () => {
  const antes = prodBySku('jira-cloud');
  const r = await sync([Object.assign({}, JIRA, { name: 'Jira Cloud Premium' })]);
  assert.equal(r.imported, 0);
  assert.equal(r.updated, 1);
  assert.equal(store.find('products', p => p.sku === 'jira-cloud').length, 1, 'nada de duplicata por slug');
  assert.equal(prodBySku('jira-cloud').id, antes.id, 'mesmo id — é upsert, não recriação');
  assert.equal(prodBySku('jira-cloud').name, 'Jira Cloud Premium');
  assert.equal(store.find('suppliers', s => s.name === 'Atlassian').length, 1, 'fornecedor não duplica');
});

test('tier de custo escolhe a maior quantidade que cabe na qty do lead', () => {
  const p = prodBySku('jira-cloud');
  assert.equal(pickCostTier(p, 1).unitCostUsd, 100);
  assert.equal(pickCostTier(p, 9).unitCostUsd, 100);
  assert.equal(pickCostTier(p, 10).unitCostUsd, 80, 'quantidade exata pega o tier dela');
  assert.equal(pickCostTier(p, 49).unitCostUsd, 80);
  assert.equal(pickCostTier(p, 500).unitCostUsd, 60, 'acima do maior tier fica no maior tier');
  assert.equal(pickCostTier({}, 5), null);
});

test('qty menor que a menor faixa usa a faixa de entrada, não o atacado', () => {
  const so_atacado = { cost_tiers: [{ quantity: 25, unitCostUsd: 90, currency: 'USD' }, { quantity: 100, unitCostUsd: 70, currency: 'USD' }] };
  assert.equal(pickCostTier(so_atacado, 3).unitCostUsd, 90, 'comprar 3 nunca pode custar o preço de 100');
  assert.equal(entryCostUsd(so_atacado.cost_tiers), 90);
});

test('custo ignora moeda diferente de USD e empate de faixa fica com o mais caro', () => {
  const misto = [
    { planName: 'Euro', quantity: 1, unitCostUsd: 10, currency: 'EUR' },
    { planName: 'Basic', quantity: 1, unitCostUsd: 40, currency: 'USD' },
    { planName: 'Plus',  quantity: 1, unitCostUsd: 55, currency: 'USD' },
    { planName: 'Bulk',  quantity: 20, unitCostUsd: 30, currency: 'USD' },
  ];
  assert.equal(entryCostUsd(misto), 55, 'empate de quantity fica com o custo maior — nunca superestima a margem');
  assert.equal(pickCostTier({ cost_tiers: misto }, 1).unitCostUsd, 55);
  assert.equal(pickCostTier({ cost_tiers: misto }, 30).unitCostUsd, 30);
  assert.equal(entryCostUsd([{ quantity: 1, unitCostUsd: 10, currency: 'EUR' }]), null, 'só EUR: fora do pré-preenchimento');
  assert.equal(entryCostUsd([]), null);
});

test('produto que some do site vira site_active:false e não é apagado', async () => {
  const antes = prodBySku('jira-cloud');
  // Catálogo continua de pé, só sem o Jira (catálogo vazio é tratado como site quebrado).
  const r = await sync([OUTRO]);
  assert.equal(r.deactivated, 1);
  const p = prodBySku('jira-cloud');
  assert.ok(p, 'produto sumido do site continua no CRM — leads antigos apontam para ele');
  assert.equal(p.id, antes.id);
  assert.equal(p.site_active, false);

  const denovo = await sync([OUTRO]);
  assert.equal(denovo.deactivated, 0, 'desativar é idempotente');
});

test('produto cadastrado à mão não é desativado pelo catálogo do site', async () => {
  const manual = store.insert('products', { supplier_id: null, name: 'Licença negociada à mão', sku: 'MANUAL-01', list_cost_usd: 500, currency: 'USD' });
  const r = await sync([JIRA, OUTRO]);
  assert.equal(r.deactivated, 0);
  assert.notEqual(store.get('products', manual.id).site_active, false, 'sync só mexe em quem veio dela (tem synced_at)');
  assert.equal(prodBySku('jira-cloud').site_active, true, 'produto voltou ao site e reativou');
});

test('produto manual adotado pelo catálogo registra a adoção uma vez só', async () => {
  const manual = store.insert('products', { supplier_id: null, name: 'Confluence comprado direto', sku: 'confluence', list_cost_usd: 999, currency: 'USD' });
  const r = await sync([JIRA, OUTRO, CONF]);
  assert.equal(r.adopted, 1);
  assert.equal(store.get('products', manual.id).list_cost_usd, 42, 'a partir da adoção o site manda no custo');
  const nota = store.find('activities', a => a.type === 'catalog' && /confluence/i.test(a.message));
  assert.equal(nota.length, 1);
  assert.match(nota[0].message, /passou a ser gerido pelo catálogo do site/);

  const denovo = await sync([JIRA, OUTRO, CONF]);
  assert.equal(denovo.adopted, 0, 'adoção é registrada uma vez, não a cada sync');
  assert.equal(store.find('activities', a => a.type === 'catalog' && /confluence/i.test(a.message)).length, 1);
});

test('resposta malformada falha sem encostar nos produtos', async () => {
  const antes = store.all('products').map(p => ({ id: p.id, ativo: p.site_active, custo: p.list_cost_usd }));
  const lixo = [
    () => Promise.resolve('<html>login</html>'),
    () => Promise.resolve({ success: false, error: 'sem permissão' }),
    () => Promise.resolve({ success: true, data: { generatedAt: 'x' } }),
    () => Promise.resolve({ success: true, data: { products: 'nao-e-array' } }),
  ];
  for (const fetchCatalog of lixo) {
    await assert.rejects(syncCatalog({ fetchCatalog }), /formato inesperado/);
  }
  assert.deepEqual(store.all('products').map(p => ({ id: p.id, ativo: p.site_active, custo: p.list_cost_usd })), antes,
    'catálogo quebrado não desativa nem altera nada');
});

test('catálogo válido porém vazio não desativa ninguém', async () => {
  const ativos = store.find('products', p => p.site_active === true).map(p => p.id);
  assert.ok(ativos.length, 'o teste precisa de produtos ativos para valer alguma coisa');
  const r = await sync([]);
  assert.equal(r.empty, true);
  assert.equal(r.deactivated, 0);
  ativos.forEach(id => assert.equal(store.get('products', id).site_active, true, 'site vazio é suspeita de site quebrado'));
});

test('isActive:false vindo do site desativa sem apagar', async () => {
  const r = await sync([Object.assign({}, JIRA, { isActive: false }), OUTRO, CONF]);
  assert.equal(r.updated, 3);
  assert.equal(r.deactivated, 1, 'só o Jira saiu do ar');
  assert.equal(prodBySku('jira-cloud').site_active, false);
  assert.equal(prodBySku('curso-ia').site_active, true);
});

test('sem envs a sync fica desligada em vez de estourar', async () => {
  delete process.env.SITE_CATALOG_URL;
  delete process.env.SITE_CATALOG_KEY;
  const r = await syncCatalog();
  assert.equal(r.disabled, true);
  assert.deepEqual([r.imported, r.updated, r.deactivated], [0, 0, 0]);
});
