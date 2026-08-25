// api.js — rotas REST do Nexxus CRM sobre o store JSON (sem SQL).
'use strict';
const store = require('./store');
const { verifyPassword, sign, hashPassword } = require('./auth');
const { getUsdBrl } = require('./fx');
const { calculatePricing } = require('./pricing');
const { sendEmail, isConfigured } = require('./mailer');
const sdr = require('./sdr');
const catalog = require('./catalogSync');
const S = store; // alias

const STAGES = [
  { key: 'novo_lead',          label: 'Novo Lead',          area: 'marketing' },
  { key: 'triagem',            label: 'Triagem',            area: 'vendas' },
  { key: 'aguardando_cotacao', label: 'Aguardando Cotação', area: 'compras' },
  { key: 'precificacao',       label: 'Precificação',       area: 'vendas' },
  { key: 'proposta_enviada',   label: 'Proposta Enviada',   area: 'vendas' },
  { key: 'negociacao',         label: 'Negociação',         area: 'vendas' },
];
const AREAS = ['vendas','prevendas','compras','produto','marketing','financeiro','juridico','admin'];

function log(leadId, userId, type, message){ S.insert('activities', { lead_id:leadId, user_id:userId||null, type, message }); }
function touchLead(id){ S.update('leads', id, { updated_at: S.now() }); }
function getConfig(){ return S.data.config; }
function byId(coll){ const m={}; S.data[coll].forEach(r=>m[r.id]=r); return m; }
// Nome do cliente para a notificação — lead sem empresa cadastrada não vira "null".
function clientName(lead){ return (lead && (lead.account_name || lead.contact_name || lead.title)) || 'Cliente'; }
function notify(type, message, leadId){ S.insert('notifications', { type, message, lead_id: leadId||null, read:0 }); }
function pickOwner(){
  const vend = S.find('users', u=>u.active && u.area==='vendas');
  if (!vend.length) { const admin = S.findOne('users', u=>u.active && (u.role==='admin'||u.area==='admin')); return admin?admin.id:null; }
  S.data.rr = ((S.data.rr||0) + 1); return vend[S.data.rr % vend.length].id;
}
function makeToken(){ return require('crypto').randomBytes(16).toString('hex'); }
// Vencimento de tarefa no fuso de Brasília: depois das 21h o UTC já virou o dia e o
// D+1 aparecia como D+2 para quem olha a tela.
function dueIn(days){ return new Date(Date.now() + days*86400000).toLocaleDateString('en-CA', { timeZone:'America/Sao_Paulo' }); }
// Inteiro estrito e positivo — '12abc' e 3.9 não viram quantidade.
function intPositivo(v, padrao){
  if (v === null || v === undefined || v === '') return padrao;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : padrao;
}
function baseUrl(req){
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/,'');
  const h = (req && req.headers)||{};
  const proto = (h['x-forwarded-proto']||'http').split(',')[0];
  const host = h['x-forwarded-host'] || h['host'] || 'localhost:3001';
  return proto+'://'+host;
}


// Close Won compartilhado: fechamento manual (Vendas) e aceite do cliente na página
// pública passam por aqui. Só age sobre lead ABERTO — lead já ganho (idempotência) ou
// perdido não ganha contrato/tarefa/notificação novos; quem chama decide o que responder.
// opts.setValue força o valor fechado (o aceite fecha pelo preço da proposta aceita).
function closeWon(leadId, userId, opts) {
  opts = opts || {};
  const before = S.get('leads', leadId); if (!before) return null;
  if (before.status !== 'open') return { skipped: before.status, lead: leadWithJoins(leadId) };
  // lost_reason zerado: lead reaberto depois de perdido não pode fechar carregando o motivo antigo.
  const patch = { status:'won', lost_reason:null, updated_at:S.now() };
  if (opts.value != null && (opts.setValue || !before.estimated_value)) patch.estimated_value = opts.value;
  S.update('leads', leadId, patch);
  const lead = leadWithJoins(leadId);
  const lastProp = S.find('proposals', p=>p.lead_id===leadId).sort((a,b)=>b.version-a.version)[0];
  const val = (opts.setValue && opts.value != null) ? opts.value
    : (lead.estimated_value || opts.value || (lastProp?lastProp.final_price:null));
  S.insert('contracts', { lead_id:leadId, status:'pending', value:val, notes:null });
  const jur = S.findOne('users', u=>u.area==='juridico' && u.active);
  S.insert('tasks', { lead_id:leadId, title:'Emitir contrato — '+lead.title, type:'contract', area:'juridico', assignee_id:jur?jur.id:null, done:0, due_date:null });
  notify('won', `Negócio GANHO: ${lead?lead.title:('#'+leadId)}.`, leadId);
  log(leadId, userId, 'close', opts.message || 'Negócio GANHO (Close Won). Gatilho enviado ao Jurídico.');
  return { skipped:null, lead };
}

// ============ Passos do funil compartilhados ============
// Cada um destes é executado tanto por gente (rota REST) quanto pelo agente Nexus
// (agentNexus.js). Uma implementação só: o que o humano faz e o que o agente faz
// não podem divergir com o tempo.

// Triagem: valida a demanda e despacha para Compras.
// Só age em lead ABERTO e nunca reabre nada: se alguém fechou o negócio enquanto o
// agente pensava, o fechamento vale — reabrir por efeito colateral seria pior que parar.
function triageLead(leadId, userId, mensagem) {
  const atual = S.get('leads', leadId);
  if (!atual || atual.status !== 'open') return null;
  S.update('leads', leadId, { stage:'aguardando_cotacao', updated_at:S.now() });
  const lead = leadWithJoins(leadId);
  const compras = S.findOne('users', u=>u.area==='compras' && u.active);
  S.insert('tasks', { lead_id:leadId, title:'Solicitar cotação ao fabricante: '+(lead.requested_software||lead.title),
    type:'quote_request', area:'compras', assignee_id:compras?compras.id:null, due_date:dueIn(2), done:0 });
  log(leadId, userId, 'triage', mensagem || 'Demanda validada e despachada para Compras (aguardando cotação).');
  return lead;
}

// Close Lost. Reverter um ganho é decisão humana, mas a pendência do Close Won não
// pode ficar de pé: contrato pendente vira cancelado e a tarefa do jurídico encerra.
function closeLost(leadId, userId, motivo, mensagem) {
  const before = S.get('leads', leadId); if (!before) return null;
  const wasWon = before.status === 'won';
  motivo = motivo || 'Não informado';
  S.update('leads', leadId, { status:'lost', lost_reason:motivo, updated_at:S.now() });
  if (wasWon) {
    S.find('contracts', c=>c.lead_id===leadId && (c.status==='pending'||c.status==='drafting')).forEach(c=> S.update('contracts', c.id, { status:'cancelled' }));
    S.find('tasks', t=>t.lead_id===leadId && t.type==='contract' && !t.done).forEach(t=> S.update('tasks', t.id, { done:1 }));
  }
  log(leadId, userId, 'close', (wasWon?'Negócio revertido de GANHO para PERDIDO — contrato pendente cancelado e tarefa do Jurídico encerrada. ':'')
    + (mensagem || ('Negócio PERDIDO (Close Lost). Motivo: '+motivo)));
  if (wasWon) notify('lost_after_won', `Negócio revertido de GANHO para PERDIDO: ${clientName(leadWithJoins(leadId))}. Motivo: ${motivo}.`, leadId);
  return { wasWon };
}

// Cotação recebida do fabricante.
function createQuote(o) {
  const atual = S.get('leads', o.leadId);
  if (!atual || atual.status !== 'open') return null;
  const r = S.insert('quotes', { lead_id:o.leadId, supplier_id:o.supplierId||null, product_id:o.productId||null,
    cost_amount:Number(o.costAmount), cost_currency:o.currency||'USD', qty:o.qty||1,
    supplier_ref:o.ref||null, notes:o.notes||null, status:'received', created_by:o.userId||null });
  const lead = S.get('leads', o.leadId);
  if (lead && ['aguardando_cotacao','triagem','novo_lead'].includes(lead.stage)) S.update('leads', o.leadId, { stage:'precificacao' });
  touchLead(o.leadId);
  notify('quote_received', `Cotação recebida para o lead #${o.leadId}.`, o.leadId);
  log(o.leadId, o.userId, 'quote', o.mensagem
    || `Cotação registrada: ${o.currency||'USD'} ${Number(o.costAmount).toLocaleString('pt-BR')} (ref ${o.ref||'-'}).`);
  return r;
}

// Toda escrita que vem DEPOIS de um await tem de reler o lead: a busca de câmbio ou o
// envio de e-mail levam segundos, e nesse intervalo um humano pode ter fechado, pausado
// ou movido o negócio. Devolve o motivo do aborto, ou null se pode escrever.
function leadMudou(leadId, etapaEsperada) {
  const l = S.get('leads', leadId);
  if (!l) return 'lead removido';
  if (l.status !== 'open') return 'negócio já foi encerrado';
  if (l.agent_paused) return 'agente pausado neste lead';
  if (etapaEsperada && l.stage !== etapaEsperada) return 'etapa mudou para '+l.stage;
  return null;
}

// Revalidação da proposta depois de um await. Sempre relê do banco — nunca confia no
// objeto de antes da chamada de rede. Devolve o motivo do aborto, ou null.
// Chamada pelo AGENTE (exigirEtapa preenchido): exige lead aberto, não pausado e na etapa.
// Chamada MANUAL: o vendedor pode reenviar o link de um negócio já fechado (é reenvio de
// histórico, coberto por teste) — ali o que não pode é a proposta ou o lead terem sumido.
function revalidarProposta(propId, exigirEtapa) {
  const prop = S.get('proposals', propId);
  if (!prop) return 'proposta removida';
  const lead = S.get('leads', prop.lead_id);
  if (!lead) return 'lead removido';
  if (exigirEtapa === undefined) return null;
  return leadMudou(prop.lead_id, exigirEtapa);
}

