# Nexxus CRM — A Máquina de Vendas B2B de Software

CRM full-stack para revenda B2B de softwares. Réplica funcional do CRM legado ("A Máquina" / Monofloor) reconstruída com a identidade Nexxus e um **novo fluxo nativo** de cotação internacional e precificação automática, cobrindo as 7 áreas: Vendas, Pré-vendas, Compras, Produto, Marketing, Financeiro e Jurídico.

---

## 1. Arquitetura

| Camada | Tecnologia | Por quê |
|---|---|---|
| Frontend | **Vue 3** (global build via CDN) + router por hash, sem etapa de build | Mantém fidelidade ao legado (também Vue 3) e roda abrindo o app, sem `npm build`. |
| Backend | **Node.js puro** (`node:http`) — sem Express | Zero dependências externas: nada para instalar, nada para compilar. |
| Banco | **Arquivo JSON** (`lib/store.js`) | Persistência em `server/data/nexxus.json`. Roda em **qualquer Node ≥ 18**, sem flags, sem SQLite/Docker. Migra para Postgres em produção trocando `lib/store.js`. |
| Auth | Token HMAC assinado + senha com `scrypt` (`node:crypto`) | Sem libs de JWT/bcrypt; mesmo contrato do legado: `POST /api/auth/admin/login`. |
| Câmbio | API pública **AwesomeAPI** com fallback para **PTAX/Banco Central** e cache de 10 min | Requisito de dólar em tempo real. |

**Decisão de engenharia:** a stack pedida foi "Vue 3 + Node/Express + SQLite". Para máxima compatibilidade e um único comando, o backend usa **apenas módulos nativos do Node** (`node:http`, `node:crypto`) e persiste em **arquivo JSON** — sem Express, sem SQLite nativo, sem flags experimentais. Assim roda em **qualquer Node ≥ 18** (não exige Node 22.5+), **sem `npm install` e sem compilação nativa**. Para produção em escala, o item 5 mostra como migrar para Postgres.

```
nexxus-crm/
├── README.md
├── server/
│   ├── server.js            # HTTP server: API + estáticos + SPA fallback
│   ├── package.json         # scripts (sem dependências)
│   └── lib/
│       ├── store.js         # persistência em arquivo JSON (coleções)
│       ├── seed.js          # dados de exemplo (8 usuários, catálogo, funil)
│       ├── auth.js          # hash de senha + tokens
│       ├── fx.js            # câmbio USD/BRL em tempo real (+ fallback)
│       ├── pricing.js       # MOTOR DE PRECIFICAÇÃO (markup divisor)
│       └── api.js           # todas as rotas REST
└── client/
    ├── index.html
    ├── css/
    │   ├── tokens.css       # ← IDENTIDADE VISUAL (cores/fontes) — trocar aqui
    │   └── app.css
    └── js/
        ├── api.js           # cliente HTTP + sessão
        ├── template.js      # todo o HTML da SPA
        └── app.js           # lógica Vue (estado, funil, drawer, precificação)
```

---

## 2. Como rodar localmente

Requisito único: **Node.js ≥ 18**. Verifique com `node -v`.

```bash
cd nexxus-crm/server
npm start
```

Isso sobe tudo (API + frontend) em **http://localhost:3001**. Na primeira execução o banco é criado e populado automaticamente.

> Não precisa de flags nem de `npm install`. O Vue é carregado de um CDN (com fallback automático), então mantenha internet ao abrir a página. Para uso 100% offline, veja o item 5.

### Login demo

| E-mail | Senha | Área |
|---|---|---|
| `joao@nexxustech.one` | senha123 | Vendas + **Admin** (faz tudo) |
| `carla@nexxustech.one` | senha123 | Compras |
| `felipe@nexxustech.one` | senha123 | Financeiro |
| `gabriela@nexxustech.one` | senha123 | Jurídico |
| bruno / diego / elena / marina | senha123 | Pré-vendas / Produto / Marketing / Vendas |

---

## 3. Como testar o fluxo completo (roteiro de 2 min)

1. **Login** como `joao`.
2. **Dashboard** — veja KPIs, funil por etapa, motivos de perda e a taxa de câmbio ao vivo no topo.
3. **Funil de Vendas** — arraste cards entre colunas (muda o estágio). Clique em **+ Novo Lead** para simular uma captura do site.
4. Abra o card em **"Novo Lead"** → aba **Resumo** → **"Validar e despachar para Compras"** (triagem em 1 clique). O lead vai para *Aguardando Cotação* e cria tarefa para Compras.
5. Aba **Cotação** → informe o custo em USD (ex.: `1000`), fornecedor e ref → **Registrar cotação**. (Faça logado como `carla`/Compras ou `joao`/Admin.)
6. Aba **Precificação** → **Calcular (preview)** mostra o câmbio ao vivo aplicado; **Gerar preços** cria o **Preço Sugerido** e o **Preço Mínimo (piso)**.
7. Aba **Proposta** → digite um preço. Se for **abaixo do piso**, o sistema **bloqueia** (HTTP 422) e só libera marcando a aprovação gerencial. Ao enviar, agenda follow-ups automáticos (D+3, D+7, D+15).
8. Aba **Fechamento** → **Close Won** dispara o **gatilho do Jurídico** (cria contrato + tarefa). Ou **Close Lost** com motivo (entra nos relatórios).
9. **Tarefas & Follow-up** — veja as tarefas geradas automaticamente.

