// mailer.js — envio de e-mail transacional via API HTTP (sem dependências).
// Configuração por variáveis de ambiente:
//   EMAIL_PROVIDER = resend | sendgrid | graph   (se ausente, resend)
//   EMAIL_API_KEY  = chave do provedor (resend/sendgrid)
//   EMAIL_FROM     = remetente verificado (ex.: "Nexxus CRM <crm@nexxustech.one>")
//
// graph = caixas do Outlook do nexxus.ia.br, pelo app "Nexxus CRM" do Entra. Pede, em vez
// da EMAIL_API_KEY: MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID e MS_GRAPH_CLIENT_SECRET. O app
// só enxerga as caixas do grupo "Agentes CRM" (trava do Exchange, não do código) — um
// remetente fora do grupo volta 403, e é isso que deve acontecer.
'use strict';

function provedor() {
  return (process.env.EMAIL_PROVIDER || 'resend').toLowerCase();
}

function credenciaisGraph() {
  const e = process.env;
  return !!(e.MS_GRAPH_TENANT_ID && e.MS_GRAPH_CLIENT_ID && e.MS_GRAPH_CLIENT_SECRET);
}

function isConfigured() {
  // Basta ter a chave e ALGUM remetente. Exigir EMAIL_FROM fazia com que configurar só as
  // três caixas novas derrubasse todo o envio para "não configurado".
  const temRemetente = !!(process.env.EMAIL_FROM || process.env.EMAIL_FROM_VENDAS
    || process.env.EMAIL_FROM_COMPRAS || process.env.EMAIL_FROM_FINANCEIRO);
  const temChave = provedor() === 'graph' ? credenciaisGraph() : !!process.env.EMAIL_API_KEY;
  return temChave && temRemetente;
}

// ---- Caixas por função (decidido na presencial de 09/09) ----
//
// A regra de roteamento que o Ítalo cravou: "tudo que se relaciona com cliente é vendas;
// relacionamento com a Ampler é sempre compras". O financeiro só recebe fatura.
//
//   vendas     → cliente          EMAIL_FROM_VENDAS
//   compras    → fornecedor       EMAIL_FROM_COMPRAS
//   financeiro → faturas          EMAIL_FROM_FINANCEIRO
//
// Enquanto essas caixas não existirem de verdade (elas dependem do provedor de e-mail,
// não do código), TUDO cai na caixa única de hoje. Assim o dia em que forem criadas é
// só preencher três variáveis — nenhuma linha de código muda, e nada quebra nesse meio
// tempo, que é o estado em que o sistema está agora.
const CAIXAS = {
  vendas: 'EMAIL_FROM_VENDAS',
  compras: 'EMAIL_FROM_COMPRAS',
  financeiro: 'EMAIL_FROM_FINANCEIRO',
};

function remetenteDe(area) {
  const env = CAIXAS[String(area || '').toLowerCase()];
  const especifico = env ? process.env[env] : null;
  if (especifico && especifico.trim()) return especifico.trim();
  if (process.env.EMAIL_FROM) return process.env.EMAIL_FROM;
  // Sem a caixa da área e sem a caixa geral, usa qualquer uma configurada em vez de não
  // enviar: e-mail saindo pelo remetente vizinho é melhor que e-mail não saindo.
  for (const nome of Object.values(CAIXAS)) {
    const v = (process.env[nome] || '').trim();
    if (v) return v;
  }
  return null;
}

// Para a tela de configuração e para o diagnóstico: quais caixas já existem de verdade.
function caixasConfiguradas() {
  const saida = {};
  for (const [area, env] of Object.entries(CAIXAS)) {
    const v = (process.env[env] || '').trim();
    saida[area] = { variavel: env, endereco: v || null, propria: !!v, usando: remetenteDe(area) };
  }
  return saida;
}

// Tudo que sai daqui é máquina falando (a Patrícia), nunca uma pessoa digitando. Estes
// cabeçalhos são o que impede o autoresponder do outro lado de responder de volta e os
// dois robôs entrarem em pingue-pongue infinito. Ficam no mailer, e não em cada chamador,
// para que nenhum caminho de envio escape da regra.
const HEADERS_AUTOMATICO = {
  'Auto-Submitted': 'auto-generated',
  'X-Auto-Response-Suppress': 'All',
};

// ---- Microsoft Graph ----
// Token de aplicativo (client credentials), guardado até 1 min antes de vencer.
let tokenGraph = null;   // { valor, venceEm }

