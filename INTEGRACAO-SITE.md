# Integração — Captura automática de leads do site

Quando alguém preenche o formulário B2B/contato no **nexxustech.one**, o lead deve cair
automaticamente no funil do CRM (coluna **Novo Lead**), já atribuído a um vendedor.

## Como funciona

O CRM expõe um endpoint protegido por chave:

```
POST {BASE_URL}/api/public/leads
Header:  x-intake-key: <INTAKE_KEY>
Body (JSON): { companyName, contactName, email, phone, employees, message, protocol,
               productSlug, quantity, preferredChannel }
```

Os campos são exatamente os da tabela `b2bLeads` do site. O CRM cria a empresa, o contato
e o lead, distribui para um vendedor (round-robin) e gera uma notificação interna. O campo
`protocol` funciona como chave de idempotência: se o site reenviar o mesmo protocolo após uma
falha ou timeout, o CRM devolve o lead existente em vez de criar uma duplicata.

Os três últimos são opcionais e retrocompatíveis (sem eles nada muda):

| Campo | O que o CRM faz |
|---|---|
| `productSlug` | casa com o `sku` do produto (o slug do catálogo) e preenche o produto do lead |
| `quantity` | vira a quantidade do lead. Só inteiro positivo: `3.9`, `"12abc"` e `0` caem em 1 |
| `preferredChannel` | `email`, `whatsapp`, `phone` ou `telefone` — o CRM grava `phone` como `telefone`. Valor fora da lista é ignorado |

## Catálogo — o site é a fonte da verdade

O CRM **puxa** o catálogo do site (no boot e a cada 30 min) e espelha na tabela de produtos:

```
GET {SITE_CATALOG_URL}/api/public/catalog
Header: x-catalog-key: <SITE_CATALOG_KEY>
→ { success, data: { generatedAt, products: [ { slug, name, manufacturer, type, isActive,
      prices: [...], costs: [ { planName, quantity, unitCostUsd, currency, status } ] } ] } }
```

O casamento é `sku === slug`. O fabricante vira fornecedor e os `costs` viram os tiers de custo
— a tela de cotação abre com o custo da maior faixa que cabe na quantidade do lead (quantidade
abaixo da menor faixa usa a faixa de entrada, nunca o preço de atacado). Só `costs` em **USD**
entram nessa conta, porque o motor de precificação trabalha em dólar; os demais ficam gravados
mas fora do pré-preenchimento. O custo de tabela (`list_cost_usd`) é o unitário da faixa de
entrada, não o menor custo publicado.

Proteções: **produto que some do site nunca é apagado** — vira `site_active:false`, porque
leads e cotações antigos apontam para ele; resposta fora do formato acima **falha sem alterar
nada**; e catálogo válido porém **vazio** só gera aviso no log (site vazio quase sempre é site
quebrado, e desativar tudo seria pior). Sem as duas variáveis a sync fica desligada e o CRM
opera com o catálogo que já tem.

Sync sob demanda (qualquer usuário logado): `POST {BASE_URL}/api/catalog/sync` →
`{ imported, updated, deactivated }`.

## Variáveis de ambiente do CRM

| Variável | Para quê |
|---|---|
| `INTAKE_KEY` | chave do endpoint de captura de leads |
| `SITE_CATALOG_URL` | origem do site que publica o catálogo (ex.: `https://nexxustech.one`) |
| `SITE_CATALOG_KEY` | chave enviada no header `x-catalog-key` |
| `AUTO_LOST_DAYS` | dias **sem nenhum sinal de vida** (proposta nova, abertura da proposta pelo cliente ou qualquer atividade na timeline) até o lead com proposta virar perdido automaticamente (padrão 60) |

## O que adicionar no backend do site (repo NexxusTECH)

No handler que hoje grava o `b2bLead` (em `server/routers.ts`, a mutation do formulário B2B),
adicione **uma chamada** logo após salvar no banco. Exemplo:

```ts
// ... após inserir o b2bLead no banco (db.insert(b2bLeads)...):
try {
  await fetch(`${process.env.CRM_URL}/api/public/leads`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-intake-key": process.env.CRM_INTAKE_KEY!, // mesma chave do INTAKE_KEY do CRM
    },
    body: JSON.stringify({
      companyName: input.companyName,
      contactName: input.contactName,
      email: input.email,
      phone: input.phone,
      employees: input.employees,
      message: input.message,
      protocol: lead.protocol, // se você gera protocolo
    }),
  });
} catch (err) {
  console.error("Falha ao enviar lead ao CRM:", err); // não bloqueia o cadastro no site
}
```

