// faq.js — FAQ que aprende (decisão da reunião: "perguntas recorrentes viram FAQ;
// quem responde passa a ser o SDR, não cai mais no BDR").
//
// O ciclo é: o BDR responde uma pendência → o par pergunta/resposta é GENERALIZADO pela
// IA (sem nome de cliente, sem quantidade específica) e vira RASCUNHO inativo → alguém do
// time aprova (ativa) na tela FAQ → o contexto do agente passa a carregar essas respostas
// oficiais → na próxima vez que a mesma dúvida aparecer, a máscara SDR responde sozinha.
//
// Nada aqui bloqueia o clique do BDR: a geração é assíncrona e falha em silêncio (log).
'use strict';
const S = require('./store');
const llm = require('./llm');

const MAX_CONTEXTO = 30;        // entradas que cabem no prompt do agente
const MAX_CHARS_CONTEXTO = 4000;
const MAX_PERGUNTA = 300, MAX_RESPOSTA = 1200;

// ---------- normalização e dedupe (sem IA) ----------
// Perguntar ao modelo se duas perguntas são a mesma custaria uma chamada a cada
// resolução do BDR e ainda erraria. Comparação de palavras resolve o caso real:
// a mesma dúvida reescrita com outra ordem de palavras.
const VAZIAS = new Set(['para','pra','pro','com','sem','que','qual','quais','dos','das',
  'nos','nas','aos','sao','ser','tem','ter','voces','voce','vcs','meu','minha','seu','sua',
  'isso','esse','essa','este','esta','como','quando','onde','sobre','mais','menos','uma','uns','umas']);

function palavras(texto) {
  return String(texto == null ? '' : texto)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // "não" e "nao" são a mesma palavra
    .toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(Boolean);
}
function tokens(texto) {
  return new Set(palavras(texto).filter(w => w.length > 2 && !VAZIAS.has(w)));
}
// cobertura = quanto da pergunta MAIS CURTA aparece na outra; jaccard = o quanto as duas
// têm o mesmo tamanho. Só a cobertura deixaria "vocês emitem nota fiscal?" casar com
// qualquer pergunta longa que citasse nota fiscal.
function semelhanca(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return { cobertura: 0, jaccard: 0, menor: 0 };
  let inter = 0; A.forEach(w => { if (B.has(w)) inter++; });
  return { cobertura: inter / Math.min(A.size, B.size), jaccard: inter / (A.size + B.size - inter),
    menor: Math.min(A.size, B.size) };
}
function pareceRepetida(a, b) {
  const s = semelhanca(a, b);
  if (s.menor < 3) return false;   // pergunta de duas palavras casa com tudo — não arrisca
  return s.cobertura >= 0.7 && s.jaccard >= 0.4;
}

