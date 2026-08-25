// Patrícia inbound — webhook do Resend: assinatura Svix, casamento com o lead e
// idempotência pelo svix-id.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DB_FILE = path.join('/tmp', `nexxus-inbound-${process.pid}.json`);
process.env.DB_FILE = DB_FILE;
process.env.AGENT_AUTOPILOT = 'off'; // o assunto aqui é receber, não o que o agente faz depois

const SEGREDO_BRUTO = crypto.randomBytes(24).toString('base64');
process.env.EMAIL_WEBHOOK_SECRET = 'whsec_' + SEGREDO_BRUTO;
process.env.EMAIL_INBOUND_ADDRESS = 'patricia@nexxustech.ia.br';

const store = require('./store');
const { seedIfEmpty } = require('./seed');
const api = require('./api');
const { handle } = api;

seedIfEmpty();
after(async () => { await new Promise(r => setTimeout(r, 60)); try { fs.unlinkSync(DB_FILE); } catch {} });

// Assina como o Svix assina: base64(HMAC-SHA256(segredo decodificado, "id.ts.corpo")).
function assina(id, ts, corpoCru, segredo) {
  const chave = Buffer.from(String(segredo || SEGREDO_BRUTO), 'base64');
  return crypto.createHmac('sha256', chave).update(`${id}.${ts}.${corpoCru}`).digest('base64');
}
let seq = 0;
function webhook(payload, o = {}) {
  const corpoCru = JSON.stringify(payload);
  const id = o.id || ('msg_' + (++seq));
  const ts = o.ts || Math.floor(Date.now() / 1000);
  const sig = o.sig || ('v1,' + assina(id, ts, corpoCru, o.segredo));
  return handle({
    method: 'POST', path: '/api/public/email/inbound', body: payload, rawBody: corpoCru,
    user: null, query: {},
    headers: { host: 'localhost:3001', 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': sig },
  });
}
const email = (from, subject, text, extra) => ({ type: 'email.received',
  data: Object.assign({ from, to: ['patricia@nexxustech.ia.br'], subject, text }, extra || {}) });

function leadComContato(empresa, mail, stage) {
  const acc = store.insert('accounts', { name: empresa, cnpj: null, segment: null, city: null });
  const ct = store.insert('contacts', { account_id: acc.id, name: 'Contato', email: mail, phone: null, role_title: null });
  const lead = store.insert('leads', { title: empresa + ' — teste', account_id: acc.id, contact_id: ct.id,
    product_id: null, requested_software: 'Jira', source: 'site', stage: stage || 'novo_lead', owner_id: null,
    hot: 0, status: 'open', lost_reason: null, estimated_value: null, qty: 1, kind: 'b2b', notes: null,
    updated_at: store.now() });
  return { acc, ct, lead };
}

test('assinatura válida registra o e-mail no lead aberto do contato', async () => {
  const { lead } = leadComContato('Alfa Inbound', 'joao@alfa.com');
  const r = await webhook(email('João <joao@alfa.com>', 'Dúvida sobre o Jira', 'Quantas licenças mínimas?'));

  assert.equal(r.status, 200);
  assert.equal(r.body.data.lead_id, lead.id);
  assert.equal(r.body.data.created, false, 'casou com o lead existente em vez de criar outro');

  const entrada = store.find('activities', a => a.lead_id === lead.id && a.type === 'email_in');
  assert.equal(entrada.length, 1);
  assert.equal(entrada[0].email_from, 'joao@alfa.com', 'extraiu o e-mail de "Nome <e@mail>"');
  assert.equal(entrada[0].email_subject, 'Dúvida sobre o Jira');
  assert.equal(entrada[0].email_body, 'Quantas licenças mínimas?');
});

test('assinatura inválida é rejeitada com 401', async () => {
  const antes = store.all('activities').length;
  const r = await webhook(email('x@y.com', 'Oi', 'texto'), { sig: 'v1,ZmFsc2E=' });
  assert.equal(r.status, 401);
  assert.equal(store.all('activities').length, antes, 'nada foi gravado');
});

test('assinatura feita com outro segredo não passa', async () => {
  const outro = crypto.randomBytes(24).toString('base64');
  const r = await webhook(email('x@y.com', 'Oi', 'texto'), { segredo: outro });
  assert.equal(r.status, 401);
});

test('corpo adulterado depois de assinado não passa', async () => {
  const original = email('joao@alfa.com', 'Original', 'texto');
  const corpoCru = JSON.stringify(original);
  const id = 'msg_adulterado', ts = Math.floor(Date.now() / 1000);
  const sig = 'v1,' + assina(id, ts, corpoCru);
  const r = await handle({
    method: 'POST', path: '/api/public/email/inbound',
    body: email('joao@alfa.com', 'Trocado', 'outro texto'),
    rawBody: JSON.stringify(email('joao@alfa.com', 'Trocado', 'outro texto')),
    user: null, query: {},
    headers: { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': sig },
  });
  assert.equal(r.status, 401, 'a assinatura é sobre os bytes originais');
});

test('timestamp velho (replay) é rejeitado', async () => {
  const velho = Math.floor(Date.now() / 1000) - 6 * 60;
  const r = await webhook(email('joao@alfa.com', 'Antigo', 'texto'), { ts: velho });
  assert.equal(r.status, 401);

  const futuro = Math.floor(Date.now() / 1000) + 6 * 60;
  assert.equal((await webhook(email('joao@alfa.com', 'Futuro', 'texto'), { ts: futuro })).status, 401);
});

test('cabeçalhos de assinatura ausentes dão 400', async () => {
  const r = await handle({ method: 'POST', path: '/api/public/email/inbound', body: {}, rawBody: '{}',
    user: null, query: {}, headers: {} });
  assert.equal(r.status, 400);
});

test('o mesmo svix-id não é processado duas vezes', async () => {
  const { lead } = leadComContato('Beta Inbound', 'maria@beta.com');
  const payload = email('maria@beta.com', 'Retorno', 'Podemos fechar?');

  const r1 = await webhook(payload, { id: 'msg_repetido' });
  const r2 = await webhook(payload, { id: 'msg_repetido' });

  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.data.duplicated, true);
  assert.equal(store.find('activities', a => a.lead_id === lead.id && a.type === 'email_in').length, 1,
    'a retentativa do Resend não vira segunda mensagem');
});

test('remetente desconhecido cria lead novo com origem email', async () => {
  const r = await webhook(email('novo@empresa-nova.com', 'Quero uma cotação', 'Preciso de 30 licenças do AutoCAD.'));

  assert.equal(r.status, 200);
  assert.equal(r.body.data.created, true);
  const lead = store.get('leads', r.body.data.lead_id);
  assert.equal(lead.source, 'email');
  assert.equal(lead.kind, 'b2b');
  assert.equal(lead.stage, 'novo_lead');
  assert.equal(lead.status, 'open');
  assert.equal(lead.notes, 'Preciso de 30 licenças do AutoCAD.', 'o texto do e-mail vira a nota do lead');

  const ct = store.get('contacts', lead.contact_id);
  assert.equal(ct.email, 'novo@empresa-nova.com');
  assert.ok(store.find('activities', a => a.lead_id === lead.id && a.type === 'email_in').length === 1);
  assert.ok(store.find('notifications', n => n.lead_id === lead.id && n.type === 'lead_new').length === 1);
});

test('contato conhecido sem negócio aberto ganha um lead novo em vez de perder o e-mail', async () => {
  const { ct, lead } = leadComContato('Gama Inbound', 'carlos@gama.com');
  store.update('leads', lead.id, { status: 'won' });

  const r = await webhook(email('carlos@gama.com', 'Nova demanda', 'Agora quero Confluence.'));
  assert.equal(r.body.data.created, true);
  const novo = store.get('leads', r.body.data.lead_id);
  assert.notEqual(novo.id, lead.id);
  assert.equal(novo.contact_id, ct.id, 'reaproveita o contato que já existia');
  assert.equal(novo.account_id, lead.account_id, 'e a mesma empresa');
});

test('e-mail só em HTML tem o texto extraído', async () => {
  const { lead } = leadComContato('Delta Inbound', 'ana@delta.com');
  const r = await webhook(email('ana@delta.com', 'Em HTML', undefined,
    { html: '<html><body><p>Bom dia!</p><p>Seguem as <b>30</b> licenças.</p></body></html>' }));

  assert.equal(r.status, 200);
  const act = store.find('activities', a => a.lead_id === lead.id && a.type === 'email_in')[0];
  assert.match(act.email_body, /Bom dia!/);
  assert.match(act.email_body, /30/);
  assert.ok(!/</.test(act.email_body), 'sem tags no corpo guardado');
});

test('sem EMAIL_WEBHOOK_SECRET a rota responde 503 em vez de aceitar qualquer coisa', async () => {
  const guardado = process.env.EMAIL_WEBHOOK_SECRET;
  delete process.env.EMAIL_WEBHOOK_SECRET;
  const r = await webhook(email('x@y.com', 'Oi', 'texto'));
  process.env.EMAIL_WEBHOOK_SECRET = guardado;
  assert.equal(r.status, 503);
});

// ====================================================================
// Trava de laço: robô não conversa com robô
// ====================================================================
test('resposta automática (Auto-Submitted) é ignorada sem virar atividade', async () => {
  const { lead } = leadComContato('Ferias Inbound', 'ferias@empresa.com');
  const antes = store.find('activities', a => a.lead_id === lead.id).length;

  const r = await webhook(email('ferias@empresa.com', 'Fora do escritório', 'Estou de férias até dia 20.',
    { headers: { 'Auto-Submitted': 'auto-replied' } }));

  assert.equal(r.status, 200, 'responde 200 para o Resend não ficar retentando');
  assert.match(r.body.data.ignored, /resposta automática/);
  assert.equal(store.find('activities', a => a.lead_id === lead.id).length, antes, 'nada foi registrado');
});

test('Precedence bulk, X-Auto-Response-Suppress e lista são ignorados', async () => {
  const casos = [
    { 'Precedence': 'bulk' },
    { 'Precedence': 'auto_reply' },
    { 'X-Auto-Response-Suppress': 'All' },
    { 'List-Unsubscribe': '<mailto:x@y.com>' },
  ];
  for (const headers of casos) {
    const r = await webhook(email('alguem@empresa.com', 'Boletim', 'texto', { headers }));
    assert.match(r.body.data.ignored, /resposta automática/, JSON.stringify(headers));
  }
});

test('Auto-Submitted: no é e-mail de gente e passa normalmente', async () => {
  const { lead } = leadComContato('Humano Inbound', 'humano@empresa.com');
  const r = await webhook(email('humano@empresa.com', 'Oi', 'Mensagem de verdade.',
    { headers: { 'Auto-Submitted': 'no' } }));
  assert.equal(r.body.data.lead_id, lead.id);
});

test('remetentes de sistema (mailer-daemon, no-reply, postmaster) são ignorados', async () => {
  for (const de of ['mailer-daemon@google.com', 'no-reply@empresa.com', 'noreply@empresa.com', 'postmaster@x.com', 'bounce@y.com']) {
    const r = await webhook(email(de, 'Falha na entrega', 'texto'));
    assert.match(r.body.data.ignored, /resposta automática/, de);
  }
});

// ====================================================================
// Semântica do evento
// ====================================================================
test('evento que não é email.received é ignorado', async () => {
  for (const tipo of ['email.delivered', 'email.bounced', 'email.opened', undefined]) {
    const p = email('joao@alfa.com', 'x', 'y'); p.type = tipo;
    const r = await webhook(p);
    assert.equal(r.status, 200);
    assert.match(r.body.data.ignored, /não é email.received/);
  }
});

test('e-mail endereçado a outra caixa é ignorado', async () => {
  const r = await webhook(email('joao@alfa.com', 'x', 'y', { to: ['financeiro@nexxustech.ia.br'] }));
  assert.match(r.body.data.ignored, /EMAIL_INBOUND_ADDRESS/);
});

// ====================================================================
// From forjado e enxurrada
// ====================================================================
test('DMARC fail não casa com contato existente — vai para quarentena', async () => {
  const { lead } = leadComContato('Vitima Inbound', 'diretor@vitima.com');
  const antes = store.find('activities', a => a.lead_id === lead.id).length;

  const r = await webhook(email('diretor@vitima.com', 'Mude a conta bancária', 'Segue novo PIX.',
    { headers: { 'Authentication-Results': 'mx.google.com; spf=fail; dkim=fail; dmarc=fail header.from=vitima.com' } }));

  assert.equal(r.status, 200);
  assert.equal(r.body.data.quarantined, true);
  assert.equal(store.find('activities', a => a.lead_id === lead.id).length, antes,
    'e-mail forjado NÃO entra no negócio de outra pessoa');
  assert.ok(store.find('notifications', n => n.type === 'email_quarentena').length >= 1, 'um humano é avisado');
});

test('DMARC pass segue o fluxo normal', async () => {
  const { lead } = leadComContato('Legit Inbound', 'ok@legit.com');
  const r = await webhook(email('ok@legit.com', 'Tudo certo', 'texto',
    { headers: { 'Authentication-Results': 'mx.google.com; spf=pass; dkim=pass; dmarc=pass' } }));
  assert.equal(r.body.data.lead_id, lead.id);
});

test('enxurrada do mesmo domínio para de virar lead depois do limite', async () => {
  api._resetLimiteCriacao();
  const criados = [];
  for (let i = 0; i < 7; i++) {
    const r = await webhook(email(`pessoa${i}@spam-inc.com`, 'Oferta ' + i, 'texto'));
    criados.push(r.body.data);
  }
  const viraramLead = criados.filter(d => d.created).length;
  const barrados = criados.filter(d => d.quarantined);

  assert.equal(viraramLead, 5, 'no máximo 5 leads/hora por domínio');
  assert.equal(barrados.length, 2);
  assert.match(barrados[0].reason, /5 leads\/hora do domínio spam-inc\.com/);
  assert.ok(store.find('notifications', n => n.type === 'email_quarentena').length >= 1);
  api._resetLimiteCriacao();
});

test('limite global segura a enxurrada vinda de muitos domínios', async () => {
  api._resetLimiteCriacao();
  let barrado = 0;
  for (let i = 0; i < 24; i++) {
    const r = await webhook(email(`alguem@dominio-${i}.com`, 'Oi', 'texto'));
    if (r.body.data.quarantined) barrado++;
  }
  assert.ok(barrado >= 4, 'passou de 20/hora no total e começou a barrar');
  api._resetLimiteCriacao();
});

// ====================================================================
// Threading
// ====================================================================
test('In-Reply-To casa a resposta com o lead exato, mesmo com outro lead mais novo', async () => {
  api._resetLimiteCriacao();
  const antigo = leadComContato('Thread Inbound', 'ana@thread.com');
  // A Patrícia mandou um e-mail nesse lead e guardou o message-id.
  api.logEmailOut(antigo.lead.id, null, 'ana@thread.com', 'Sua proposta', 'corpo', 'resend-abc-123');
  // Depois o MESMO contato ganhou um lead mais novo — o casamento por remetente pegaria este.
  const novo = store.insert('leads', { title: 'Lead mais novo', account_id: antigo.acc.id, contact_id: antigo.ct.id,
    product_id: null, source: 'site', stage: 'novo_lead', owner_id: null, hot: 0, status: 'open',
    qty: 1, kind: 'b2b', notes: null, updated_at: store.now() });

  const r = await webhook(email('ana@thread.com', 'Re: Sua proposta', 'Aceito!',
    { headers: { 'In-Reply-To': '<resend-abc-123>' } }));

  assert.equal(r.body.data.lead_id, antigo.lead.id, 'o In-Reply-To manda, não a data');
  assert.notEqual(r.body.data.lead_id, novo.id);
});

test('References com vários ids também encontra o lead', async () => {
  const t = leadComContato('Refs Inbound', 'bruno@refs.com');
  api.logEmailOut(t.lead.id, null, 'bruno@refs.com', 'Proposta', 'corpo', 'resend-xyz-999');
  const r = await webhook(email('bruno@refs.com', 'Re: Proposta', 'ok',
    { headers: { 'References': '<outro-id@mail> <resend-xyz-999> <mais-um@mail>' } }));
  assert.equal(r.body.data.lead_id, t.lead.id);
});

test('In-Reply-To desconhecido cai no comportamento antigo (casa por remetente)', async () => {
  const t = leadComContato('Fallback Inbound', 'carla@fallback.com');
  const r = await webhook(email('carla@fallback.com', 'Oi', 'texto',
    { headers: { 'In-Reply-To': '<id-que-nao-existe>' } }));
  assert.equal(r.body.data.lead_id, t.lead.id);
});

// ====================================================================
// Fail-closed do destinatário e dedupe com estado
// ====================================================================
test('sem EMAIL_INBOUND_ADDRESS a rota fica desligada (503), não aberta a todos', async () => {
  const guardado = process.env.EMAIL_INBOUND_ADDRESS;
  delete process.env.EMAIL_INBOUND_ADDRESS;
  const r = await webhook(email('joao@alfa.com', 'Oi', 'texto'));
  process.env.EMAIL_INBOUND_ADDRESS = guardado;
  assert.equal(r.status, 503);
  assert.match(r.body.error.message, /EMAIL_INBOUND_ADDRESS/);
});

test('falha transitória no meio libera o evento — a retentativa do Resend processa', async () => {
  const { lead } = leadComContato('Retry Inbound', 'retry@empresa.com');
  const payload = email('retry@empresa.com', 'Preciso de cotação', 'Quero 10 licenças.');

  // Pane de persistência bem na hora de gravar o e-mail na timeline.
  const insertOriginal = store.insert;
  store.insert = function (coll, obj) {
    if (coll === 'activities' && obj && obj.type === 'email_in') throw new Error('pane ao gravar no banco');
    return insertOriginal.call(store, coll, obj);
  };

  await assert.rejects(() => webhook(payload, { id: 'msg_retry' }), /pane ao gravar/);
  store.insert = insertOriginal;
  assert.equal(store.find('activities', a => a.lead_id === lead.id && a.type === 'email_in').length, 0,
    'a transação não deixou meio-caminho registrado como concluída');
  assert.equal(store.findOne('webhook_events', e => e.event_id === 'msg_retry'), null,
    'o evento foi liberado em vez de ficar marcado como visto');

  // Resend retenta o MESMO evento — e agora tem de processar de verdade.
  const r2 = await webhook(payload, { id: 'msg_retry' });

  assert.ok(!r2.body.data.duplicated, 'a retentativa NÃO pode ser descartada como duplicada');
  assert.equal(r2.body.data.lead_id, lead.id);
  assert.equal(store.find('activities', a => a.lead_id === lead.id && a.type === 'email_in').length, 1,
    'o e-mail que quase se perdeu está registrado — uma vez só');
});

test('evento concluído com sucesso é que responde duplicated na retentativa', async () => {
  const { lead } = leadComContato('Done Inbound', 'done@empresa.com');
  const payload = email('done@empresa.com', 'Oi', 'texto');
  const r1 = await webhook(payload, { id: 'msg_done' });
  assert.equal(r1.body.data.lead_id, lead.id);

  const ev = store.findOne('webhook_events', e => e.event_id === 'msg_done');
  assert.equal(ev.status, 'done');

  const r2 = await webhook(payload, { id: 'msg_done' });
  assert.equal(r2.body.data.duplicated, true);
  assert.equal(store.find('activities', a => a.lead_id === lead.id && a.type === 'email_in').length, 1);
});

test('entrega ainda em curso (<2 min) é duplicada; travada há mais de 2 min é reprocessada', async () => {
  const { lead } = leadComContato('Inflight Inbound', 'inflight@empresa.com');
  const payload = email('inflight@empresa.com', 'Oi', 'texto');

  // Registro 'processing' recém-criado: é a mesma entrega ainda rodando.
  store.insert('webhook_events', { event_id: 'msg_inflight', source: 'resend_inbound',
    status: 'processing', started_at: store.now() });
  const r1 = await webhook(payload, { id: 'msg_inflight' });
  assert.equal(r1.body.data.duplicated, true);
  assert.equal(r1.body.data.inflight, true);

  // Agora envelhece o registro: a tentativa anterior claramente morreu.
  const ev = store.findOne('webhook_events', e => e.event_id === 'msg_inflight');
  const velho = new Date(Date.now() - 3 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  store.update('webhook_events', ev.id, { started_at: velho });

  const r2 = await webhook(payload, { id: 'msg_inflight' });
  assert.ok(!r2.body.data.duplicated, 'processamento travado não pode reter o e-mail para sempre');
  assert.equal(r2.body.data.lead_id, lead.id);
  assert.equal(store.findOne('webhook_events', e => e.event_id === 'msg_inflight').status, 'done');
});

test('header com várias assinaturas passa se UMA bater (rotação de segredo)', async () => {
  const { lead } = leadComContato('Epsilon Inbound', 'rot@eps.com');
  const payload = email('rot@eps.com', 'Rotação', 'texto');
  const corpoCru = JSON.stringify(payload);
  const id = 'msg_rotacao', ts = Math.floor(Date.now() / 1000);
  const boa = assina(id, ts, corpoCru);
  const r = await handle({ method: 'POST', path: '/api/public/email/inbound', body: payload, rawBody: corpoCru,
    user: null, query: {},
    headers: { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': 'v1,ZmFsc2E= v1,' + boa } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.lead_id, lead.id);
});
