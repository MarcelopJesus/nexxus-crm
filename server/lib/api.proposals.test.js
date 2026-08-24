// Fluxo público da proposta: abertura rastreada, preview, aceite (close won) e recusa.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { rm } = require('node:fs/promises');
const path = require('node:path');

const PORT = 3201;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join('/tmp', `nexxus-proposals-${process.pid}.json`);

let server = null;
let token = null;

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Servidor de teste não iniciou no prazo esperado');
}

async function api(method, url, body, auth = true) {
  const res = await fetch(BASE_URL + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, auth && token ? { Authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// Lead novo com cotação, precificação e proposta enviada. Devolve o id e o token público.
async function novaProposta(titulo, price) {
  const lead = await api('POST', '/api/leads', { title: titulo, requested_software: 'Jira Software', qty: 1 });
  const leadId = lead.body.data.id;
  const quote = await api('POST', '/api/quotes', { lead_id: leadId, cost_amount: 1000, cost_currency: 'USD', qty: 1 });
  await api('POST', '/api/pricing', { lead_id: leadId, quote_id: quote.body.data.id, cost_usd: 1000, qty: 1 });
  const prop = await api('POST', '/api/proposals', { lead_id: leadId, final_price: price });
  assert.equal(prop.status, 201, 'proposta deveria ter sido criada: ' + JSON.stringify(prop.body));
  return { leadId, propToken: prop.body.data.token, propId: prop.body.data.id };
}

// Nova versão da proposta para o mesmo lead (invalida o link anterior).
async function novaVersao(leadId, price) {
  const prop = await api('POST', '/api/proposals', { lead_id: leadId, final_price: price });
  assert.equal(prop.status, 201, 'nova versão deveria ter sido criada: ' + JSON.stringify(prop.body));
  return { propToken: prop.body.data.token, version: prop.body.data.version };
}

const getLead = async (id) => (await api('GET', '/api/leads/' + id)).body.data;
const getPublic = (tok, qs = '') => api('GET', `/api/public/proposals/${tok}${qs}`, undefined, false);
const aceitar = (tok) => api('POST', `/api/public/proposals/${tok}/accept`, {}, false);
const recusar = (tok, reason) => api('POST', `/api/public/proposals/${tok}/reject`, reason === undefined ? {} : { reason }, false);

before(async () => {
  await rm(DB_FILE, { force: true });
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DB_FILE,
      JWT_SECRET: 'jwt-secret-for-proposals-test',
      SUPABASE_URL_CRM: '',
      SUPABASE_SERVICE_KEY_CRM: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer();
  const login = await api('POST', '/api/auth/admin/login', { email: 'joao@nexxustech.one', password: 'senha123' }, false);
  token = login.body.data.token;
  // Câmbio manual: teste não pode depender de API externa.
  await api('PUT', '/api/config/pricing', { fx_mode: 'manual', fx_manual_rate: 5.2 });
});

after(async () => {
  if (server) server.kill('SIGTERM');
  await rm(DB_FILE, { force: true });
});

test('primeira abertura marca vista, move para negociação e conta as seguintes', async () => {
  const { leadId, propToken } = await novaProposta('Teste — abertura', 50000);
  const antes = await getLead(leadId);
  assert.equal(antes.lead.stage, 'proposta_enviada');
  assert.equal(antes.proposals[0].view_count, 0);

  const first = await getPublic(propToken);
  assert.equal(first.status, 200);
  assert.equal(first.body.data.status, 'viewed');

  const depoisDaPrimeira = await getLead(leadId);
  assert.equal(depoisDaPrimeira.lead.stage, 'negociacao', 'abertura move o lead para negociação');
  assert.equal(depoisDaPrimeira.proposals[0].view_count, 1);
  assert.ok(depoisDaPrimeira.proposals[0].viewed_at);
  assert.ok(depoisDaPrimeira.proposals[0].last_viewed_at);
  assert.equal(depoisDaPrimeira.activities.filter(a => a.type === 'stage_change').length, 1);

  await getPublic(propToken);
  await getPublic(propToken);
  const depois = await getLead(leadId);
  assert.equal(depois.proposals[0].view_count, 3, 'toda abertura incrementa o contador');
  assert.equal(depois.activities.filter(a => a.message.includes('foi ABERTA')).length, 1, 'só a primeira abertura registra na timeline');

  const notif = await api('GET', '/api/notifications');
  const vistas = notif.body.data.items.filter(n => n.type === 'proposal_viewed' && n.lead_id === leadId);
  assert.equal(vistas.length, 1, 'aberturas seguintes não notificam de novo');
});

test('preview não registra abertura nem mexe no lead', async () => {
  const { leadId, propToken } = await novaProposta('Teste — preview', 40000);

  const r = await getPublic(propToken, '?preview=1');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'sent');

  const lead = await getLead(leadId);
  assert.equal(lead.lead.stage, 'proposta_enviada', 'preview não move o estágio');
  assert.equal(lead.proposals[0].view_count, 0);
  assert.equal(lead.proposals[0].viewed_at, null);
  assert.equal(lead.proposals[0].last_viewed_at, null);
  assert.equal(lead.activities.filter(a => a.message.includes('foi ABERTA')).length, 0);
});

test('aceite do cliente fecha o negócio como ganho e é idempotente', async () => {
  const { leadId, propToken } = await novaProposta('Teste — aceite', 60000);
  await getPublic(propToken);

  const first = await api('POST', `/api/public/proposals/${propToken}/accept`, {}, false);
  assert.equal(first.status, 200);

  const lead = await getLead(leadId);
  assert.equal(lead.lead.status, 'won');
  assert.equal(lead.lead.estimated_value, 60000);
  assert.equal(lead.proposals[0].status, 'accepted');
  assert.ok(lead.proposals[0].accepted_at);
  assert.ok(lead.contract, 'contrato deveria ter sido criado');
  assert.equal(lead.contract.status, 'pending');
  assert.equal(lead.contract.value, 60000);
  assert.equal(lead.tasks.filter(t => t.type === 'contract' && t.area === 'juridico').length, 1);
  assert.equal(lead.activities.filter(a => a.type === 'close').length, 1);
  assert.equal(lead.activities.find(a => a.type === 'close').user_id, null, 'quem fechou foi o cliente');

  const second = await api('POST', `/api/public/proposals/${propToken}/accept`, {}, false);
  assert.equal(second.status, 200);
  const depois = await getLead(leadId);
  assert.equal(depois.contract.id, lead.contract.id);
  assert.equal(depois.tasks.filter(t => t.type === 'contract').length, 1, 'aceite repetido não duplica a tarefa do jurídico');
  assert.equal(depois.activities.filter(a => a.type === 'close').length, 1);
  assert.equal(depois.activities.filter(a => a.message.includes('ACEITA')).length, 1);
});

test('recusa registra o motivo, não mexe no lead e não duplica', async () => {
  const { leadId, propToken } = await novaProposta('Teste — recusa', 30000);
  await getPublic(propToken);
  const antes = await getLead(leadId);

  const r = await api('POST', `/api/public/proposals/${propToken}/reject`, { reason: 'Preço acima do orçamento' }, false);
  assert.equal(r.status, 200);

  const lead = await getLead(leadId);
  assert.equal(lead.proposals[0].status, 'rejected');
  assert.equal(lead.proposals[0].reject_reason, 'Preço acima do orçamento');
  assert.ok(lead.proposals[0].rejected_at);
  assert.equal(lead.lead.status, 'open', 'marcar como perdido é decisão humana');
  assert.equal(lead.lead.stage, antes.lead.stage, 'recusa não muda o estágio');
  assert.equal(lead.activities.filter(a => a.message.includes('RECUSADA')).length, 1);

  await api('POST', `/api/public/proposals/${propToken}/reject`, { reason: 'de novo' }, false);
  const depois = await getLead(leadId);
  assert.equal(depois.activities.filter(a => a.message.includes('RECUSADA')).length, 1, 'recusar duas vezes não duplica o log');
  assert.equal(depois.proposals[0].reject_reason, 'Preço acima do orçamento', 'mantém o motivo original');
});

test('recusa sem motivo funciona e proposta aceita responde 409', async () => {
  const semMotivo = await novaProposta('Teste — recusa sem motivo', 25000);
  const r = await api('POST', `/api/public/proposals/${semMotivo.propToken}/reject`, {}, false);
  assert.equal(r.status, 200);
  const lead = await getLead(semMotivo.leadId);
  assert.equal(lead.proposals[0].status, 'rejected');
  assert.equal(lead.proposals[0].reject_reason, null);

  const aceita = await novaProposta('Teste — recusa após aceite', 70000);
  await api('POST', `/api/public/proposals/${aceita.propToken}/accept`, {}, false);
  const conflito = await api('POST', `/api/public/proposals/${aceita.propToken}/reject`, { reason: 'mudei de ideia' }, false);
  assert.equal(conflito.status, 409);
  assert.match(conflito.body.error.message, /já foi aceita/);
  const leadAceito = await getLead(aceita.leadId);
  assert.equal(leadAceito.proposals[0].status, 'accepted');
  assert.equal(leadAceito.lead.status, 'won');
});

test('link de versão antiga não pode ser aceito', async () => {
  const { leadId, propToken } = await novaProposta('Teste — versão antiga', 20000);
  await getPublic(propToken);
  const v2 = await novaVersao(leadId, 18000);

  const antiga = await aceitar(propToken);
  assert.equal(antiga.status, 409);
  assert.match(antiga.body.error.message, /proposta mais recente \(v2\)/);
  const aindaAberto = await getLead(leadId);
  assert.equal(aindaAberto.lead.status, 'open');
  assert.equal(aindaAberto.contract, null, 'nada de contrato pela versão vencida');

  const nova = await aceitar(v2.propToken);
  assert.equal(nova.status, 200);
  const fechado = await getLead(leadId);
  assert.equal(fechado.lead.status, 'won');
  assert.equal(fechado.lead.estimated_value, 18000, 'fecha pelo preço da proposta aceita');
  assert.equal(fechado.contract.value, 18000);
});

test('aceite em lead já encerrado responde 409', async () => {
  const perdido = await novaProposta('Teste — aceite em lead perdido', 15000);
  await api('POST', `/api/leads/${perdido.leadId}/close`, { result: 'lost', lost_reason: 'Sem orçamento' });
  const r = await aceitar(perdido.propToken);
  assert.equal(r.status, 409);
  assert.match(r.body.error.message, /já foi encerrado/);
  const lead = await getLead(perdido.leadId);
  assert.equal(lead.lead.status, 'lost');
  assert.equal(lead.contract, null);
  assert.equal(lead.proposals[0].status, 'sent');

  // Fechar como ganho um lead perdido também é barrado (reabrir é decisão humana).
  const won = await api('POST', `/api/leads/${perdido.leadId}/close`, { result: 'won' });
  assert.equal(won.status, 409);
  assert.equal((await getLead(perdido.leadId)).lead.status, 'lost');
});

test('reverter ganho para perdido cancela contrato e encerra a tarefa do jurídico', async () => {
  const { leadId, propToken } = await novaProposta('Teste — ganho revertido', 35000);
  await aceitar(propToken);
  const ganho = await getLead(leadId);
  assert.equal(ganho.contract.status, 'pending');

  const r = await api('POST', `/api/leads/${leadId}/close`, { result: 'lost', lost_reason: 'Cliente cancelou a compra' });
  assert.equal(r.status, 200);
  const lead = await getLead(leadId);
  assert.equal(lead.lead.status, 'lost');
  assert.equal(lead.contract.status, 'cancelled', 'contrato pendente não pode sobrar de pé');
  assert.equal(lead.tasks.filter(t => t.type === 'contract' && !t.done).length, 0);
  assert.match(lead.activities.find(a => a.type === 'close').message, /revertido de GANHO/);
});

test('proposta já decidida não conta mais aberturas', async () => {
  const aceita = await novaProposta('Teste — abertura após aceite', 45000);
  await getPublic(aceita.propToken);
  await aceitar(aceita.propToken);
  const depoisDoAceite = await getLead(aceita.leadId);
  const contadorAceite = depoisDoAceite.proposals[0].view_count;

  await getPublic(aceita.propToken);
  await getPublic(aceita.propToken);
  const lead = await getLead(aceita.leadId);
  assert.equal(lead.proposals[0].view_count, contadorAceite, 'proposta aceita não incrementa mais');
  assert.equal(lead.proposals[0].status, 'accepted');

  const recusada = await novaProposta('Teste — abertura após recusa', 22000);
  await getPublic(recusada.propToken);
  await recusar(recusada.propToken, 'Achamos caro');
  const contadorRecusa = (await getLead(recusada.leadId)).proposals[0].view_count;
  await getPublic(recusada.propToken);
  const leadR = await getLead(recusada.leadId);
  assert.equal(leadR.proposals[0].view_count, contadorRecusa, 'proposta recusada não incrementa mais');
  assert.equal(leadR.proposals[0].status, 'rejected');
});

test('reenvio de e-mail não ressuscita proposta decidida', async () => {
  const recusada = await novaProposta('Teste — reenvio após recusa', 28000);
  await recusar(recusada.propToken, 'Fora do orçamento');
  const envio = await api('POST', `/api/proposals/${recusada.propId}/send-email`, { to: 'cliente@example.com' });
  assert.equal(envio.status, 200);
  assert.equal((await getLead(recusada.leadId)).proposals[0].status, 'rejected');

  const aceita = await novaProposta('Teste — reenvio após aceite', 32000);
  await aceitar(aceita.propToken);
  await api('POST', `/api/proposals/${aceita.propId}/send-email`, { to: 'cliente@example.com' });
  assert.equal((await getLead(aceita.leadId)).proposals[0].status, 'accepted');
});

test('motivo da recusa é truncado e guardado como texto puro', async () => {
  const { leadId, propToken } = await novaProposta('Teste — motivo gigante', 26000);
  const gigante = 'x'.repeat(1500);
  await recusar(propToken, '<img src=x onerror=alert(1)>\n' + gigante);
  const prop = (await getLead(leadId)).proposals[0];
  assert.equal(prop.reject_reason.length, 1000, 'motivo limitado a 1000 caracteres');
  assert.ok(!/[\u0000-\u001F\u007F]/.test(prop.reject_reason), 'sem caracteres de controle');
  assert.ok(prop.reject_reason.startsWith('<img src=x onerror=alert(1)>'), 'guardado como texto puro — quem exibe escapa');
});

test('lead reaberto e ganho não carrega o motivo da perda antiga', async () => {
  const { leadId, propToken } = await novaProposta('Teste — reaberto e ganho', 33000);
  await api('POST', `/api/leads/${leadId}/close`, { result: 'lost', lost_reason: 'Escolheu concorrente' });
  assert.equal((await getLead(leadId)).lead.lost_reason, 'Escolheu concorrente');

  // Reabertura manual (mover de estágio devolve o lead para open).
  await api('PATCH', `/api/leads/${leadId}/stage`, { stage: 'negociacao' });
  assert.equal((await getLead(leadId)).lead.status, 'open');

  const r = await aceitar(propToken);
  assert.equal(r.status, 200);
  const lead = await getLead(leadId);
  assert.equal(lead.lead.status, 'won');
  assert.equal(lead.lead.lost_reason, null, 'negócio ganho não pode exibir motivo de perda');
});

test('reversão para perdido cancela também contrato em elaboração', async () => {
  const { leadId, propToken } = await novaProposta('Teste — contrato em elaboração', 41000);
  await aceitar(propToken);
  const contrato = (await getLead(leadId)).contract;
  await api('PATCH', `/api/contracts/${contrato.id}`, { status: 'drafting' });
  assert.equal((await getLead(leadId)).contract.status, 'drafting');

  await api('POST', `/api/leads/${leadId}/close`, { result: 'lost', lost_reason: 'Cliente desistiu' });
  const lead = await getLead(leadId);
  assert.equal(lead.lead.status, 'lost');
  assert.equal(lead.contract.status, 'cancelled', 'contrato em elaboração não sobrevive à perda');
});

test('aceite depois da recusa limpa o estado de recusada', async () => {
  const { leadId, propToken } = await novaProposta('Teste — mudou de ideia', 27000);
  await recusar(propToken, 'Achei caro');
  const recusada = (await getLead(leadId)).proposals[0];
  assert.equal(recusada.status, 'rejected');
  assert.ok(recusada.rejected_at);

  const r = await aceitar(propToken);
  assert.equal(r.status, 200);
  const prop = (await getLead(leadId)).proposals[0];
  assert.equal(prop.status, 'accepted');
  assert.equal(prop.rejected_at, null, 'não pode aparecer aceita e recusada ao mesmo tempo');
  assert.equal(prop.reject_reason, null);
  const acts = (await getLead(leadId)).activities;
  assert.equal(acts.filter(a => a.message.includes('RECUSADA')).length, 1, 'a recusa continua na timeline');
  assert.equal(acts.filter(a => a.message.includes('ACEITA')).length, 1);
});

test('recusa por link vencido é barrada com 409', async () => {
  const antiga = await novaProposta('Teste — recusa de versão antiga', 19000);
  const v2 = await novaVersao(antiga.leadId, 17000);
  const r = await recusar(antiga.propToken, 'não quero');
  assert.equal(r.status, 409);
  assert.match(r.body.error.message, /proposta mais recente \(v2\)/);
  const lead = await getLead(antiga.leadId);
  assert.equal(lead.proposals.find(p => p.version === 1).status, 'sent', 'a v1 fica intocada');
  assert.equal(lead.activities.filter(a => a.message.includes('RECUSADA')).length, 0, 'sem notificação falsa de recusa');
  assert.equal((await recusar(v2.propToken, 'agora sim')).status, 200);

  const fechado = await novaProposta('Teste — recusa em lead fechado', 21000);
  await api('POST', `/api/leads/${fechado.leadId}/close`, { result: 'lost', lost_reason: 'Sumiu' });
  const bloqueada = await recusar(fechado.propToken, 'tarde demais');
  assert.equal(bloqueada.status, 409);
  assert.match(bloqueada.body.error.message, /já foi encerrado/);

  // Re-recusar a mesma proposta segue idempotente mesmo com o lead já fechado depois.
  const idem = await novaProposta('Teste — recusa idempotente', 23000);
  await recusar(idem.propToken, 'motivo original');
  await api('POST', `/api/leads/${idem.leadId}/close`, { result: 'lost', lost_reason: 'Perdido' });
  const segunda = await recusar(idem.propToken, 'de novo');
  assert.equal(segunda.status, 200);
  const leadIdem = await getLead(idem.leadId);
  assert.equal(leadIdem.proposals[0].reject_reason, 'motivo original');
  assert.equal(leadIdem.activities.filter(a => a.message.includes('RECUSADA')).length, 1);
});

test('token inexistente devolve 404', async () => {
  const r = await getPublic('a'.repeat(32));
  assert.equal(r.status, 404);
});
