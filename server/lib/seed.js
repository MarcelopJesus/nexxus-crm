// seed.js — popula o banco (JSON) com dados de exemplo. Idempotente.
'use strict';
const store = require('./store');
const { hashPassword } = require('./auth');

function seedIfEmpty() {
  if (!store.isEmpty()) return false;
  const pw = hashPassword('senha123');

  const U = {};
  const users = [
    ['Joao Silva',        'joao@nexxustech.one',      'vendas',     'admin'],
    ['Marina Vendas',     'marina@nexxustech.one',    'vendas',     'user'],
    ['Bruno Pré-vendas',  'bruno@nexxustech.one',     'prevendas',  'user'],
    ['Carla Compras',     'carla@nexxustech.one',     'compras',    'user'],
    ['Diego Produto',     'diego@nexxustech.one',     'produto',    'user'],
    ['Elena Marketing',   'elena@nexxustech.one',     'marketing',  'user'],
    ['Felipe Financeiro', 'felipe@nexxustech.one',    'financeiro', 'manager'],
    ['Gabriela Jurídico', 'gabriela@nexxustech.one',  'juridico',   'user'],
  ];
  for (const [name, email, area, role] of users) {
    const u = store.insert('users', { name, email, password_hash: pw, area, role, active: 1 });
    if (!U[area]) U[area] = u.id;
  }
  const vendas = U['vendas'];

  store.data.config = { fx_mode:'api', fx_manual_rate:5.20, fx_spread_pct:0.04,
    import_tax_pct:0.15, invoice_tax_pct:0.10, target_margin_pct:0.20, min_margin_pct:0.10,
    updated_at: store.now() };

  const s1 = store.insert('suppliers', { name:'Atlassian', country:'Austrália', currency:'USD' }).id;
  const s2 = store.insert('suppliers', { name:'Autodesk', country:'EUA', currency:'USD' }).id;
  const s3 = store.insert('suppliers', { name:'JetBrains', country:'Rep. Tcheca', currency:'EUR' }).id;
  const p1 = store.insert('products', { supplier_id:s1, name:'Jira Software (100 users/ano)', sku:'JIRA-100', list_cost_usd:7700, currency:'USD' }).id;
  const p2 = store.insert('products', { supplier_id:s2, name:'AutoCAD LT (licença anual)', sku:'ACAD-LT', list_cost_usd:490, currency:'USD' }).id;
  const p3 = store.insert('products', { supplier_id:s3, name:'IntelliJ IDEA (10 seats)', sku:'IIDEA-10', list_cost_usd:1500, currency:'EUR' }).id;

  const a1 = store.insert('accounts', { name:'Construtora Alfa', cnpj:'11.222.333/0001-44', segment:'Construção', city:'São Paulo' }).id;
  const a2 = store.insert('accounts', { name:'Fintech Beta', cnpj:'22.333.444/0001-55', segment:'Financeiro', city:'Rio de Janeiro' }).id;
  const a3 = store.insert('accounts', { name:'Agência Gamma', cnpj:'33.444.555/0001-66', segment:'Marketing', city:'Curitiba' }).id;
  const c1 = store.insert('contacts', { account_id:a1, name:'Ricardo Mendes', email:'ricardo@alfa.com', phone:'(11) 99999-0001', role_title:'Head de TI' }).id;
  const c2 = store.insert('contacts', { account_id:a2, name:'Patrícia Souza', email:'patricia@beta.com', phone:'(21) 99999-0002', role_title:'CTO' }).id;
  const c3 = store.insert('contacts', { account_id:a3, name:'Lucas Oliveira', email:'lucas@gamma.com', phone:'(41) 99999-0003', role_title:'Diretor' }).id;

  const mkLead = (o) => store.insert('leads', Object.assign({
    hot:0, status:'open', lost_reason:null, estimated_value:null, qty:1, notes:null, source:'site',
    updated_at: store.now() }, o)).id;
  const L = [];
  L.push(mkLead({ title:'Alfa — Jira p/ 100 devs', account_id:a1, contact_id:c1, product_id:p1, requested_software:'Jira Software', stage:'novo_lead', owner_id:vendas, hot:1, notes:'Veio do formulário do site' }));
  L.push(mkLead({ title:'Beta — Licenças AutoCAD', account_id:a2, contact_id:c2, product_id:p2, requested_software:'AutoCAD LT', stage:'triagem', owner_id:vendas, qty:20, notes:'Precisa validar volume' }));
  L.push(mkLead({ title:'Gamma — IntelliJ time dev', account_id:a3, contact_id:c3, product_id:p3, requested_software:'IntelliJ IDEA', source:'indicacao', stage:'aguardando_cotacao', owner_id:vendas, hot:1, qty:10, notes:'Enviado p/ Compras' }));
  L.push(mkLead({ title:'Alfa — Confluence add-on', account_id:a1, contact_id:c1, product_id:p1, requested_software:'Confluence', source:'outbound', stage:'precificacao', owner_id:vendas }));
  L.push(mkLead({ title:'Beta — Renovação anual', account_id:a2, contact_id:c2, product_id:p2, requested_software:'AutoCAD', stage:'proposta_enviada', owner_id:vendas, estimated_value:48000, qty:15 }));
  L.push(mkLead({ title:'Gamma — Upsell seats', account_id:a3, contact_id:c3, product_id:p3, requested_software:'IntelliJ', source:'outbound', stage:'negociacao', owner_id:vendas, hot:1, estimated_value:62000, qty:12 }));

  store.insert('activities', { lead_id:L[0], user_id:vendas, type:'note', message:'Lead capturado automaticamente pelo formulário do site.' });
  store.insert('activities', { lead_id:L[2], user_id:vendas, type:'triage', message:'Demanda validada e despachada para Compras.' });
  store.insert('quotes', { lead_id:L[3], supplier_id:s1, product_id:p1, cost_amount:1200, cost_currency:'USD', qty:1, supplier_ref:'ATL-2026-0091', notes:null, status:'received', created_by:U['compras'] });
  store.insert('tasks', { lead_id:L[4], title:'Follow-up proposta (D+3)', type:'followup', area:'vendas', assignee_id:vendas, due_date:new Date(Date.now()+3*86400000).toISOString().slice(0,10), done:0 });
  store.insert('tasks', { lead_id:L[5], title:'Ligar para negociar condições', type:'followup', area:'vendas', assignee_id:vendas, due_date:new Date(Date.now()+1*86400000).toISOString().slice(0,10), done:0 });

  store.saveNow();
  return true;
}

module.exports = { seedIfEmpty };
if (require.main === module) { console.log(seedIfEmpty() ? 'Seed aplicado.' : 'Banco já populado.'); }
