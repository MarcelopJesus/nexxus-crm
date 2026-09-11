'use strict';
// O fluxo pós-pagamento em sete etapas, desenhado na presencial de 09/09/2026 e chamado
// pelo Ítalo de "a nossa Bíblia":
//
//   1. pagamento confirmado          → abre o PV, que cai com o agente de vendas
//   2. vendas avisa o cliente          "estamos gerando sua licença"
//   3. vendas repassa para compras
//   4. compras abre o PC e pede a licença ao fornecedor
//   5. fornecedor devolve: CHAVE para @compras, FATURA para @financeiro
//   6. compras confere (double-check) e devolve a chave para vendas
//   7. vendas entrega chave + book ao cliente → o PV fecha
//
// Por que o compras não entrega direto ao cliente, já que é tudo automático: porque numa
// empresa de verdade o vendedor confere antes de entregar, e porque CADA UM DESSES
// AGENTES É UM PRODUTO QUE A NEXXUS VENDE. A estrutura tem que espelhar papéis reais.
//
// ⚠️ FREIO: nada é enviado para fora sem FLUXO_POS_PAGAMENTO=on. Desligado (o padrão), o
// fluxo registra as etapas e deixa os e-mails como RASCUNHO para um humano aprovar. O
// destinatário da etapa 4 é um fornecedor real; mandar pedido de compra por engano custa
// dinheiro e credibilidade.
const store = require('./store');
const documentos = require('./documentos');
const docnum = require('./docnum');

function ligado() {
  return String(process.env.FLUXO_POS_PAGAMENTO || '').trim().toLowerCase() === 'on';
}

// As etapas em ordem, com o agente dono de cada uma. É esta lista que a timeline mostra.
const ETAPAS = [
  { id: 'pagamento_ok',    agente: 'sistema', texto: 'Pagamento confirmado — pedido de venda aberto' },
  { id: 'vendas_avisa',    agente: 'vendas',  texto: 'Vendas avisou o cliente: estamos gerando sua licença' },
  { id: 'vendas_compras',  agente: 'vendas',  texto: 'Vendas repassou o pedido para compras' },
  { id: 'compras_pede',    agente: 'compras', texto: 'Compras abriu o pedido de compra e solicitou a licença ao fornecedor' },
  { id: 'fornecedor_devolve', agente: 'compras', texto: 'Fornecedor devolveu a chave (compras) e a fatura (financeiro)' },
  { id: 'compras_confere', agente: 'compras', texto: 'Compras conferiu quantidade, produto e número do pedido' },
  { id: 'vendas_entrega',  agente: 'vendas',  texto: 'Vendas entregou chave e book ao cliente — pedido de venda fechado' },
];

function etapa(id) { return ETAPAS.find(e => e.id === id) || null; }

function registrar(deps, leadId, etapaId, detalhe) {
  const e = etapa(etapaId);
  if (!e) throw new Error('Etapa desconhecida: ' + etapaId);
  deps.log(leadId, null, 'fluxo', `[${e.agente}] ${e.texto}${detalhe ? ' — ' + detalhe : ''}`);
  return e;
}

// Etapa 6: o double-check. É a razão de o compras não falar direto com o cliente.
// Divergência NÃO entrega e NÃO fecha nada: para e chama gente.
function conferir(lead, recebido) {
  const problemas = [];
  const pedido = { qty: Number(lead.qty || 0), produto: lead.doc_sku || null, seq: Number(lead.doc_seq || 0) };
  const veio = recebido || {};
  if (veio.qty != null && Number(veio.qty) !== pedido.qty) {
    problemas.push(`quantidade: pedimos ${pedido.qty}, veio ${veio.qty}`);
  }
  if (veio.sku != null && pedido.produto && docnum.normalizaSku(veio.sku) !== pedido.produto) {
    problemas.push(`produto: pedimos ${pedido.produto}, veio ${docnum.normalizaSku(veio.sku)}`);
  }
  if (veio.seq != null && Number(veio.seq) !== pedido.seq) {
    problemas.push(`número do pedido: nosso é ${pedido.seq}, veio ${veio.seq}`);
  }
  // A chave é o objeto da compra: sem ela não há o que entregar. Ausente conta como
  // divergência, não como "o fornecedor não informou" — deixar passar aqui seria entregar
  // ao cliente um e-mail sem licença, o pior erro possível neste fluxo.
  if (!String(veio.chave == null ? '' : veio.chave).trim()) {
    problemas.push('não veio chave de licença');
  }
  return { ok: problemas.length === 0, problemas };
}

