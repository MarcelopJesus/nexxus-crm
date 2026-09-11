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
  if (veio.chave != null && !String(veio.chave).trim()) {
    problemas.push('a chave veio vazia');
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
  const lead = store.get('leads', leadId);
  if (!lead) return { ok: false, razao: 'lead inexistente' };

  const pv = documentos.abrir(leadId, 'PV');
  registrar(deps, leadId, 'pagamento_ok', pv.codigo);
  registrar(deps, leadId, 'vendas_avisa', ligado() ? null : 'rascunho — aguardando liberação do fluxo');
  registrar(deps, leadId, 'vendas_compras');

  const pc = documentos.abrir(leadId, 'PC');
  const produto = lead.product_id ? store.get('products', lead.product_id) : null;
  const fornecedor = produto && produto.supplier_id ? store.get('suppliers', produto.supplier_id) : null;
  const email = textoPedidoDeCompra(lead, produto, fornecedor);

  if (ligado()) {
    registrar(deps, leadId, 'compras_pede', pc.codigo);
  } else {
    // Fail-closed: sem o freio ligado o pedido de compra fica escrito e visível, esperando
    // um humano. É melhor o pedido parar aqui do que sair sozinho para o fornecedor.
    registrar(deps, leadId, 'compras_pede', `${pc.codigo} — RASCUNHO, não enviado (FLUXO_POS_PAGAMENTO desligado)`);
    deps.log(leadId, null, 'email_rascunho', `Para o fornecedor${fornecedor ? ' (' + fornecedor.name + ')' : ''} — ${email.assunto}\n\n${email.corpo}`);
    deps.notify('fluxo_rascunho', `Pedido de compra ${pc.codigo} pronto para revisão — nada foi enviado ao fornecedor.`, leadId);
  }

  return { ok: true, pv, pc, email, enviado: ligado() };
}

module.exports = { ETAPAS, etapa, ligado, registrar, conferir, textoPedidoDeCompra, aoConfirmarPagamento };
