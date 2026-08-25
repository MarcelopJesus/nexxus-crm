// sdr.js — SDR Agent: pesquisa de leads, preparação de abordagem e qualificação BANT.
// Quem fala com o modelo é o llm.js (provider openai ou vertex): aqui ficam só os
// prompts e os schemas de cada tarefa.
'use strict';
const llm = require('./llm');

const isConfigured = llm.isConfigured;
const chatJSON = llm.chatJSON;

// ====================================================================
// 1) PESQUISA DE LEADS — gera lista de empresas-alvo a partir do ICP
// ====================================================================
const PROSPECT_SCHEMA = {
  type: 'object',
  properties: {
    prospects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          company_name:   { type: 'string' },
          segment:        { type: 'string' },
          city:           { type: 'string' },
          size_estimate:  { type: 'string' },
          website:        { type: 'string' },
          why_fit:        { type: 'string' },
          suggested_software: { type: 'string' },
          contact_name:   { type: 'string' },
          contact_role:   { type: 'string' },
          fit_score:      { type: 'integer' },
        },
        required: ['company_name','segment','city','size_estimate','website','why_fit','suggested_software','contact_name','contact_role','fit_score'],
        additionalProperties: false,
      },
    },
  },
  required: ['prospects'],
  additionalProperties: false,
};

async function researchLeads(icp, catalog) {
  const products = (catalog && catalog.products || []).map(p => p.name).join(', ') || 'softwares B2B em geral';
  const qty = Math.min(Math.max(parseInt(icp.quantity) || 8, 3), 15);
  const system = [
    'Você é um SDR sênior especialista em prospecção outbound B2B no mercado brasileiro de revenda de softwares.',
    'Sua tarefa: gerar uma lista de empresas-alvo REALISTAS e plausíveis que correspondam ao ICP informado.',
    'Baseie-se em conhecimento real do mercado brasileiro: empresas conhecidas dos segmentos citados, portes e cidades coerentes.',
    'Para o contato sugerido, indique o CARGO típico do decisor (ex.: Head de TI, CTO, Diretor de Engenharia) e um nome plausível — deixe claro no campo why_fit que o contato deve ser validado no LinkedIn.',
    'fit_score: inteiro 0-100 indicando aderência ao ICP.',
    'suggested_software: escolha o software do catálogo mais aderente à empresa.',
    'Responda SOMENTE com JSON válido no schema. Todos os textos em português brasileiro.',
  ].join('\n');
  const user = [
    'ICP (perfil de cliente ideal):',
    '- Segmento/indústria: ' + (icp.segment || 'qualquer'),
    '- Porte (funcionários): ' + (icp.size || 'qualquer'),
    '- Região/cidade: ' + (icp.region || 'Brasil'),
    '- Software/categoria de interesse: ' + (icp.software || 'qualquer do catálogo'),
    '- Observações: ' + (icp.notes || '—'),
    '',
    'Catálogo de softwares que revendemos: ' + products,
    '',
    'Gere exatamente ' + qty + ' empresas-alvo ordenadas por fit_score decrescente.',
  ].join('\n');
  const out = await chatJSON({ system, user, schemaName: 'prospect_list', schema: PROSPECT_SCHEMA, maxTokens: 6000 });
  return out.prospects || [];
}

// ====================================================================
// 2) PREPARAÇÃO DE ABORDAGEM — e-mail, WhatsApp/LinkedIn e roteiro de call
// ====================================================================
const OUTREACH_SCHEMA = {
  type: 'object',
  properties: {
    email_subject:   { type: 'string' },
    email_body:      { type: 'string' },
    whatsapp_message:{ type: 'string' },
    linkedin_message:{ type: 'string' },
    call_script:     { type: 'string' },
    talking_points:  { type: 'array', items: { type: 'string' } },
    objections:      {
      type: 'array',
      items: {
        type: 'object',
        properties: { objection: { type: 'string' }, answer: { type: 'string' } },
        required: ['objection','answer'],
        additionalProperties: false,
      },
    },
  },
  required: ['email_subject','email_body','whatsapp_message','linkedin_message','call_script','talking_points','objections'],
  additionalProperties: false,
};

