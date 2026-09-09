// M28 — chat do site como canal da oportunidade.
//
// Regra escolhida com o Marcelo em 09/09: visitante curioso NÃO entra no kanban (o funil
// é de oportunidade, não de curioso). A conversa fica guardada e vira oportunidade só
// quando aparece intenção — e-mail deixado ou pedido de orçamento/preço/demonstração.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB_FILE = path.join('/tmp', `nexxus-chat-${process.pid}.json`);
process.env.DB_FILE = DB_FILE;

const store = require('./store');
const { seedIfEmpty } = require('./seed');
const api = require('./api');

seedIfEmpty();
const admin = store.findOne('users', u => u.role === 'admin');
const user = { id: admin.id, email: admin.email, area: admin.area, role: admin.role };

const chat = (body, key) => api.handle({ method:'POST', path:'/api/public/chat', body,
  user:null, query:{}, headers:{ 'x-intake-key': key === undefined ? 'nexxus-intake-dev' : key, host:'localhost:3001' } });
const call = (method, p, body) => api.handle({ method, path:p, body: body||{}, user, query:{}, headers:{ host:'localhost:3001' } });
const atividades = (leadId, tipo) => store.find('activities', a => a.lead_id === leadId && a.type === tipo);

after(async () => {
  await new Promise(r => setTimeout(r, 60));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

test('chave de captura errada é recusada', async () => {
  const r = await chat({ sessionId:'x', messages:[{ role:'user', content:'oi' }] }, 'chave-errada');
  assert.equal(r.status, 401);
});

test('visitante curioso fica guardado e NÃO vira card no funil', async () => {
  const antes = store.all('leads').length;
  const r = await chat({ sessionId:'curioso-1', messages:[
    { role:'user', content:'o Ampler funciona no Excel?' },
    { role:'assistant', content:'Funciona em PowerPoint, Excel, Word e Outlook.' },
  ]});
  assert.equal(r.status, 200);
  assert.equal(r.body.data.lead_id, null, 'curiosidade não abre oportunidade');
  assert.equal(store.all('leads').length, antes, 'o kanban não pode encher de visitante');

  const sessao = store.findOne('chat_sessions', c => c.session_id === 'curioso-1');
  assert.equal(sessao.messages.length, 2, 'a conversa fica guardada mesmo sem lead');
});

test('pedido de orçamento vira oportunidade e leva a conversa inteira junto', async () => {
  const r = await chat({ sessionId:'quente-1', messages:[
    { role:'user', content:'o Ampler funciona no Excel?' },
    { role:'assistant', content:'Sim.' },
    { role:'user', content:'quero um orçamento para 10 licenças, meu e-mail é compras@empresa.com.br' },
    { role:'assistant', content:'Perfeito, vou encaminhar.' },
  ]});
  assert.equal(r.status, 201);
  const leadId = r.body.data.lead_id;
  assert.ok(leadId, 'intenção precisa abrir oportunidade');

  const lead = store.get('leads', leadId);
  assert.equal(lead.source, 'site-chat', 'a origem do lead é o chat do site, não o formulário');
  assert.equal(atividades(leadId, 'chat_in').length, 2, 'as falas do visitante entram na timeline');
  assert.equal(atividades(leadId, 'chat_out').length, 2, 'as do assistente também');
});

test('mensagem nova da mesma sessão continua caindo na oportunidade já aberta', async () => {
  const inicial = await chat({ sessionId:'quente-2', messages:[
    { role:'user', content:'preciso de uma proposta' },
    { role:'assistant', content:'Claro.' },
  ]});
  const leadId = inicial.body.data.lead_id;
  assert.ok(leadId);

  await chat({ sessionId:'quente-2', messages:[
    { role:'user', content:'preciso de uma proposta' },
    { role:'assistant', content:'Claro.' },
    { role:'user', content:'são 50 licenças' },
    { role:'assistant', content:'Anotado.' },
  ]});
  assert.equal(atividades(leadId, 'chat_in').length, 2, 'sem duplicar o que já tinha entrado');
  assert.equal(store.findOne('chat_sessions', c => c.session_id === 'quente-2').messages.length, 4);
});

test('reenvio idêntico da mesma conversa não duplica nada', async () => {
  const msgs = [{ role:'user', content:'quero cotação' }, { role:'assistant', content:'ok' }];
  const a = await chat({ sessionId:'repetida', messages: msgs });
  const leadId = a.body.data.lead_id;
  const b = await chat({ sessionId:'repetida', messages: msgs });
  assert.equal(b.body.data.novas, 0);
  assert.equal(atividades(leadId, 'chat_in').length, 1);
});

test('conversa parada pode ser promovida à mão pelo vendedor', async () => {
  await chat({ sessionId:'manual-1', messages:[
    { role:'user', content:'vocês atendem em Belo Horizonte?' },
    { role:'assistant', content:'Atendemos todo o Brasil.' },
  ]});
  const sessao = store.findOne('chat_sessions', c => c.session_id === 'manual-1');
  assert.equal(sessao.lead_id, null);

  const r = await call('POST', `/api/chat-sessions/${sessao.id}/promover`, {});
  assert.equal(r.status, 201);
  const leadId = r.body.data.lead_id;
  assert.equal(atividades(leadId, 'chat_in').length, 1);
  assert.equal(store.get('chat_sessions', sessao.id).lead_id, leadId);
});

test('SITE_CHAT_AUTOLEAD=off desliga a criação automática sem perder a conversa', async () => {
  process.env.SITE_CHAT_AUTOLEAD = 'off';
  try {
    const r = await chat({ sessionId:'desligado-1', messages:[{ role:'user', content:'quero orçamento, email@empresa.com' }] });
    assert.equal(r.body.data.lead_id, null);
    assert.equal(store.findOne('chat_sessions', c => c.session_id === 'desligado-1').messages.length, 1);
  } finally { delete process.env.SITE_CHAT_AUTOLEAD; }
});
