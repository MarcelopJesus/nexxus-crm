// Envio pelas caixas do Outlook (EMAIL_PROVIDER=graph). O fetch é trocado por um falso:
// nada sai para a rede, e cada chamada fica registrada para conferir o que foi pedido.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.EMAIL_PROVIDER = 'graph';
process.env.MS_GRAPH_TENANT_ID = 'tenant-teste';
process.env.MS_GRAPH_CLIENT_ID = 'cliente-teste';
process.env.MS_GRAPH_CLIENT_SECRET = 'segredo-teste';
process.env.EMAIL_FROM = 'Patrícia | Atendimento Nexxus <patricia.atendimento@nexxus.ia.br>';
process.env.EMAIL_FROM_VENDAS = 'veridiana.vendas@nexxus.ia.br';
delete process.env.EMAIL_API_KEY;

const mailer = require('./mailer');

let chamadas;
let respostas;
const resposta = (status, corpo) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => corpo, headers: { get: () => null },
});

beforeEach(() => {
  chamadas = [];
  respostas = null;
  mailer._zerarTokenGraph();
  global.fetch = async (url, opts) => {
    chamadas.push({ url, opts });
    if (respostas) return respostas(url, opts);
    if (url.includes('login.microsoftonline.com')) return resposta(200, { access_token: 'tok', expires_in: 3600 });
    if (url.endsWith('/messages')) return resposta(201, { id: 'rascunho-1', internetMessageId: '<abc@nexxus.prod.outlook.com>' });
    if (url.endsWith('/send')) return resposta(202, null);
    throw new Error('url inesperada: ' + url);
  };
});

test('graph dispensa EMAIL_API_KEY, mas exige as três credenciais', () => {
  assert.equal(mailer.isConfigured(), true);
  const guardado = process.env.MS_GRAPH_CLIENT_SECRET;
  delete process.env.MS_GRAPH_CLIENT_SECRET;
  assert.equal(mailer.isConfigured(), false);
  process.env.MS_GRAPH_CLIENT_SECRET = guardado;
});

test('envia pela caixa da área, guarda o Message-ID sem < > e reaproveita o token', async () => {
  const r = await mailer.sendEmail({ to: 'cliente@example.com', subject: 'Proposta', html: '<p>oi</p>', area: 'vendas' });
  assert.deepEqual(r, { sent: true, status: 202, id: 'abc@nexxus.prod.outlook.com' });

  const [token, rascunho, envio] = chamadas;
  assert.match(token.url, /tenant-teste\/oauth2\/v2\.0\/token$/);
  assert.equal(rascunho.url, 'https://graph.microsoft.com/v1.0/users/veridiana.vendas%40nexxus.ia.br/messages');
  assert.equal(envio.url, 'https://graph.microsoft.com/v1.0/users/veridiana.vendas%40nexxus.ia.br/messages/rascunho-1/send');

  const msg = JSON.parse(rascunho.opts.body);
  assert.equal(msg.body.contentType, 'HTML');
  assert.deepEqual(msg.toRecipients, [{ emailAddress: { address: 'cliente@example.com' } }]);
  // Só cabeçalho x- passa: o Graph recusa a mensagem inteira com Auto-Submitted.
  assert.deepEqual(msg.internetMessageHeaders.map(h => h.name), ['X-Auto-Response-Suppress']);

  await mailer.sendEmail({ to: 'outro@example.com', subject: 'x', html: 'x' });
  assert.equal(chamadas.filter(c => c.url.includes('login.microsoftonline.com')).length, 1, 'token em cache');
  assert.match(chamadas.at(-2).url, /patricia\.atendimento%40nexxus\.ia\.br\/messages$/, 'sem área → EMAIL_FROM');
});

test('caixa fora da trava (403) volta como não enviado, com o motivo da Microsoft', async () => {
  respostas = (url) => url.includes('login.microsoftonline.com')
    ? resposta(200, { access_token: 'tok', expires_in: 3600 })
    : resposta(403, { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } });
  const r = await mailer.sendEmail({ to: 'cliente@example.com', subject: 's', html: 'h' });
  assert.equal(r.sent, false);
  assert.equal(r.status, 403);
  assert.match(r.reason, /ErrorAccessDenied/);
  assert.equal(chamadas.filter(c => c.url.endsWith('/send')).length, 0, 'sem rascunho, não tenta enviar');
});

test('segredo errado não derruba o processo: vira envio não feito', async () => {
  respostas = () => resposta(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret.' });
  const r = await mailer.sendEmail({ to: 'cliente@example.com', subject: 's', html: 'h' });
  assert.equal(r.sent, false);
  assert.match(r.reason, /AADSTS7000215/);
});
