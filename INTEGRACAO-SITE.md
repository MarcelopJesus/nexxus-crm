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