async function obterTokenGraph() {
  if (tokenGraph && tokenGraph.venceEm > Date.now()) return tokenGraph.valor;
  const e = process.env;
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(e.MS_GRAPH_TENANT_ID)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: e.MS_GRAPH_CLIENT_ID,
      client_secret: e.MS_GRAPH_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }).toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    // O corpo de erro da Microsoft não traz o segredo — só o código (ex.: AADSTS7000215).
    throw new Error('token Graph recusado: ' + (j.error_description || j.error || res.status));
  }
  tokenGraph = { valor: j.access_token, venceEm: Date.now() + ((Number(j.expires_in) || 3600) - 60) * 1000 };
  return tokenGraph.valor;
}

function enderecoDe(remetente) {
  const m = String(remetente || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(remetente || '')).trim();
}

// Rascunho + envio em vez de /sendMail: o /sendMail responde 202 sem nada, e o CRM precisa
// do Message-ID de verdade para casar a resposta do cliente (In-Reply-To) com o card.
// A cópia fica em "Itens Enviados" da caixa do agente — é o rastro no Outlook.
async function enviarPorGraph({ from, to, subject, html, replyTo, cabecalhos }) {
  const token = await obterTokenGraph();
  const caixa = encodeURIComponent(enderecoDe(from));
  const base = `https://graph.microsoft.com/v1.0/users/${caixa}`;
  const auth = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  // O Graph só aceita cabeçalho próprio começando com "x-". O Auto-Submitted fica de fora
  // (a Microsoft recusa a mensagem inteira se ele for); o X-Auto-Response-Suppress segue.
  const extras = Object.entries(cabecalhos)
    .filter(([nome]) => /^x-/i.test(nome))
    .map(([name, value]) => ({ name, value: String(value) }));
  const msg = {
    subject,
    body: { contentType: 'HTML', content: html },
    toRecipients: [{ emailAddress: { address: to } }],
  };
  if (replyTo) msg.replyTo = [{ emailAddress: { address: enderecoDe(replyTo) } }];
  if (extras.length) msg.internetMessageHeaders = extras;

  const rascunho = await fetch(`${base}/messages`, { method: 'POST', headers: auth, body: JSON.stringify(msg) });
  if (!rascunho.ok) return { sent: false, status: rascunho.status, reason: await motivoGraph(rascunho) };
  const criado = await rascunho.json();
  const envio = await fetch(`${base}/messages/${encodeURIComponent(criado.id)}/send`, { method: 'POST', headers: auth });
  if (!envio.ok) return { sent: false, status: envio.status, reason: await motivoGraph(envio) };
  // Guardado sem < >: é assim que o leadPorReferencia compara.
  const id = String(criado.internetMessageId || '').replace(/^<|>$/g, '') || null;
  return { sent: true, status: envio.status, id };
}

async function motivoGraph(res) {
  try { const j = await res.json(); return (j.error && (j.error.code + ': ' + j.error.message)) || String(res.status); }
  catch (e) { return String(res.status); }
}

// Devolve { sent, status, id } — o id é o message-id do provedor, guardado na timeline
// para casar a resposta do cliente (In-Reply-To) com o lead certo.
async function sendEmail({ to, subject, html, headers, replyTo, area }) {
  if (!isConfigured()) return { sent: false, reason: 'not_configured' };
  const provider = provedor();
  // `area` escolhe a caixa; sem ela (ou sem caixa própria) continua a de sempre.
  const from = remetenteDe(area);
  const key = process.env.EMAIL_API_KEY;
  const cabecalhos = Object.assign({}, HEADERS_AUTOMATICO, headers || {});
  try {
    if (provider === 'graph') return await enviarPorGraph({ from, to, subject, html, replyTo, cabecalhos });
    if (provider === 'sendgrid') {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: from.replace(/.*<(.+)>.*/, '$1') },
          subject, content: [{ type: 'text/html', value: html }],
          headers: cabecalhos,
        }),
      });
      return { sent: res.ok, status: res.status, id: res.headers.get('x-message-id') || null };
    }
    // default: Resend
    const corpo = { from, to: [to], subject, html, headers: cabecalhos };
    if (replyTo) corpo.reply_to = replyTo;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    let id = null;
    try { const j = await res.json(); id = (j && j.id) || null; } catch (e) { /* sem id, segue */ }
    return { sent: res.ok, status: res.status, id };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

function _zerarTokenGraph() { tokenGraph = null; }   // só para os testes

module.exports = { sendEmail, isConfigured, remetenteDe, caixasConfiguradas, CAIXAS, HEADERS_AUTOMATICO,
  provedor, credenciaisGraph, obterTokenGraph, _zerarTokenGraph };
