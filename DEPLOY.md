# Plano de Deploy — Nexxus CRM (ambiente de demonstração)

Objetivo: colocar o protótipo **no ar com um link `https://` público**, para você fazer demonstrações comerciais a outras empresas, mesmo antes do produto final.

> **Leia isto primeiro — importante.** Este deploy é para **demonstração**, não para dados reais de clientes ainda. Motivos: (1) a persistência é um arquivo JSON, adequada para demos mas não para volume/concorrência de produção; (2) ainda é *single-tenant* (uma base de dados só, sem isolamento entre empresas); (3) faltam LGPD, backups robustos e billing. O produto vendável de verdade será construído na fase seguinte, dentro do repositório NexxusTECH (React + PostgreSQL + Stripe + autenticação), reaproveitando tudo que já validamos aqui. Este ambiente serve para **vender a visão e fechar early adopters**.

---

## Opção A — Render.com (recomendada: mais simples, HTTPS automático)

Melhor caminho para quem não é desenvolvedor. Sobe direto do GitHub, dá HTTPS e domínio grátis, e o arquivo `render.yaml` já configura tudo.

### Passo 1 — Colocar o código no GitHub
1. Crie uma conta em https://github.com (se não tiver).
2. Crie um repositório novo, ex.: `nexxus-crm` (pode ser privado).
3. Suba a pasta `nexxus-crm` para esse repositório. Sem terminal: instale o **GitHub Desktop** (https://desktop.github.com), clique em *Add Local Repository*, aponte para a pasta `nexxus-crm`, e *Publish*.

### Passo 2 — Criar o serviço no Render
1. Crie conta em https://render.com e conecte sua conta do GitHub.
2. **New → Blueprint** e selecione o repositório. O Render lê o `render.yaml` automaticamente e configura: serviço web, `JWT_SECRET` forte gerado sozinho, disco persistente de 1 GB e health check.
3. Clique em **Apply**. Em 1–2 minutos você recebe uma URL tipo `https://nexxus-crm.onrender.com`.

> Se preferir configurar na mão (sem blueprint): **New → Web Service** → conecte o repo → *Root Directory* = `server`, *Build Command* vazio, *Start Command* = `node server.js`, *Health Check Path* = `/healthz`. Em *Environment* adicione `JWT_SECRET` (um valor longo e aleatório) e `DB_FILE=/var/data/nexxus.json`, e em *Disks* crie um disco montado em `/var/data`.

### Passo 3 — Domínio próprio (opcional)
Em **Settings → Custom Domains**, adicione algo como `crm.nexxustech.one`. O Render mostra o registro DNS (CNAME) para você criar no seu provedor de domínio; o certificado HTTPS é emitido automaticamente.

---

## Opção B — Docker (portátil: Railway, Fly.io, Google Cloud Run, VPS)

O projeto já inclui um `Dockerfile`. Em qualquer host de containers:

```bash
# construir e rodar localmente (teste)
docker build -t nexxus-crm .
docker run -p 3001:3001 -e JWT_SECRET="uma-chave-forte" -v nexxus_data:/data nexxus-crm
```

- **Railway** (https://railway.app): *New Project → Deploy from GitHub* → detecta o Dockerfile. Defina `JWT_SECRET` e um volume em `/data`.
- **Fly.io**: `fly launch` (usa o Dockerfile) e `fly volumes create` para `/data`.
- **VPS próprio** (DigitalOcean/Hetzner): rode o container atrás de um Nginx/Caddy com HTTPS.

---

## Checklist de segurança ANTES de compartilhar o link

Rápido, mas essencial ao expor na internet:

1. **`JWT_SECRET` forte** — no Render por blueprint já é gerado. Nunca use o valor padrão do código.
2. **Trocar as senhas demo** — os usuários de exemplo usam `senha123`. Para uma demo pública, edite `server/lib/seed.js` (ou crie usuários novos e desative os demo em *Usuários*). Para um cliente sério, cada empresa terá seu próprio login na fase de produto.
3. **HTTPS sempre** — Render/Railway/Fly entregam automático. Nunca exponha em `http://` puro.
4. **Câmbio** — em produção a API pública de câmbio pode ter limite; para SLA, contrate um provedor e ajuste `server/lib/fx.js`.

---

## Limites conhecidos deste ambiente (e quando saem)

| Limite | Impacto na demo | Resolvido na fase |
|---|---|---|
| Persistência em arquivo JSON | OK para demos; não aguarda muitos usuários simultâneos | Fase 2 — PostgreSQL |
| Single-tenant (uma base para todos) | Cada empresa veria os mesmos dados | Fase 3 — Multi-tenant no repo NexxusTECH |
| Sem billing/assinatura | Demonstra o produto, não cobra | Fase 4 — Stripe |
| Sem LGPD/backup formal | Aceitável para demo sem dados reais | Fase 5 — Conformidade |
| Disco efêmero no plano free do Render | Dados resetam a cada deploy (re-populados) | Use plano `starter` + disco (já no `render.yaml`) |

---

## Custo aproximado (demonstração)

- **Render Free**: US$ 0 — hiberna após inatividade e reseta o disco; bom para testes rápidos.
- **Render Starter**: ~US$ 7/mês por serviço + ~US$ 0,25/GB do disco — fica sempre ligado e mantém os dados. Recomendado para demos a clientes.
- Domínio: custo do seu registrador (o subdomínio de `nexxustech.one` que você já tem é grátis).

---

## Próximo passo depois das demos

Quando validar interesse comercial, partimos para a **Fase de produto** dentro do repositório NexxusTECH: multi-tenant (isolamento por empresa), cadastro self-service, planos e cobrança com Stripe, LGPD e integrações (NF-e, assinatura eletrônica). O protótipo atual vira a especificação viva dessa construção.
