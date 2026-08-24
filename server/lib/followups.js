// followups.js — varredura periódica dos follow-ups. Hoje faz uma coisa só:
// lead que ficou com proposta parada além do prazo vira PERDIDO automaticamente,
// para o funil não acumular negócio morto. Nunca toca em ganho nem em proposta
// aceita, e nunca alcança estágio anterior à proposta.
'use strict';
const S = require('./store');
const { log, notify } = require('./api');

const ESTAGIOS_ALVO = ['proposta_enviada', 'negociacao'];

function autoLostDays() {
  const n = parseInt(process.env.AUTO_LOST_DAYS, 10);
  return isFinite(n) && n > 0 ? n : 60;
}
// O store grava "YYYY-MM-DD HH:MM:SS" em UTC, sem o "Z" — sem colar o Z o Node
// leria como hora local e o prazo saía 3h errado.
function toMs(v) {
  if (!v) return null;
  let s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  const t = Date.parse(s);
  return isNaN(t) ? null : t;
}

// Índices por lead numa passada só — a varredura roda sobre a base inteira de hora
// em hora e não pode ser leads × propostas.
function indexar() {
  // Chave sempre numérica: lead_id pode chegar como string em registro antigo,
  // e "123" !== 123 num Map faria a varredura ignorar o sinal de vida do lead.
  const props = new Map();   // lead_id -> { ultima, visto }
  for (const p of S.all('proposals')) {
    const k = Number(p.lead_id);
    const cur = props.get(k) || { ultima: null, visto: 0 };
    if (!cur.ultima || p.version > cur.ultima.version || (p.version === cur.ultima.version && p.id > cur.ultima.id))
      cur.ultima = p;
    const v = toMs(p.last_viewed_at);
    if (v && v > cur.visto) cur.visto = v;
    props.set(k, cur);
  }
  const acts = new Map();    // lead_id -> ms da atividade mais recente
  for (const a of S.all('activities')) {
    const k = Number(a.lead_id);
    const t = toMs(a.created_at);
    if (t != null && t > (acts.get(k) || 0)) acts.set(k, t);
  }
  return { props, acts };
}

// Idempotente: só olha lead 'open', e o que ele marca vira 'lost' — na próxima
// rodada o mesmo lead já não entra na lista.
function runFollowupSweep(nowMs) {
  const days = autoLostDays();
  const limite = (nowMs || Date.now()) - days * 86400000;
  const motivo = `Sem resposta após ${days} dias (automático)`;
  const { props, acts } = indexar();
  let checked = 0, lost = 0;

  for (const lead of S.find('leads', l => l.status === 'open' && ESTAGIOS_ALVO.includes(l.stage))) {
    const info = props.get(Number(lead.id));
    if (!info || !info.ultima) continue;
    const ultima = info.ultima;
    // Proposta mais recente aceita com o lead ainda aberto é estado inconsistente —
    // quem resolve é gente. Aceite ANTIGO (lead reaberto com versão nova) não blinda.
    if (ultima.accepted_at || ultima.status === 'accepted') continue;
    checked++;

    // O relógio não conta da proposta: conta do ÚLTIMO SINAL DE VIDA do lead —
    // proposta mais recente, abertura da proposta pelo cliente ou qualquer atividade
    // na timeline (nota do vendedor, mudança de estágio, reabertura). Negociação viva
    // com proposta velha não pode morrer por prazo.
    const sinais = [toMs(ultima.created_at), info.visto || null, acts.get(Number(lead.id)) || null]
      .filter(t => t != null);
    if (!sinais.length || Math.max.apply(null, sinais) > limite) continue;

    S.update('leads', lead.id, { status: 'lost', lost_reason: motivo, updated_at: S.now() });
    log(lead.id, null, 'close', `Negócio PERDIDO automaticamente — ${days} dias sem nenhum sinal de vida desde a proposta v${ultima.version}.`);
    notify('lost_auto', `Sem resposta há ${days} dias: ${lead.title} foi marcado como perdido.`, lead.id);
    lost++;
  }
  return { checked, lost, days };
}

module.exports = { runFollowupSweep, autoLostDays };