### Verificação automatizada
O backend foi validado end-to-end (auth, triagem, cotação, precificação, bloqueio de piso, proposta, close-won com contrato, relatórios e permissões). O motor de precificação reproduz o exemplo do documento BPM: custo US$ 1.000 × 5,20, importação 15%, NF 10%, margem 20% → **R$ 8.542,86** sugerido e **R$ 7.475,00** de piso (margem 10%).

---

## 4. Onde estão as novas regras

**Motor de Precificação** — `server/lib/pricing.js`. Fórmula (markup divisor, top-down):

```
Custo_BRL              = CUSTO_USD × TAXA_CAMBIO_EFETIVA        (taxa = câmbio × (1 + spread/IOF))
Custo_Total_Importacao = Custo_BRL × (1 + IMPOSTO_IMPORTACAO)
Preco_de_Venda         = Custo_Total_Importacao ÷ (1 − IMPOSTO_NF − MARGEM)
```

- **Preço Sugerido** usa a margem alvo; **Preço Mínimo** usa a margem mínima (piso).
- Parâmetros (câmbio manual/API, spread, impostos de importação, impostos de NF, margens) ficam em **Catálogo & Regras** e só o **Financeiro/Admin** edita (`PUT /api/config/pricing`).
- **Câmbio ao vivo:** `server/lib/fx.js` (AwesomeAPI → PTAX/BCB → cache). Endpoint `GET /api/fx`.

**Fluxo de processo B2B** — implementado em `server/lib/api.js`:
- Triagem 1-clique: `POST /api/leads/:id/triage`
- Cotação internacional: `POST /api/quotes`
- Precificação: `POST /api/pricing/calculate` (preview) e `POST /api/pricing` (persiste)
- Proposta com trava de piso: `POST /api/proposals`
- Fechamento + gatilho Jurídico: `POST /api/leads/:id/close`

**Identidade visual** — `client/css/tokens.css`. Todas as cores, fontes e raios da marca estão centralizados ali. Ver item 6.

---

## 5. Colocar em produção

O app é um único processo Node servindo API + estáticos.

1. **Servidor:** rode atrás de um proxy reverso (nginx/Caddy) com HTTPS. Suba o processo com `pm2` ou `systemd`:
   ```bash
   PORT=3001 JWT_SECRET="uma-chave-forte" pm2 start server.js --interpreter "node" --node-args="--experimental-sqlite"
   ```
2. **Variáveis de ambiente:** defina `JWT_SECRET` (nunca use o default), `BASE_URL` (URL pública, p/ links de proposta), `INTAKE_KEY` (chave da captura de leads do site) e, se quiser e-mail automático, `EMAIL_PROVIDER`/`EMAIL_API_KEY`/`EMAIL_FROM`. Veja `server/.env.example`.
3. **Banco:** para baixo volume o arquivo `server/data/nexxus.json` já atende — basta fazer backup dele. Para alta concorrência, migre para **PostgreSQL** reescrevendo `lib/store.js` (as coleções `users`, `leads`, `quotes`, etc. viram tabelas; a API `insert/find/get/update` mapeia direto para SQL).
4. **Câmbio:** as APIs usadas são públicas e gratuitas; para SLA garantido, contrate um provedor e ajuste `lib/fx.js`.
5. **Frontend offline (opcional):** o Vue vem de CDN (com fallback). Para uso sem internet, baixe `vue.global.prod.js` da versão 3.5.13 em `client/vendor/` e troque os `<script>` de CDN no `index.html` por `<script src="vendor/vue.global.prod.js"></script>`.

---

## 6. Identidade visual

O tema foi extraído do **repositório oficial do site** (`italoportes-ship-it/nexxustech`, arquivo `client/src/index.css`) e aplicado ao CRM. É o design premium "inspirado na Apple":

- **Azul Apple `#0071E3`** como cor primária/CTA (hover `#0077ED`).
- Fundo branco elegante `#FBFBFD`, superfícies brancas, sidebar clara.
- Fonte **Inter / SF Pro Display**; escala de cinzas Apple (`#1D1D1F`, `#86868B`, `#E8E8ED`).
- Cantos muito arredondados (cards 20px), **botões pill**, sombras suaves e semânticos iOS (verde `#34C759`, vermelho `#FF3B30`).

Tudo centralizado em **`client/css/tokens.css`** — ajuste fino em um só arquivo. Falta apenas o **logotipo oficial**: hoje uso o wordmark "NEXXUS CRM". Se me enviar o arquivo do logo (SVG/PNG), eu o insiro na sidebar e no login.

---

## 7. Funcionalidades legadas replicadas

Gestão de usuários e permissões por área/papel · funil de vendas Kanban com drag-and-drop e estágios configuráveis · contas (empresas) e contatos · histórico/timeline de atividades por lead · propostas com versionamento · lead "quente" · tarefas e cadências de follow-up · relatórios (conversão por etapa, motivos de perda, forecast) · catálogo de fornecedores/produtos.

