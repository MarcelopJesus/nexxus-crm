// api.js — rotas REST do Nexxus CRM sobre o store JSON (sem SQL).
'use strict';
const store = require('./store');
const { verifyPassword, sign, hashPassword } = require('./auth');
const { getUsdBrl } = require('./fx');
const { calculatePricing } = require('./pricing');
const { sendEmail, isConfigured } = require('./mailer');
const sdr = require('./sdr');
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
function notify(type, message, leadId){ S.insert('notifications', { type, message, lead_id: leadId||null, read:0 }); }
function pickOwner(){
  const vend = S.find('users', u=>u.active && u.area==='vendas');
  if (!vend.length) { const admin = S.findOne('users', u=>u.active && (u.role==='admin'||u.area==='admin')); return admin?admin.id:null; }
  S.data.rr = ((S.data.rr||0) + 1); return vend[S.data.rr % vend.length].id;
}
function makeToken(){ return require('crypto').randomBytes(16).toString('hex'); }
function baseUrl(req){
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/,'');
  const h = req.headers||{};
  const proto = (h['x-forwarded-proto']||'http').split(',')[0];
  const host = h['x-forwarded-host'] || h['host'] || 'localhost:3001';
  return proto+'://'+host;
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
      const lead = S.insert('leads', { title: 'Pedido pago — '+companyName, account_id:acc.id, contact_id:ct.id, product_id:null,
        requested_software: items||message, source:'checkout', stage:'proposta_enviada', owner_id:owner, hot:0,
        status:'won', lost_reason:null, estimated_value: valueNum||null, qty:1,
        notes: 'Pedido pago via site'+(cf.pedido_id?(' (#'+cf.pedido_id+')'):'')+(items?('\nItens: '+items):''), updated_at:S.now() });
      log(lead.id, owner, 'close', 'Pedido pago no site — negócio GANHO'+(cf.pedido_id?(' (pedido #'+cf.pedido_id+')'):'')+'. Valor R$ '+valueNum.toLocaleString('pt-BR')+'.');
      notify('order_paid', `Pedido pago no site: ${companyName} — R$ ${valueNum.toLocaleString('pt-BR')}.`, lead.id);
      return { status:201, body:{ success:true, data:{ id:lead.id, owner_id:owner, kind:'order' } } };
    }

    const lead = S.insert('leads', { title: companyName+' — '+(kind==='newsletter'?'Newsletter':(message?String(message).slice(0,40):'Consulta do site')),
      account_id:acc.id, contact_id:ct.id, product_id:null, requested_software:message,
      source:(kind==='newsletter'?'newsletter':'site'), stage:'novo_lead', owner_id:owner, hot:0, status:'open',
      lost_reason:null, estimated_value:null, qty:1, notes:(message||'')+(protocol?('\nProtocolo site: '+protocol):''), updated_at:S.now() });
    log(lead.id, owner, 'note', 'Lead capturado automaticamente do site'+(protocol?(' (protocolo '+protocol+')'):'')+'.');
    notify('lead_new', `Novo lead do site: ${companyName} — atribuído a ${ownerName||'—'}.`, lead.id);
    return { status:201, body:{ success:true, data:{ id:lead.id, owner_id:owner, kind } } };
  }
  // Página pública da proposta (rastreio de abertura).
  if ((m=P(/^\/api\/public\/proposals\/([a-f0-9]{16,})$/)) && method==='GET') {
    const prop = S.findOne('proposals', x=> x.token===m[1]); if (!prop) return notfound();
    const lead = leadWithJoins(prop.lead_id);
    if (!prop.viewed_at) { S.update('proposals', prop.id, { viewed_at:S.now(), status: prop.status==='accepted'?'accepted':'viewed' });
      log(prop.lead_id, null, 'proposal', `Proposta v${prop.version} foi ABERTA pelo cliente.`);
      notify('proposal_viewed', `${lead?lead.account_name:'Cliente'} abriu a proposta v${prop.version}.`, prop.lead_id); }
    return { status:200, body:{ success:true, data:{
      company: lead?lead.account_name:null, contact: lead?lead.contact_name:null,
      software: lead?(lead.requested_software||lead.product_name):null, seller: lead?lead.owner_name:null,
      version: prop.version, final_price: prop.final_price, status: prop.status,
      created_at: prop.created_at, accepted_at: prop.accepted_at||null } } };
  }
  if ((m=P(/^\/api\/public\/proposals\/([a-f0-9]{16,})\/accept$/)) && method==='POST') {
    const prop = S.findOne('proposals', x=> x.token===m[1]); if (!prop) return notfound();
    S.update('proposals', prop.id, { status:'accepted', accepted_at:S.now() });
    const lead = leadWithJoins(prop.lead_id);
    log(prop.lead_id, null, 'proposal', `Proposta v${prop.version} ACEITA pelo cliente.`);
    notify('proposal_accepted', `${lead?lead.account_name:'Cliente'} ACEITOU a proposta v${prop.version}! 🎉`, prop.lead_id);
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
    S.update('leads', id, { stage:'aguardando_cotacao', status:'open', updated_at:S.now() });
    const lead = leadWithJoins(id);
    const compras = S.findOne('users', u=>u.area==='compras' && u.active);
    S.insert('tasks', { lead_id:id, title:'Solicitar cotação ao fabricante: '+(lead.requested_software||lead.title), type:'quote_request', area:'compras', assignee_id:compras?compras.id:null, due_date:new Date(Date.now()+2*86400000).toISOString().slice(0,10), done:0 });
    log(id, user.id, 'triage', 'Demanda validada e despachada para Compras (aguardando cotação).');
    return { status:200, body:{ success:true, data: lead } };
  }
  if ((m=P(/^\/api\/leads\/(\d+)\/hot$/)) && method==='POST') {
    const id=+m[1]; const l=S.get('leads', id); const nv=l.hot?0:1; S.update('leads', id, { hot:nv });
    return { status:200, body:{ success:true, data:{ hot:nv } } };
  }
  if ((m=P(/^\/api\/leads\/(\d+)\/close$/)) && method==='POST') {
    const id=+m[1]; const result=body.result;
    if (result==='won') {
      S.update('leads', id, { status:'won' });
      const lead = leadWithJoins(id);
      const lastProp = S.find('proposals', p=>p.lead_id===id).sort((a,b)=>b.version-a.version)[0];
      const val = lead.estimated_value || (lastProp?lastProp.final_price:null);
      S.insert('contracts', { lead_id:id, status:'pending', value:val, notes:null });
      const jur = S.findOne('users', u=>u.area==='juridico' && u.active);
      S.insert('tasks', { lead_id:id, title:'Emitir contrato — '+lead.title, type:'contract', area:'juridico', assignee_id:jur?jur.id:null, done:0, due_date:null });
      notify('won', `Negócio GANHO: ${lead?lead.title:('#'+id)}.`, id);
      log(id, user.id, 'close', 'Negócio GANHO (Close Won). Gatilho enviado ao Jurídico.');
      return { status:200, body:{ success:true, data:{ status:'won' } } };
    } else {
      S.update('leads', id, { status:'lost', lost_reason: body.lost_reason||'Não informado' });
      log(id, user.id, 'close', 'Negócio PERDIDO (Close Lost). Motivo: '+(body.lost_reason||'Não informado'));
      return { status:200, body:{ success:true, data:{ status:'lost' } } };
    }
  }

  // ==================== SDR AGENT ====================
  // Status da IA
  if (method==='GET' && path==='/api/sdr/status') {
    return { status:200, body:{ success:true, data:{ configured: sdr.isConfigured(), model: sdr.MODEL } } };
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
          due_date:new Date(Date.now()+(i+1)*86400000).toISOString().slice(0,10), done:0 });
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
    const r = S.insert('quotes', { lead_id:body.lead_id, supplier_id:body.supplier_id||null, product_id:body.product_id||null,
      cost_amount:Number(body.cost_amount), cost_currency:body.cost_currency||'USD', qty:body.qty||1,
      supplier_ref:body.supplier_ref||null, notes:body.notes||null, status:'received', created_by:user.id });
    const lead = S.get('leads', body.lead_id);
    if (lead && ['aguardando_cotacao','triagem','novo_lead'].includes(lead.stage)) S.update('leads', body.lead_id, { stage:'precificacao' });
    touchLead(body.lead_id);
    notify('quote_received', `Cotação recebida para o lead #${body.lead_id}.`, body.lead_id);
    log(body.lead_id, user.id, 'quote', `Cotação registrada: ${body.cost_currency||'USD'} ${Number(body.cost_amount).toLocaleString('pt-BR')} (ref ${body.supplier_ref||'-'}).`);
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
    const c = getConfig();
    const fx = c.fx_mode==='manual' ? { rate:c.fx_manual_rate } : await getUsdBrl();
    const r = calculatePricing({ costUsd:Number(body.cost_usd), qty:Number(body.qty)||1,
      fxBase:Number(body.fx_base!=null?body.fx_base:fx.rate), fxSpreadPct:c.fx_spread_pct,
      importTaxPct:c.import_tax_pct, invoiceTaxPct:c.invoice_tax_pct, targetMarginPct:c.target_margin_pct, minMarginPct:c.min_margin_pct });
    const row = S.insert('pricings', { lead_id:body.lead_id, quote_id:body.quote_id||null, cost_usd:r.costUsd, fx_rate:r.fxRate,
      fx_base:r.fxBase, import_tax_pct:r.importTaxPct, invoice_tax_pct:r.invoiceTaxPct, target_margin_pct:r.targetMarginPct,
      min_margin_pct:r.minMarginPct, cost_brl:r.costBrl, cost_with_import:r.costWithImport, suggested_price:r.suggestedPrice, min_price:r.minPrice });
    log(body.lead_id, user.id, 'pricing', `Precificação gerada — Sugerido R$ ${fmt(r.suggestedPrice)} / Mínimo R$ ${fmt(r.minPrice)}.`);
    return { status:201, body:{ success:true, data: Object.assign({ id:row.id }, r) } };
  }

  // ---- Propostas ----
  if (method==='POST' && path==='/api/proposals') {
    const leadId = body.lead_id;
    const props = S.find('proposals', p=>p.lead_id===leadId);
    const last = props.reduce((mx,p)=>Math.max(mx,p.version), 0);
    const pricing = S.find('pricings', p=>p.lead_id===leadId).sort(byCreatedDesc)[0];
    const floor = pricing ? pricing.min_price : (body.min_price||0);
    const suggested = pricing ? pricing.suggested_price : (body.suggested_price||null);
    const finalPrice = Number(body.final_price);
    const below = floor && finalPrice < floor ? 1 : 0;
    if (below && !body.approve_below_floor)
      return { status:422, body:{ success:false, code:'BELOW_FLOOR',
        error:{ message:`Preço R$ ${fmt(finalPrice)} está ABAIXO do piso (R$ ${fmt(floor)}). Requer aprovação gerencial.` },
        data:{ floor, suggested } } };
    const row = S.insert('proposals', { lead_id:leadId, version:last+1, final_price:finalPrice, min_price:floor||null,
      suggested_price:suggested, below_floor:below, approved_by:below?user.id:null, status:'sent',
      token:makeToken(), viewed_at:null, accepted_at:null, created_by:user.id });
    S.update('leads', leadId, { stage:'proposta_enviada', estimated_value:finalPrice, updated_at:S.now() });
    for (const d of [3,7,15])
      S.insert('tasks', { lead_id:leadId, title:`Follow-up proposta v${last+1} (D+${d})`, type:'followup', area:'vendas', assignee_id:user.id, due_date:new Date(Date.now()+d*86400000).toISOString().slice(0,10), done:0 });
    log(leadId, user.id, 'proposal', `Proposta v${last+1} enviada — R$ ${fmt(finalPrice)}${below?' (ABAIXO do piso, aprovada)':''}. Follow-ups agendados (D+3/7/15).`);
    return { status:201, body:{ success:true, data: row } };
  }

  // Enviar proposta por e-mail (usa serviço configurado; senão devolve o link)
  if ((m=P(/^\/api\/proposals\/(\d+)\/send-email$/)) && method==='POST') {
    const prop = S.get('proposals', +m[1]); if (!prop) return notfound();
    if (!prop.token) { prop.token = makeToken(); S.update('proposals', prop.id, { token: prop.token }); }
    const lead = leadWithJoins(prop.lead_id);
    const link = baseUrl(req) + '/p/' + prop.token;
    const to = body.to || (lead && lead.contact_email);
    if (!to) return { status:400, body:{ success:false, error:{ message:'Sem e-mail do contato. Informe um destinatário.' } } };
    const html = `<div style="font-family:Inter,Arial,sans-serif;color:#1D1D1F">`
      + `<h2 style="color:#0071E3">Proposta comercial — NexxusCRM</h2>`
      + `<p>Olá, ${lead?lead.contact_name||'':''}. Preparamos sua proposta para <b>${lead?lead.requested_software||lead.product_name||'a solução solicitada':''}</b>.</p>`
      + `<p><a href="${link}" style="background:#0071E3;color:#fff;padding:12px 20px;border-radius:980px;text-decoration:none;font-weight:600">Ver proposta</a></p>`
      + `<p style="color:#86868B;font-size:13px">Ou copie: ${link}</p></div>`;
    const r = await sendEmail({ to, subject:'Sua proposta — NexxusCRM', html });
    if (r.sent) { S.update('proposals', prop.id, { status: prop.status==='accepted'?'accepted':'sent' });
      log(prop.lead_id, user.id, 'proposal', 'Proposta enviada por e-mail para '+to+'.'); }
    return { status:200, body:{ success:true, data:{ link, email: r, configured: isConfigured() } } };
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

module.exports = { handle };
