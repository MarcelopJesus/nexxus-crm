// mailer.js — envio de e-mail transacional via API HTTP (sem dependências).
// Configuração por variáveis de ambiente:
//   EMAIL_PROVIDER = resend | sendgrid   (se ausente, o envio é "não configurado")
//   EMAIL_API_KEY  = chave do provedor
//   EMAIL_FROM     = remetente verificado (ex.: "Nexxus CRM <crm@nexxustech.one>")
'use strict';

function isConfigured() {
  // Basta ter a chave e ALGUM remetente. Exigir EMAIL_FROM fazia com que configurar só as
  // três caixas novas derrubasse todo o envio para "não configurado".
  const temRemetente = !!(process.env.EMAIL_FROM || process.env.EMAIL_FROM_VENDAS
    || process.env.EMAIL_FROM_COMPRAS || process.env.EMAIL_FROM_FINANCEIRO);
  return !!(process.env.EMAIL_API_KEY && temRemetente);
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

// Devolve { sent, status, id } — o id é o message-id do provedor, guardado na timeline
// para casar a resposta do cliente (In-Reply-To) com o lead certo.
async function sendEmail({ to, subject, html, headers, replyTo, area }) {
  if (!isConfigured()) return { sent: false, reason: 'not_configured' };
  const provider = (process.env.EMAIL_PROVIDER || 'resend').toLowerCase();
  // `area` escolhe a caixa; sem ela (ou sem caixa própria) continua a de sempre.
  const from = remetenteDe(area);
  const key = process.env.EMAIL_API_KEY;
  const cabecalhos = Object.assign({}, HEADERS_AUTOMATICO, headers || {});
  try {
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

module.exports = { sendEmail, isConfigured, remetenteDe, caixasConfiguradas, CAIXAS, HEADERS_AUTOMATICO };
