// FAQ que aprende — captura pelo BDR, dedupe sem IA, uso no contexto do agente e rotas.
// O modelo e o mailer são stubados por require.cache: nenhum teste toca rede.
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const DB_FILE = path.join('/tmp', `nexxus-faq-${process.pid}.json`);
process.env.DB_FILE = DB_FILE;
process.env.AGENT_AUTOPILOT = 'on';
process.env.BASE_URL = 'https://crm.teste.local';

// ---- stub do LLM ----
const llmPath = require.resolve('./llm');
let respostaLLM = null;    // decisão do SDR / entrada de FAQ
let promptsLLM = [];
require.cache[llmPath] = {
  id: llmPath, filename: llmPath, loaded: true,
  exports: {
    chatJSON: async (args) => {
      promptsLLM.push(args);
      if (respostaLLM instanceof Error) throw respostaLLM;
      return typeof respostaLLM === 'function' ? respostaLLM(args) : respostaLLM;
    },
    isConfigured: () => true, provider: () => 'stub', model: () => 'modelo-de-teste',
  },
};
// ---- stub do mailer ----
const mailerPath = require.resolve('./mailer');
let enviados = [];
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true,
  exports: { sendEmail: async (m) => { enviados.push(m); return { sent: true, status: 200, id: 'msg-1' }; }, isConfigured: () => true },
};

const store = require('./store');
const { seedIfEmpty } = require('./seed');
const { handle } = require('./api');
const faq = require('./faq');
const agent = require('./agentNexus');

seedIfEmpty();
const admin = store.findOne('users', u => u.role === 'admin');
const user = { id: admin.id, email: admin.email, area: admin.area, role: admin.role };
const call = (method, p, body, opts = {}) =>
  handle(Object.assign({ method, path: p, body: body || {}, user, query: {}, headers: { host: 'localhost:3001' } }, opts));
const tique = () => new Promise(r => setTimeout(r, 40));

after(async () => { await tique(); try { fs.unlinkSync(DB_FILE); } catch {} });
beforeEach(() => {
  enviados = []; promptsLLM = []; respostaLLM = null;
  store.all('faq_entries').forEach(f => store.remove('faq_entries', f.id));
});

function leadEscalado(empresa, resumo) {
  const acc = store.insert('accounts', { name: empresa, cnpj: null, segment: null, city: null });
  const ct = store.insert('contacts', { account_id: acc.id, name: 'Contato', email: 'cliente@example.com', phone: null, role_title: null });
  const lead = store.insert('leads', { title: empresa + ' — teste', account_id: acc.id, contact_id: ct.id,
    product_id: null, requested_software: 'Jira Software', source: 'site', stage: 'novo_lead', owner_id: null,
    hot: 0, status: 'open', lost_reason: null, estimated_value: null, qty: 5, kind: 'b2b', notes: 'Preciso de licenças.',
    updated_at: store.now() });
  store.update('leads', lead.id, { needs_bdr: 1, bdr_summary: resumo, bdr_options: ['A', 'B', 'C'],
    bdr_mask: 'sdr', bdr_at: store.now(), agent_mask: 'sdr', agent_done_stage: 'novo_lead' });
  return lead;
}

// ---------- captura ----------
test('o "sim" do BDR vira RASCUNHO de FAQ generalizado, sem bloquear a resposta', async () => {
  const lead = leadEscalado('Alfa FAQ', 'Cliente perguntou se a Nexxus emite nota fiscal nacional.');
  respostaLLM = {
    virar_faq: true,
    question: 'A Nexxus emite nota fiscal nacional na compra de software internacional?',
    answer: 'Sim. A compra é faturada no Brasil, com nota fiscal nacional e valores em reais conforme a tabela vigente.',
    reason: 'dúvida comum de qualquer cliente B2B',
  };

  const r = await call('POST', `/api/bdr/${lead.id}/resolve`,
    { decision: 'yes', message: 'Sim, emitimos nota fiscal nacional. A Acme Ltda recebe a NF em reais.' });
  assert.equal(r.status, 200);
  assert.equal(store.all('faq_entries').length, 0, 'a geração é assíncrona: o clique não espera a IA');

  await tique();
  const entradas = store.all('faq_entries');
  assert.equal(entradas.length, 1);
  assert.equal(entradas[0].question, respostaLLM.question);
  // Nasce INATIVA de propósito: a pergunta vem de texto do cliente processado pela IA —
  // só entra no prompt do agente depois que alguém do time ativar na tela FAQ.
  assert.equal(entradas[0].active, 0);
  assert.equal(entradas[0].source_lead_id, lead.id);
  assert.equal(entradas[0].created_by, admin.id);
  assert.ok(!/Acme/.test(entradas[0].answer), 'a resposta oficial não carrega o nome do cliente');

  const prompt = promptsLLM.find(p => p.schemaName === 'entrada_faq');
  assert.ok(prompt, 'a pendência foi mandada para o modelo');
  assert.match(prompt.user, /<<<DADOS_DO_CLIENTE>>>/, 'texto do cliente vai cercado, como dado');
  assert.ok(store.find('activities', a => a.lead_id === lead.id).some(a => a.type === 'faq'),
    'a timeline registra que a dúvida virou FAQ');
});