---

## 8. Automações internas (captura de leads, proposta, notificações)

- **Captura automática de leads do site** — endpoint `POST /api/public/leads` (protegido por `INTAKE_KEY`) cria empresa+contato+lead em *Novo Lead* e distribui para um vendedor por **round-robin**. Passo a passo de integração com o backend do site em **`INTEGRACAO-SITE.md`**.
- **Proposta automática com link e rastreio** — cada proposta ganha um link público (`/p/<token>`) com a marca Nexxus. O sistema marca **enviada → vista → aceita** (rastreia quando o cliente abre e quando aceita) e nunca expõe custo/margem internos. Botões na aba *Proposta*: copiar link, abrir, enviar por e-mail.
- **Envio por e-mail (opcional)** — se `EMAIL_API_KEY`/`EMAIL_FROM` estiverem configurados (Resend ou SendGrid), a proposta é enviada por e-mail; senão, o sistema gera o link para você enviar por WhatsApp/e-mail.
- **Notificações internas** — sino no topo com contador: avisa lead novo, proposta vista, proposta aceita, cotação recebida e negócio ganho. Clique na notificação para abrir o lead.
- **Follow-up** — cadência automática D+3/7/15 ao enviar proposta; a tela *Tarefas* destaca **atrasadas** (vermelho) e **para hoje**, com contadores.
- **Origem dos negócios (dashboard)** — painel com leads, ganhos, conversão e **faturamento por canal** (site, checkout, newsletter, indicação, outbound) para acompanhar o retorno de cada fonte.

---

## 9. SDR Agent — Prospecção Inteligente com IA

Módulo de pré-vendas com IA que cobre as três etapas do trabalho de um SDR, integrado nativamente ao funil. Acesse pelo menu **⚡ SDR Agent** (tela de prospecção) e pela aba **⚡ SDR** dentro do drawer de qualquer lead.

| Função | O que faz | Onde fica |
|---|---|---|
| **1. Pesquisa de leads** | A partir do ICP (segmento, porte, região, software de interesse), o agente gera uma lista de empresas-alvo do mercado brasileiro com decisor sugerido, software do catálogo mais aderente, justificativa de fit e **fit score 0-100**. Cada prospect pode ser **importado para o funil com 1 clique** (cria conta + contato + lead em *Novo Lead*, origem `outbound`) ou descartado. | Tela **SDR Agent** |
| **2. Preparação de abordagem** | Gera um kit completo e personalizado por lead: **e-mail de cold outreach** (assunto + corpo), **mensagem de WhatsApp**, **mensagem de LinkedIn**, **roteiro de ligação** com pontos-chave e **3 objeções prováveis com respostas prontas**. Tudo com botão de copiar. | Drawer do lead → aba **⚡ SDR** |
| **3. Qualificação de contas (BANT)** | Analisa dados do lead + timeline e pontua **Budget, Authority, Need e Timing** (0-25 cada, total 0-100) com justificativa por dimensão, resumo executivo, **Tier A/B/C**, informações a levantar e **próximas ações que viram tarefas automaticamente**. Tier A marca o lead como 🔥 quente. O score aparece como badge nos cards do funil. | Drawer do lead → aba **⚡ SDR** |

### Configuração

O SDR Agent usa qualquer API compatível com OpenAI (Chat Completions). Defina no ambiente do servidor:

```bash
export OPENAI_API_KEY="sk-..."            # obrigatória — sem ela o módulo fica desativado com aviso na UI
export OPENAI_API_BASE="https://api.openai.com/v1"  # opcional (default OpenAI)
export SDR_MODEL="gpt-5-mini"             # opcional (default gpt-5-mini)
```

Sem chave configurada, o CRM continua funcionando normalmente — os botões do SDR Agent ficam desabilitados com um aviso de configuração.

### Rotas da API

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/sdr/status` | Status da IA (configurada? qual modelo?) |
| POST | `/api/sdr/research` | Pesquisa leads a partir do ICP `{segment, size, region, software, notes, quantity}` |
| GET | `/api/sdr/prospects` | Lista prospects pesquisados |
| POST | `/api/sdr/prospects/:id/import` | Importa prospect para o funil (conta + contato + lead) |
| DELETE | `/api/sdr/prospects/:id` | Descarta prospect |
| POST | `/api/sdr/leads/:id/outreach` | Gera kit de abordagem para o lead |
| POST | `/api/sdr/leads/:id/qualify` | Qualifica a conta (BANT) e cria tarefas |

Implementação em `server/lib/sdr.js` (zero dependências, `node:https` nativo), rotas em `server/lib/api.js`, novas coleções `prospects`, `outreaches` e `qualifications` em `server/lib/store.js`.

> **Nota sobre a pesquisa de leads:** os prospects são gerados pelo modelo de IA com base em conhecimento do mercado brasileiro — são pontos de partida realistas, mas **valide empresa e decisor no LinkedIn** antes do outreach (a própria UI e as tarefas geradas reforçam isso).
