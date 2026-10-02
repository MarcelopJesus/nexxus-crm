'use strict';
// Cobrança B2B pelo Asaas (M51, presencial de 30/09/2026):
//
//   cliente aceita a proposta  → boleto de 7 dias no Asaas → Veridiana manda o link
//   Asaas avisa "pago"         → o pedido entra no fluxo pós-pagamento das 7 etapas
//
// É o mesmo ponto de entrada do pedido pago no site (fluxoPedido.aoConfirmarPagamento):
// quem paga por boleto anda pelo mesmo trilho de quem paga por cartão.
//
// Uma cobrança por proposta aceita, guardada na coleção `cobrancas`. Status:
//   gerando → pendente → pago        (o caminho feliz)
//                      → vencido     (o Asaas cobra 3 dias por WhatsApp; depois é gente)
//                      → cancelado   (apagada ou estornada no Asaas)
//   erro                             (o Asaas recusou — o motivo fica na cobrança)
const store = require('./store');
const asaas = require('./asaas');
const docnum = require('./docnum');
const fluxo = require('./fluxoPedido');

function prazoDias() {
  const n = parseInt(process.env.ASAAS_PRAZO_DIAS, 10);
  return Number.isInteger(n) && n > 0 && n <= 60 ? n : 7;
}

// Vencimento contado no calendário de São Paulo: às 22h de Brasília já é amanhã em UTC,
// e o boleto sairia com um dia a mais.
function vencimento(dias, agora) {
  const hojeSP = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(agora || new Date());
  const d = new Date(hojeSP + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function dataBR(iso) {
  const [a, m, d] = String(iso).split('-');
  return `${d}/${m}/${a}`;
}

function reais(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function codigoOP(lead) {
  const seq = Number(lead && lead.doc_seq);
  return Number.isInteger(seq) && seq > 0 ? docnum.formatar('OP', seq) : `lead #${lead && lead.id}`;
}

// A referência que vai e volta pelo Asaas: é por ela que o aviso de pagamento acha o
// pedido mesmo se a cobrança local tiver sumido.
function referencia(leadId, propId) {
  return `nexxus-lead-${leadId}-prop-${propId}`;
}

function daProposta(propId) {
  return store.find('cobrancas', c => c.proposal_id === propId && c.status !== 'cancelado')
    .sort((a, b) => b.id - a.id)[0] || null;
}

const GERANDO_MORTO_MS = 2 * 60 * 1000;
function gerandoMorto(cob) {
  return cob.status === 'gerando' && Date.now() - Number(cob.gerando_desde || 0) > GERANDO_MORTO_MS;
}

function textoBoleto(lead, cob) {
  const ct = lead.contact_id ? store.get('contacts', lead.contact_id) : null;
  const nome = ct && ct.name;
  const op = codigoOP(lead);
  return {
    assunto: `Proposta aceita — boleto do pedido ${op}`,
    corpo: [
      `Olá${nome ? ', ' + nome : ''},`,
      ``,
      `Obrigado por aceitar a nossa proposta!`,
      ``,
      `Segue o boleto para pagamento:`,
      `  • Valor: ${reais(cob.valor)}`,
      `  • Vencimento: ${dataBR(cob.vencimento)}`,
      `  • Boleto: ${cob.link}`,
      ``,
      `Assim que o pagamento for compensado, solicitamos a licença ao fabricante e enviamos a chave e o guia de instalação neste mesmo e-mail.`,
      `Número do seu pedido: ${op} — se precisar falar com a gente, é só responder citando esse número.`,
      ``,
      `Veridiana — Vendas · Nexxus Tech`,
    ].join('\n'),
  };
}

// Aceite da proposta → boleto. `deps`: log, notify, enviar (mailer.sendEmail), logEmailOut.
// Nunca lança: falha vira notificação e timeline, e o aceite do cliente segue valendo.
async function gerarNoAceite(deps, leadId, prop) {
  const lead = store.get('leads', leadId);
  if (!lead || !prop) return { ok: false, razao: 'lead ou proposta inexistente' };

  // Aceite repetido (duplo clique, link reaberto) não gera segundo boleto. "gerando" há
  // mais de 2 minutos é tentativa que morreu no meio (processo caiu): pode tentar de novo —
  // a busca pela referência no Asaas, lá embaixo, impede o boleto em dobro.
  const existente = daProposta(prop.id);
  if (existente && existente.status !== 'erro' && !gerandoMorto(existente)) return { ok: true, repetido: true, cobranca: existente };

  const off = asaas.motivoDesligado();
  if (off) {
    deps.log(leadId, null, 'cobranca', `Boleto NÃO gerado — integração com o Asaas desligada (${off}). Gere a cobrança à mão.`);
    deps.notify('cobranca_falha', `Proposta aceita, mas o boleto não foi gerado: ${off}.`, leadId);
    return { ok: false, razao: off };
  }

  const conta = lead.account_id ? store.get('accounts', lead.account_id) : null;
  const doc = asaas.soDigitos(conta && conta.cnpj);
  if (doc.length !== 14 && doc.length !== 11) {
    deps.log(leadId, null, 'cobranca', 'Boleto NÃO gerado — a empresa está sem CNPJ cadastrado. Cadastre o CNPJ e clique em "Gerar boleto".');
    deps.notify('cobranca_sem_cnpj', `Proposta aceita por ${conta ? conta.name : 'cliente'}, mas falta o CNPJ para gerar o boleto.`, leadId);
    return { ok: false, razao: 'sem CNPJ' };
  }

  // Sem número NXT o pagamento não teria como abrir o PV depois: o lead criado à mão no CRM
  // nasce sem ele. Reserva agora, antes de cobrar.
  if (!(Number(lead.doc_seq) > 0)) {
    const op = docnum.novaOportunidade();
    store.update('leads', leadId, { doc_seq: op.seq });
    lead.doc_seq = op.seq;
    deps.log(leadId, null, 'doc', `Oportunidade ${op.codigo} aberta para a cobrança.`);
  }

  const valor = Number(prop.final_price);
  if (!(valor > 0)) {
    deps.notify('cobranca_falha', `Proposta v${prop.version} aceita sem valor — boleto não gerado.`, leadId);
    return { ok: false, razao: 'proposta sem valor' };
  }

  // Reserva antes de chamar o Asaas: um segundo aceite no meio da chamada encontra esta
  // linha e para, em vez de gerar outro boleto.
  const cob = existente
    ? store.update('cobrancas', existente.id, { status: 'gerando', gerando_desde: Date.now(), erro: null, valor, vencimento: vencimento(prazoDias()) })
    : store.insert('cobrancas', { lead_id: leadId, proposal_id: prop.id, valor, vencimento: vencimento(prazoDias()),
      status: 'gerando', gerando_desde: Date.now(), ambiente: asaas.ambiente(), referencia: referencia(leadId, prop.id),
      asaas_id: null, asaas_cliente: null, link: null, boleto_pdf: null, pago_em: null, erro: null });

  try {
    const ct = lead.contact_id ? store.get('contacts', lead.contact_id) : null;
    const cliente = await asaas.acharOuCriarCliente({ nome: conta.name, cpfCnpj: doc, email: ct && ct.email,
      referencia: `nexxus-conta-${conta.id}` });
    const pag = (await asaas.boletoDaReferencia(cob.referencia))
      || await asaas.criarBoleto({ cliente: cliente.id, valor, vencimento: cob.vencimento,
        descricao: `Nexxus Tech — pedido ${codigoOP(lead)} (proposta v${prop.version})`, referencia: cob.referencia });
    // Um aviso de estorno/exclusão pode ter chegado enquanto o Asaas respondia: o que o
    // webhook gravou vale mais que o "pendente" desta continuação.
    if (store.get('cobrancas', cob.id).status !== 'gerando') return { ok: false, razao: 'cobrança mudou durante a geração' };
    const pronta = store.update('cobrancas', cob.id, { status: 'pendente', asaas_id: pag.id, asaas_cliente: cliente.id,
      vencimento: pag.dueDate || cob.vencimento, link: pag.invoiceUrl || pag.bankSlipUrl || null, boleto_pdf: pag.bankSlipUrl || null });
    const sandbox = pronta.ambiente === 'sandbox' ? ' [SANDBOX — não é cobrança real]' : '';
    deps.log(leadId, null, 'cobranca', `Boleto de ${reais(valor)} gerado no Asaas, vence ${dataBR(pronta.vencimento)}${sandbox}. ${pronta.link || ''}`.trim());
    await avisarCliente(deps, lead, pronta);
    return { ok: true, cobranca: pronta };
  } catch (e) {
    if (store.get('cobrancas', cob.id).status === 'gerando') store.update('cobrancas', cob.id, { status: 'erro', erro: e.message });
    deps.log(leadId, null, 'cobranca', `Boleto NÃO gerado — ${e.message}`);
    deps.notify('cobranca_falha', `O Asaas recusou o boleto: ${e.message}`, leadId);
    return { ok: false, razao: e.message };
  }
}

// O e-mail da Veridiana passa pelo mesmo freio do fluxo pós-pagamento
// (FLUXO_POS_PAGAMENTO): desligado vira rascunho, em teste só sai para a lista permitida.
async function avisarCliente(deps, lead, cob) {
  const ct = lead.contact_id ? store.get('contacts', lead.contact_id) : null;
  const para = ct && ct.email;
  const { assunto, corpo } = textoBoleto(lead, cob);
  const barrado = fluxo.motivoParaNaoEnviar(para);
  if (barrado) {
    deps.log(lead.id, null, 'email_rascunho', `Para o cliente${para ? ' (' + para + ')' : ''} — ${assunto} — NÃO enviado (${barrado})\n\n${corpo}`);
    return { enviado: false, razao: barrado };
  }
  const r = await deps.enviar({ to: para, subject: assunto, html: fluxo.paraHtml(corpo), area: 'vendas' });
  if (r && r.sent) {
    deps.logEmailOut(lead.id, para, assunto, corpo, r.id || null);
    return { enviado: true };
  }
  const motivo = (r && (r.reason || r.status)) || 'sem resposta do provedor';
  deps.log(lead.id, null, 'email_rascunho', `Para o cliente (${para}) — ${assunto} — FALHOU (${motivo})\n\n${corpo}`);
  deps.notify('fluxo_falha_envio', `O boleto foi gerado, mas o e-mail ao cliente não saiu (${motivo}). Mande o link à mão.`, lead.id);
  return { enviado: false, razao: motivo };
}

const PAGO = ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED_IN_CASH'];
const CANCELADO = ['PAYMENT_DELETED', 'PAYMENT_REFUNDED'];

function acharCobranca(pag) {
  if (!pag) return null;
  return (pag.id && store.findOne('cobrancas', c => c.asaas_id === pag.id))
    || (pag.externalReference && store.findOne('cobrancas', c => c.referencia === pag.externalReference))
    || null;
}

// Aviso do Asaas. `deps`: log, notify, confirmarPagamento(leadId).
// Devolve sempre um resumo — evento que não é nosso é ignorado sem erro, senão o Asaas
// acumula falhas e pausa a fila inteira de webhooks.
function aoReceberWebhook(deps, evento) {
  const tipo = evento && evento.event;
  const pag = evento && evento.payment;
  const cob = acharCobranca(pag);
  if (!cob) return { tratado: false, razao: 'cobrança desconhecida' };
  const leadId = cob.lead_id;

  if (PAGO.includes(tipo)) {
    // Cartão manda CONFIRMED e depois RECEIVED: o segundo não pode abrir outro PV.
    if (cob.status === 'pago') return { tratado: true, repetido: true };
    // Aviso de "pago" atrasado, chegando depois do estorno, não reabre o pedido sozinho.
    if (cob.status === 'cancelado') {
      deps.log(leadId, null, 'cobranca', `O Asaas avisou pagamento (${tipo}) de uma cobrança já cancelada/estornada. Nada foi aberto — confira no Asaas.`);
      deps.notify('cobranca_falha', 'Pagamento avisado numa cobrança cancelada — confira no Asaas antes de liberar a licença.', leadId);
      return { tratado: true, ignorado: 'cancelada' };
    }
    // O fluxo primeiro, a marca de pago depois: se abrir o PV falhar, a cobrança continua
    // pendente, o webhook responde erro e a retentativa do Asaas tenta de novo.
    // (aoConfirmarPagamento é idempotente — o que já abriu não abre outra vez.)
    deps.confirmarPagamento(leadId);
    store.update('cobrancas', cob.id, { status: 'pago', pago_em: store.now() });
    store.update('leads', leadId, { doc_pago_em: store.now(), updated_at: store.now() });
    deps.log(leadId, null, 'cobranca', `Pagamento confirmado pelo Asaas — ${reais(pag.value || cob.valor)} (${tipo}).`);
    deps.notify('order_paid', `Boleto pago: ${reais(pag.value || cob.valor)}. Pedido segue para a licença.`, leadId);
    return { tratado: true, pago: true };
  }
  if (tipo === 'PAYMENT_OVERDUE') {
    if (cob.status !== 'pendente') return { tratado: true, repetido: true };
    store.update('cobrancas', cob.id, { status: 'vencido' });
    deps.log(leadId, null, 'cobranca', `Boleto VENCIDO em ${dataBR(cob.vencimento)} sem pagamento. O Asaas cobra o cliente por 3 dias; depois disso, contato humano.`);
    deps.notify('cobranca_vencida', `Boleto de ${reais(cob.valor)} venceu sem pagamento.`, leadId);
    return { tratado: true };
  }
  if (CANCELADO.includes(tipo)) {
    if (cob.status === 'cancelado') return { tratado: true, repetido: true };
    const estavaPago = cob.status === 'pago';
    store.update('cobrancas', cob.id, { status: 'cancelado' });
    deps.log(leadId, null, 'cobranca', `Cobrança ${tipo === 'PAYMENT_REFUNDED' ? 'ESTORNADA' : 'apagada'} no Asaas.`);
    deps.notify('cobranca_falha', `Cobrança ${tipo === 'PAYMENT_REFUNDED' ? 'estornada' : 'apagada'} no Asaas${estavaPago ? ' DEPOIS de paga — confira o pedido' : ''}.`, leadId);
    return { tratado: true };
  }
  return { tratado: false, razao: `evento ${tipo} ignorado` };
}

module.exports = { gerarNoAceite, aoReceberWebhook, vencimento, prazoDias, referencia, daProposta, textoBoleto };