test('caso específico demais não vira FAQ', async () => {
  const lead = leadEscalado('Beta FAQ', 'Cliente pediu 15% de desconto excepcional aprovado pela diretoria.');
  respostaLLM = { virar_faq: false, question: '', answer: '', reason: 'exceção pontual daquele contrato' };
  await call('POST', `/api/bdr/${lead.id}/resolve`, { decision: 'yes', message: 'Aprovado só neste caso.' });
  await tique();
  assert.equal(store.all('faq_entries').length, 0);
});

test('BDR sem pendência registrada não gera FAQ nem chama a IA', async () => {
  const lead = leadEscalado('Gama FAQ', null);
  store.update('leads', lead.id, { bdr_summary: null });
  await call('POST', `/api/bdr/${lead.id}/resolve`, { decision: 'yes', message: 'Respondido.' });
  await tique();
  assert.equal(store.all('faq_entries').length, 0);
  assert.equal(promptsLLM.filter(p => p.schemaName === 'entrada_faq').length, 0);
});

// ---------- dedupe ----------
test('pergunta muito parecida não duplica a FAQ', async () => {
  faq.salvarSeNova({ question: 'Vocês parcelam o pagamento em quantas vezes?',
    answer: 'Parcelamos conforme a política vigente.', sourceLeadId: null, createdBy: admin.id });

  const igual = faq.salvarSeNova({ question: 'Em quantas vezes vocês parcelam o pagamento?', answer: 'Outra redação.' });
  assert.equal(igual.salvo, null);
  assert.match(igual.motivo, /parecida/);
  assert.equal(store.all('faq_entries').length, 1);

  // Pergunta de outro assunto entra normalmente.
  const nova = faq.salvarSeNova({ question: 'O suporte técnico atende em português?', answer: 'Sim, suporte em português.' });
  assert.ok(nova.salvo);
  assert.equal(store.all('faq_entries').length, 2);

  // Entrada desativada não bloqueia: se o time desligou, a pergunta pode ser recadastrada.
  store.update('faq_entries', nova.salvo.id, { active: 0 });
  const rec = faq.salvarSeNova({ question: 'O suporte técnico atende em português?', answer: 'Sim.' });
  assert.ok(rec.salvo);
});

test('o dedupe é conservador com perguntas curtas e com assuntos diferentes', () => {
  assert.equal(faq.pareceRepetida('Tem desconto?', 'Tem desconto para ONG?'), false, 'duas palavras casam com tudo');
  assert.equal(faq.pareceRepetida('Vocês emitem nota fiscal nacional?',
    'Vocês fazem treinamento de implantação da ferramenta?'), false);
  assert.equal(faq.pareceRepetida('Vocês emitem nota fiscal nacional para compra internacional?',
    'A nota fiscal nacional é emitida na compra internacional?'), true);
});

test('a captura pelo BDR também passa pelo dedupe', async () => {
  faq.salvarSeNova({ question: 'A Nexxus emite nota fiscal nacional na compra internacional?', answer: 'Sim, emitimos.' });
  const lead = leadEscalado('Delta FAQ', 'Cliente perguntou sobre nota fiscal.');
  respostaLLM = { virar_faq: true, question: 'A nota fiscal nacional é emitida na compra internacional pela Nexxus?',
    answer: 'Sim.', reason: 'comum' };
  await call('POST', `/api/bdr/${lead.id}/resolve`, { decision: 'yes', message: 'Sim, emitimos NF nacional.' });
  await tique();
  assert.equal(store.all('faq_entries').length, 1, 'a mesma dúvida não vira duas entradas');
});

// ---------- uso pelo agente ----------
test('o contexto do agente carrega as FAQ ativas, com a instrução de não escalar', () => {
  faq.salvarSeNova({ question: 'O suporte é em português?', answer: 'Sim, suporte em português durante todo o contrato.' });
  const inativa = faq.salvarSeNova({ question: 'Vocês atendem fora do horário comercial em plantão?', answer: 'Somente em contrato específico.' });
  store.update('faq_entries', inativa.salvo.id, { active: 0 });

  const lead = leadEscalado('Epsilon FAQ', 'x');
  const ctx = agent.contextoLead(require('./api').leadWithJoins(lead.id));
  assert.match(ctx, /FAQ OFICIAL DA NEXXUS/);
  assert.match(ctx, /NÃO escale por dúvidas cobertas aqui/);
  assert.match(ctx, /suporte em português durante todo o contrato/);
  assert.ok(!/plantão/.test(ctx), 'entrada desativada sai do contexto do agente');
});

