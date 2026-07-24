// app.js — Nexxus CRM (Vue 3, global build). SPA com router por hash.
const { createApp, reactive, ref, computed, onMounted, watch, h } = Vue;

// ---------- helpers ----------
const BRL = (n) => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PCT = (n) => (Number(n || 0) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + '%';
const initials = (name) => (name || '?').split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();
const AREA_LABEL = { vendas:'Vendas', prevendas:'Pré-vendas', compras:'Compras', produto:'Produto', marketing:'Marketing', financeiro:'Financeiro', juridico:'Jurídico', admin:'Admin' };

const app = createApp({
  setup() {
    const route = ref(location.hash.replace('#', '') || '/');
    window.addEventListener('hashchange', () => { route.value = location.hash.replace('#', '') || '/'; });
    const go = (p) => { location.hash = '#' + p; };

    const S = reactive({
      user: null, ready: false,
      // login
      email: 'joao@nexxustech.one', password: 'senha123', loginErr: '', loggingIn: false,
      // data
      meta: { stages: [], areas: [], users: [] },
      fx: { rate: null, source: '', ts: 0 },
      leads: [], accounts: [], contacts: [], suppliers: [], products: [], tasks: [], users: [],
      config: null, report: null,
      // ui
      toast: '', drawer: null, drawerTab: 'resumo', showNewLead: false, dragId: null, dragOver: null,
      notif: { items: [], unread: 0 }, showNotif: false,
      newLead: { title:'', account_id:'', contact_id:'', product_id:'', requested_software:'', qty:1, source:'site', notes:'' },
      quoteForm: { supplier_id:'', product_id:'', cost_amount:'', cost_currency:'USD', qty:1, supplier_ref:'', notes:'' },
      priceCalc: null, propInput: { final_price:'', approve_below_floor:false }, closeForm:{ result:'', lost_reason:'' },
      noteInput: '', savingPrice:false,
      newSupplier:{ name:'', country:'', currency:'USD' }, newProduct:{ supplier_id:'', name:'', sku:'', list_cost_usd:'' },
      newUser:{ name:'', email:'', password:'senha123', area:'vendas', role:'user' },
      // SDR Agent
      sdr: { configured:false, model:'' },
      icp: { segment:'', size:'', region:'', software:'', notes:'', quantity: 8 },
      prospects: [], researching:false, importingId:null,
      genOutreach:false, genQualify:false, outreachTab:'email',
    });

    const stageLabel = (k) => (S.meta.stages.find(s => s.key === k) || {}).label || k;
    const flash = (m) => { S.toast = m; setTimeout(() => { if (S.toast === m) S.toast = ''; }, 2600); };
    const canArea = (a) => S.user && (S.user.role === 'admin' || S.user.area === 'admin' || S.user.area === a);

    // ---------- data loading ----------
    async function bootstrap() {
      if (!API.state.token) { S.ready = true; return; }
      const me = await API.get('/api/auth/me');
      if (!me.ok) { S.ready = true; return; }
      S.user = me.data.data.user;
      await Promise.all([loadMeta(), loadFx(), loadLeads(), loadCatalog(), loadConfig(), loadNotifications(), loadSdrStatus()]);
      S.ready = true;
    }
    async function loadMeta(){ const r = await API.get('/api/meta'); if (r.ok) S.meta = r.data.data; }
    async function loadFx(){ const r = await API.get('/api/fx'); if (r.ok) S.fx = r.data.data; }
    async function loadLeads(){ const r = await API.get('/api/leads'); if (r.ok) S.leads = r.data.data; }
    async function loadReport(){ const r = await API.get('/api/reports/summary'); if (r.ok) S.report = r.data.data; }
    async function loadConfig(){ const r = await API.get('/api/config/pricing'); if (r.ok) S.config = r.data.data; }
    async function loadTasks(){ const r = await API.get('/api/tasks'); if (r.ok) S.tasks = r.data.data; }
    async function loadUsers(){ const r = await API.get('/api/users'); if (r.ok) S.users = r.data.data; }
    async function loadNotifications(){ const r = await API.get('/api/notifications'); if (r.ok) S.notif = r.data.data; }
    // ---------- SDR Agent ----------
    async function loadSdrStatus(){ const r = await API.get('/api/sdr/status'); if (r.ok) S.sdr = r.data.data; }
    async function loadProspects(){ const r = await API.get('/api/sdr/prospects'); if (r.ok) S.prospects = r.data.data; }
    async function runResearch(){
      if (S.researching) return; S.researching = true;
      const r = await API.post('/api/sdr/research', S.icp);
      S.researching = false;
      if (r.ok) { flash(r.data.data.length + ' empresas-alvo encontradas.'); await loadProspects(); }
      else flash((r.data && r.data.error && r.data.error.message) || 'Erro na pesquisa.');
    }
    async function importProspect(p){
      S.importingId = p.id;
      const r = await API.post('/api/sdr/prospects/' + p.id + '/import', {});
      S.importingId = null;
      if (r.ok) { flash(p.company_name + ' importado para o funil.'); await Promise.all([loadProspects(), loadLeads(), loadCatalog()]); }
      else flash((r.data && r.data.error && r.data.error.message) || 'Erro ao importar.');
    }
    async function discardProspect(p){
      await API.del('/api/sdr/prospects/' + p.id); await loadProspects(); flash('Prospect descartado.');
    }
    async function generateOutreach(){
      if (S.genOutreach) return; S.genOutreach = true;
      const r = await API.post('/api/sdr/leads/' + S.drawer.lead.id + '/outreach', {});
      S.genOutreach = false;
      if (r.ok) { flash('Kit de abordagem gerado.'); await refreshDrawer(); S.drawerTab='sdr'; S.outreachTab='email'; }
      else flash((r.data && r.data.error && r.data.error.message) || 'Erro ao gerar abordagem.');
    }
    async function runQualify(){
      if (S.genQualify) return; S.genQualify = true;
      const r = await API.post('/api/sdr/leads/' + S.drawer.lead.id + '/qualify', {});
      S.genQualify = false;
      if (r.ok) { flash('Conta qualificada: ' + r.data.data.total_score + '/100 (Tier ' + r.data.data.tier + ').'); await refreshDrawer(); S.drawerTab='sdr'; }
      else flash((r.data && r.data.error && r.data.error.message) || 'Erro ao qualificar.');
    }
    function tierColor(t){ return ({A:'var(--nx-success)',B:'var(--nx-warning, #FF9500)',C:'var(--nx-danger)'})[t] || 'var(--nx-text-mute)'; }
    function fitColor(n){ return n>=80?'var(--nx-success)':(n>=60?'#FF9500':'var(--nx-text-mute)'); }
    async function markNotifRead(){ await API.post('/api/notifications/read', {}); await loadNotifications(); }
    function propLink(p){ return location.origin + '/p/' + p.token; }
    function propStatusLabel(p){ return ({draft:'Rascunho', sent:'Enviada', viewed:'Vista', accepted:'Aceita', rejected:'Recusada'})[p.status] || p.status; }
    async function copyText(t){ try { await navigator.clipboard.writeText(t); flash('Link copiado.'); } catch(e) { flash('Copie: ' + t); } }
    function copyProposal(p){ copyText(propLink(p)); }
    function openProposal(p){ window.open(propLink(p), '_blank'); }
    async function sendPropEmail(p){
      const r = await API.post('/api/proposals/' + p.id + '/send-email', {});
      if (!r.ok) { flash((r.data && r.data.error && r.data.error.message) || 'Erro ao enviar.'); return; }
      if (r.data.data.email && r.data.data.email.sent) flash('E-mail enviado ao cliente.');
      else flash('Serviço de e-mail não configurado — use "Copiar link" e envie por WhatsApp/e-mail.');
      await refreshDrawer();
    }
    function isOverdue(t){ return !t.done && t.due_date && t.due_date < new Date().toISOString().slice(0,10); }
    function isToday(t){ return !t.done && t.due_date === new Date().toISOString().slice(0,10); }
    const SRC_COLORS = { site:'#0071E3', checkout:'#34C759', newsletter:'#FF9500', indicacao:'#5E5CE6', outbound:'#FF2D55' };
    function srcColor(k){ return SRC_COLORS[k] || '#86868B'; }
    function barPct(v){ const arr = (S.report && S.report.bySource) || []; const max = Math.max(1, ...arr.map(x=>x.revenue||0)); return Math.round((v/max)*100); }
    async function loadCatalog(){
      const [ac, ct, su, pr] = await Promise.all([API.get('/api/accounts'), API.get('/api/contacts'), API.get('/api/suppliers'), API.get('/api/products')]);
      if (ac.ok) S.accounts = ac.data.data; if (ct.ok) S.contacts = ct.data.data;
      if (su.ok) S.suppliers = su.data.data; if (pr.ok) S.products = pr.data.data;
    }

    // ---------- auth ----------
    async function doLogin() {
      S.loginErr = ''; S.loggingIn = true;
      const r = await API.post('/api/auth/admin/login', { email: S.email, password: S.password });
      S.loggingIn = false;
      if (!r.ok) { S.loginErr = (r.data && r.data.error && r.data.error.message) || 'Falha no login.'; return; }
      API.setToken(r.data.data.token); S.user = r.data.data.user;
      await bootstrap(); go('/');
    }
    function logout(){ API.logout(); S.user = null; }

    // ---------- pipeline ----------
    const leadsByStage = computed(() => {
      const map = {}; S.meta.stages.forEach(s => map[s.key] = []);
      S.leads.filter(l => l.status === 'open').forEach(l => { (map[l.stage] = map[l.stage] || []).push(l); });
      return map;
    });
    function onDragStart(l){ S.dragId = l.id; }
    function onDrop(stageKey){
      const id = S.dragId; S.dragOver = null; S.dragId = null;
      const lead = S.leads.find(l => l.id === id); if (!lead || lead.stage === stageKey) return;
      lead.stage = stageKey; // otimista
      API.patch('/api/leads/' + id + '/stage', { stage: stageKey }).then(loadLeads);
      flash('Lead movido para ' + stageLabel(stageKey));
    }
    async function createLead(){
      if (!S.newLead.title) { flash('Informe um título.'); return; }
      const r = await API.post('/api/leads', S.newLead);
      if (r.ok) { S.showNewLead = false; S.newLead = { title:'', account_id:'', contact_id:'', product_id:'', requested_software:'', qty:1, source:'site', notes:'' }; await loadLeads(); flash('Lead criado.'); }
    }

    // ---------- lead drawer ----------
    async function openLead(id){
      const r = await API.get('/api/leads/' + id);
      if (r.ok) { const keepTab = S.drawer && S.drawer.lead.id === r.data.data.lead.id ? S.drawerTab : 'resumo';
        S.drawer = r.data.data; S.drawerTab = keepTab; S.priceCalc = null;
        const q = S.drawer.quotes[0];
        S.quoteForm = { supplier_id:'', product_id: S.drawer.lead.product_id || '', cost_amount:'', cost_currency:'USD', qty: S.drawer.lead.qty || 1, supplier_ref:'', notes:'' };
        S.propInput = { final_price:'', approve_below_floor:false }; S.closeForm = { result:'', lost_reason:'' };
      }
    }
    async function refreshDrawer(){ if (S.drawer) await openLead(S.drawer.lead.id); await loadLeads(); }
    function closeDrawer(){ S.drawer = null; }

    async function triage(){ await API.post('/api/leads/' + S.drawer.lead.id + '/triage', {}); flash('Despachado para Compras.'); await refreshDrawer(); }
    async function toggleHot(){ await API.post('/api/leads/' + S.drawer.lead.id + '/hot', {}); await refreshDrawer(); }
    async function addNote(){ if (!S.noteInput) return; await API.post('/api/activities', { lead_id:S.drawer.lead.id, message:S.noteInput }); S.noteInput=''; await refreshDrawer(); }

    async function submitQuote(){
      const f = S.quoteForm; if (!f.cost_amount) { flash('Informe o custo.'); return; }
      const r = await API.post('/api/quotes', { lead_id: S.drawer.lead.id, ...f, cost_amount: Number(f.cost_amount) });
      if (r.ok) { flash('Cotação registrada.'); await refreshDrawer(); S.drawerTab = 'precificacao'; }
      else flash((r.data && r.data.error && r.data.error.message) || 'Erro.');
    }
    async function runPricing(){
      const q = S.drawer.quotes[0]; if (!q) { flash('Registre uma cotação primeiro.'); return; }
      const r = await API.post('/api/pricing/calculate', { cost_usd: q.cost_amount, qty: q.qty });
      if (r.ok) S.priceCalc = r.data.data;
    }
    async function savePricing(){
      const q = S.drawer.quotes[0]; if (!q) return; S.savingPrice = true;
      const r = await API.post('/api/pricing', { lead_id:S.drawer.lead.id, quote_id:q.id, cost_usd:q.cost_amount, qty:q.qty });
      S.savingPrice = false;
      if (r.ok) { flash('Precificação salva. Preços disponíveis para o vendedor.'); await refreshDrawer(); }
    }
    async function sendProposal(){
      const r = await API.post('/api/proposals', { lead_id:S.drawer.lead.id, final_price:Number(S.propInput.final_price), approve_below_floor:S.propInput.approve_below_floor });
      if (r.status === 422) { S.propInput.belowFloorMsg = r.data.error.message; flash('Abaixo do piso — marque a aprovação para prosseguir.'); return; }
      if (r.ok) { flash('Proposta enviada. Follow-ups agendados.'); S.propInput = { final_price:'', approve_below_floor:false }; await refreshDrawer(); S.drawerTab = 'timeline'; }
    }
    async function closeLead(){
      if (!S.closeForm.result) { flash('Escolha ganho ou perdido.'); return; }
      await API.post('/api/leads/' + S.drawer.lead.id + '/close', S.closeForm);
      flash(S.closeForm.result === 'won' ? 'Ganho! Gatilho enviado ao Jurídico.' : 'Marcado como perdido.');
      await refreshDrawer(); await loadLeads();
    }
    async function toggleTask(t){ await API.patch('/api/tasks/' + t.id, { done: !t.done }); await refreshDrawer(); await loadTasks(); }
    async function toggleTaskRow(t){ await API.patch('/api/tasks/' + t.id, { done: !t.done }); await loadTasks(); }
    async function updateContract(status){ if (!S.drawer.contract) return; await API.patch('/api/contracts/' + S.drawer.contract.id, { status }); await refreshDrawer(); }

    const latestPricing = computed(() => S.drawer && S.drawer.pricings && S.drawer.pricings[0]);

    // ---------- config / catalog / users ----------
    async function saveConfig(){ const r = await API.put('/api/config/pricing', S.config); if (r.ok){ S.config = r.data.data; flash('Regras de precificação salvas.'); } else flash((r.data&&r.data.error&&r.data.error.message)||'Sem permissão.'); }
    async function addSupplier(){ if(!S.newSupplier.name)return; const r=await API.post('/api/suppliers', S.newSupplier); if(r.ok){ S.newSupplier={name:'',country:'',currency:'USD'}; await loadCatalog(); flash('Fornecedor adicionado.'); } }
    async function addProduct(){ if(!S.newProduct.name)return; const r=await API.post('/api/products', S.newProduct); if(r.ok){ S.newProduct={supplier_id:'',name:'',sku:'',list_cost_usd:''}; await loadCatalog(); flash('Produto adicionado.'); } }
    async function addUser(){ if(!S.newUser.name||!S.newUser.email)return; const r=await API.post('/api/users', S.newUser); if(r.ok){ S.newUser={name:'',email:'',password:'senha123',area:'vendas',role:'user'}; await loadUsers(); flash('Usuário criado.'); } else flash((r.data&&r.data.error&&r.data.error.message)||'Sem permissão.'); }

    // route-driven loads
    watch(route, (r) => {
      if (r === '/' || r === '/dashboard') loadReport();
      if (r === '/tarefas') loadTasks();
      if (r === '/usuarios') loadUsers();
      if (r === '/sdr') loadProspects();
    }, { immediate: false });

    onMounted(async () => { await bootstrap(); if ((route.value === '/' || route.value === '/dashboard') && S.user) loadReport(); });
    // FX auto-refresh a cada 5 min
    setInterval(() => { if (S.user) loadFx(); }, 300000);
    setInterval(() => { if (S.user) loadNotifications(); }, 30000);

    const filteredContacts = computed(() => S.newLead.account_id ? S.contacts.filter(c => c.account_id == S.newLead.account_id) : S.contacts);

    return { S, route, go, stageLabel, AREA_LABEL, BRL, PCT, initials, canArea, flash,
      doLogin, logout, leadsByStage, onDragStart, onDrop, createLead, openLead, closeDrawer,
      triage, toggleHot, addNote, submitQuote, runPricing, savePricing, sendProposal, closeLead,
      toggleTask, toggleTaskRow, updateContract, latestPricing, saveConfig, addSupplier, addProduct, addUser,
      loadReport, loadTasks, loadUsers, filteredContacts,
      loadNotifications, markNotifRead, propLink, propStatusLabel, copyText, copyProposal, openProposal, sendPropEmail, isOverdue, isToday, srcColor, barPct,
      loadProspects, runResearch, importProspect, discardProspect, generateOutreach, runQualify, tierColor, fitColor };
  },
  template: APP_TEMPLATE(),
});
app.mount('#app');
