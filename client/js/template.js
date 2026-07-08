function APP_TEMPLATE() { return `
<div v-if="!S.ready" style="min-height:100vh;display:flex;align-items:center;justify-content:center;color:var(--nx-text-soft)">Carregando…</div>

<!-- ============ LOGIN ============ -->
<div v-else-if="!S.user" class="login-wrap">
  <div class="login-hero">
    <div class="login-brand">Nexxus<span>CRM</span></div>
    <div>
      <h1>A Máquina de Vendas<br/>B2B de Software.</h1>
      <p>Do lead à assinatura: triagem, cotação internacional, precificação automática com câmbio ao vivo e follow-up — tudo em um fluxo só.</p>
      <div class="login-tags">
        <span class="login-tag">Funil Kanban</span><span class="login-tag">Cotação USD</span>
        <span class="login-tag">Precificação automática</span><span class="login-tag">Câmbio em tempo real</span>
      </div>
    </div>
    <div class="small" style="color:#8b90bb">© 2026 NexxusTECH · Revenda B2B de Softwares</div>
  </div>
  <div class="login-form-col">
    <div class="login-card">
      <h2>Entrar</h2>
      <p class="muted">Acesse o CRM com suas credenciais.</p>
      <div v-if="S.loginErr" class="error-box">{{ S.loginErr }}</div>
      <form @submit.prevent="doLogin">
        <div class="field"><label>E-mail</label><input v-model="S.email" type="email" autocomplete="username" placeholder="voce@nexxustech.one"/></div>
        <div class="field"><label>Senha</label><input v-model="S.password" type="password" autocomplete="current-password" placeholder="••••••••"/></div>
        <button class="btn btn-block" :disabled="S.loggingIn">{{ S.loggingIn ? 'Entrando…' : 'Entrar' }}</button>
      </form>
      <p class="small muted mt">Demo: <b>joao@nexxustech.one</b> / senha123 · também: carla (compras), felipe (financeiro), gabriela (jurídico)…</p>
    </div>
  </div>
</div>

<!-- ============ APP SHELL ============ -->
<div v-else class="shell">
  <aside class="sidebar">
    <div class="brand">Nexxus<span>CRM</span></div>
    <div class="nav-group">Operação</div>
    <div class="nav-item" :class="{active: route==='/'||route==='/dashboard'}" @click="go('/')"><span class="ic">▚</span> Dashboard</div>
    <div class="nav-item" :class="{active: route==='/funil'}" @click="go('/funil')"><span class="ic">▤</span> Funil de Vendas</div>
    <div class="nav-item" :class="{active: route==='/tarefas'}" @click="go('/tarefas'); loadTasks()"><span class="ic">✓</span> Tarefas & Follow-up</div>
    <div class="nav-group">Administração</div>
    <div class="nav-item" :class="{active: route==='/config'}" @click="go('/config')"><span class="ic">⚙</span> Catálogo & Regras</div>
    <div class="nav-item" :class="{active: route==='/usuarios'}" @click="go('/usuarios'); loadUsers()"><span class="ic">◔</span> Usuários</div>
    <div class="nav-group">Áreas</div>
    <div class="small" style="color:var(--nx-text-mute);padding:0 11px;line-height:1.9">Vendas · Pré-vendas · Compras · Produto · Marketing · Financeiro · Jurídico</div>
  </aside>

  <div class="main">
    <div class="topbar">
      <h1>
        <template v-if="route==='/'||route==='/dashboard'">Dashboard</template>
        <template v-else-if="route==='/funil'">Funil de Vendas</template>
        <template v-else-if="route==='/tarefas'">Tarefas & Follow-up</template>
        <template v-else-if="route==='/config'">Catálogo & Regras de Precificação</template>
        <template v-else-if="route==='/usuarios'">Usuários & Permissões</template>
      </h1>
      <div class="flex center gap">
        <div class="fx-pill" title="Câmbio USD/BRL em tempo real"><span class="dot"></span> USD/BRL {{ S.fx.rate ? Number(S.fx.rate).toFixed(4) : '—' }} <span class="small muted" style="font-weight:500">· {{ S.fx.source }}</span></div>
        <div style="position:relative">
          <button class="btn btn-ghost btn-sm" @click="S.showNotif=!S.showNotif; markNotifRead()" title="Notificações" style="position:relative">
            🔔<span v-if="S.notif.unread" style="position:absolute;top:-5px;right:-5px;background:var(--nx-hot);color:#fff;border-radius:999px;font-size:10px;padding:1px 5px;font-weight:700">{{ S.notif.unread }}</span>
          </button>
          <div v-if="S.showNotif" style="position:absolute;right:0;top:44px;width:330px;background:#fff;border:1px solid var(--nx-border);border-radius:14px;box-shadow:var(--nx-shadow-lg);z-index:60;max-height:400px;overflow:auto">
            <div style="padding:12px 14px;font-weight:700;border-bottom:1px solid var(--nx-border)">Notificações</div>
            <div v-for="n in S.notif.items" :key="n.id" style="padding:11px 14px;border-bottom:1px solid var(--nx-border);font-size:13px" @click="n.lead_id && openLead(n.lead_id); S.showNotif=false" :style="{cursor: n.lead_id?'pointer':'default'}">
              <div>{{ n.message }}</div><div class="muted" style="font-size:11.5px;margin-top:2px">{{ n.created_at }}</div>
            </div>
            <p v-if="!S.notif.items.length" class="muted small" style="padding:16px">Nenhuma notificação ainda.</p>
          </div>
        </div>
        <div class="user-chip">
          <div class="avatar">{{ initials(S.user.name) }}</div>
          <div class="small"><div style="font-weight:700">{{ S.user.name }}</div><div class="muted">{{ AREA_LABEL[S.user.area] }}</div></div>
          <button class="btn btn-ghost btn-sm" @click="logout">Sair</button>
        </div>
      </div>
    </div>

    <div class="content">
      <!-- ===== DASHBOARD ===== -->
      <div v-if="route==='/'||route==='/dashboard'">
        <div v-if="S.report">
          <div class="grid kpis mb">
            <div class="card card-p kpi"><div class="kpi-label">Oportunidades abertas</div><div class="kpi-value">{{ S.report.open }}</div><div class="kpi-sub">no funil</div></div>
            <div class="card card-p kpi"><div class="kpi-label">Forecast (proposta+negociação)</div><div class="kpi-value" style="color:var(--nx-primary)">{{ BRL(S.report.forecast) }}</div><div class="kpi-sub">receita potencial</div></div>
            <div class="card card-p kpi"><div class="kpi-label">Ganhos</div><div class="kpi-value" style="color:var(--nx-success)">{{ S.report.won.c }}</div><div class="kpi-sub">{{ BRL(S.report.won.v) }} fechados</div></div>
            <div class="card card-p kpi"><div class="kpi-label">Taxa de conversão</div><div class="kpi-value">{{ PCT(S.report.conversion) }}</div><div class="kpi-sub">{{ S.report.won.c }} ganhos / {{ S.report.lost }} perdidos</div></div>
          </div>
          <div class="row2">
            <div class="card card-p">
              <div class="section-title">Funil por etapa</div>
              <div v-for="s in S.report.stages" :key="s.key" class="mb">
                <div class="flex between small" style="margin-bottom:5px"><span><span class="stage-dot" :style="{background:'var(--st-'+s.key+')'}"></span>{{ s.label }}</span><b>{{ S.report.byStage[s.key] }}</b></div>
                <div class="bar"><span :style="{width: Math.min(100, (S.report.byStage[s.key]/(S.report.open||1))*100)+'%'}"></span></div>
              </div>
            </div>
            <div class="card card-p">
              <div class="section-title">Motivos de perda</div>
              <table class="tbl" v-if="S.report.lostReasons.length"><tbody>
                <tr v-for="r in S.report.lostReasons" :key="r.reason"><td>{{ r.reason }}</td><td style="text-align:right"><b>{{ r.c }}</b></td></tr>
              </tbody></table>
              <p v-else class="muted small">Nenhuma perda registrada ainda.</p>
              <div class="section-title mt">Câmbio</div>
              <p class="small muted">Taxa USD/BRL: <b>{{ S.fx.rate ? Number(S.fx.rate).toFixed(4) : '—' }}</b> (fonte: {{ S.fx.source }}). Usada pelo motor de precificação com o spread configurado pelo Financeiro.</p>
            </div>
          </div>
          <div class="card card-p mt">
            <div class="flex between center mb">
              <div class="section-title" style="margin:0">Origem dos negócios</div>
              <span class="muted small">retorno por canal</span>
            </div>
            <table class="tbl">
              <thead><tr><th>Canal</th><th style="text-align:center">Leads</th><th style="text-align:center">Ganhos</th><th style="text-align:center">Conversão</th><th style="text-align:right">Faturamento ganho</th></tr></thead>
              <tbody>
                <tr v-for="r in S.report.bySource" :key="r.source">
                  <td><span class="stage-dot" :style="{background: srcColor(r.source)}"></span>{{ r.label }}</td>
                  <td style="text-align:center">{{ r.total }}</td>
                  <td style="text-align:center"><b>{{ r.won }}</b></td>
                  <td style="text-align:center">{{ PCT(r.convRate) }}</td>
                  <td style="text-align:right" class="mono"><b :style="{color: r.revenue>0?'var(--nx-success)':'inherit'}">{{ BRL(r.revenue) }}</b></td>
                </tr>
                <tr v-if="!S.report.bySource || !S.report.bySource.length"><td colspan="5" class="muted" style="padding:16px">Sem dados de origem ainda.</td></tr>
              </tbody>
            </table>
            <div class="mt">
              <div v-for="r in S.report.bySource" :key="'bar-'+r.source" class="mb">
                <div class="flex between small" style="margin-bottom:5px"><span>{{ r.label }}</span><span class="muted">{{ BRL(r.revenue) }}</span></div>
                <div class="bar"><span :style="{width: barPct(r.revenue)+'%', background: srcColor(r.source)}"></span></div>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="muted">Carregando indicadores…</div>
      </div>

      <!-- ===== FUNIL (KANBAN) ===== -->
      <div v-else-if="route==='/funil'">
        <div class="flex between center mb">
          <div class="muted small">Arraste os cards entre as colunas para mudar o estágio. Clique para abrir o detalhe.</div>
          <button class="btn" @click="S.showNewLead=true">+ Novo Lead</button>
        </div>
        <div class="board">
          <div v-for="s in S.meta.stages" :key="s.key" class="col" :class="{drop:S.dragOver===s.key}"
               @dragover.prevent="S.dragOver=s.key" @dragleave="S.dragOver=null" @drop="onDrop(s.key)">
            <div class="col-head"><span><span class="stage-dot" :style="{background:'var(--st-'+s.key+')'}"></span>{{ s.label }}</span><span class="count">{{ (leadsByStage[s.key]||[]).length }}</span></div>
            <div v-for="l in (leadsByStage[s.key]||[])" :key="l.id" class="lead-card" draggable="true"
                 @dragstart="onDragStart(l)" @click="openLead(l.id)">
              <div class="lc-title">{{ l.title }} <span v-if="l.hot" class="hot-flag">🔥</span></div>
              <div class="lc-acc">{{ l.account_name || '—' }}</div>
              <div class="lc-meta">
                <span class="chip">{{ l.requested_software || l.product_name || 'Software' }}</span>
                <span v-if="l.estimated_value" class="chip val">{{ BRL(l.estimated_value) }}</span>
                <span class="chip">Qtd {{ l.qty }}</span>
              </div>
            </div>
            <p v-if="!(leadsByStage[s.key]||[]).length" class="muted small" style="padding:8px 6px">Vazio</p>
          </div>
        </div>
      </div>

      <!-- ===== TAREFAS ===== -->
      <div v-else-if="route==='/tarefas'">
        <div class="flex gap wrap mb">
          <div class="card card-p" style="padding:12px 16px"><span class="muted small">Abertas</span> <b>{{ S.tasks.filter(t=>!t.done).length }}</b></div>
          <div class="card card-p" style="padding:12px 16px;border-color:#f7c7c7"><span class="muted small">Atrasadas</span> <b style="color:var(--nx-danger)">{{ S.tasks.filter(isOverdue).length }}</b></div>
          <div class="card card-p" style="padding:12px 16px"><span class="muted small">Para hoje</span> <b style="color:var(--nx-warning)">{{ S.tasks.filter(isToday).length }}</b></div>
        </div>
        <div class="card">
          <table class="tbl"><thead><tr><th></th><th>Tarefa</th><th>Tipo</th><th>Área</th><th>Lead</th><th>Responsável</th><th>Prazo</th></tr></thead>
          <tbody>
            <tr v-for="t in S.tasks" :key="t.id">
              <td><input type="checkbox" :checked="t.done" @change="toggleTaskRow(t)"/></td>
              <td :style="{textDecoration: t.done?'line-through':'', color: t.done?'var(--nx-text-mute)':''}">{{ t.title }}</td>
              <td><span class="chip">{{ t.type }}</span></td>
              <td>{{ AREA_LABEL[t.area]||t.area||'—' }}</td>
              <td class="muted">{{ t.lead_title || '—' }}</td>
              <td>{{ t.assignee_name || '—' }}</td>
              <td class="mono small">{{ t.due_date || '—' }} <span v-if="isOverdue(t)" class="badge lost">Atrasada</span><span v-else-if="isToday(t)" class="badge" style="background:#fff3e0;color:#c46a00">Hoje</span></td>
            </tr>
            <tr v-if="!S.tasks.length"><td colspan="7" class="muted" style="padding:20px">Nenhuma tarefa.</td></tr>
          </tbody></table>
        </div>
      </div>

      <!-- ===== CONFIG / CATÁLOGO ===== -->
      <div v-else-if="route==='/config'">
        <div class="row2">
          <div class="card card-p">
            <div class="section-title">Regras de Precificação (Financeiro)</div>
            <p class="small muted" style="margin-top:-6px">Preço = [USD × câmbio × (1+imposto imp.)] ÷ (1 − imposto NF − margem)</p>
            <div v-if="S.config">
              <div class="row2">
                <div class="field"><label>Modo do câmbio</label><select v-model="S.config.fx_mode"><option value="api">API (tempo real)</option><option value="manual">Manual</option></select></div>
                <div class="field"><label>Taxa manual (se manual)</label><input v-model.number="S.config.fx_manual_rate" type="number" step="0.01"/></div>
              </div>
              <div class="row2">
                <div class="field"><label>Spread + IOF (%)</label><input v-model.number="S.config.fx_spread_pct" type="number" step="0.01"/></div>
                <div class="field"><label>Impostos importação (%)</label><input v-model.number="S.config.import_tax_pct" type="number" step="0.01"/></div>
              </div>
              <div class="row2">
                <div class="field"><label>Impostos NF venda (%)</label><input v-model.number="S.config.invoice_tax_pct" type="number" step="0.01"/></div>
                <div class="field"><label>Margem alvo (%)</label><input v-model.number="S.config.target_margin_pct" type="number" step="0.01"/></div>
              </div>
              <div class="field"><label>Margem mínima / piso (%)</label><input v-model.number="S.config.min_margin_pct" type="number" step="0.01"/></div>
              <p class="small muted">Percentuais em decimal (ex.: 0.20 = 20%).</p>
              <button class="btn" @click="saveConfig" :disabled="!canArea('financeiro')">Salvar regras</button>
              <span v-if="!canArea('financeiro')" class="small muted" style="margin-left:8px">Somente Financeiro/Admin</span>
            </div>
          </div>
          <div>
            <div class="card card-p mb">
              <div class="section-title">Fornecedores (fabricantes)</div>
              <table class="tbl"><tbody><tr v-for="s in S.suppliers" :key="s.id"><td>{{ s.name }}</td><td class="muted">{{ s.country }}</td><td>{{ s.currency }}</td></tr></tbody></table>
              <div class="flex gap wrap mt">
                <input v-model="S.newSupplier.name" placeholder="Nome" style="flex:1;padding:8px;border:1px solid var(--nx-border);border-radius:8px"/>
                <input v-model="S.newSupplier.country" placeholder="País" style="width:90px;padding:8px;border:1px solid var(--nx-border);border-radius:8px"/>
                <button class="btn btn-sm" @click="addSupplier">Add</button>
              </div>
            </div>
            <div class="card card-p">
              <div class="section-title">Produtos (catálogo)</div>
              <table class="tbl"><tbody><tr v-for="p in S.products" :key="p.id"><td>{{ p.name }}</td><td class="muted">{{ p.supplier_name }}</td><td class="mono">{{ p.currency }} {{ p.list_cost_usd }}</td></tr></tbody></table>
              <div class="flex gap wrap mt">
                <select v-model="S.newProduct.supplier_id" style="padding:8px;border:1px solid var(--nx-border);border-radius:8px"><option value="">Fornecedor</option><option v-for="s in S.suppliers" :value="s.id">{{ s.name }}</option></select>
                <input v-model="S.newProduct.name" placeholder="Produto" style="flex:1;padding:8px;border:1px solid var(--nx-border);border-radius:8px"/>
                <input v-model.number="S.newProduct.list_cost_usd" type="number" placeholder="USD" style="width:90px;padding:8px;border:1px solid var(--nx-border);border-radius:8px"/>
                <button class="btn btn-sm" @click="addProduct">Add</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ===== USUÁRIOS ===== -->
      <div v-else-if="route==='/usuarios'">
        <div class="card mb">
          <table class="tbl"><thead><tr><th>Nome</th><th>E-mail</th><th>Área</th><th>Papel</th></tr></thead>
          <tbody><tr v-for="u in S.users" :key="u.id"><td>{{ u.name }}</td><td class="muted">{{ u.email }}</td><td><span class="chip">{{ AREA_LABEL[u.area]||u.area }}</span></td><td>{{ u.role }}</td></tr></tbody></table>
        </div>
        <div class="card card-p" v-if="canArea('admin')">
          <div class="section-title">Novo usuário</div>
          <div class="row3">
            <div class="field"><label>Nome</label><input v-model="S.newUser.name"/></div>
            <div class="field"><label>E-mail</label><input v-model="S.newUser.email"/></div>
            <div class="field"><label>Senha</label><input v-model="S.newUser.password"/></div>
          </div>
          <div class="row3">
            <div class="field"><label>Área</label><select v-model="S.newUser.area"><option v-for="a in S.meta.areas" :value="a">{{ AREA_LABEL[a]||a }}</option></select></div>
            <div class="field"><label>Papel</label><select v-model="S.newUser.role"><option value="user">user</option><option value="manager">manager</option><option value="admin">admin</option></select></div>
            <div class="field" style="display:flex;align-items:flex-end"><button class="btn btn-block" @click="addUser">Criar usuário</button></div>
          </div>
        </div>
        <div v-else class="muted small">Apenas Admin pode criar usuários.</div>
      </div>
    </div>
  </div>
</div>

${DRAWER_TEMPLATE()}
${NEWLEAD_TEMPLATE()}
<div v-if="S.toast" class="toast">{{ S.toast }}</div>
`; }