test('o bloco de FAQ respeita o teto de 30 entradas e ~4000 caracteres', () => {
  // Assuntos propositalmente distintos: aqui o teto é o assunto, não o dedupe.
  for (let i = 0; i < 40; i++)
    faq.salvarSeNova({ question: 'Pergunta sobre assuntoum' + i + ', assuntodois' + i + ' e assuntotres' + i + '?',
      answer: 'Resposta oficial ' + i + ': texto suficiente para ocupar espaço no contexto do agente. '.repeat(2) });
  assert.equal(faq.ativas().length, 40);

  const bloco = faq.blocoContexto();
  const entradas = bloco.split('\n    P: ').length - 1;
  assert.ok(entradas <= 30, 'no máximo 30 entradas, veio ' + entradas);
  assert.ok(bloco.length < 4600, 'bloco cabe no orçamento de contexto: ' + bloco.length);
  // As mais recentes primeiro: a última cadastrada tem de estar lá, a primeira não.
  assert.match(bloco, /assuntoum39/);
  assert.ok(!/assuntoum0[^0-9]/.test(bloco), 'a mais antiga é a que fica de fora');
});

test('dúvida coberta pela FAQ é respondida pela máscara SDR em vez de virar caso de BDR', async () => {
  // O stub faz o que se espera do modelo: se a resposta oficial está no prompt, ele usa;
  // se não estiver, escala. É exatamente o comportamento que a FAQ muda.
  respostaLLM = (args) => {
    const cobre = /suporte em português durante todo o contrato/.test(args.user);
    return { decision: cobre ? 'reply_and_advance' : 'escalate', confidence: 95,
      reply_subject: 'Sobre o suporte', reply_body: cobre ? 'Sim, o suporte é em português durante todo o contrato.' : '',
      bdr_summary: cobre ? '' : 'Não sei responder sobre o suporte.', bdr_options: cobre ? [] : ['a', 'b', 'c'],
      reason: 'faq' };
  };
  const criar = (empresa) => {
    const acc = store.insert('accounts', { name: empresa, cnpj: null, segment: null, city: null });
    const ct = store.insert('contacts', { account_id: acc.id, name: 'Contato', email: 'cliente@example.com', phone: null, role_title: null });
    return store.insert('leads', { title: empresa + ' — teste', account_id: acc.id, contact_id: ct.id,
      product_id: null, requested_software: 'Jira Software', source: 'site', stage: 'novo_lead', owner_id: null,
      hot: 0, status: 'open', lost_reason: null, estimated_value: null, qty: 5, kind: 'b2b',
      notes: 'O suporte de vocês é em português?', updated_at: store.now() });
  };
  // Antes da FAQ: a mesma dúvida vai para a fila do BDR.
  const semFaq = criar('Zeta sem FAQ');
  const antes = await agent.runLead(semFaq.id);
  assert.ok(antes.passos.some(p => p.action === 'escalate' && p.mask === 'sdr'), 'sem FAQ, a SDR escala');
  assert.equal(store.get('leads', semFaq.id).needs_bdr, 1);
  assert.equal(enviados.length, 0);

  // Depois que o time cadastrou a resposta oficial:
  faq.salvarSeNova({ question: 'O suporte técnico é em português?',
    answer: 'Sim: suporte em português durante todo o contrato, com SLA da revenda oficial.' });
  const comFaq = criar('Zeta com FAQ');
  const depois = await agent.runLead(comFaq.id);

  assert.ok(!depois.passos.some(p => p.action === 'escalate' && p.mask === 'sdr'), 'com FAQ, a SDR não escala mais');
  assert.deepEqual(depois.passos[0], { action: 'advance', mask: 'sdr' });
  assert.equal(store.get('leads', comFaq.id).stage, 'aguardando_cotacao', 'respondeu e o funil andou');
  assert.equal(enviados.length, 1);
  assert.match(enviados[0].html, /suporte é em português/);
});

