// Leitura das caixas do Outlook. Roda com a api.js de verdade (banco em /tmp) e o fetch
// falso: o e-mail "chega" pela caixa e tem que virar a mesma coisa que viraria pelo Resend.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB_FILE = path.join('/tmp', `nexxus-outlook-${process.pid}.json`);
process.env.DB_FILE = DB_FILE;
process.env.EMAIL_PROVIDER = 'graph';
process.env.MS_GRAPH_TENANT_ID = 't';
process.env.MS_GRAPH_CLIENT_ID = 'c';
process.env.MS_GRAPH_CLIENT_SECRET = 's';
process.env.EMAIL_FROM = 'patricia.atendimento@nexxus.ia.br';
process.env.EMAIL_INBOX_MAILBOXES = 'Patricia.Atendimento@nexxus.ia.br';
// O filtro de destinatário do Resend aponta para outro endereço: a varredura tem que
// passar mesmo assim, porque o CRM leu a própria caixa.
process.env.EMAIL_INBOUND_ADDRESS = 'patricia@nexxustech.ia.br';

const store = require('./store');
const { seedIfEmpty } = require('./seed');
const api = require('./api');
const mailer = require('./mailer');
const caixa = require('./caixaOutlook');
seedIfEmpty();

let caixaDeEntrada;   // mensagens que o Graph "devolve"
let patches;
const resposta = (status, corpo) => ({ ok: status >= 200 && status < 300, status, json: async () => corpo, headers: { get: () => null } });

beforeEach(() => {
  patches = [];
  mailer._zerarTokenGraph();
  global.fetch = async (url, opts = {}) => {
    if (url.includes('login.microsoftonline.com')) return resposta(200, { access_token: 'tok', expires_in: 3600 });
    if (url.includes('/mailFolders/inbox/messages')) {
      assert.match(url, /patricia\.atendimento%40nexxus\.ia\.br/, 'caixa em minúsculas e codificada');
      return resposta(200, { value: caixaDeEntrada });
    }
    if (opts.method === 'PATCH') {
      patches.push({ url, corpo: JSON.parse(opts.body) });
      const id = decodeURIComponent(url.split('/messages/')[1]);
      const m = caixaDeEntrada.find(x => x.id === id);
      if (m) m.categories = JSON.parse(opts.body).categories;
      return resposta(200, {});
    }
    throw new Error('url inesperada: ' + url);
  };
});

after(async () => {
  await new Promise(r => setTimeout(r, 60));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

const email = (id, de, assunto, texto, extra = {}) => Object.assign({
  id, internetMessageId: `<${id}@cliente.example>`, subject: assunto, categories: [],
  from: { emailAddress: { name: 'Cliente', address: de } },
  body: { contentType: 'text', content: texto },
  internetMessageHeaders: [{ name: 'Authentication-Results', value: 'spf=pass; dkim=pass; dmarc=pass' }],
}, extra);

test('e-mail novo na caixa vira lead com a conversa, e ganha a etiqueta CRM', async () => {
  caixaDeEntrada = [email('m1', 'compras@acme.example', 'Cotação Ampler 10 licenças', 'Quero 10 licenças.')];
  const r = await caixa.varrer(api);
  assert.deepEqual(r, { lidas: 1, processadas: 1, puladas: 0, erros: 0 });

  const act = store.findOne('activities', a => a.type === 'email_in' && a.email_from === 'compras@acme.example');
  assert.ok(act, 'a conversa entrou na timeline');
  assert.equal(act.email_body, 'Quero 10 licenças.');
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].corpo.categories, ['CRM']);

  // Segunda volta: já etiquetado, não processa de novo.
  const r2 = await caixa.varrer(api);
  assert.deepEqual(r2, { lidas: 1, processadas: 0, puladas: 1, erros: 0 });
  assert.equal(store.find('activities', a => a.type === 'email_in' && a.email_from === 'compras@acme.example').length, 1);
});

test('processado mas sem etiqueta (PATCH falhou) não duplica na volta seguinte', async () => {
  caixaDeEntrada = [email('m2', 'ti@beta.example', 'Licença 1Password', 'Precisamos de 5.')];
  const fetchBom = global.fetch;
  global.fetch = async (url, opts = {}) => (opts.method === 'PATCH' ? resposta(503, {}) : fetchBom(url, opts));
  await caixa.varrer(api);
  global.fetch = fetchBom;
  await caixa.varrer(api);
  assert.equal(store.find('activities', a => a.type === 'email_in' && a.email_from === 'ti@beta.example').length, 1);
  assert.deepEqual(caixaDeEntrada[0].categories, ['CRM'], 'a etiqueta entra na volta seguinte');
});

test('resposta automática continua barrada pela mesma trava do Resend', async () => {
  caixaDeEntrada = [email('m3', 'ferias@gama.example', 'Fora do escritório', 'Volto dia 30.', {
    internetMessageHeaders: [{ name: 'Auto-Submitted', value: 'auto-replied' }],
  })];
  await caixa.varrer(api);
  assert.equal(store.find('activities', a => a.email_from === 'ferias@gama.example').length, 0);
  assert.deepEqual(caixaDeEntrada[0].categories, ['CRM'], 'ignorado também é desfecho: etiqueta para não reler');
});

test('sem EMAIL_PROVIDER=graph a varredura nem chama a Microsoft', async () => {
  process.env.EMAIL_PROVIDER = 'resend';
  global.fetch = async () => { throw new Error('não devia chamar'); };
  assert.match(caixa.motivoDesligado(), /graph/);
  assert.deepEqual(await caixa.varrer(api), { lidas: 0, processadas: 0, puladas: 0, erros: 0 });
  process.env.EMAIL_PROVIDER = 'graph';
});
