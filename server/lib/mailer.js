// mailer.js — envio de e-mail transacional via API HTTP (sem dependências).
// Configuração por variáveis de ambiente:
//   EMAIL_PROVIDER = resend | sendgrid   (se ausente, o envio é "não configurado")
//   EMAIL_API_KEY  = chave do provedor
//   EMAIL_FROM     = remetente verificado (ex.: "Nexxus CRM <crm@nexxustech.one>")
'use strict';

function isConfigured() {
  return !!(process.env.EMAIL_API_KEY && process.env.EMAIL_FROM);
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
async function sendEmail({ to, subject, html, headers, replyTo }) {
  if (!isConfigured()) return { sent: false, reason: 'not_configured' };
  const provider = (process.env.EMAIL_PROVIDER || 'resend').toLowerCase();
  const from = process.env.EMAIL_FROM;
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

module.exports = { sendEmail, isConfigured, HEADERS_AUTOMATICO };