// Precificação salva (o cálculo em si mora no pricing.js).
// o.exigirEtapa: quando informado, a gravação só acontece se o lead ainda estiver nela.
async function savePricingFor(o) {
  const c = getConfig();
  const fx = c.fx_mode==='manual' ? { rate:c.fx_manual_rate } : await getUsdBrl();
  // getUsdBrl é await de rede: confere o lead antes de gravar qualquer coisa.
  const mudou = leadMudou(o.leadId, o.exigirEtapa);
  if (mudou) return { aborted:mudou };
  const r = calculatePricing({ costUsd:Number(o.costUsd), qty:Number(o.qty)||1,
    fxBase:Number(o.fxBase!=null?o.fxBase:fx.rate), fxSpreadPct:c.fx_spread_pct,
    importTaxPct:c.import_tax_pct, invoiceTaxPct:c.invoice_tax_pct,
    targetMarginPct:c.target_margin_pct, minMarginPct:c.min_margin_pct });
  const row = S.insert('pricings', { lead_id:o.leadId, quote_id:o.quoteId||null, cost_usd:r.costUsd, fx_rate:r.fxRate,
    fx_base:r.fxBase, import_tax_pct:r.importTaxPct, invoice_tax_pct:r.invoiceTaxPct, target_margin_pct:r.targetMarginPct,
    min_margin_pct:r.minMarginPct, cost_brl:r.costBrl, cost_with_import:r.costWithImport,
    suggested_price:r.suggestedPrice, min_price:r.minPrice });
  log(o.leadId, o.userId, 'pricing', o.mensagem
    || `Precificação gerada — Sugerido R$ ${fmt(r.suggestedPrice)} / Mínimo R$ ${fmt(r.minPrice)}.`);
  return { row, calc:r };
}

// Proposta nova (versão n+1). Devolve { belowFloor } quando o preço fura o piso sem
// aprovação — quem chamou decide se recusa (rota) ou nunca chega aqui (agente).
// opts.draft (usado pelo agente): a proposta nasce 'draft' e o lead NÃO muda de estágio.
// Só depois do e-mail sair de verdade ela vira 'sent' (ver promoverProposta) — assim o
// funil nunca mostra "proposta enviada" para um cliente que não recebeu nada.
function createProposal(o) {
  const leadId = o.leadId;
  const atual = S.get('leads', leadId);
  if (!atual || atual.status !== 'open') return { notOpen:true };
  const props = S.find('proposals', p=>p.lead_id===leadId);
  const last = props.reduce((mx,p)=>Math.max(mx,p.version), 0);
  const pricing = S.find('pricings', p=>p.lead_id===leadId).sort(byCreatedDesc)[0];
  const floor = pricing ? pricing.min_price : (o.minPrice||0);
  const suggested = pricing ? pricing.suggested_price : (o.suggestedPrice||null);
  const finalPrice = Number(o.finalPrice);
  const below = floor && finalPrice < floor ? 1 : 0;
  if (below && !o.approveBelowFloor) return { belowFloor:{ floor, suggested, finalPrice } };
  const row = S.insert('proposals', { lead_id:leadId, version:last+1, final_price:finalPrice, min_price:floor||null,
    suggested_price:suggested, below_floor:below, approved_by:below?(o.userId||null):null,
    status: o.draft ? 'draft' : 'sent',
    token:makeToken(), viewed_at:null, accepted_at:null, rejected_at:null, reject_reason:null,
    view_count:0, last_viewed_at:null, created_by:o.userId||null });
  if (o.draft) {
    log(leadId, o.userId, 'proposal', `Proposta v${last+1} montada (rascunho) — R$ ${fmt(finalPrice)}. Aguardando o envio ao cliente.`);
    return { row, draft:true };
  }
  S.update('leads', leadId, { stage:'proposta_enviada', estimated_value:finalPrice, updated_at:S.now() });
  agendarFollowups(leadId, last+1, o.userId);
  log(leadId, o.userId, 'proposal', o.mensagem
    || `Proposta v${last+1} enviada — R$ ${fmt(finalPrice)}${below?' (ABAIXO do piso, aprovada)':''}. Follow-ups agendados (D+1/2/7/15).`);
  return { row };
}
// D+1 e D+2 são as janelas de 24h/48h combinadas na reunião: quem não responde
// em dois dias raramente responde no terceiro.
function agendarFollowups(leadId, versao, userId) {
  for (const d of [1,2,7,15])
    S.insert('tasks', { lead_id:leadId, title:`Follow-up proposta v${versao} (D+${d})`, type:'followup', area:'vendas',
      assignee_id:userId||null, due_date:dueIn(d), done:0 });
}
// Rascunho que conseguiu sair: só agora o lead anda e os follow-ups entram na agenda.
function promoverProposta(propId, userId, mensagem) {
  const prop = S.get('proposals', propId); if (!prop || prop.status !== 'draft') return null;
  const lead = S.get('leads', prop.lead_id);
  if (!lead || lead.status !== 'open') return null;
  S.update('proposals', propId, { status:'sent' });
  S.update('leads', prop.lead_id, { stage:'proposta_enviada', estimated_value:prop.final_price, updated_at:S.now() });
  agendarFollowups(prop.lead_id, prop.version, userId);
  log(prop.lead_id, userId, 'proposal', mensagem
    || `Proposta v${prop.version} enviada — R$ ${fmt(prop.final_price)}. Follow-ups agendados (D+1/2/7/15).`);
  return prop;
}

// Envio da proposta por e-mail. Também grava email_out — a aba E-mail do lead mostra
// a conversa inteira, e proposta enviada faz parte dela.
async function sendProposalEmail(o) {
  const prop = S.get('proposals', o.propId); if (!prop) return { notfound:true };
  if (!prop.token) { prop.token = makeToken(); S.update('proposals', prop.id, { token: prop.token }); }
  const lead = leadWithJoins(prop.lead_id);
  const link = baseUrl(o.req) + '/p/' + prop.token;
  const to = o.to || (lead && lead.contact_email);
  if (!to) return { noRecipient:true };
  const subject = 'Sua proposta — NexxusCRM';
  const html = `<div style="font-family:Inter,Arial,sans-serif;color:#1D1D1F">`
    + `<h2 style="color:#0071E3">Proposta comercial — NexxusCRM</h2>`
    + `<p>Olá, ${lead?lead.contact_name||'':''}. Preparamos sua proposta para <b>${lead?lead.requested_software||lead.product_name||'a solução solicitada':''}</b>.</p>`
    + `<p><a href="${link}" style="background:#0071E3;color:#fff;padding:12px 20px;border-radius:980px;text-decoration:none;font-weight:600">Ver proposta</a></p>`
    + `<p style="color:#86868B;font-size:13px">Ou copie: ${link}</p>`
    + SIGNATURE_HTML + `</div>`;
  const r = await sendEmail({ to, subject, html });
  // Releitura OBRIGATÓRIA depois do await — sem caminho condicional. O e-mail já saiu (não
  // dá para desfazer), mas nenhuma ESCRITA acontece sobre um estado que mudou no meio.
  const conferido = revalidarProposta(prop.id, o.exigirEtapa);
  if (conferido) return { link, email:r, configured: isConfigured(), aborted:conferido };
  // Reenviar o e-mail não ressuscita proposta já decidida (aceita ou recusada).
  const decided = prop.status==='accepted' || prop.status==='rejected';
  if (r.sent) {
    // Rascunho continua rascunho: quem promove é promoverProposta(), junto com o
    // estágio do lead. Aqui só se registra que o e-mail saiu.
    if (prop.status !== 'draft') S.update('proposals', prop.id, { status: decided ? prop.status : 'sent' });
    log(prop.lead_id, o.userId, 'proposal', 'Proposta enviada por e-mail para '+to+'.');
    logEmailOut(prop.lead_id, o.userId, to, subject, `Proposta v${prop.version} — R$ ${fmt(prop.final_price)}. Link: ${link}`, r.id);
  }
  return { link, email:r, configured: isConfigured() };
}

// Persona da Patrícia (M20): assinatura única para tudo que o CRM manda ao cliente.
const SIGNATURE_TEXT = 'Patrícia — Assistente Comercial · Nexxus Tech';
const SIGNATURE_HTML = `<p style="margin-top:22px;color:#86868B;font-size:13px;border-top:1px solid #e5e5ea;padding-top:12px">${SIGNATURE_TEXT}</p>`;

// Toda mensagem que sai vira activity 'email_out'; toda que entra, 'email_in'. É essa
// dupla que a aba E-mail do drawer renderiza como conversa.
// messageId é o id do provedor: é por ele que o In-Reply-To da resposta do cliente
// encontra o lead exato, sem depender de casar por e-mail do remetente.
function logEmailOut(leadId, userId, to, subject, body, messageId) {
  S.insert('activities', { lead_id:leadId, user_id:userId||null, type:'email_out',
    message:`Para ${to} — ${subject}\n${body||''}`.trim(), email_to:to, email_subject:subject,
    email_body:body||'', message_id: messageId||null });
}
function logEmailIn(leadId, from, subject, body) {
  S.insert('activities', { lead_id:leadId, user_id:null, type:'email_in',
    message:`De ${from} — ${subject}\n${body||''}`.trim(), email_from:from, email_subject:subject, email_body:body||'' });
}