function DRAWER_TEMPLATE() { return `
<div v-if="S.drawer" class="overlay" @click.self="closeDrawer">
  <div class="drawer">
    <div class="drawer-head">
      <div class="flex between center">
        <div>
          <div class="flex center gap">
            <span class="stage-pill" :style="{background:'var(--st-'+S.drawer.lead.stage+')'}">{{ stageLabel(S.drawer.lead.stage) }}</span>
            <span v-if="S.drawer.lead.status==='won'" class="badge won">GANHO</span>
            <span v-if="S.drawer.lead.status==='lost'" class="badge lost">PERDIDO</span>
            <span v-if="S.drawer.lead.hot" class="hot-flag">🔥 Quente</span>
          </div>
          <h2 style="margin:8px 0 2px">{{ S.drawer.lead.title }}</h2>
          <div class="muted small">{{ S.drawer.lead.account_name }} · {{ S.drawer.lead.contact_name }} · {{ S.drawer.lead.contact_email }}</div>
        </div>
        <button class="x-btn" @click="closeDrawer">✕</button>
      </div>
      <div class="tabs mt">
        <div class="tab" :class="{active:S.drawerTab==='resumo'}" @click="S.drawerTab='resumo'">Resumo</div>
        <div class="tab" :class="{active:S.drawerTab==='cotacao'}" @click="S.drawerTab='cotacao'">Cotação</div>
        <div class="tab" :class="{active:S.drawerTab==='precificacao'}" @click="S.drawerTab='precificacao'">Precificação</div>
        <div class="tab" :class="{active:S.drawerTab==='proposta'}" @click="S.drawerTab='proposta'">Proposta</div>
        <div class="tab" :class="{active:S.drawerTab==='fechamento'}" @click="S.drawerTab='fechamento'">Fechamento</div>
        <div class="tab" :class="{active:S.drawerTab==='timeline'}" @click="S.drawerTab='timeline'">Timeline</div>
      </div>
    </div>
    <div class="drawer-body">

      <!-- RESUMO / TRIAGEM -->
      <div v-if="S.drawerTab==='resumo'">
        <div class="card card-p mb">
          <div class="section-title">Triagem (Vendas / Pré-vendas)</div>
          <p class="small muted" style="margin-top:-6px">Valide a demanda e despache para Compras com 1 clique.</p>
          <div class="flex gap wrap">
            <button class="btn" v-if="['novo_lead','triagem'].includes(S.drawer.lead.stage)" @click="triage">➜ Validar e despachar para Compras</button>
            <button class="btn btn-ghost" @click="toggleHot">{{ S.drawer.lead.hot ? 'Desmarcar quente' : '🔥 Marcar como quente' }}</button>
          </div>
        </div>
        <div class="row2">
          <div class="card card-p"><div class="section-title">Dados do lead</div>
            <p class="small"><b>Software:</b> {{ S.drawer.lead.requested_software || '—' }}</p>
            <p class="small"><b>Produto:</b> {{ S.drawer.lead.product_name || '—' }}</p>
            <p class="small"><b>Quantidade:</b> {{ S.drawer.lead.qty }}</p>
            <p class="small"><b>Origem:</b> {{ S.drawer.lead.source }}</p>
            <p class="small"><b>Responsável:</b> {{ S.drawer.lead.owner_name || '—' }}</p>
            <p class="small"><b>Valor estimado:</b> {{ S.drawer.lead.estimated_value ? BRL(S.drawer.lead.estimated_value) : '—' }}</p>
          </div>
          <div class="card card-p"><div class="section-title">Nota rápida</div>
            <textarea v-model="S.noteInput" rows="4" placeholder="Registrar contato, observação…" style="width:100%;padding:10px;border:1px solid var(--nx-border);border-radius:8px"></textarea>
            <button class="btn btn-sm mt" @click="addNote">Adicionar à timeline</button>
          </div>
        </div>
      </div>

      <!-- COTAÇÃO -->
      <div v-if="S.drawerTab==='cotacao'">
        <div class="card card-p mb">
          <div class="section-title">Cotação internacional (Compras)</div>
          <p class="small muted" style="margin-top:-6px">Registre o custo na moeda do fabricante e associe fornecedor/produto.</p>
          <div class="row2">
            <div class="field"><label>Fornecedor</label><select v-model="S.quoteForm.supplier_id"><option value="">—</option><option v-for="s in S.suppliers" :value="s.id">{{ s.name }}</option></select></div>
            <div class="field"><label>Produto</label><select v-model="S.quoteForm.product_id"><option value="">—</option><option v-for="p in S.products" :value="p.id">{{ p.name }}</option></select></div>
          </div>
          <div class="row3">
            <div class="field"><label>Custo</label><input v-model.number="S.quoteForm.cost_amount" type="number" step="0.01" placeholder="1000.00"/></div>
            <div class="field"><label>Moeda</label><select v-model="S.quoteForm.cost_currency"><option>USD</option><option>EUR</option><option>BRL</option></select></div>
            <div class="field"><label>Quantidade</label><input v-model.number="S.quoteForm.qty" type="number"/></div>
          </div>
          <div class="field"><label>Ref. / nº da cotação do fabricante</label><input v-model="S.quoteForm.supplier_ref" placeholder="Ex.: ATL-2026-0091"/></div>
          <button class="btn" @click="submitQuote" :disabled="!canArea('compras')">Registrar cotação</button>
          <span v-if="!canArea('compras')" class="small muted" style="margin-left:8px">Somente Compras/Admin</span>
        </div>
        <div class="card card-p" v-if="S.drawer.quotes.length">
          <div class="section-title">Cotações registradas</div>
          <table class="tbl"><thead><tr><th>Custo</th><th>Fornecedor</th><th>Qtd</th><th>Ref</th><th>Quando</th></tr></thead>
          <tbody><tr v-for="q in S.drawer.quotes" :key="q.id"><td class="mono">{{ q.cost_currency }} {{ q.cost_amount }}</td><td>{{ q.supplier_name||'—' }}</td><td>{{ q.qty }}</td><td>{{ q.supplier_ref||'—' }}</td><td class="small muted">{{ q.created_at }}</td></tr></tbody></table>
        </div>
      </div>

      <!-- PRECIFICAÇÃO -->
      <div v-if="S.drawerTab==='precificacao'">
        <div class="card card-p">
          <div class="section-title">Motor de Precificação Automática</div>
          <p class="small muted" style="margin-top:-6px" v-if="S.drawer.quotes[0]">Custo base: <b class="mono">{{ S.drawer.quotes[0].cost_currency }} {{ S.drawer.quotes[0].cost_amount }}</b> × câmbio ao vivo + impostos + margem (regras do Financeiro).</p>
          <p class="small muted" v-else>Registre uma cotação na aba anterior para calcular.</p>
          <div class="flex gap wrap mb">
            <button class="btn btn-ghost btn-sm" @click="runPricing" :disabled="!S.drawer.quotes[0]">Calcular (preview)</button>
            <button class="btn btn-sm" @click="savePricing" :disabled="!S.drawer.quotes[0]||S.savingPrice">{{ S.savingPrice?'Salvando…':'Gerar preços p/ o vendedor' }}</button>
          </div>
          <div v-if="S.priceCalc || latestPricing">
            <div class="price-out">
              <div class="price-box sugg"><div class="pb-l">Preço de Venda Sugerido</div><div class="pb-v" style="color:var(--nx-primary)">{{ BRL((S.priceCalc||latestPricing).suggestedPrice ?? latestPricing.suggested_price) }}</div><div class="small muted">margem alvo</div></div>
              <div class="price-box"><div class="pb-l">Preço de Venda Mínimo (piso)</div><div class="pb-v">{{ BRL((S.priceCalc||latestPricing).minPrice ?? latestPricing.min_price) }}</div><div class="small muted">margem mínima aprovada</div></div>
            </div>
            <table class="tbl mt"><tbody>
              <tr><td>Custo (USD × qtd)</td><td class="mono" style="text-align:right">{{ (S.priceCalc||{}).costUsd ?? latestPricing.cost_usd }}</td></tr>
              <tr><td>Câmbio efetivo (com spread)</td><td class="mono" style="text-align:right">{{ ((S.priceCalc||{}).fxRate ?? latestPricing.fx_rate) }}</td></tr>
              <tr><td>Custo em BRL</td><td class="mono" style="text-align:right">{{ BRL((S.priceCalc||{}).costBrl ?? latestPricing.cost_brl) }}</td></tr>
              <tr><td>Custo + impostos de importação</td><td class="mono" style="text-align:right">{{ BRL((S.priceCalc||{}).costWithImport ?? latestPricing.cost_with_import) }}</td></tr>
            </tbody></table>
          </div>
        </div>
      </div>

      <!-- PROPOSTA -->
      <div v-if="S.drawerTab==='proposta'">
        <div class="card card-p mb">
          <div class="section-title">Enviar proposta (Vendas)</div>
          <div v-if="latestPricing" class="flex gap wrap mb small">
            <span class="chip">Sugerido: {{ BRL(latestPricing.suggested_price) }}</span>
            <span class="chip">Piso: {{ BRL(latestPricing.min_price) }}</span>
          </div>
          <p v-else class="small muted">Gere a precificação antes para validar o piso.</p>
          <div class="field"><label>Preço final ao cliente (R$)</label><input v-model.number="S.propInput.final_price" type="number" step="0.01" placeholder="0,00"/></div>
          <div v-if="S.propInput.belowFloorMsg" class="error-box">{{ S.propInput.belowFloorMsg }}</div>
          <label class="small flex center gap" style="margin-bottom:12px"><input type="checkbox" v-model="S.propInput.approve_below_floor"/> Aprovar venda abaixo do piso (requer alçada gerencial)</label>
          <button class="btn" @click="sendProposal">Enviar proposta &amp; agendar follow-up</button>
        </div>
        <div class="card card-p" v-if="S.drawer.proposals.length">
          <div class="section-title">Histórico de propostas</div>
          <table class="tbl"><thead><tr><th>Versão</th><th>Preço final</th><th>Status</th><th>Link do cliente</th></tr></thead>
          <tbody><tr v-for="p in S.drawer.proposals" :key="p.id">
            <td>v{{ p.version }}</td>
            <td class="mono">{{ BRL(p.final_price) }} <span v-if="p.below_floor" class="badge lost">abaixo piso</span></td>
            <td><span class="badge" :class="{won:p.status==='accepted',open:p.status!=='accepted'}">{{ propStatusLabel(p) }}</span><div class="muted" style="font-size:11px" v-if="p.viewed_at">visto {{ p.viewed_at }}</div><div class="muted" style="font-size:11px" v-if="p.accepted_at">aceito {{ p.accepted_at }}</div></td>
            <td><div class="flex gap wrap"><button class="btn btn-ghost btn-sm" @click="copyProposal(p)">Copiar link</button><button class="btn btn-ghost btn-sm" @click="openProposal(p)">Abrir</button><button class="btn btn-sm" @click="sendPropEmail(p)">Enviar e-mail</button></div></td>
          </tr></tbody></table>
        </div>
      </div>

      <!-- FECHAMENTO -->
      <div v-if="S.drawerTab==='fechamento'">
        <div class="card card-p mb">
          <div class="section-title">Fechamento (Vendas / Jurídico)</div>
          <div v-if="S.drawer.lead.status==='open'">
            <div class="flex gap wrap mb">
              <button class="btn btn-success" @click="S.closeForm.result='won'; closeLead()">✓ Close Won</button>
              <button class="btn btn-danger" @click="S.closeForm.result='lost'">✕ Close Lost</button>
            </div>
            <div v-if="S.closeForm.result==='lost'">
              <div class="field"><label>Motivo da perda</label><input v-model="S.closeForm.lost_reason" placeholder="Preço, concorrência, timing…"/></div>
              <button class="btn btn-danger" @click="closeLead">Confirmar perda</button>
            </div>
          </div>
          <div v-else>
            <span class="badge" :class="S.drawer.lead.status">{{ S.drawer.lead.status==='won'?'GANHO':'PERDIDO' }}</span>
            <span v-if="S.drawer.lead.lost_reason" class="small muted"> · {{ S.drawer.lead.lost_reason }}</span>
          </div>
        </div>
        <div class="card card-p" v-if="S.drawer.contract">
          <div class="section-title">Contrato (Jurídico)</div>
          <p class="small">Status: <span class="chip">{{ S.drawer.contract.status }}</span> · Valor: {{ S.drawer.contract.value?BRL(S.drawer.contract.value):'—' }}</p>
          <div class="flex gap wrap">
            <button class="btn btn-sm btn-ghost" @click="updateContract('drafting')" :disabled="!canArea('juridico')">Em elaboração</button>
            <button class="btn btn-sm btn-success" @click="updateContract('signed')" :disabled="!canArea('juridico')">Marcar assinado</button>
          </div>
          <span v-if="!canArea('juridico')" class="small muted">Somente Jurídico/Admin atualiza o contrato.</span>
        </div>
      </div>

      <!-- TIMELINE -->
      <div v-if="S.drawerTab==='timeline'">
        <div class="card card-p"><div class="section-title">Histórico</div>
          <div class="timeline">
            <div v-for="a in S.drawer.activities" :key="a.id" class="tl-item">
              <div class="flex between"><span class="tl-type">{{ a.type }}</span><span class="tl-time">{{ a.created_at }}</span></div>
              <div class="small">{{ a.message }} <span class="muted" v-if="a.user_name">· {{ a.user_name }}</span></div>
            </div>
            <p v-if="!S.drawer.activities.length" class="muted small">Sem eventos.</p>
          </div>
        </div>
      </div>

    </div>
  </div>
</div>
`; }

