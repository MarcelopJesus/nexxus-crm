# Integração — Captura automática de leads do site

Quando alguém preenche o formulário B2B/contato no **nexxustech.one**, o lead deve cair
automaticamente no funil do CRM (coluna **Novo Lead**), já atribuído a um vendedor.

## Como funciona

O CRM expõe um endpoint protegido por chave:

```
POST {BASE_URL}/api/public/leads
Header:  x-intake-key: <INTAKE_KEY>
Body (JSON): { companyName, contactName, email, phone, employees, message, protocol }
```

Os campos são exatamente os da tabela `b2bLeads` do site. O CRM cria a empresa, o contato
e o lead, distribui para um vendedor (round-robin) e gera uma notificação interna.

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