// O e-mail que compras manda ao fornecedor (pendência M40). Texto, não envio: quem envia
// é a etapa 4, e só com o freio ligado.
function textoPedidoDeCompra(lead, produto, fornecedor) {
  const cods = docnum.codigosDoLead(lead);
  const pc = cods ? cods.pc : '(sem número)';
  const nomeProduto = (produto && produto.name) || lead.requested_software || 'licença';
  const qtd = Number(lead.qty || 1);
  const assunto = `Pedido de compra ${pc} — ${qtd} licença(s) de ${nomeProduto}`;
  const corpo = [
    `Olá${fornecedor && fornecedor.name ? ', ' + fornecedor.name : ''},`,
    ``,
    `Segue nosso pedido de compra ${pc}.`,
    ``,
    `Produto: ${nomeProduto}`,
    `Quantidade: ${qtd} licença(s)`,
    `Nosso número de pedido: ${pc}`,
    ``,
    `Pedimos a gentileza de responder com:`,
    `  • a chave de licença, para este endereço (compras);`,
    `  • a fatura, para o nosso e-mail financeiro.`,
    ``,
    `Por favor, cite o número ${pc} na resposta — é por ele que conciliamos o pedido.`,
    ``,
    `Obrigado,`,
    `Nexxus Tech`,
  ].join('\n');
  return { assunto, corpo, codigo: pc };
}

// Ponto de entrada: chamado quando o pagamento é confirmado.
//
// `deps` recebe log e notify de fora em vez de importar api.js — api.js já importa este
// módulo, e o ciclo entre os dois deixaria um dos lados com metade das funções vazia.
function aoConfirmarPagamento(deps, leadId) {
  // Dependências conferidas na porta: sem isto um chamador esquecido abriria PV e PC e
  // só quebraria no notify, deixando o pedido metade processado em produção.
  if (!deps || typeof deps.log !== 'function' || typeof deps.notify !== 'function') {
    throw new Error('aoConfirmarPagamento exige deps.log e deps.notify');
  }
  const lead = store.get('leads', leadId);
  if (!lead) return { ok: false, razao: 'lead inexistente' };

  // O webhook do Stripe repete. Abrir PV/PC já era idempotente, mas os RASCUNHOS e as
  // NOTIFICAÇÕES não eram: rodar duas vezes enchia a caixa de avisos do mesmo pedido.
  const jaRodou = store.findOne('activities', a => a.lead_id === Number(leadId)
    && a.type === 'fluxo' && String(a.message || '').includes('Pagamento confirmado'));
  if (jaRodou) {
    return { ok: true, repetido: true, pv: documentos.achar(leadId, 'PV'), pc: documentos.achar(leadId, 'PC') };
  }

  const pv = documentos.abrir(leadId, 'PV');
  registrar(deps, leadId, 'pagamento_ok', pv.codigo);
  registrar(deps, leadId, 'vendas_avisa', ligado() ? null : 'rascunho — aguardando liberação do fluxo');
  registrar(deps, leadId, 'vendas_compras');

  const pc = documentos.abrir(leadId, 'PC');
  const produto = lead.product_id ? store.get('products', lead.product_id) : null;
  const fornecedor = produto && produto.supplier_id ? store.get('suppliers', produto.supplier_id) : null;
  const email = textoPedidoDeCompra(lead, produto, fornecedor);

  if (ligado()) {
    // ⚠️ O envio real ao fornecedor AINDA NÃO EXISTE: depende da caixa @compras, que é
    // tarefa do Marcelo (fase 4 do plano). Ligar o freio hoje libera o fluxo, mas o
    // e-mail continua saindo como rascunho — e o texto abaixo diz isso em vez de mentir
    // "enviado", que faria alguém parar de cobrar o fornecedor achando que já pediu.
    registrar(deps, leadId, 'compras_pede', `${pc.codigo} — PRONTO PARA ENVIO (a caixa @compras ainda não existe)`);
    deps.log(leadId, null, 'email_rascunho', `Para o fornecedor${fornecedor ? ' (' + fornecedor.name + ')' : ''} — ${email.assunto}\n\n${email.corpo}`);
    deps.notify('fluxo_rascunho', `Pedido de compra ${pc.codigo} pronto para envio — falta a caixa @compras.`, leadId);
  } else {
    // Fail-closed: sem o freio ligado o pedido de compra fica escrito e visível, esperando
    // um humano. É melhor o pedido parar aqui do que sair sozinho para o fornecedor.
    registrar(deps, leadId, 'compras_pede', `${pc.codigo} — RASCUNHO, não enviado (FLUXO_POS_PAGAMENTO desligado)`);
    deps.log(leadId, null, 'email_rascunho', `Para o fornecedor${fornecedor ? ' (' + fornecedor.name + ')' : ''} — ${email.assunto}\n\n${email.corpo}`);
    deps.notify('fluxo_rascunho', `Pedido de compra ${pc.codigo} pronto para revisão — nada foi enviado ao fornecedor.`, leadId);
  }

  // `enviado` é sempre false até a caixa @compras existir. O campo continua aqui para
  // quem chama saber que NADA saiu — não é o mesmo que o freio estar ligado.
  return { ok: true, pv, pc, email, enviado: false, liberado: ligado() };
}


// ---- Etapas 5 a 7: a volta do fornecedor ----