No site, defina duas variáveis de ambiente:
- `CRM_URL` = `https://crm.nexxustech.one`
- `CRM_INTAKE_KEY` = o mesmo valor de `INTAKE_KEY` configurado no CRM

## Alternativa sem programar (rápida)

Se preferir não mexer no código do site agora, use um automatizador (Zapier/Make) ou o webhook
do seu provedor de formulário apontando para o mesmo endpoint e header acima. O corpo (JSON)
deve conter os mesmos campos.

## Teste rápido (linha de comando)

```bash
curl -X POST https://crm.nexxustech.one/api/public/leads \
  -H "Content-Type: application/json" \
  -H "x-intake-key: SUA_CHAVE" \
  -d '{"companyName":"Empresa Teste","contactName":"Fulano","email":"fulano@teste.com","message":"Quero o produto X"}'
```

Depois, abra o CRM: o lead estará em **Novo Lead** e o sino de notificações mostrará o aviso.

---

# Agente Nexus e Patrícia (e-mail) — o que o deploy precisa saber

## Réplica única (importante)

O agente foi desenhado para **uma instância só**. As travas que impedem trabalho duplicado —
lock por lead, varredura única, limitadores de taxa do inbound e cache do token do Vertex —
vivem **em memória do processo**. Com duas réplicas, cada uma teria o seu conjunto e o mesmo
lead poderia receber dois e-mails, duas cotações ou duas propostas.

**Produção roda `replicas: 1`.** Se um dia precisar escalar horizontalmente, essas travas têm
de virar lock no Postgres (ou Redis) antes — não é só subir o número de réplicas.

## Piloto automático é opt-in

O agente **só liga com `AGENT_AUTOPILOT=on`**. Env ausente, vazia ou com qualquer outro valor
deixa tudo desligado (fail-closed): o CRM funciona normalmente, na mão, como antes. O log de
boot diz em qual estado subiu.

## Webhook de e-mail recebido (Resend Inbound)

Aponte o Resend para `POST https://crm.nexxustech.one/api/public/email/inbound`, com o segredo
do endpoint em `EMAIL_WEBHOOK_SECRET`. A rota:

- exige `Content-Type: application/json` e corpo de no máximo 1 MB;
- exige `EMAIL_WEBHOOK_SECRET` **e** `EMAIL_INBOUND_ADDRESS` configuradas (sem qualquer uma delas: 503);
- confere a assinatura Svix sobre o **corpo cru** e rejeita timestamp fora de ±5 min;
- ignora (respondendo 200) evento que não seja `email.received`, e-mail endereçado a outra
  caixa, resposta automática (`Auto-Submitted`, `Precedence: bulk`, autoresponder, lista) e
  remetente de sistema (`no-reply@`, `mailer-daemon@`, `postmaster@`, `bounce@`);
- põe em quarentena, sem criar nem casar lead, mensagem com `dmarc=fail`/`spf=fail`;
- limita a criação de leads por e-mail a 5/hora por domínio e 20/hora no total;
- deduplica por `svix-id` com estado: o id entra como `processing` e só vira `done` depois do
  sucesso. Falha no meio libera o evento, para a **retentativa do Resend processar de verdade**
  em vez de receber "duplicado" e a mensagem se perder.

Responder 200 nesses casos é de propósito: erro faria o Resend retentar para sempre.

## Variáveis de ambiente

| ENV | Obrigatória | Para quê |
|---|---|---|
| `AGENT_AUTOPILOT` | para ligar o agente | `on` liga. Qualquer outro valor (ou ausente) = desligado. |
| `LLM_PROVIDER` | não | `vertex` ou `openai` (default). |
| `GOOGLE_VERTEX_SA` | se `vertex` | JSON inteiro da Service Account (aceita base64). |
| `LLM_MODEL` | não | Default `google/gemini-3.7-flash` no vertex, `gpt-5-mini` no openai. |
| `OPENAI_API_KEY` | se `openai` | Chave do provedor compatível. |
| `BASE_URL` | **sim** p/ propostas | `https://crm.nexxustech.ia.br`. Sem ela o agente **não envia proposta** (o link sairia quebrado) e escala para o BDR. |
| `EMAIL_API_KEY` / `EMAIL_FROM` | p/ enviar | Resend/SendGrid. Sem elas a Patrícia redige mas não envia. |
| `EMAIL_WEBHOOK_SECRET` | p/ receber | Segredo do Resend Inbound (`whsec_...`). Sem ela a rota responde 503. |
| `EMAIL_INBOUND_ADDRESS` | **sim** p/ receber | Caixa da Patrícia (ex.: `patricia@nexxustech.ia.br`). Sem ela a rota responde 503 — aceitar qualquer destinatário seria abrir a porta para tudo que o provedor encaminhar. |