// ---------- leitura ----------
function byCreatedDesc(a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')) || (b.id - a.id); }
function ativas() { return S.find('faq_entries', f => f.active).sort(byCreatedDesc); }
function todas() { return S.all('faq_entries').sort(byCreatedDesc); }
// ignorarId: no PATCH a entrada não pode colidir consigo mesma.
function repetidaDe(pergunta, ignorarId) {
  return ativas().find(f => f.id !== ignorarId && pareceRepetida(f.question, pergunta)) || null;
}

// ---------- escrita ----------
// Devolve { salvo } ou { salvo:null, motivo } — nunca lança: quem chama é fluxo de fundo.
function salvarSeNova(o) {
  const question = String((o && o.question) || '').trim();
  const answer = String((o && o.answer) || '').trim();
  if (!question || !answer) return { salvo: null, motivo: 'pergunta ou resposta vazia' };
  const igual = repetidaDe(question);
  if (igual) return { salvo: null, motivo: 'já existe entrada ativa muito parecida (#' + igual.id + ')', repetidaDe: igual.id };
  const row = S.insert('faq_entries', {
    question: question.slice(0, MAX_PERGUNTA), answer: answer.slice(0, MAX_RESPOSTA),
    source_lead_id: (o && o.sourceLeadId) || null, created_by: (o && o.createdBy) || null,
    active: (o && o.ativo === false) ? 0 : 1,
  });
  return { salvo: row };
}

// ---------- contexto do agente ----------
// Entra no bloco CONFIÁVEL do prompt: foi escrito/aprovado por gente da casa, não pelo
// cliente. As mais recentes primeiro — é o que o time decidiu por último que vale.
function blocoContexto() {
  const lista = ativas();
  if (!lista.length) return '- FAQ oficial: nenhuma pergunta cadastrada ainda.';
  const linhas = [
    '- FAQ OFICIAL DA NEXXUS (' + lista.length + ' pergunta(s) ativas): estas perguntas JÁ TÊM resposta',
    '  oficial aprovada pelo time. Use-as para responder e NÃO escale por dúvidas cobertas aqui.',
  ];
  let chars = 0;
  for (const f of lista.slice(0, MAX_CONTEXTO)) {
    const linha = '    P: ' + f.question + '\n    R: ' + f.answer;
    if (chars + linha.length > MAX_CHARS_CONTEXTO) break;
    chars += linha.length;
    linhas.push(linha);
  }
  return linhas.join('\n');
}

// ---------- captura pela IA ----------
const FAQ_SCHEMA = {
  type: 'object',
  properties: {
    virar_faq: { type: 'boolean' },
    question: { type: 'string' },
    answer: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['virar_faq', 'question', 'answer', 'reason'],
  additionalProperties: false,
};

const FAQ_SYSTEM = [
  'Você organiza a base de conhecimento comercial da Nexxus Tech — revenda B2B de softwares',
  'internacionais. Acabou de acontecer isto: um cliente levantou uma dúvida/objeção e uma pessoa',
  'do time respondeu. Sua tarefa é transformar esse par em uma entrada de FAQ REUTILIZÁVEL.',
  '',
  'Regras da entrada:',
  '- question: a pergunta na forma GERAL, como qualquer cliente faria. Sem nome de pessoa, sem',
  '  nome de empresa, sem quantidade específica de licenças e sem valores em reais.',
  '- answer: a resposta oficial, também geral. Onde a resposta original citava número específico,',
  '  use um marcador ("conforme a faixa de quantidade", "conforme a tabela vigente") em vez do número.',
  '- virar_faq: false quando o caso é específico demais para servir a outro cliente (negociação',
  '  pontual, exceção autorizada, problema daquele contrato). Nesse caso explique em reason.',
  '- reason: uma frase dizendo por que vira (ou não vira) FAQ.',
  '',
  'Português brasileiro, direto, sem clichê. Nunca invente política comercial que não esteja na',
  'resposta que o time deu.',
].join('\n');

// Gera o par canônico a partir da pendência que o BDR acabou de responder.
// o = { leadId, pendencia, resposta, userId }
async function gerarDoBdr(o) {
  const pendencia = String((o && o.pendencia) || '').trim();
  const resposta = String((o && o.resposta) || '').trim();
  if (!pendencia || !resposta) return { salvo: null, motivo: 'sem pendência ou sem resposta' };
  if (!llm.isConfigured()) return { salvo: null, motivo: 'IA não configurada' };
  // require tardio: agentNexus carrega este módulo no topo (para o contexto do agente).
  // Pegar a cerca lá em cima fecharia o ciclo — mesma razão do require tardio do api.js.
  const { cercar } = require('./agentNexus');
  const out = await llm.chatJSON({
    system: FAQ_SYSTEM,
    user: 'Dúvida/objeção que o cliente levantou (resumo do agente, pode conter texto do cliente):\n'
      + cercar(pendencia)
      + '\n\nResposta que o time enviou ao cliente:\n' + cercar(resposta)
      + '\n\nGere a entrada de FAQ.',
    schemaName: 'entrada_faq', schema: FAQ_SCHEMA, maxTokens: 1500,
  });
  if (!out.virar_faq) return { salvo: null, motivo: 'caso específico demais — ' + (out.reason || 'sem justificativa') };
  // ativo:false — a pergunta nasce do texto do CLIENTE passado pela IA. Se entrasse ativa
  // direto, um motivo de recusa malicioso poderia plantar instrução persistente no prompt
  // que responde OUTROS leads. Gente da casa aprova (ativa) na tela FAQ antes de valer.
  return salvarSeNova({ question: out.question, answer: out.answer, ativo: false,
    sourceLeadId: (o && o.leadId) || null, createdBy: (o && o.userId) || null });
}

module.exports = { ativas, todas, salvarSeNova, blocoContexto, gerarDoBdr,
  pareceRepetida, semelhanca, repetidaDe, MAX_PERGUNTA, MAX_RESPOSTA };
