'use strict';
// Numeração de documentos NXT — decidido na presencial de 09/09/2026 (seção 11 do
// DECISOES.md). Um número sequencial só; o prefixo diz em que ponto do processo o
// pedido está:
//
//   NXT-OP-0007   oportunidade  — nasce com o lead, antes de qualquer pagamento
//   NXT-PV-0007   pedido de venda — nasce no instante em que o dinheiro entra
//   NXT-PC-0007   pedido de compra — interno, é o que vai para o fornecedor
//   NXT-FIN-0007  ciclo financeiro — corre em paralelo até a fatura do fornecedor ser paga
//
// O número NÃO muda quando o documento troca de tipo: é o mesmo pedido andando.
// Carrinho com dois produtos gera UM OP e UM PV por produto, com o SKU no sufixo:
//   NXT-PV-0007-AMPLER  e  NXT-PV-0007-1PASSWORD
//
// Por que isso existe: sem um número que viaje do site até o e-mail, a resposta do
// cliente era casada pelo endereço do remetente — e três oportunidades do mesmo
// cliente caíam no mesmo card. Foi o defeito visto ao vivo em 09/09.
const store = require('./store');

const TIPOS = ['OP', 'PV', 'PC', 'FIN'];
const PREFIXO = 'NXT';
// 4 dígitos cobrem 9.999 pedidos; passando disso o número simplesmente cresce, em vez
// de reiniciar e colidir com um pedido antigo.
const DIGITOS = 4;

// O SKU entra no código, então precisa ser previsível: sem acento, sem espaço e sem
// hífen — hífen é o separador do próprio código e criaria ambiguidade ao ler de volta.
function normalizaSku(sku) {
  if (sku == null) return '';
  return String(sku)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 20);
}

function formatar(tipo, seq, sku) {
  const t = String(tipo || '').toUpperCase();
  if (!TIPOS.includes(t)) throw new Error('Tipo de documento inválido: ' + tipo);
  const n = Number(seq);
  if (!Number.isInteger(n) || n <= 0) throw new Error('Sequencial inválido: ' + seq);
  const base = PREFIXO + '-' + t + '-' + String(n).padStart(DIGITOS, '0');
  const s = normalizaSku(sku);
  return s ? base + '-' + s : base;
}

// Reserva o próximo sequencial. Uma chave só para os quatro tipos, porque o número é
// compartilhado entre eles de propósito.
function proximoSeq() {
  return store.nextId('nxt_doc');
}

// Abre um pedido novo: reserva o número e devolve já formatado como oportunidade.
function novaOportunidade() {
  const seq = proximoSeq();
  return { seq, codigo: formatar('OP', seq) };
}

const RE_CODIGO = /\bNXT-(OP|PV|PC|FIN)-(\d{1,9})(?:-([A-Z0-9]{1,20}))?\b/i;
const RE_CODIGO_GLOBAL = new RegExp(RE_CODIGO.source, 'gi');

// Lê um código de dentro de um texto qualquer — assunto de e-mail, corpo, mensagem de
// WhatsApp. Devolve null quando não há nada reconhecível.
function extrair(texto) {
  if (!texto) return null;
  const m = String(texto).match(RE_CODIGO);
  if (!m) return null;
  return {
    tipo: m[1].toUpperCase(),
    seq: Number(m[2]),
    sku: m[3] ? m[3].toUpperCase() : null,
    codigo: m[0].toUpperCase(),
  };
}

// Todos os códigos de um texto, sem repetir. Um e-mail encaminhado pode citar mais de um.
function extrairTodos(texto) {
  if (!texto) return [];
  const achados = String(texto).match(RE_CODIGO_GLOBAL) || [];
  const vistos = new Set();
  const saida = [];
  for (const bruto of achados) {
    const item = extrair(bruto);
    if (item && !vistos.has(item.codigo)) { vistos.add(item.codigo); saida.push(item); }
  }
  return saida;
}

// O lead guarda o sequencial; o código de cada tipo é derivado dele. Guardar o número
// e não a string evita que OP e PV saiam de sincronia quando um for regravado.
function codigosDoLead(lead) {
  if (!lead || !lead.doc_seq) return null;
  const seq = Number(lead.doc_seq);
  if (!Number.isInteger(seq) || seq <= 0) return null;
  const sku = lead.doc_sku || null;
  return {
    seq,
    op: formatar('OP', seq),
    pv: formatar('PV', seq, sku),
    pc: formatar('PC', seq, sku),
    fin: formatar('FIN', seq),
  };
}

module.exports = { TIPOS, PREFIXO, formatar, normalizaSku, proximoSeq, novaOportunidade,
  extrair, extrairTodos, codigosDoLead };
