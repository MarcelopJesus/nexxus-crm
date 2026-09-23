// caixaOutlook.js — a outra metade do Outlook: o CRM LÊ as caixas dos agentes.
//
// Com EMAIL_PROVIDER=graph o e-mail sai da caixa do agente, e a resposta do cliente cai
// nessa mesma caixa — não passa mais pelo webhook do Resend. Sem esta varredura, a
// Patrícia ficaria surda no dia da troca.
//
// Configuração (além das MS_GRAPH_* do mailer):
//   EMAIL_INBOX_MAILBOXES = caixas lidas, separadas por vírgula
//                           (ex.: patricia.atendimento@nexxus.ia.br,veridiana.vendas@nexxus.ia.br)
//   GRAPH_INBOX_DESDE     = opcional, data ISO: de onde começar na PRIMEIRA leitura de cada
//                           caixa (sem ela, os últimos 2 dias). Depois disso manda o marcador.
//
// Marcador por caixa (coleção sync_cursors): "li tudo até esta hora". Só avança sobre e-mail
// resolvido, na ordem de chegada — se um falha, o marcador para ali e a próxima volta relê
// dali em diante. Servidor fora do ar por dias não perde nada: retoma do marcador.
//
// Cada e-mail passa pelo MESMO processarEmailRecebido do Resend — mesmas travas de laço,
// quarentena, limite de criação e ordem de casamento. Aqui só se traduz o formato.
//
// Marcação: em vez de "marcar como lido" (que esconderia o e-mail de quem acompanha a
// caixa no Outlook), o CRM põe a categoria "CRM". O que já tem a categoria é pulado.
'use strict';

const mailer = require('./mailer');
const S = require('./store');

const CATEGORIA = 'CRM';
const JANELA_MS = 2 * 24 * 3600 * 1000;   // primeira leitura: últimos 2 dias
const POR_PAGINA = 50;
const MAX_PAGINAS = 20;                    // 1.000 e-mails por volta; o resto fica para a próxima

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

function marcadorDe(caixa) {
  return S.findOne('sync_cursors', c => c.caixa === caixa);
}
function inicioDe(caixa) {
  const m = marcadorDe(caixa);
  if (m && m.desde) return m.desde;
  const desde = Date.parse(process.env.GRAPH_INBOX_DESDE || '');
  return new Date(isNaN(desde) ? Date.now() - JANELA_MS : desde).toISOString();
}
function gravarMarcador(caixa, desde) {
  const m = marcadorDe(caixa);
  if (m) { if (m.desde !== desde) S.update('sync_cursors', m.id, { desde, updated_at: S.now() }); }
  else S.insert('sync_cursors', { caixa, desde, updated_at: S.now() });
}

// Mensagem do Graph → o formato do webhook do Resend que processarEmailRecebido entende.
// O remetente vai SÓ como endereço: montar "Nome <endereço>" deixava um nome de exibição
// como "Cliente <vitima@x>" enganar o extraiEmail e grudar o e-mail no card da vítima.
function paraEvento(msg, caixa) {
  const de = msg.from && msg.from.emailAddress ? String(msg.from.emailAddress.address || '') : '';
  return {
    type: 'email.received',
    data: {
      from: de,
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
  for (const caixa of caixas()) {
    const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(caixa)}`;
    const q = new URLSearchParams({
      // "ge" (e não "gt"): o último e-mail do marcador é relido e pulado pela etiqueta —
      // melhor reler um do que perder o que chegou no mesmo segundo.
      $filter: `receivedDateTime ge ${inicioDe(caixa)}`,
      $orderby: 'receivedDateTime asc',
      $top: String(POR_PAGINA),
      $select: 'id,subject,from,body,internetMessageHeaders,internetMessageId,categories,receivedDateTime',
    });
    let url = `${base}/mailFolders/inbox/messages?${q}`;
    let marcador = null;      // até onde está tudo resolvido, na ordem
    let travou = false;       // um e-mail não resolvido segura o marcador
    for (let pagina = 0; url && pagina < MAX_PAGINAS; pagina++) {
      let lista;
      try {
        // Corpo em texto puro: é o que vai para a timeline e para o prompt do agente.
        lista = await graph(token, url, { headers: { Prefer: 'outlook.body-content-type="text"' } });
      } catch (e) {
        resumo.erros++;
        console.error(`[outlook] não consegui ler ${caixa}: ${e.message}`);
        break;
      }
      for (const msg of (lista && lista.value) || []) {
        resumo.lidas++;
        const ok = await tratar(api, token, base, caixa, msg, resumo);
        if (!ok) travou = true;
        if (!travou && msg.receivedDateTime) marcador = msg.receivedDateTime;
      }
      url = lista && lista['@odata.nextLink'];
    }
    if (marcador) gravarMarcador(caixa, marcador);
  }
  return resumo;
}

// Devolve true quando o e-mail está resolvido (processado agora ou antes) e o marcador
// pode passar por ele.
async function tratar(api, token, base, caixa, msg, resumo) {
  if ((msg.categories || []).includes(CATEGORIA)) { resumo.puladas++; return true; }
  // Mesmo controle "pelo menos uma vez" do webhook: se cair no meio, a próxima volta
  // tenta de novo; se já foi feito e só a etiqueta falhou, não duplica.
  const chave = 'graph:' + (msg.internetMessageId || msg.id);
  const ev = api.reservarEvento(chave);
  if (ev.emAndamento) return false;
  if (!ev.duplicado) {
    try {
      await api.processarEmailRecebido(paraEvento(msg, caixa), null, { caixaPropria: true });
      api.fecharEvento(chave);
      resumo.processadas++;
    } catch (e) {
      api.liberarEvento(chave);
      resumo.erros++;
      console.error(`[outlook] falha ao processar e-mail de ${caixa}: ${e.message}`);
      return false;
    }
  }
  try {
    await graph(token, `${base}/messages/${encodeURIComponent(msg.id)}`, {
      method: 'PATCH', body: JSON.stringify({ categories: [...(msg.categories || []), CATEGORIA] }),
    });
  } catch (e) {
    // Já processado: o marcador pode seguir. Sem etiqueta, a releitura cai no dedupe.
    console.error(`[outlook] processado, mas não consegui etiquetar em ${caixa}: ${e.message}`);
  }
  return true;
}

module.exports = { varrer, isConfigured, motivoDesligado, paraEvento, caixas, CATEGORIA };
