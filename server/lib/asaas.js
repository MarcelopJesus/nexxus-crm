'use strict';
// Cliente da API do Asaas — boleto B2B e aviso de pagamento (M51, decidido em 30/09/2026).
//
// Dois ambientes, duas contas separadas no Asaas: sandbox (api-sandbox.asaas.com) e
// produção (api.asaas.com). A chave diz de qual conta ela é — `_hmlg_` no sandbox,
// `_prod_` na produção. Chave de um ambiente apontada para o outro é recusada aqui, antes
// de sair qualquer chamada: boleto de verdade gerado por engano chega no cliente.
const crypto = require('crypto');

const URLS = {
  sandbox: 'https://api-sandbox.asaas.com/v3',
  producao: 'https://api.asaas.com/v3',
};

const TIMEOUT_MS = 20 * 1000;

function ambiente() {
  const v = String(process.env.ASAAS_AMBIENTE || '').trim().toLowerCase();
  return v === 'producao' ? 'producao' : 'sandbox';
}

function chave() {
  return String(process.env.ASAAS_API_KEY || '').trim();
}

// Por que a integração não pode rodar agora. null = pode.
function motivoDesligado() {
  const k = chave();
  if (!k) return 'ASAAS_API_KEY ausente';
  const amb = ambiente();
  if (amb === 'sandbox' && k.includes('_prod_')) return 'chave de PRODUÇÃO com ASAAS_AMBIENTE=sandbox';
  if (amb === 'producao' && k.includes('_hmlg_')) return 'chave de SANDBOX com ASAAS_AMBIENTE=producao';
  return null;
}

async function chamar(method, caminho, corpo) {
  const off = motivoDesligado();
  if (off) throw new Error(`Asaas desligado: ${off}`);
  const res = await fetch(URLS[ambiente()] + caminho, {
    method,
    // Chamada pendurada não pode segurar a cobrança em "gerando" para sempre.
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      access_token: chave(),
      'Content-Type': 'application/json',
      // Conta criada depois de 2024 recusa chamada sem User-Agent.
      'User-Agent': 'nexxus-crm',
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* corpo vazio */ }
  if (!res.ok) {
    const desc = json && Array.isArray(json.errors) && json.errors.length
      ? json.errors.map(e => e.description).join('; ')
      : `HTTP ${res.status}`;
    throw new Error(`Asaas ${res.status}: ${desc}`);
  }
  return json;
}

function soDigitos(v) {
  return String(v || '').replace(/\D/g, '');
}

// O mesmo CNPJ não vira dois clientes no Asaas: procura antes de criar.
// notificationDisabled: quem avisa o cliente é a Veridiana, pelo e-mail da Nexxus —
// sem isto o Asaas mandaria o próprio e-mail/SMS em paralelo, com outra cara.
async function acharOuCriarCliente({ nome, cpfCnpj, email, referencia }) {
  const doc = soDigitos(cpfCnpj);
  const achados = await chamar('GET', `/customers?cpfCnpj=${doc}&limit=1`);
  if (achados && Array.isArray(achados.data) && achados.data.length) {
    const c = achados.data[0];
    // Cliente cadastrado antes (à mão, no painel) pode estar com os avisos do Asaas ligados.
    if (!c.notificationDisabled) return chamar('POST', `/customers/${c.id}`, { notificationDisabled: true });
    return c;
  }
  return chamar('POST', '/customers', {
    name: nome, cpfCnpj: doc, email: email || undefined,
    externalReference: referencia || undefined, notificationDisabled: true,
  });
}

// Boleto já criado para esta referência (e não apagado). É o que impede o "tentar de novo"
// de gerar um segundo boleto quando o primeiro foi criado mas a resposta se perdeu.
async function boletoDaReferencia(referencia) {
  const r = await chamar('GET', `/payments?externalReference=${encodeURIComponent(referencia)}&limit=10`);
  const vivos = (r && Array.isArray(r.data) ? r.data : []).filter(p => !p.deleted && p.status !== 'REFUNDED');
  return vivos[0] || null;
}

async function criarBoleto({ cliente, valor, vencimento, descricao, referencia }) {
  return chamar('POST', '/payments', {
    customer: cliente, billingType: 'BOLETO', value: valor, dueDate: vencimento,
    description: descricao, externalReference: referencia,
  });
}

// O Asaas assina o webhook com o token que a gente cadastra na tela dele, no cabeçalho
// `asaas-access-token`. Sem ASAAS_WEBHOOK_TOKEN configurado, nada passa (fail-closed):
// rota pública que confirma pagamento é a porta mais cara do CRM.
function tokenWebhookValido(recebido) {
  const esperado = String(process.env.ASAAS_WEBHOOK_TOKEN || '');
  const r = String(recebido || '');
  if (!esperado || !r) return false;
  const a = Buffer.from(r), b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { ambiente, motivoDesligado, acharOuCriarCliente, criarBoleto, boletoDaReferencia, tokenWebhookValido, soDigitos, URLS };