// Registra a abertura da proposta pelo cliente. Toda abertura conta; só a primeira
// notifica, marca "vista" e empurra o lead para Negociação. Proposta já decidida
// (aceita/recusada) não rastreia mais nada — rastreio só faz sentido enquanto pendente.
function registerProposalView(prop) {
  if (prop.status === 'accepted' || prop.status === 'rejected') return;
  const first = !prop.viewed_at;
  const patch = { view_count: (prop.view_count||0) + 1, last_viewed_at: S.now() };
  if (first) { patch.viewed_at = S.now(); patch.status = 'viewed'; }
  S.update('proposals', prop.id, patch);
  if (!first) return;
  const lead = leadWithJoins(prop.lead_id);
  log(prop.lead_id, null, 'proposal', `Proposta v${prop.version} foi ABERTA pelo cliente.`);
  notify('proposal_viewed', `${clientName(lead)} abriu a proposta v${prop.version}.`, prop.lead_id);
  const l = S.get('leads', prop.lead_id);
  if (l && l.stage === 'proposta_enviada' && l.status === 'open') {
    S.update('leads', prop.lead_id, { stage:'negociacao', updated_at:S.now() });
    log(prop.lead_id, null, 'stage_change', 'Movido para Negociação — cliente abriu a proposta (negócio na mão do cliente).');
  }
}
// Guardas dos links públicos: negócio já encerrado ou versão superada não decidem nada.
// Devolve a resposta 409 pronta, ou null quando o link ainda vale.
function linkVencido(prop, leadRow) {
  if (!leadRow || leadRow.status !== 'open')
    return { status:409, body:{ success:false, error:{ message:'Este negócio já foi encerrado. Fale com o responsável comercial para reabrir a proposta.' } } };
  const newer = S.find('proposals', p=>p.lead_id===prop.lead_id && p.version>prop.version)
    .sort((a,b)=>b.version-a.version)[0];
  if (newer)
    return { status:409, body:{ success:false, error:{ message:`Há uma proposta mais recente (v${newer.version}). Peça o link atualizado ao responsável comercial.` } } };
  return null;
}
// preview=1: o time abre a própria proposta sem contaminar o rastreio.
function isPreview(req) {
  const v = String(((req.query)||{}).preview || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function leadWithJoins(id) {
  const l = S.get('leads', id); if (!l) return null;
  const acc = l.account_id ? S.get('accounts', l.account_id) : null;
  const ct  = l.contact_id ? S.get('contacts', l.contact_id) : null;
  const u   = l.owner_id ? S.get('users', l.owner_id) : null;
  const p   = l.product_id ? S.get('products', l.product_id) : null;
  const sup = p && p.supplier_id ? S.get('suppliers', p.supplier_id) : null;
  return Object.assign({}, l, {
    account_name: acc ? acc.name : null,
    contact_name: ct ? ct.name : null, contact_email: ct ? ct.email : null,
    owner_name: u ? u.name : null, product_name: p ? p.name : null,
    supplier_name: sup ? sup.name : null,
  });
}

// Processamento do e-mail recebido, separado da rota para caber num try/catch: se algo
// aqui estourar, o evento Svix volta a ficar livre e a retentativa do Resend funciona.
async function processarEmailRecebido(body, req) {
  const d = (body && body.data) || {};
  // Só evento de e-mail recebido, e só no endereço da Patrícia. Outro tipo de evento
  // (entregue, bounce) ou outro destinatário não é conversa com cliente.
  if (String(body.type||'') !== 'email.received')
    return ignorado('evento '+(body.type||'sem tipo')+' não é email.received');
  if (!enderecoDaPatricia(d.to))
    return ignorado('destinatário fora de EMAIL_INBOUND_ADDRESS');

  const from = extraiEmail(d.from);
  if (!from) return ignorado('sem remetente');
  // Trava de laço: resposta automática do outro lado (férias, bounce, lista) nunca pode
  // acionar a Patrícia, senão os dois robôs conversam para sempre.
  const laco = respostaAutomatica(d, from);
  if (laco) return ignorado('resposta automática ('+laco+')');

  const assunto = String(d.subject || '(sem assunto)').slice(0, 300);
  const texto = String(d.text || stripHtml(d.html) || '').slice(0, 20000);
  // DMARC/SPF reprovado = remetente possivelmente forjado. Não casa com contato
  // existente (seria sequestro de negócio alheio) e não cria lead: fica para um humano.
  const auth = autenticacaoFalhou(d);

  if (auth) {
    notify('email_quarentena', `E-mail de ${from} em QUARENTENA (${auth}) — verifique antes de responder: ${assunto}`, null);
    log(null, null, 'email_quarentena', `E-mail de ${from} barrado por falha de autenticação (${auth}). Assunto: ${assunto}`);
    return { status:200, body:{ success:true, data:{ quarantined:true, reason:auth } } };
  }

  // Threading: a resposta do cliente cita o message-id que mandamos. Casar por ele é
  // exato — só cai no casamento por e-mail do remetente quando não vier referência.
  let leadId = leadPorReferencia(d);
  const ct = S.findOne('contacts', c => String(c.email||'').toLowerCase() === from.toLowerCase());
  if (!leadId && ct) {
    const abertos = S.find('leads', l => l.contact_id===ct.id && l.status==='open')
      .sort((a,b)=> String(b.updated_at||b.created_at||'').localeCompare(String(a.updated_at||a.created_at||'')));
    if (abertos.length) leadId = abertos[0].id;
  }
  let novo = false;
  if (!leadId) {
    // Antes de criar lead: trava de enxurrada. Sem ela, um spammer vira milhares de
    // leads e milhares de chamadas de IA.
    const limite = limiteDeCriacao(from);
    if (limite) {
      notify('email_quarentena', `E-mail de ${from} em QUARENTENA — ${limite}. Nenhum lead criado.`, null);
      log(null, null, 'email_quarentena', `Limite de criação por e-mail atingido (${limite}). Remetente: ${from}. Assunto: ${assunto}`);
      return { status:200, body:{ success:true, data:{ quarantined:true, reason:limite } } };
    }
    // Contato conhecido sem negócio aberto, ou remetente novo: o e-mail vira lead. Deixar
    // cair no vazio seria perder uma demanda que chegou pela porta da frente.
    const acc = ct && ct.account_id ? S.get('accounts', ct.account_id)
      : S.insert('accounts', { name: from.split('@')[1] || from, cnpj:null, segment:null, city:null });
    const contato = ct || S.insert('contacts', { account_id:acc.id, name:from.split('@')[0], email:from, phone:null, role_title:null });
    const owner = pickOwner();
    const lead = S.insert('leads', { title: (acc?acc.name:from)+' — '+assunto.slice(0,40),
      account_id:acc?acc.id:null, contact_id:contato.id, product_id:null, requested_software:null,
      source:'email', stage:'novo_lead', owner_id:owner, hot:0, status:'open', lost_reason:null,
      estimated_value:null, qty:1, kind:'b2b', preferred_channel:'email',
      notes:texto, updated_at:S.now() });
    leadId = lead.id; novo = true;
    log(leadId, null, 'note', 'Lead criado a partir de e-mail recebido de '+from+'.');
    notify('lead_new', `Novo lead por e-mail: ${from} — ${assunto}`, leadId);
  }
  logEmailIn(leadId, from, assunto, texto);
  touchLead(leadId);
  if (!novo) notify('email_in', `${from} respondeu por e-mail: ${assunto}`, leadId);
  // E-mail novo é informação nova: a máscara da etapa atual decide de novo (responder
  // ou escalar). Etapa sem máscara (proposta/negociação) fica para o humano.
  let acionado = false;
  try { acionado = require('./agentNexus').reagirAEmail(leadId); }
  catch (e) { console.error('[agente] falha ao reagir ao e-mail do lead '+leadId+':', e.message); }
  if (!acionado && !novo) notify('email_in', `E-mail de ${from} aguarda resposta humana (lead #${leadId}).`, leadId);
  return { status:200, body:{ success:true, data:{ lead_id:leadId, created:novo, agent:acionado } } };
}

async function handle(req) {
  const { method, path, body, user } = req;
  const P = (re) => path.match(re);
  let m;

  if (method === 'POST' && path === '/api/auth/admin/login') {
    const u = S.findOne('users', x => x.email === (body.email||'').trim() && x.active);
    if (!u || !verifyPassword(body.password||'', u.password_hash))
      return { status:401, body:{ success:false, error:{ message:'Credenciais inválidas.' } } };
    return { status:200, body:{ success:true, data:{ token: sign({ id:u.id, email:u.email, area:u.area, role:u.role }), user: publicUser(u) } } };
  }

  // ===================== ROTAS PÚBLICAS (sem login) =====================
  // Captura de lead vinda do site (backend do site chama este endpoint).
  if (method==='POST' && (path==='/api/public/leads' || path==='/api/webhooks/lead')) {
    const h = req.headers || {};
    const key = h['x-intake-key'] || h['x-api-key'] || body.key;
    if (key !== (process.env.INTAKE_KEY || 'nexxus-intake-dev'))
      return { status:401, body:{ success:false, error:{ message:'Chave de captura inválida.' } } };
    const cf = body.customFields || {};
    const origem = String(cf.origem || body.origem || 'site').toLowerCase();
    const kind = origem.includes('checkout') ? 'order' : (origem.includes('newsletter') ? 'newsletter' : 'b2b');
    const email = body.email || cf.email || null;
    const phone = body.phone || cf.telefone || null;
    const message = body.message || body.summary || cf.mensagem || null;
    const protocol = body.protocol || cf.protocolo || null;
    if (protocol) {
      const protocolMarker = `Protocolo site: ${protocol}`;
      const existingLead = S.findOne('leads', lead => String(lead.notes || '').includes(protocolMarker));
      if (existingLead) {
        return { status:200, body:{ success:true, data:{
          id:existingLead.id,
          owner_id:existingLead.owner_id,
          kind,
          deduplicated:true,
        } } };
      }
    }
    // Campos novos do site (todos opcionais — sem eles o intake é o de antes).
    const slug = String(body.productSlug || '').trim();
    const prod = slug ? S.findOne('products', p => String(p.sku||'').toLowerCase() === slug.toLowerCase()) : null;
    const qtyNum = intPositivo(body.quantity, 1);
    // O site manda 'phone'; dentro do CRM a etiqueta é 'telefone'. Normaliza na porta
    // de entrada para não existirem dois nomes para o mesmo canal.
    const CANAIS = { email:'email', whatsapp:'whatsapp', phone:'telefone', telefone:'telefone' };
    const preferredChannel = CANAIS[String(body.preferredChannel || '').trim().toLowerCase()] || null;

    let valueNum = 0;
    if (body.value != null && !isNaN(parseFloat(body.value))) valueNum = parseFloat(body.value);
    else if (cf.valor) valueNum = parseFloat(String(cf.valor).replace(/[^0-9.,]/g,'').replace(/\.(?=\d{3})/g,'').replace(',','.')) || 0;

    let companyName, contactName;
    if (kind==='order') {
      contactName = String(cf.nome || cf.cliente || body.contactName || 'Cliente').trim();
      companyName = String(cf.empresa || cf.cliente || contactName).trim();
    } else if (kind==='newsletter') {
      contactName = email || 'Inscrito'; companyName = 'Newsletter';
    } else {
      companyName = String(body.companyName||body.company||cf.empresa||'').trim() || 'Empresa sem nome';
      contactName = String(body.contactName||body.name||cf.nome||'').trim() || 'Contato';
    }
    let acc = S.findOne('accounts', a=> a.name.toLowerCase()===companyName.toLowerCase());
    if (!acc) acc = S.insert('accounts', { name:companyName, cnpj:null, segment:null, city:null });
    const ct = S.insert('contacts', { account_id:acc.id, name:contactName, email, phone,
      role_title: (kind==='b2b' && body.employees) ? ('Empresa: '+body.employees+' func.') : null });
    const owner = pickOwner();
    const ownerName = owner ? (S.get('users', owner)||{}).name : '—';

    if (kind==='order') {
      const items = cf.itens || '';
      const lead = S.insert('leads', { title: 'Pedido pago — '+companyName, account_id:acc.id, contact_id:ct.id, product_id: prod?prod.id:null,
        requested_software: items||message, source:'checkout', stage:'proposta_enviada', owner_id:owner, hot:0,
        status:'won', lost_reason:null, estimated_value: valueNum||null, qty:qtyNum, kind, preferred_channel:preferredChannel,
        notes: 'Pedido pago via site'+(cf.pedido_id?(' (#'+cf.pedido_id+')'):'')+(items?('\nItens: '+items):''), updated_at:S.now() });
      log(lead.id, owner, 'close', 'Pedido pago no site — negócio GANHO'+(cf.pedido_id?(' (pedido #'+cf.pedido_id+')'):'')+'. Valor R$ '+valueNum.toLocaleString('pt-BR')+'.');
      notify('order_paid', `Pedido pago no site: ${companyName} — R$ ${valueNum.toLocaleString('pt-BR')}.`, lead.id);
      return { status:201, body:{ success:true, data:{ id:lead.id, owner_id:owner, kind:'order' } } };
    }

    const lead = S.insert('leads', { title: companyName+' — '+(kind==='newsletter'?'Newsletter':(message?String(message).slice(0,40):'Consulta do site')),
      account_id:acc.id, contact_id:ct.id, product_id: prod?prod.id:null, requested_software:message||(prod?prod.name:null),
      source:(kind==='newsletter'?'newsletter':'site'), stage:'novo_lead', owner_id:owner, hot:0, status:'open',
      lost_reason:null, estimated_value:null, qty:qtyNum, kind, preferred_channel:preferredChannel,
      notes:(message||'')+(protocol?('\nProtocolo site: '+protocol):''), updated_at:S.now() });
    log(lead.id, owner, 'note', 'Lead capturado automaticamente do site'+(protocol?(' (protocolo '+protocol+')'):'')+'.');
    notify('lead_new', `Novo lead do site: ${companyName} — atribuído a ${ownerName||'—'}.`, lead.id);
    // O agente Nexus pega o lead novo na hora, sem esperar a varredura de 5 min. Assíncrono
    // de propósito: o site recebe o 201 na mesma velocidade de antes.
    dispararAgente(lead.id);
    return { status:201, body:{ success:true, data:{ id:lead.id, owner_id:owner, kind } } };
  }
  // ---- Patrícia inbound: e-mail que o cliente responde volta para a timeline ----
  if (method==='POST' && path==='/api/public/email/inbound') {
    const segredo = process.env.EMAIL_WEBHOOK_SECRET || '';
    if (!segredo) return { status:503, body:{ success:false, error:{ message:'Recebimento de e-mail desligado — defina EMAIL_WEBHOOK_SECRET no servidor.' } } };
    // Fail-closed: sem saber qual é a caixa da Patrícia, aceitar "qualquer destinatário"
    // seria abrir a porta para tudo que o provedor encaminhar. Melhor desligado.
    if (!String(process.env.EMAIL_INBOUND_ADDRESS || '').trim())
      return { status:503, body:{ success:false, error:{ message:'Recebimento de e-mail desligado — defina EMAIL_INBOUND_ADDRESS no servidor.' } } };
    const h = req.headers || {};
    const svixId = h['svix-id'], svixTs = h['svix-timestamp'], svixSig = h['svix-signature'];
    if (!svixId || !svixTs || !svixSig)
      return { status:400, body:{ success:false, error:{ message:'Cabeçalhos de assinatura ausentes.' } } };
    if (!timestampRecente(svixTs))
      return { status:401, body:{ success:false, error:{ message:'Timestamp fora da janela de 5 minutos.' } } };
    if (!assinaturaValida(segredo, svixId, svixTs, req.rawBody || '', svixSig))
      return { status:401, body:{ success:false, error:{ message:'Assinatura inválida.' } } };
    // Webhook é "pelo menos uma vez": o mesmo svix-id não pode virar dois e-mails.
    // Mas marcar como visto ANTES de processar perde e-mail: se algo falhar no meio, a
    // retentativa legítima do Resend voltaria como "duplicado" e a mensagem sumiria.
    // Por isso o registro tem estado: 'processing' na entrada, 'done' só após o sucesso.
    const evento = reservarEvento(svixId);
    if (evento.duplicado)
      return { status:200, body:{ success:true, data:{ duplicated:true, inflight: evento.emAndamento || false } } };
    podaWebhookEvents();
    // Terminou bem (inclusive "ignorado" e "quarentena", que são desfechos definitivos):
    // fecha o evento. Qualquer exceção deixa o registro liberado para a retentativa.
    const concluir = (resposta) => { fecharEvento(svixId); return resposta; };
    try {
      return concluir(await processarEmailRecebido(body, req));
    } catch (e) {
      liberarEvento(svixId);   // a retentativa do Resend vai poder processar de novo
      throw e;
    }
  }

  // Página pública da proposta (rastreio de abertura).

  // Página pública da proposta (rastreio de abertura).
  if ((m=P(/^\/api\/public\/proposals\/([a-f0-9]{16,})$/)) && method==='GET') {
    const prop = S.findOne('proposals', x=> x.token===m[1]); if (!prop) return notfound();
    if (!isPreview(req)) registerProposalView(prop);
    const lead = leadWithJoins(prop.lead_id);
    return { status:200, body:{ success:true, data:{
      company: lead?lead.account_name:null, contact: lead?lead.contact_name:null,
      software: lead?(lead.requested_software||lead.product_name):null, seller: lead?lead.owner_name:null,
      version: prop.version, final_price: prop.final_price, status: prop.status,
      created_at: prop.created_at, accepted_at: prop.accepted_at||null,
      rejected_at: prop.rejected_at||null, reject_reason: prop.reject_reason||null } } };
  }
  if ((m=P(/^\/api\/public\/proposals\/([a-f0-9]{16,})\/accept$/)) && method==='POST') {
    const prop = S.findOne('proposals', x=> x.token===m[1]); if (!prop) return notfound();
    const leadRow = S.get('leads', prop.lead_id);
    // Reaceite do mesmo link num negócio já fechado por ele: idempotente, devolve 200.
    const idempotente = prop.status==='accepted' && leadRow && leadRow.status==='won';
    if (!idempotente) {
      const barrado = linkVencido(prop, leadRow); if (barrado) return barrado;
      // Cliente mudou de ideia: o estado atual vira aceita e limpa a recusa
      // (o "não" continua registrado na timeline).
      S.update('proposals', prop.id, { status:'accepted', accepted_at:S.now(), rejected_at:null, reject_reason:null });
      const lead = leadWithJoins(prop.lead_id);
      log(prop.lead_id, null, 'proposal', `Proposta v${prop.version} ACEITA pelo cliente.`);
      notify('proposal_accepted', `${clientName(lead)} ACEITOU a proposta v${prop.version}! 🎉`, prop.lead_id);
    }
    // Aceite do cliente fecha o negócio sozinho (mesma trilha do Close Won manual),
    // sempre pelo preço da proposta aceita — foi por ele que o negócio fechou.
    closeWon(prop.lead_id, null, { value: prop.final_price, setValue: true,
      message: `Negócio GANHO — cliente aceitou a proposta v${prop.version} na página pública. Gatilho enviado ao Jurídico.` });
    return { status:200, body:{ success:true } };
  }
  // Recusa do cliente: registra o não, mas quem decide marcar o lead como perdido é gente.
  if ((m=P(/^\/api\/public\/proposals\/([a-f0-9]{16,})\/reject$/)) && method==='POST') {
    const prop = S.findOne('proposals', x=> x.token===m[1]); if (!prop) return notfound();
    if (prop.status === 'accepted')
      return { status:409, body:{ success:false, error:{ message:'Esta proposta já foi aceita. Fale com o responsável comercial para revisá-la.' } } };
    // Texto puro vindo de fora: sem controle, sem tamanho ilimitado. Quem exibe escapa.
    const reason = String(body.reason||'').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 1000);
    // Re-recusar a mesma proposta é idempotente; fora isso valem as guardas do aceite,
    // senão um link velho gera notificação falsa de "cliente recusou".
    if (prop.status !== 'rejected') {
      const barrado = linkVencido(prop, S.get('leads', prop.lead_id)); if (barrado) return barrado;
      S.update('proposals', prop.id, { status:'rejected', rejected_at:S.now(), reject_reason: reason||null });
      const lead = leadWithJoins(prop.lead_id);
      log(prop.lead_id, null, 'proposal', `Proposta v${prop.version} RECUSADA pelo cliente.`+(reason?(' Motivo: '+reason):''));
      notify('proposal_rejected', `${clientName(lead)} recusou a proposta v${prop.version}.`+(reason?(' Motivo: '+reason):''), prop.lead_id);
    }
    return { status:200, body:{ success:true } };
  }
  // ======================================================================

  if (!user) return { status:401, body:{ success:false, error:{ message:'Não autenticado.' } } };

  if (method === 'GET' && path === '/api/auth/me') {
    const full = S.get('users', user.id) || user;
    return { status:200, body:{ success:true, data:{ user: publicUser(full) } } };
  }
  if (method === 'GET' && path === '/api/meta')
    return { status:200, body:{ success:true, data:{ stages:STAGES, areas:AREAS,
      users: S.find('users', u=>u.active).map(u=>({ id:u.id, name:u.name, area:u.area, role:u.role })) } } };

  if (method === 'GET' && path === '/api/fx')
    return { status:200, body:{ success:true, data: await getUsdBrl() } };

  if (method === 'GET' && path === '/api/config/pricing')
    return { status:200, body:{ success:true, data: getConfig() } };
  if (method === 'PUT' && path === '/api/config/pricing') {
    if (!canArea(user,'financeiro')) return forbidden('Apenas Financeiro/Admin altera regras de precificação.');
    const c = getConfig();
    const f = (k)=> body[k]!=null ? Number(body[k]) : c[k];
    S.data.config = { fx_mode: body.fx_mode||c.fx_mode, fx_manual_rate:f('fx_manual_rate'),
      fx_spread_pct:f('fx_spread_pct'), import_tax_pct:f('import_tax_pct'), invoice_tax_pct:f('invoice_tax_pct'),
      target_margin_pct:f('target_margin_pct'), min_margin_pct:f('min_margin_pct'), updated_at:S.now() };
    S.save();
    return { status:200, body:{ success:true, data: getConfig() } };
  }

  // ---- Leads / Funil ----
  if (method === 'GET' && path === '/api/leads') {
    const rows = S.all('leads')
      .sort((a,b)=> (b.updated_at||'').localeCompare(a.updated_at||''))
      .map(l => leadWithJoins(l.id));
    return { status:200, body:{ success:true, data: rows } };
  }
  if (method === 'POST' && path === '/api/leads') {
    const r = S.insert('leads', { title:body.title, account_id:body.account_id||null, contact_id:body.contact_id||null,
      product_id:body.product_id||null, requested_software:body.requested_software||null, source:body.source||'site',
      stage:body.stage||'novo_lead', owner_id:body.owner_id||user.id, hot:0, status:'open', lost_reason:null,
      estimated_value:body.estimated_value||null, qty:body.qty||1, notes:body.notes||null, updated_at:S.now() });
    log(r.id, user.id, 'note', 'Lead criado.');
    return { status:201, body:{ success:true, data: leadWithJoins(r.id) } };
  }
  if ((m=P(/^\/api\/leads\/(\d+)$/))) {
    const id = +m[1];
    if (method === 'GET') {
      const lead = leadWithJoins(id); if (!lead) return notfound();
      const um = byId('users'), sm = byId('suppliers'), pm = byId('products');
      return { status:200, body:{ success:true, data: {
        lead,
        activities: S.find('activities', a=>a.lead_id===id).sort(byCreatedDesc).map(a=>Object.assign({}, a, { user_name: a.user_id&&um[a.user_id]?um[a.user_id].name:null })),
        quotes: S.find('quotes', q=>q.lead_id===id).sort(byCreatedDesc).map(q=>Object.assign({}, q, { supplier_name:q.supplier_id&&sm[q.supplier_id]?sm[q.supplier_id].name:null, product_name:q.product_id&&pm[q.product_id]?pm[q.product_id].name:null })),
        pricings: S.find('pricings', p=>p.lead_id===id).sort(byCreatedDesc),
        proposals: S.find('proposals', p=>p.lead_id===id).sort((a,b)=>b.version-a.version),
        tasks: S.find('tasks', t=>t.lead_id===id).sort((a,b)=> (a.done-b.done) || String(a.due_date||'').localeCompare(String(b.due_date||''))),
        contract: S.find('contracts', c=>c.lead_id===id).sort(byCreatedDesc)[0] || null,
        outreaches: S.find('outreaches', o=>o.lead_id===id).sort(byCreatedDesc),
        qualifications: S.find('qualifications', q=>q.lead_id===id).sort(byCreatedDesc),
      } } };
    }
    if (method === 'PATCH') {
      if (!S.get('leads', id)) return notfound();
      const fields = ['title','account_id','contact_id','product_id','requested_software','source','owner_id','estimated_value','qty','notes'];
      const patch = {}; fields.forEach(f=>{ if (body[f]!==undefined) patch[f]=body[f]; });
      patch.updated_at = S.now(); S.update('leads', id, patch);
      return { status:200, body:{ success:true, data: leadWithJoins(id) } };
    }
    if (method === 'DELETE') {
      S.remove('leads', id);
      ['activities','quotes','pricings','proposals','tasks','contracts'].forEach(c=>{ S.find(c, r=>r.lead_id===id).forEach(r=>S.remove(c, r.id)); });
      return { status:200, body:{ success:true } };
    }
  }
  if ((m=P(/^\/api\/leads\/(\d+)\/stage$/)) && method==='PATCH') {
    const id=+m[1]; const stage=body.stage;
    const sd = STAGES.find(s=>s.key===stage); if (!sd) return { status:400, body:{ success:false, error:{message:'Estágio inválido.'} } };
    S.update('leads', id, { stage, status:'open', updated_at:S.now() });
    log(id, user.id, 'stage_change', 'Movido para ' + sd.label);
    return { status:200, body:{ success:true, data: leadWithJoins(id) } };
  }
  if ((m=P(/^\/api\/leads\/(\d+)\/triage$/)) && method==='POST') {
    const id=+m[1];
    if (!S.get('leads', id)) return notfound();
    const lead = triageLead(id, user.id);
    if (!lead) return { status:409, body:{ success:false, error:{ message:'Este negócio já foi encerrado. Reabra-o antes de despachar para Compras.' } } };
    return { status:200, body:{ success:true, data: lead } };
  }
  if ((m=P(/^\/api\/leads\/(\d+)\/hot$/)) && method==='POST') {
    const id=+m[1]; const l=S.get('leads', id); const nv=l.hot?0:1; S.update('leads', id, { hot:nv });
    return { status:200, body:{ success:true, data:{ hot:nv } } };
  }
  if ((m=P(/^\/api\/leads\/(\d+)\/close$/)) && method==='POST') {
    const id=+m[1]; const result=body.result;
    if (result==='won') {
      const r = closeWon(id, user.id); if (!r) return notfound();
      if (r.skipped === 'lost')
        return { status:409, body:{ success:false, error:{ message:'Este lead está marcado como PERDIDO. Reabra-o antes de fechar como ganho.' } } };
      return { status:200, body:{ success:true, data:{ status:'won' } } };
    } else {
      const r = closeLost(id, user.id, body.lost_reason); if (!r) return notfound();
      return { status:200, body:{ success:true, data:{ status:'lost' } } };
    }
  }

  // ==================== SDR AGENT ====================
  // Status da IA (inclui o piloto automático do agente Nexus)
  if (method==='GET' && path==='/api/sdr/status') {
    const agente = require('./agentNexus');
    return { status:200, body:{ success:true, data:{ configured: sdr.isConfigured(), model: sdr.MODEL,
      agent_enabled: agente.isEnabled(), agent_off_reason: agente.motivoDesligado() } } };
  }

  // ==================== BDR — fila de decisões do agente ====================
  // Leads que o agente não soube resolver sozinho, com o resumo e as 3 respostas prontas.
  if (method==='GET' && path==='/api/bdr') {
    if (!canArea(user,'vendas')) return forbidden('Apenas Vendas/Admin acessa a fila do BDR.');
    // Inclui os que estão em 'hold': segurar um caso não some com ele da tela.
    const rows = S.find('leads', l=>l.needs_bdr && l.status==='open')
      .sort((a,b)=> String(b.bdr_at||b.updated_at||'').localeCompare(String(a.bdr_at||a.updated_at||'')))
      .map(l => { const j = leadWithJoins(l.id);
        return { id:l.id, title:l.title, account_name:j.account_name, contact_name:j.contact_name,
          contact_email:j.contact_email, stage:l.stage, qty:l.qty,
          product_name:j.product_name, requested_software:l.requested_software,
          bdr_summary:l.bdr_summary||null, bdr_options:Array.isArray(l.bdr_options)?l.bdr_options:[],
          bdr_mask:l.bdr_mask||null, bdr_hold:l.bdr_hold?1:0, bdr_at:l.bdr_at||l.updated_at||null }; });
    return { status:200, body:{ success:true, data:{ items:rows, count:rows.length } } };
  }
  // Decisão do BDR: sim (responde e devolve ao agente), não (perde) ou hold (segura).
  if ((m=P(/^\/api\/bdr\/(\d+)\/resolve$/)) && method==='POST') {
    if (!canArea(user,'vendas')) return forbidden('Apenas Vendas/Admin decide na fila do BDR.');
    const id=+m[1]; const lead = S.get('leads', id); if (!lead) return notfound();
    if (!lead.needs_bdr) return { status:409, body:{ success:false, error:{ message:'Este lead não está aguardando decisão do BDR.' } } };
    const decision = String(body.decision||'').toLowerCase();

    if (decision==='no') {
      closeLost(id, user.id, body.lost_reason||'Descartado pelo BDR',
        'Negócio PERDIDO (decisão do BDR). Motivo: '+(body.lost_reason||'Descartado pelo BDR'));
      S.update('leads', id, { needs_bdr:0, bdr_hold:0 });
      return { status:200, body:{ success:true, data:{ status:'lost' } } };
    }
    if (decision==='hold') {
      // Continua na fila, mas o agente não volta a escalar o mesmo caso.
      S.update('leads', id, { bdr_hold:1, updated_at:S.now() });
      log(id, user.id, 'bdr', 'BDR segurou o caso (hold) — sem resposta ao cliente por enquanto.');
      return { status:200, body:{ success:true, data:{ status:'hold' } } };
    }
    if (decision!=='yes') return { status:400, body:{ success:false, error:{ message:'decision deve ser yes, no ou hold.' } } };

    const texto = String(body.message||'').trim();
    if (!texto) return { status:400, body:{ success:false, error:{ message:'Escreva (ou escolha) a resposta que vai para o cliente.' } } };
    const j = leadWithJoins(id);
    const assunto = body.subject || ('Sobre sua solicitação — '+(j.requested_software||j.product_name||'Nexxus Tech'));
    let envio = { sent:false, reason:'no_recipient' };
    if (j.contact_email) {
      const corpo = `<div style="font-family:Inter,Arial,sans-serif;color:#1D1D1F;font-size:15px;line-height:1.6">`
        + texto.split(/\n{2,}/).map(p=>`<p>${escapeHtml(p).replace(/\n/g,'<br/>')}</p>`).join('')
        + SIGNATURE_HTML + `</div>`;
      envio = await sendEmail({ to:j.contact_email, subject:assunto, html:corpo });
      if (envio.sent) logEmailOut(id, user.id, j.contact_email, assunto, texto, envio.id);
    }
    log(id, user.id, 'bdr', 'BDR respondeu ao cliente'
      + (envio.sent ? (' (e-mail para '+j.contact_email+')') : ' — e-mail NÃO enviado ('+(envio.reason||'falha')+'), envie manualmente')
      + ': '+texto.slice(0,300));
    // Esgotadas as tentativas do agente naquela etapa, devolver ao trilho só faria o
    // lead voltar para a fila. Vira tarefa de gente.
    const MAX_ESCALACOES = 2;
    const esgotou = ((lead.agent_escal||{})[lead.stage]||0) >= MAX_ESCALACOES;
    const patch = { needs_bdr:0, bdr_hold:0, bdr_summary:null, bdr_options:[], updated_at:S.now() };
    if (esgotou) {
      S.insert('tasks', { lead_id:id, title:'Conduzir manualmente — o agente já tentou 2x nesta etapa: '+lead.title,
        type:'manual_takeover', area:'vendas', assignee_id: lead.owner_id||user.id, due_date:dueIn(1), done:0 });
      log(id, user.id, 'bdr', 'Agente esgotou as tentativas nesta etapa — negócio segue na mão do responsável (tarefa criada).');
    } else {
      patch.agent_done_stage = null; // volta ao trilho: a próxima varredura retoma a etapa
    }
    S.update('leads', id, patch);
    return { status:200, body:{ success:true, data:{ status:'resolved', emailed: !!envio.sent,
      email: envio, handedToHuman: esgotou } } };
  }
  // Pausar/retomar o agente num lead específico ("esse caso em especial não quero automático").
  if ((m=P(/^\/api\/leads\/(\d+)\/agent-pause$/)) && method==='POST') {
    if (!canArea(user,'vendas')) return forbidden('Apenas Vendas/Admin pausa o agente.');
    const id=+m[1]; const l = S.get('leads', id); if (!l) return notfound();
    const nv = l.agent_paused ? 0 : 1;
    S.update('leads', id, { agent_paused:nv, updated_at:S.now() });
    log(id, user.id, 'agent', nv ? 'Agente Nexus PAUSADO neste lead por decisão humana.' : 'Agente Nexus RETOMADO neste lead.');
    return { status:200, body:{ success:true, data:{ agent_paused:nv } } };
  }

  // 1) Pesquisa de leads (gera prospects a partir do ICP)
  if (method==='POST' && path==='/api/sdr/research') {
    try {
      const rows = await sdr.researchLeads(body||{}, { products: S.all('products') });
      const batch = 'R' + Date.now().toString(36);
      const saved = rows.map(p => S.insert('prospects', Object.assign({}, p, {
        batch, icp: { segment:body.segment||null, size:body.size||null, region:body.region||null, software:body.software||null, notes:body.notes||null },
        status:'new', created_by:user.id })));
      notify('sdr_research', `SDR Agent: ${saved.length} empresas-alvo pesquisadas.`, null);
      return { status:201, body:{ success:true, data: saved } };
    } catch (e) { return { status:502, body:{ success:false, error:{ message: e.message } } }; }
  }
  // Lista de prospects
  if (method==='GET' && path==='/api/sdr/prospects') {
    const um = byId('users');
    const rows = S.all('prospects').sort(byCreatedDesc).map(p=>Object.assign({}, p, { created_by_name: p.created_by&&um[p.created_by]?um[p.created_by].name:null }));
    return { status:200, body:{ success:true, data: rows } };
  }
  // Descartar prospect
  if ((m=P(/^\/api\/sdr\/prospects\/(\d+)$/)) && method==='DELETE') {
    S.remove('prospects', +m[1]);
    return { status:200, body:{ success:true } };
  }
  // Importar prospect para o funil (cria account + contact + lead)
  if ((m=P(/^\/api\/sdr\/prospects\/(\d+)\/import$/)) && method==='POST') {
    const p = S.get('prospects', +m[1]); if (!p) return notfound();
    if (p.status==='imported' && p.lead_id) return { status:200, body:{ success:true, data:{ lead_id:p.lead_id, deduplicated:true } } };
    let acc = S.findOne('accounts', a=> a.name.toLowerCase()===String(p.company_name||'').toLowerCase());
    if (!acc) acc = S.insert('accounts', { name:p.company_name, cnpj:null, segment:p.segment||null, city:p.city||null });
    const ct = S.insert('contacts', { account_id:acc.id, name:p.contact_name||'Contato a validar', email:null, phone:null, role_title:p.contact_role||null });
    const lead = S.insert('leads', { title: p.company_name+' — '+(p.suggested_software||'Prospecção'),
      account_id:acc.id, contact_id:ct.id, product_id:null, requested_software:p.suggested_software||null,
      source:'outbound', stage:'novo_lead', owner_id:user.id, hot: (p.fit_score>=80?1:0), status:'open',
      lost_reason:null, estimated_value:null, qty:1,
      notes:'Prospect gerado pelo SDR Agent (fit '+(p.fit_score||'—')+'/100). '+(p.why_fit||''), updated_at:S.now() });
    S.update('prospects', p.id, { status:'imported', lead_id:lead.id });
    log(lead.id, user.id, 'sdr', 'Lead importado do SDR Agent — fit '+(p.fit_score||'—')+'/100. '+(p.why_fit||''));
    notify('sdr_import', `SDR Agent: ${p.company_name} importado para o funil.`, lead.id);
    return { status:201, body:{ success:true, data:{ lead_id: lead.id } } };
  }

  // 2) Preparar abordagem para um lead
  if ((m=P(/^\/api\/sdr\/leads\/(\d+)\/outreach$/)) && method==='POST') {
    const id=+m[1]; const lead = leadWithJoins(id); if (!lead) return notfound();
    const acc = lead.account_id ? S.get('accounts', lead.account_id) : null;
    const ct = lead.contact_id ? S.get('contacts', lead.contact_id) : null;
    try {
      const kit = await sdr.prepareOutreach({
        company: lead.account_name, segment: acc?acc.segment:null, city: acc?acc.city:null,
        contact: lead.contact_name, role: ct?ct.role_title:null,
        software: lead.requested_software||lead.product_name, qty: lead.qty,
        source: lead.source, notes: lead.notes, seller: lead.owner_name });
      const row = S.insert('outreaches', Object.assign({ lead_id:id, created_by:user.id }, kit));
      log(id, user.id, 'sdr', 'SDR Agent gerou kit de abordagem (e-mail, WhatsApp, LinkedIn e roteiro de ligação).');
      return { status:201, body:{ success:true, data: row } };
    } catch (e) { return { status:502, body:{ success:false, error:{ message: e.message } } }; }
  }
  if ((m=P(/^\/api\/sdr\/leads\/(\d+)\/outreach$/)) && method==='GET') {
    const id=+m[1];
    return { status:200, body:{ success:true, data: S.find('outreaches', o=>o.lead_id===id).sort(byCreatedDesc) } };
  }

  // 3) Qualificar lead (BANT)
  if ((m=P(/^\/api\/sdr\/leads\/(\d+)\/qualify$/)) && method==='POST') {
    const id=+m[1]; const lead = leadWithJoins(id); if (!lead) return notfound();
    const acc = lead.account_id ? S.get('accounts', lead.account_id) : null;
    const ct = lead.contact_id ? S.get('contacts', lead.contact_id) : null;
    const acts = S.find('activities', a=>a.lead_id===id).sort(byCreatedDesc).slice(0,15)
      .map(a=>'  ['+a.created_at+'] '+a.type+': '+a.message).join('\n');
    try {
      const q = await sdr.qualifyLead({
        company: lead.account_name, segment: acc?acc.segment:null, city: acc?acc.city:null,
        contact: lead.contact_name, role: ct?ct.role_title:null,
        software: lead.requested_software||lead.product_name, qty: lead.qty,
        value: lead.estimated_value, source: lead.source, stage: lead.stage, hot: lead.hot,
        notes: lead.notes, timeline: acts });
      const row = S.insert('qualifications', Object.assign({ lead_id:id, created_by:user.id }, q));
      S.update('leads', id, { bant_score:q.total_score, bant_tier:q.tier, updated_at:S.now() });
      if (q.tier==='A' && !lead.hot) S.update('leads', id, { hot:1 });
      (q.next_actions||[]).slice(0,3).forEach((na,i)=>{
        S.insert('tasks', { lead_id:id, title:'[SDR] '+na, type:'sdr_action', area:'vendas', assignee_id:lead.owner_id||user.id,
          due_date:dueIn(i+1), done:0 });
      });
      log(id, user.id, 'sdr', 'SDR Agent qualificou a conta (BANT): '+q.total_score+'/100 — Tier '+q.tier+'. '+q.summary);
      notify('sdr_qualify', `SDR Agent: ${lead.account_name||lead.title} qualificado — ${q.total_score}/100 (Tier ${q.tier}).`, id);
      return { status:201, body:{ success:true, data: row } };
    } catch (e) { return { status:502, body:{ success:false, error:{ message: e.message } } }; }
  }
  if ((m=P(/^\/api\/sdr\/leads\/(\d+)\/qualify$/)) && method==='GET') {
    const id=+m[1];
    return { status:200, body:{ success:true, data: S.find('qualifications', q=>q.lead_id===id).sort(byCreatedDesc) } };
  }
  // ====================================================

  // ---- Cotação ----
  if (method==='POST' && path==='/api/quotes') {
    if (!canArea(user,'compras')) return forbidden('Apenas Compras/Admin registra cotação.');
    const r = createQuote({ leadId:body.lead_id, supplierId:body.supplier_id, productId:body.product_id,
      costAmount:body.cost_amount, currency:body.cost_currency, qty:body.qty,
      ref:body.supplier_ref, notes:body.notes, userId:user.id });
    if (!r) return { status:409, body:{ success:false, error:{ message:'Este negócio já foi encerrado — não é possível registrar cotação.' } } };
    return { status:201, body:{ success:true, data: r } };
  }

  // ---- Precificação ----
  if (method==='POST' && path==='/api/pricing/calculate') {
    const c = getConfig();
    const fx = c.fx_mode==='manual' ? { rate:c.fx_manual_rate, source:'manual' } : await getUsdBrl();
    const result = calculatePricing({ costUsd:Number(body.cost_usd), qty:Number(body.qty)||1,
      fxBase:Number(body.fx_base!=null?body.fx_base:fx.rate), fxSpreadPct:c.fx_spread_pct,
      importTaxPct:c.import_tax_pct, invoiceTaxPct:c.invoice_tax_pct, targetMarginPct:c.target_margin_pct, minMarginPct:c.min_margin_pct });
    return { status:200, body:{ success:true, data: Object.assign({}, result, { fxSource:fx.source, config:c }) } };
  }
  if (method==='POST' && path==='/api/pricing') {
    const r = await savePricingFor({ leadId:body.lead_id, quoteId:body.quote_id,
      costUsd:body.cost_usd, qty:body.qty, fxBase:body.fx_base, userId:user.id });
    if (r.aborted) return { status:409, body:{ success:false, error:{ message:'Não foi possível salvar: '+r.aborted+'.' } } };
    return { status:201, body:{ success:true, data: Object.assign({ id:r.row.id }, r.calc) } };
  }

  // ---- Propostas ----
  if (method==='POST' && path==='/api/proposals') {
    const r = createProposal({ leadId:body.lead_id, finalPrice:body.final_price,
      approveBelowFloor:body.approve_below_floor, minPrice:body.min_price,
      suggestedPrice:body.suggested_price, userId:user.id });
    if (r.notOpen) return { status:409, body:{ success:false, error:{ message:'Este negócio já foi encerrado — não é possível emitir proposta.' } } };
    if (r.belowFloor)
      return { status:422, body:{ success:false, code:'BELOW_FLOOR',
        error:{ message:`Preço R$ ${fmt(r.belowFloor.finalPrice)} está ABAIXO do piso (R$ ${fmt(r.belowFloor.floor)}). Requer aprovação gerencial.` },
        data:{ floor:r.belowFloor.floor, suggested:r.belowFloor.suggested } } };
    return { status:201, body:{ success:true, data: r.row } };
  }

  // Enviar proposta por e-mail (usa serviço configurado; senão devolve o link)
  if ((m=P(/^\/api\/proposals\/(\d+)\/send-email$/)) && method==='POST') {
    const r = await sendProposalEmail({ propId:+m[1], to:body.to, userId:user.id, req });
    if (r.notfound) return notfound();
    if (r.noRecipient) return { status:400, body:{ success:false, error:{ message:'Sem e-mail do contato. Informe um destinatário.' } } };
    return { status:200, body:{ success:true, data:{ link:r.link, email:r.email, configured:r.configured } } };
  }
  // Link público da proposta (para copiar/enviar manualmente)
  if ((m=P(/^\/api\/proposals\/(\d+)\/link$/)) && method==='GET') {
    const prop = S.get('proposals', +m[1]); if (!prop) return notfound();
    if (!prop.token) { prop.token = makeToken(); S.update('proposals', prop.id, { token: prop.token }); }
    return { status:200, body:{ success:true, data:{ link: baseUrl(req) + '/p/' + prop.token, status:prop.status, viewed_at:prop.viewed_at, accepted_at:prop.accepted_at } } };
  }
  // ---- Tarefas ----
  if (method==='GET' && path==='/api/tasks') {
    const lm = byId('leads'), um = byId('users');
    const rows = S.all('tasks').sort((a,b)=> (a.done-b.done) || String(a.due_date||'').localeCompare(String(b.due_date||'')))
      .map(t=>Object.assign({}, t, { lead_title:t.lead_id&&lm[t.lead_id]?lm[t.lead_id].title:null, assignee_name:t.assignee_id&&um[t.assignee_id]?um[t.assignee_id].name:null }));
    return { status:200, body:{ success:true, data: rows } };
  }
  if ((m=P(/^\/api\/tasks\/(\d+)$/)) && method==='PATCH') {
    const id=+m[1]; if (body.done!==undefined) S.update('tasks', id, { done: body.done?1:0 });
    return { status:200, body:{ success:true, data: S.get('tasks', id) } };
  }
  if (method==='POST' && path==='/api/tasks') {
    const r = S.insert('tasks', { lead_id:body.lead_id||null, title:body.title, type:body.type||'followup', area:body.area||null, assignee_id:body.assignee_id||user.id, due_date:body.due_date||null, done:0 });
    return { status:201, body:{ success:true, data: r } };
  }

  // ---- Contratos ----
  if ((m=P(/^\/api\/contracts\/(\d+)$/)) && method==='PATCH') {
    if (!canArea(user,'juridico')) return forbidden('Apenas Jurídico/Admin altera contratos.');
    const id=+m[1]; const ct = S.update('contracts', id, { status:body.status||'drafting', notes:body.notes||null });
    if (ct) log(ct.lead_id, user.id, 'contract', 'Contrato atualizado: '+(body.status||'drafting'));
    return { status:200, body:{ success:true, data: ct } };
  }

  if (method==='POST' && path==='/api/activities') { log(body.lead_id, user.id, 'note', body.message); return { status:201, body:{ success:true } }; }

  // ---- Catálogo / contas ----
  // Sync manual com o catálogo do site (o automático roda no boot e a cada 30 min).
  if (method==='POST' && path==='/api/catalog/sync') {
    if (!catalog.isConfigured())
      return { status:503, body:{ success:false, error:{ message:'Sync do catálogo desligada — defina SITE_CATALOG_URL e SITE_CATALOG_KEY no servidor.' } } };
    try {
      const r = await catalog.syncCatalog();
      log(null, user.id, 'catalog', `Catálogo do site sincronizado: ${r.imported} novos, ${r.updated} atualizados, ${r.deactivated} desativados.`);
      return { status:200, body:{ success:true, data:{ imported:r.imported, updated:r.updated, deactivated:r.deactivated } } };
    } catch (e) {
      return { status:502, body:{ success:false, error:{ message:'Falha ao ler o catálogo do site: '+e.message } } };
    }
  }
  if (method==='GET' && path==='/api/accounts') return okList(S.all('accounts').sort(byName));
  if (method==='GET' && path==='/api/contacts') { const am=byId('accounts'); return okList(S.all('contacts').sort(byName).map(c=>Object.assign({}, c, { account_name:c.account_id&&am[c.account_id]?am[c.account_id].name:null }))); }
  if (method==='GET' && path==='/api/suppliers') return okList(S.all('suppliers').sort(byName));
  if (method==='GET' && path==='/api/products') { const sm=byId('suppliers'); return okList(S.all('products').sort(byName).map(p=>Object.assign({}, p, { supplier_name:p.supplier_id&&sm[p.supplier_id]?sm[p.supplier_id].name:null }))); }
  if (method==='POST' && path==='/api/suppliers') return { status:201, body:{ success:true, data: S.insert('suppliers', { name:body.name, country:body.country||null, currency:body.currency||'USD' }) } };
  if (method==='POST' && path==='/api/products') return { status:201, body:{ success:true, data: S.insert('products', { supplier_id:body.supplier_id||null, name:body.name, sku:body.sku||null, list_cost_usd:body.list_cost_usd||null, currency:body.currency||'USD' }) } };
  if (method==='POST' && path==='/api/accounts') return { status:201, body:{ success:true, data: S.insert('accounts', { name:body.name, cnpj:body.cnpj||null, segment:body.segment||null, city:body.city||null }) } };
  if (method==='POST' && path==='/api/contacts') return { status:201, body:{ success:true, data: S.insert('contacts', { account_id:body.account_id||null, name:body.name, email:body.email||null, phone:body.phone||null, role_title:body.role_title||null }) } };

  // ---- Usuários ----
  if (method==='GET' && path==='/api/users') return okList(S.all('users').sort(byName).map(u=>({ id:u.id, name:u.name, email:u.email, area:u.area, role:u.role, active:u.active })));
  if (method==='POST' && path==='/api/users') {
    if (!canArea(user,'admin')) return forbidden('Apenas Admin cria usuários.');
    const r = S.insert('users', { name:body.name, email:body.email, password_hash:hashPassword(body.password||'senha123'), area:body.area||'vendas', role:body.role||'user', active:1 });
    return { status:201, body:{ success:true, data:{ id:r.id, name:r.name, email:r.email, area:r.area, role:r.role } } };
  }

  // ---- Notificações internas ----
  if (method==='GET' && path==='/api/notifications') {
    const list = S.all('notifications').sort(byCreatedDesc).slice(0,40);
    const unread = S.find('notifications', n=>!n.read).length;
    return { status:200, body:{ success:true, data:{ items:list, unread } } };
  }
  if (method==='POST' && path==='/api/notifications/read') {
    S.find('notifications', n=>!n.read).forEach(n=> S.update('notifications', n.id, { read:1 }));
    return { status:200, body:{ success:true } };
  }
  // ---- Relatórios ----
  if (method==='GET' && path==='/api/reports/summary') {
    const open = S.find('leads', l=>l.status==='open');
    const byStage = {}; STAGES.forEach(s=> byStage[s.key] = open.filter(l=>l.stage===s.key).length);
    const wonLeads = S.find('leads', l=>l.status==='won');
    const won = { c: wonLeads.length, v: wonLeads.reduce((a,l)=>a+(l.estimated_value||0),0) };
    const lost = S.find('leads', l=>l.status==='lost');
    const forecast = open.filter(l=>['proposta_enviada','negociacao'].includes(l.stage)).reduce((a,l)=>a+(l.estimated_value||0),0);
    const lrMap = {}; lost.forEach(l=>{ const k=l.lost_reason||'Não informado'; lrMap[k]=(lrMap[k]||0)+1; });
    const lostReasons = Object.keys(lrMap).map(reason=>({ reason, c:lrMap[reason] })).sort((a,b)=>b.c-a.c);
    // Origem dos negócios (todos os leads por canal): total, ganhos e faturamento ganho
    const SOURCES = [ {key:'site',label:'Site (formulário)'}, {key:'checkout',label:'Checkout (loja)'}, {key:'newsletter',label:'Newsletter'}, {key:'indicacao',label:'Indicação'}, {key:'outbound',label:'Outbound'} ];
    const all = S.all('leads');
    const bySourceMap = {};
    all.forEach(l => { const k = l.source || 'site';
      const o = bySourceMap[k] || (bySourceMap[k] = { source:k, total:0, won:0, revenue:0 });
      o.total++; if (l.status==='won') { o.won++; o.revenue += (l.estimated_value||0); } });
    const bySource = Object.values(bySourceMap).map(o => ({
      ...o, label: (SOURCES.find(x=>x.key===o.source)||{}).label || o.source,
      convRate: o.total>0 ? o.won/o.total : 0,
    })).sort((a,b)=> b.revenue - a.revenue || b.total - a.total);
    const conv = (won.c+lost.length)>0 ? won.c/(won.c+lost.length) : 0;
    return { status:200, body:{ success:true, data:{ byStage, won, lost:lost.length, open:open.length, forecast, conversion:conv, lostReasons, stages:STAGES, bySource } } };
  }

  return { status:404, body:{ success:false, error:{ message:'Rota não encontrada: '+method+' '+path } } };
}

function publicUser(u){ return { id:u.id, name:u.name, email:u.email, area:u.area, role:u.role }; }
function canArea(user, area){ return user.role==='admin' || user.area==='admin' || user.area===area; }
function forbidden(msg){ return { status:403, body:{ success:false, error:{ message:msg } } }; }
function notfound(){ return { status:404, body:{ success:false, error:{ message:'Não encontrado.' } } }; }
function okList(arr){ return { status:200, body:{ success:true, data: arr } }; }
function byName(a,b){ return String(a.name||'').localeCompare(String(b.name||'')); }
function byCreatedDesc(a,b){ return String(b.created_at||'').localeCompare(String(a.created_at||'')) || (b.id-a.id); }
function fmt(n){ return Number(n||0).toLocaleString('pt-BR',{minimumFractionDigits:2, maximumFractionDigits:2}); }
// Texto do BDR/cliente vai para dentro de HTML de e-mail: escapa sempre.
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
// ---- Verificação de webhook no padrão Svix (usado pelo Resend Inbound) ----
// Conteúdo assinado = "{svix-id}.{svix-timestamp}.{corpo CRU}"; assinatura esperada =
// base64(HMAC-SHA256(segredo decodificado, conteúdo)). O header lista uma ou mais
// assinaturas no formato "v1,abc v1,def" — basta UMA bater (rotação de segredo).
function timestampRecente(ts, agoraMs) {
  const t = parseInt(ts, 10);
  if (!isFinite(t)) return false;
  const diff = Math.abs((agoraMs || Date.now()) - t * 1000);
  return diff <= 5 * 60 * 1000;
}
function assinaturaValida(segredo, id, ts, corpoCru, header) {
  const crypto = require('crypto');
  // whsec_<base64>: o que assina é o segredo DECODIFICADO, não o texto do env.
  const chave = Buffer.from(String(segredo).replace(/^whsec_/, ''), 'base64');
  const esperada = crypto.createHmac('sha256', chave)
    .update(`${id}.${ts}.${corpoCru}`).digest('base64');
  const alvo = Buffer.from(esperada);
  return String(header).split(' ').some(parte => {
    const sig = parte.includes(',') ? parte.split(',')[1] : parte;
    const buf = Buffer.from(String(sig || ''));
    // timingSafeEqual exige o mesmo tamanho; tamanho diferente já é assinatura errada.
    return buf.length === alvo.length && crypto.timingSafeEqual(buf, alvo);
  });
}
// Ignorar é resposta de sucesso: webhook que recebe erro fica retentando para sempre.
function ignorado(motivo) {
  console.log('[inbound] ignorado — ' + motivo);
  return { status:200, body:{ success:true, data:{ ignored:motivo } } };
}

// Cabeçalhos do e-mail recebido, em minúsculas. O Resend manda como objeto ou como
// lista [{name,value}] dependendo do formato — aceita os dois.
function cabecalhosDe(d) {
  const out = {};
  const h = d && d.headers;
  if (!h) return out;
  if (Array.isArray(h)) h.forEach(x => { if (x && x.name) out[String(x.name).toLowerCase()] = String(x.value == null ? '' : x.value); });
  else if (typeof h === 'object') Object.keys(h).forEach(k => { out[k.toLowerCase()] = String(h[k] == null ? '' : h[k]); });
  return out;
}

// O e-mail só é tratado se veio para o endereço da Patrícia (EMAIL_INBOUND_ADDRESS).
function enderecoDaPatricia(to) {
  const alvo = String(process.env.EMAIL_INBOUND_ADDRESS || '').trim().toLowerCase();
  if (!alvo) return true; // não configurado: não filtra (o segredo do webhook já barra estranho)
  const lista = Array.isArray(to) ? to : [to];
  return lista.some(x => {
    const e = extraiEmail(x);
    return e && e.toLowerCase() === alvo;
  });
}

// RFC 3834 e vizinhança: como se reconhece "isto foi uma máquina que respondeu".
const REMETENTES_ROBO = /^(mailer-daemon|no-?reply|noreply|postmaster|bounce|bounces|donotreply)(\+|@|-)/i;
function respostaAutomatica(d, from) {
  const h = cabecalhosDe(d);
  const auto = (h['auto-submitted'] || '').trim().toLowerCase();
  if (auto && auto !== 'no') return 'Auto-Submitted: ' + auto;
  const prec = (h['precedence'] || '').trim().toLowerCase();
  if (['bulk','auto_reply','list','junk'].includes(prec)) return 'Precedence: ' + prec;
  if (h['x-auto-response-suppress']) return 'X-Auto-Response-Suppress presente';
  if (h['x-autoreply'] || h['x-autorespond'] || h['list-unsubscribe']) return 'cabeçalho de autoresposta/lista';
  const local = String(from || '').split('@')[0] + '@';
  if (REMETENTES_ROBO.test(local) || REMETENTES_ROBO.test(String(from || ''))) return 'remetente de sistema: ' + from;
  return null;
}

// Autenticação do remetente. O Resend pode ou não enviar Authentication-Results; quando
// não envia, NÃO dá para saber se o From é forjado — risco residual assumido e mitigado
// pela regra de nunca responder automático em proposta/negociação (as etapas com dinheiro
// ficam sempre na mão de gente).
function autenticacaoFalhou(d) {
  const h = cabecalhosDe(d);
  const ar = h['authentication-results'] || h['arc-authentication-results'] || '';
  if (!ar) {
    const dmarc = String((d && d.dmarc) || '').toLowerCase();
    const spf = String((d && d.spf) || '').toLowerCase();
    if (dmarc === 'fail' || spf === 'fail') return 'dmarc/spf=fail';
    return null; // sem informação: segue o fluxo normal (risco residual documentado acima)
  }
  const m = ar.match(/dmarc=(\w+)/i);
  if (m && m[1].toLowerCase() === 'fail') return 'dmarc=fail';
  const s = ar.match(/spf=(\w+)/i);
  if (s && s[1].toLowerCase() === 'fail') return 'spf=fail';
  const k = ar.match(/dkim=(\w+)/i);
  if (k && k[1].toLowerCase() === 'fail' && (!m || m[1].toLowerCase() !== 'pass')) return 'dkim=fail';
  return null;
}

// In-Reply-To / References citam o message-id que a Patrícia mandou: casamento exato.
function leadPorReferencia(d) {
  const h = cabecalhosDe(d);
  const brutos = (h['in-reply-to'] || '') + ' ' + (h['references'] || '') + ' '
    + String((d && d.inReplyTo) || '') + ' ' + String((d && d.in_reply_to) || '');
  const ids = (brutos.match(/[^\s<>,]+/g) || []).map(s => s.replace(/^<|>$/g, '')).filter(Boolean);
  if (!ids.length) return null;
  for (const id of ids) {
    const act = S.findOne('activities', a => a.type==='email_out' && a.message_id && a.message_id === id);
    if (act) {
      const lead = S.get('leads', act.lead_id);
      if (lead && lead.status === 'open') return lead.id;
    }
  }
  return null;
}

// Enxurrada de e-mail não pode virar enxurrada de lead (e de chamada de IA).
// Em memória de propósito: é defesa de instância única (ver nota de réplica única).
const criacoesPorDominio = new Map(); // dominio -> [timestamps]
let criacoesGlobais = [];
const JANELA_MS = 60 * 60 * 1000;
const MAX_POR_DOMINIO = 5, MAX_GLOBAL = 20;
function limiteDeCriacao(from, agoraMs) {
  const agora = agoraMs || Date.now();
  const corte = agora - JANELA_MS;
  const dom = String(from).split('@')[1] || 'desconhecido';
  const doDom = (criacoesPorDominio.get(dom) || []).filter(t => t > corte);
  criacoesGlobais = criacoesGlobais.filter(t => t > corte);
  if (doDom.length >= MAX_POR_DOMINIO) return `mais de ${MAX_POR_DOMINIO} leads/hora do domínio ${dom}`;
  if (criacoesGlobais.length >= MAX_GLOBAL) return `mais de ${MAX_GLOBAL} leads/hora por e-mail no total`;
  doDom.push(agora); criacoesPorDominio.set(dom, doDom);
  criacoesGlobais.push(agora);
  return null;
}
function _resetLimiteCriacao() { criacoesPorDominio.clear(); criacoesGlobais = []; }

// "Nome <e@mail.com>", {address}, {email} ou o e-mail puro.
function extraiEmail(v) {
  if (!v) return null;
  if (Array.isArray(v)) return extraiEmail(v[0]);
  if (typeof v === 'object') return extraiEmail(v.address || v.email || v.value);
  const s = String(v);
  const m = s.match(/<([^>]+)>/);
  const bruto = (m ? m[1] : s).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bruto) ? bruto : null;
}
function stripHtml(html) {
  if (!html) return '';
  return String(html).replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<script[\s\S]*?<\/script>/gi,' ')
    .replace(/<br\s*\/?>/gi,'\n').replace(/<\/p>/gi,'\n\n').replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/[ \t]{2,}/g,' ').trim();
}
// A lista de ids só existe para deduplicar: guarda os últimos 500 e esquece o resto.
// Evento ainda 'processing' nunca é podado — é ele que segura a retentativa.
function podaWebhookEvents() {
  const todos = S.all('webhook_events').filter(e => e.status !== 'processing');
  if (todos.length <= 500) return;
  todos.sort((a,b)=>a.id-b.id).slice(0, todos.length-500).forEach(e => S.remove('webhook_events', e.id));
}