function NEWLEAD_TEMPLATE() { return `
<div v-if="S.showNewLead" class="overlay modal-center" @click.self="S.showNewLead=false">
  <div class="modal">
    <div class="modal-head">Novo Lead <button class="x-btn" @click="S.showNewLead=false">✕</button></div>
    <div class="modal-body">
      <div class="field"><label>Título *</label><input v-model="S.newLead.title" placeholder="Ex.: Alfa — Jira p/ 100 devs"/></div>
      <div class="row2">
        <div class="field"><label>Empresa</label><select v-model="S.newLead.account_id"><option value="">—</option><option v-for="a in S.accounts" :value="a.id">{{ a.name }}</option></select></div>
        <div class="field"><label>Contato</label><select v-model="S.newLead.contact_id"><option value="">—</option><option v-for="c in filteredContacts" :value="c.id">{{ c.name }}</option></select></div>
      </div>
      <div class="row2">
        <div class="field"><label>Software solicitado</label><input v-model="S.newLead.requested_software" placeholder="Ex.: Jira Software"/></div>
        <div class="field"><label>Quantidade</label><input v-model.number="S.newLead.qty" type="number"/></div>
      </div>
      <div class="field"><label>Origem</label><select v-model="S.newLead.source"><option value="site">Formulário do site</option><option value="indicacao">Indicação</option><option value="outbound">Outbound</option></select></div>
    </div>
    <div class="modal-foot"><button class="btn btn-ghost" @click="S.showNewLead=false">Cancelar</button><button class="btn" @click="createLead">Criar lead</button></div>
  </div>
</div>
`; }
