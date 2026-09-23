// caixaOutlook.js — a outra metade do Outlook: o CRM LÊ as caixas dos agentes.
//
// Com EMAIL_PROVIDER=graph o e-mail sai da caixa do agente, e a resposta do cliente cai
// nessa mesma caixa — não passa mais pelo webhook do Resend. Sem esta varredura, a
// Patrícia ficaria surda no dia da troca.
//
// Configuração (além das MS_GRAPH_* do mailer):
//   EMAIL_INBOX_MAILBOXES = caixas lidas, separadas por vírgula
//                           (ex.: patricia.atendimento@nexxus.ia.br,veridiana.vendas@nexxus.ia.br)
//   GRAPH_INBOX_DESDE     = opcional, data ISO: nada anterior a ela é lido (corte do 1º dia)
//
// Cada e-mail passa pelo MESMO processarEmailRecebido do Resend — mesmas travas de laço,
// quarentena, limite de criação e ordem de casamento. Aqui só se traduz o formato.
//
// Marcação: em vez de "marcar como lido" (que esconderia o e-mail de quem acompanha a
// caixa no Outlook), o CRM põe a categoria "CRM". O que já tem a categoria é pulado.
'use strict';

const mailer = require('./mailer');

const CATEGORIA = 'CRM';
const JANELA_MS = 2 * 24 * 3600 * 1000;   // olha só os últimos 2 dias
const POR_CAIXA = 50;

function caixas() {
  return String(process.env.EMAIL_INBOX_MAILBOXES || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function isConfigured() {
  return mailer.provedor() === 'graph' && mailer.credenciaisGraph() && caixas().length > 0;
}

function motivoDesligado() {
  if (mailer.provedor() !== 'graph') return 'EMAIL_PROVIDER não é graph';
  if (!mailer.credenciaisGraph()) return 'faltam MS_GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET';
  if (!caixas().length) return 'EMAIL_INBOX_MAILBOXES vazio';
  return null;
}

function corte() {
  const janela = Date.now() - JANELA_MS;
  const desde = Date.parse(process.env.GRAPH_INBOX_DESDE || '');
  return new Date(isNaN(desde) ? janela : Math.max(janela, desde)).toISOString();
}

// Mensagem do Graph → o formato do webhook do Resend que processarEmailRecebido entende.
function paraEvento(msg, caixa) {
  const end = (r) => r && r.emailAddress
    ? (r.emailAddress.name ? `${r.emailAddress.name} <${r.emailAddress.address}>` : r.emailAddress.address)
    : '';
  return {
    type: 'email.received',
    data: {
      from: end(msg.from),
      to: [caixa],
      subject: msg.subject || '',
      text: msg.body && msg.body.contentType === 'text' ? msg.body.content : '',
      html: msg.body && msg.body.contentType !== 'text' ? msg.body.content : '',
      headers: msg.internetMessageHeaders || [],
    },
  };
}

async function graph(token, url, opts = {}) {
  const res = await fetch(url, Object.assign({}, opts, {
    headers: Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, opts.headers || {}),
  }));
  if (!res.ok) {
    let motivo = String(res.status);
    try { const j = await res.json(); if (j.error) motivo = j.error.code + ': ' + j.error.message; } catch (e) { /* sem corpo */ }
    const err = new Error(motivo); err.status = res.status; throw err;
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

// Uma volta em todas as caixas. `api` é injetado (e não requerido aqui) para não criar
// require circular com api.js e para os testes poderem trocar o processamento.
async function varrer(api) {
  const resumo = { lidas: 0, processadas: 0, puladas: 0, erros: 0 };
  if (!isConfigured()) return resumo;
  const token = await mailer.obterTokenGraph();
  const desde = corte();
  for (const caixa of caixas()) {
    const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(caixa)}`;
    let lista;
    try {
      const q = new URLSearchParams({
        $filter: `receivedDateTime ge ${desde}`,
        $orderby: 'receivedDateTime asc',
        $top: String(POR_CAIXA),
        $select: 'id,subject,from,body,internetMessageHeaders,internetMessageId,categories,receivedDateTime',
      });
      // Corpo em texto puro: é o que vai para a timeline e para o prompt do agente.
      lista = await graph(token, `${base}/mailFolders/inbox/messages?${q}`, { headers: { Prefer: 'outlook.body-content-type="text"' } });
    } catch (e) {
      resumo.erros++;
      console.error(`[outlook] não consegui ler ${caixa}: ${e.message}`);
      continue;
    }
    for (const msg of (lista && lista.value) || []) {
      resumo.lidas++;
      if ((msg.categories || []).includes(CATEGORIA)) { resumo.puladas++; continue; }
      // Mesmo controle "pelo menos uma vez" do webhook: se cair no meio, a próxima volta
      // tenta de novo; se já foi feito e só a etiqueta falhou, não duplica.
      const chave = 'graph:' + (msg.internetMessageId || msg.id);
      const ev = api.reservarEvento(chave);
      if (!ev.duplicado) {
        try {
          await api.processarEmailRecebido(paraEvento(msg, caixa), null, { caixaPropria: true });
          api.fecharEvento(chave);
          resumo.processadas++;
        } catch (e) {
          api.liberarEvento(chave);
          resumo.erros++;
          console.error(`[outlook] falha ao processar e-mail de ${caixa}: ${e.message}`);
          continue;
        }
      } else if (ev.emAndamento) {
        continue;
      }
      try {
        await graph(token, `${base}/messages/${encodeURIComponent(msg.id)}`, {
          method: 'PATCH', body: JSON.stringify({ categories: [...(msg.categories || []), CATEGORIA] }),
        });
      } catch (e) {
        console.error(`[outlook] processado, mas não consegui etiquetar em ${caixa}: ${e.message}`);
      }
    }
  }
  return resumo;
}

module.exports = { varrer, isConfigured, motivoDesligado, paraEvento, caixas, CATEGORIA };