// Máquina de estados do dedupe. Marcar "visto" antes de processar seria perder e-mail:
// bastava uma falha no meio para a retentativa legítima voltar como duplicada.
//   ausente                    -> processa (reserva como 'processing')
//   'processing' há < 2 min    -> é a mesma entrega ainda em curso: duplicado
//   'processing' há > 2 min    -> a tentativa anterior morreu (processo caiu): reprocessa
//   'done'                     -> duplicado de verdade
const PROCESSANDO_MS = 2 * 60 * 1000;
function reservarEvento(eventId) {
  const atual = S.findOne('webhook_events', e => e.event_id === eventId);
  if (atual) {
    if (atual.status === 'done') return { duplicado:true };
    const desde = msDe(atual.started_at) || 0;
    if (Date.now() - desde < PROCESSANDO_MS) return { duplicado:true, emAndamento:true };
    S.update('webhook_events', atual.id, { status:'processing', started_at:S.now(), retomado:1 });
    return { duplicado:false, id:atual.id };
  }
  const novo = S.insert('webhook_events', { event_id:eventId, source:'resend_inbound',
    status:'processing', started_at:S.now() });
  return { duplicado:false, id:novo.id };
}
function fecharEvento(eventId) {
  const e = S.findOne('webhook_events', x => x.event_id === eventId);
  if (e) S.update('webhook_events', e.id, { status:'done', done_at:S.now() });
}
// Falhou no meio: apaga o registro para a retentativa poder trabalhar na hora, sem
// precisar esperar a janela de 2 minutos.
function liberarEvento(eventId) {
  const e = S.findOne('webhook_events', x => x.event_id === eventId);
  if (e) S.remove('webhook_events', e.id);
}
// "YYYY-MM-DD HH:MM:SS" gravado em UTC — sem colar o Z o Node leria como hora local.
function msDe(v) {
  if (!v) return null;
  let s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) s = s.replace(' ','T') + 'Z';
  const t = Date.parse(s);
  return isNaN(t) ? null : t;
}

// require tardio: agentNexus depende deste módulo, então carregá-lo no topo fecharia um
// ciclo e o agente veria um api.js pela metade.
function dispararAgente(leadId){
  try { require('./agentNexus').dispararParaLead(leadId); }
  catch (e) { console.error('[agente] não foi possível disparar para o lead '+leadId+':', e.message); }
}

// log/notify saem daqui para o followups.js escrever timeline e sino no mesmo formato.
// Os passos do funil saem para o agentNexus.js executar exatamente o que o humano executa.
module.exports = { handle, log, notify, leadWithJoins, clientName,
  triageLead, closeLost, createQuote, savePricingFor, createProposal, promoverProposta, sendProposalEmail,
  logEmailIn, logEmailOut, SIGNATURE_TEXT, SIGNATURE_HTML,
  timestampRecente, assinaturaValida, extraiEmail, stripHtml,
  respostaAutomatica, autenticacaoFalhou, leadPorReferencia, limiteDeCriacao, _resetLimiteCriacao,
  reservarEvento, fecharEvento, liberarEvento };