async function prepareOutreach(ctx) {
  const system = [
    'Você é um SDR sênior brasileiro, especialista em cold outreach B2B para revenda de softwares.',
    'Escreva abordagens curtas, consultivas e personalizadas — nada genérico, sem clichês ("espero que esteja bem").',
    'E-mail: máx. 120 palavras, com CTA claro de agendar 15 min. WhatsApp: máx. 60 palavras, tom leve. LinkedIn: máx. 50 palavras.',
    'Roteiro de ligação: estrutura abertura → motivo → pergunta de descoberta → próximo passo, em tópicos curtos.',
    'objections: 3 objeções prováveis com respostas prontas.',
    'Todos os textos em português brasileiro. Responda SOMENTE com JSON válido no schema.',
  ].join('\n');
  const user = [
    'Contexto do lead:',
    '- Empresa: ' + (ctx.company || '—') + ' (' + (ctx.segment || 'segmento não informado') + ', ' + (ctx.city || 'cidade não informada') + ')',
    '- Contato: ' + (ctx.contact || '—') + (ctx.role ? (' — ' + ctx.role) : ''),
    '- Software de interesse: ' + (ctx.software || '—'),
    '- Quantidade/escopo: ' + (ctx.qty || '—'),
    '- Origem do lead: ' + (ctx.source || '—'),
    '- Notas/histórico: ' + (ctx.notes || '—'),
    '- Quem somos: NexxusTECH, revenda B2B oficial de softwares internacionais (Atlassian, Autodesk, JetBrains etc.) com precificação em reais, NF nacional e suporte em português.',
    '- Vendedor responsável: ' + (ctx.seller || 'Time NexxusTECH'),
  ].join('\n');
  return chatJSON({ system, user, schemaName: 'outreach_kit', schema: OUTREACH_SCHEMA, maxTokens: 4000 });
}

// ====================================================================
// 3) QUALIFICAÇÃO BANT — score 0-100 com justificativas
// ====================================================================
const QUALIFY_SCHEMA = {
  type: 'object',
  properties: {
    budget:    { type: 'object', properties: { score: { type: 'integer' }, rationale: { type: 'string' } }, required: ['score','rationale'], additionalProperties: false },
    authority: { type: 'object', properties: { score: { type: 'integer' }, rationale: { type: 'string' } }, required: ['score','rationale'], additionalProperties: false },
    need:      { type: 'object', properties: { score: { type: 'integer' }, rationale: { type: 'string' } }, required: ['score','rationale'], additionalProperties: false },
    timing:    { type: 'object', properties: { score: { type: 'integer' }, rationale: { type: 'string' } }, required: ['score','rationale'], additionalProperties: false },
    total_score: { type: 'integer' },
    tier:        { type: 'string', enum: ['A','B','C'] },
    summary:     { type: 'string' },
    next_actions:{ type: 'array', items: { type: 'string' } },
    missing_info:{ type: 'array', items: { type: 'string' } },
  },
  required: ['budget','authority','need','timing','total_score','tier','summary','next_actions','missing_info'],
  additionalProperties: false,
};

async function qualifyLead(ctx) {
  const system = [
    'Você é um SDR sênior que qualifica contas B2B pela metodologia BANT (Budget, Authority, Need, Timing).',
    'Cada dimensão recebe score 0-25. total_score = soma (0-100).',
    'tier: "A" se total_score >= 70 (priorizar já), "B" se 40-69 (nutrir), "C" se < 40 (baixa prioridade).',
    'Seja rigoroso: quando faltar informação, dê score conservador na dimensão e liste o que falta em missing_info (perguntas que o SDR deve fazer).',
    'next_actions: 2-4 ações práticas e imediatas.',
    'Todos os textos em português brasileiro. Responda SOMENTE com JSON válido no schema.',
  ].join('\n');
  const user = [
    'Dados da conta/lead para qualificar:',
    '- Empresa: ' + (ctx.company || '—') + ' (' + (ctx.segment || 'segmento não informado') + ', ' + (ctx.city || '—') + ')',
    '- Contato: ' + (ctx.contact || '—') + (ctx.role ? (' — cargo: ' + ctx.role) : ' — cargo não informado'),
    '- Software de interesse: ' + (ctx.software || '—'),
    '- Quantidade/licenças: ' + (ctx.qty || '—'),
    '- Valor estimado: ' + (ctx.value ? ('R$ ' + ctx.value) : 'não informado'),
    '- Origem: ' + (ctx.source || '—'),
    '- Estágio no funil: ' + (ctx.stage || '—'),
    '- Lead marcado como quente: ' + (ctx.hot ? 'sim' : 'não'),
    '- Notas: ' + (ctx.notes || '—'),
    '- Histórico de atividades (mais recentes primeiro):',
    (ctx.timeline || '  (sem atividades)'),
  ].join('\n');
  const out = await chatJSON({ system, user, schemaName: 'bant_qualification', schema: QUALIFY_SCHEMA, maxTokens: 3000 });
  // saneamento defensivo
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, parseInt(n) || 0));
  ['budget','authority','need','timing'].forEach(k => { out[k].score = clamp(out[k].score, 0, 25); });
  out.total_score = out.budget.score + out.authority.score + out.need.score + out.timing.score;
  out.tier = out.total_score >= 70 ? 'A' : (out.total_score >= 40 ? 'B' : 'C');
  return out;
}

module.exports = { isConfigured, researchLeads, prepareOutreach, qualifyLead };
// MODEL era constante lida no require. Agora o modelo depende do provider ativo, então
// vira leitura dinâmica — a tela de status mostra o que está mesmo em uso.
Object.defineProperty(module.exports, 'MODEL', { enumerable: true, get: () => llm.model() });
