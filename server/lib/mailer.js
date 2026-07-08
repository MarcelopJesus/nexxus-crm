// mailer.js — envio de e-mail transacional via API HTTP (sem dependências).
// Configuração por variáveis de ambiente:
//   EMAIL_PROVIDER = resend | sendgrid   (se ausente, o envio é "não configurado")
//   EMAIL_API_KEY  = chave do provedor
//   EMAIL_FROM     = remetente verificado (ex.: "Nexxus CRM <crm@nexxustech.one>")
'use strict';

function isConfigured() {
  return !!(process.env.EMAIL_API_KEY && process.env.EMAIL_FROM);
}

async function sendEmail({ to, subject, html }) {
  if (!isConfigured()) return { sent: false, reason: 'not_configured' };
  const provider = (process.env.EMAIL_PROVIDER || 'resend').toLowerCase();
  const from = process.env.EMAIL_FROM;
  const key = process.env.EMAIL_API_KEY;
  try {
    if (provider === 'sendgrid') {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: from.replace(/.*<(.+)>.*/, '$1') },
          subject, content: [{ type: 'text/html', value: html }],
        }),
      });
      return { sent: res.ok, status: res.status };
    }
    // default: Resend
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    return { sent: res.ok, status: res.status };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

module.exports = { sendEmail, isConfigured };