// Tira a chave de licença do corpo do e-mail. Deliberadamente CONSERVADOR: só aceita o
// que estiver rotulado ("chave: XXX", "license key: XXX"). Um e-mail de fornecedor tem
// número de nota, CNPJ e código de produto no meio do texto — adivinhar qual deles é a
// licença entregaria lixo ao cliente. Não achou rótulo, devolve null e vira divergência,
// que é o comportamento seguro.
// O último caractere tem que ser alfanumérico: a pontuação da frase ("...chave: ABC-123.")
// entrava na captura e o cliente receberia uma licença com um ponto a mais, que não ativa.
const ROTULOS_CHAVE = /(?:chave(?:\s+de\s+licen[çc]a)?|licen[çc]a|license\s*key|serial|activation\s*key)\s*[:\-–]\s*([A-Za-z0-9](?:[A-Za-z0-9\-_.]{4,}[A-Za-z0-9]))/i;

function extrairChave(texto) {
  if (!texto) return null;
  const m = String(texto).match(ROTULOS_CHAVE);
  return m ? m[1].trim() : null;
}

// A fatura vem no mesmo e-mail ou em outro, para o financeiro. Serve para abrir o NXT-FIN.
const SINAL_FATURA = /(fatura|invoice|nota\s*fiscal|boleto|cobran[çc]a)/i;

function pareceFatura(texto) {
  return !!(texto && SINAL_FATURA.test(String(texto)));
}

/**
 * Chamado quando chega e-mail que cita um pedido de compra nosso.
 *
 * Encadeia as etapas 5, 6 e 7. A 7 (entrega ao cliente) NÃO envia: depende da caixa
 * @vendas e do freio. Fica como rascunho, igual à etapa 4.
 */
function aoReceberDoFornecedor(deps, leadId, entrada) {
  if (!deps || typeof deps.log !== 'function' || typeof deps.notify !== 'function') {
    throw new Error('aoReceberDoFornecedor exige deps.log e deps.notify');
  }
  const lead = store.get('leads', leadId);
  if (!lead) return { ok: false, razao: 'lead inexistente' };
  const pc = documentos.achar(leadId, 'PC');
  if (!pc) return { ok: false, razao: 'não há pedido de compra para este lead' };

  const texto = (entrada && entrada.texto) || '';
  const chave = extrairChave(texto);

  registrar(deps, leadId, 'fornecedor_devolve', chave ? 'chave recebida' : 'sem chave reconhecível no e-mail');

  // A fatura abre o ciclo financeiro, que corre por fora e não segura a entrega.
  if (pareceFatura(texto)) {
    const fin = documentos.abrir(leadId, 'FIN');
    deps.log(leadId, null, 'doc', `Ciclo financeiro ${fin.codigo} aberto — fatura do fornecedor recebida. Fecha quando for paga e o comprovante voltar.`);
  }

  // Etapa 6: o double-check. Divergência PARA aqui e chama gente — não entrega, não fecha.
  const conferencia = conferir(lead, { chave, qty: entrada && entrada.qty, sku: entrada && entrada.sku, seq: entrada && entrada.seq });
  if (!conferencia.ok) {
    deps.log(leadId, null, 'fluxo', `[compras] Conferência REPROVADA: ${conferencia.problemas.join('; ')}. Nada foi entregue ao cliente.`);
    deps.notify('fluxo_divergencia', `Pedido ${pc.codigo}: o que o fornecedor mandou não bate — ${conferencia.problemas.join('; ')}.`, leadId);
    return { ok: false, razao: 'divergência na conferência', problemas: conferencia.problemas, chave: null };
  }
  registrar(deps, leadId, 'compras_confere', 'quantidade, produto e número conferem');

  // A chave voltou e confere: o pedido de compra cumpriu o papel dele.
  documentos.fechar(leadId, 'PC', 'chave recebida do fornecedor e conferida');

  // Etapa 7: a entrega. O e-mail com chave + book é para o CLIENTE — não sai sem a caixa
  // @vendas existir. Sem entrega confirmada, o PV continua aberto, que é a regra.
  const entrega = { assunto: `Sua licença — pedido ${docnum.formatar('PV', lead.doc_seq, lead.doc_sku)}`, chave };
  deps.log(leadId, null, 'email_rascunho', `Para o cliente — ${entrega.assunto}\n\nChave de licença registrada. Falta anexar o book de instalação e enviar pela caixa @vendas.`);
  deps.notify('fluxo_entrega', `Pedido ${pc.codigo} conferido: chave pronta para ir ao cliente. Falta a caixa @vendas.`, leadId);

  return { ok: true, chave, entrega, pvFechado: false };
}

/**
 * A entrega saiu de verdade: registra e fecha o PV. É o único caminho que fecha o pedido,
 * e exige a prova (chave + book) — pagar não é receber.
 */
function confirmarEntregaAoCliente(deps, leadId, prova) {
  const r = documentos.fechar(leadId, 'PV', 'chave e book entregues ao cliente', prova);
  if (!r.ok) return r;
  registrar(deps, leadId, 'vendas_entrega', 'chave e book enviados');
  deps.notify('pedido_entregue', `Pedido ${r.doc.codigo} entregue ao cliente — ciclo de venda fechado.`, leadId);
  return r;
}

module.exports = { ETAPAS, etapa, ligado, registrar, conferir, textoPedidoDeCompra, aoConfirmarPagamento,
  extrairChave, pareceFatura, aoReceberDoFornecedor, confirmarEntregaAoCliente };