// ---------- rotas ----------
test('rotas da FAQ: listar, criar, editar e desativar (Vendas/Admin)', async () => {
  const criada = await call('POST', '/api/faq', { question: 'Vocês vendem licença acadêmica com desconto?',
    answer: 'Sim, mediante comprovação da instituição, conforme a tabela vigente.' });
  assert.equal(criada.status, 201);
  const id = criada.body.data.id;

  const lista = await call('GET', '/api/faq');
  assert.equal(lista.status, 200);
  assert.equal(lista.body.data.items.length, 1);
  assert.equal(lista.body.data.active, 1);
  assert.equal(lista.body.data.items[0].created_by_name, admin.name);

  const editada = await call('PATCH', `/api/faq/${id}`, { answer: 'Sim, com comprovação da instituição.' });
  assert.equal(editada.status, 200);
  assert.equal(store.get('faq_entries', id).answer, 'Sim, com comprovação da instituição.');

  const off = await call('PATCH', `/api/faq/${id}`, { active: 0 });
  assert.equal(off.body.data.active, 0);
  assert.equal(faq.ativas().length, 0);
  assert.equal((await call('GET', '/api/faq')).body.data.items.length, 1, 'inativa continua listada na tela');

  const vazia = await call('PATCH', `/api/faq/${id}`, { question: '   ' });
  assert.equal(vazia.status, 400, 'pergunta vazia não passa');
  assert.equal((await call('POST', '/api/faq', { question: 'só a pergunta' })).status, 400,
    'sem resposta (ou com tipo errado) é erro de validação');
  assert.equal((await call('PATCH', '/api/faq/9999', { active: 1 })).status, 404);
});

test('validação estrita das rotas da FAQ: tipos errados não passam', async () => {
  // Objeto no lugar de texto virava "[object Object]" na base.
  assert.equal((await call('POST', '/api/faq', { question: { a: 1 }, answer: 'x' })).status, 400);
  // source_lead_id tem que apontar para lead existente.
  assert.equal((await call('POST', '/api/faq',
    { question: 'Pergunta válida sobre nota fiscal?', answer: 'Resposta.', source_lead_id: 9999 })).status, 400);
  const ok = await call('POST', '/api/faq', { question: 'Vocês dão suporte em português?',
    answer: 'Sim, durante todo o contrato.' });
  assert.equal(ok.status, 201);
  // "false"/"0" como string eram truthy e ATIVAVAM a entrada; agora ou é estrito ou é 400.
  assert.equal((await call('PATCH', `/api/faq/${ok.body.data.id}`, { active: 'false' })).status, 400);
  assert.equal((await call('PATCH', `/api/faq/${ok.body.data.id}`, { active: '0' })).body.data.active, 0);
  assert.equal((await call('PATCH', `/api/faq/${ok.body.data.id}`, { active: true })).body.data.active, 1);
});

test('editar ou reativar passa pelo mesmo dedupe da criação', async () => {
  const a = await call('POST', '/api/faq', { question: 'Vocês emitem nota fiscal nacional da compra?',
    answer: 'Sim, faturada no Brasil.' });
  const b = await call('POST', '/api/faq', { question: 'Qual o prazo de entrega das licenças?',
    answer: 'Até 2 dias úteis após o pagamento.' });
  assert.equal(a.status, 201); assert.equal(b.status, 201);

  // Editar B deixando a pergunta igual à de A: 409, senão o agente recebe as duas.
  const clone = await call('PATCH', `/api/faq/${b.body.data.id}`,
    { question: 'Vocês emitem nota fiscal nacional da compra de licenças?' });
  assert.equal(clone.status, 409);
  assert.equal(clone.body.data.repetidaDe, a.body.data.id);

  // Desativar A, criar A2 equivalente, e tentar REATIVAR A: mesmo 409.
  await call('PATCH', `/api/faq/${a.body.data.id}`, { active: 0 });
  const a2 = await call('POST', '/api/faq', { question: 'A compra vem com nota fiscal nacional?',
    answer: 'Sim, com NF-e brasileira.' });
  assert.equal(a2.status, 201);
  const reativa = await call('PATCH', `/api/faq/${a.body.data.id}`, { active: 1 });
  assert.equal(reativa.status, 409, 'reativar duplicando entrada ativa equivalente não passa');
  // Editar a própria entrada sem mudar a pergunta continua livre (não colide consigo mesma).
  assert.equal((await call('PATCH', `/api/faq/${a2.body.data.id}`, { answer: 'Sim — NF-e nacional.' })).status, 200);
});

test('quem não é de Vendas nem Admin não vê nem escreve na FAQ', async () => {
  const juridico = store.findOne('users', u => u.area === 'juridico')
    || store.insert('users', { name: 'Jur', email: 'jur@x.com', password_hash: 'x', area: 'juridico', role: 'user', active: 1 });
  const outro = { user: { id: juridico.id, email: juridico.email, area: 'juridico', role: 'user' } };

  assert.equal((await call('GET', '/api/faq', null, outro)).status, 403);
  assert.equal((await call('POST', '/api/faq', { question: 'q', answer: 'a' }, outro)).status, 403);
  assert.equal((await call('PATCH', '/api/faq/1', { active: 0 }, outro)).status, 403);
  assert.equal(store.all('faq_entries').length, 0, 'nada foi criado');
});
