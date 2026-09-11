'use strict';
// Documentos do pedido — o fluxo pós-pagamento desenhado na presencial de 09/09, que o
// Ítalo chamou de "a nossa Bíblia".
//
// O que existe, e a ordem em que fecha:
//
//   PV (pedido de venda)   nasce quando o dinheiro entra
//   PC (pedido de compra)  nasce quando o agente de compras pede a licença ao fornecedor
//   FIN (financeiro)       corre EM PARALELO, nos 45 dias de fatura do fornecedor
//
// A regra que é fácil errar, e por isso está num lugar só:
//   - o PC fecha ANTES do PV, porque é ele que traz a chave de volta para o ciclo de vendas
//   - o PV só fecha quando o e-mail com CHAVE + BOOK sai para o cliente. Antes disso o
//     pedido continua aberto, mesmo já pago — foi o ponto que o Ítalo mais bateu:
//     "enquanto o PV não gerar o e-mail com o book mais a licença, ele não vira close"
//   - o FIN só fecha quando a fatura do fornecedor é paga E o comprovante volta para ele
const store = require('./store');
const docnum = require('./docnum');

const TIPOS = ['PV', 'PC', 'FIN'];
const ABERTO = 'open';
const FECHADO = 'close';

function doLead(leadId) {
  return store.find('documents', d => d.lead_id === Number(leadId));
}

function achar(leadId, tipo) {
  const t = String(tipo).toUpperCase();
  return store.findOne('documents', d => d.lead_id === Number(leadId) && d.tipo === t);
}

// Abrir é idempotente de propósito: o webhook de pagamento do Stripe pode chegar duas
// vezes, e o agente de compras pode ser acionado de novo depois de uma falha. Dois PVs
// para o mesmo pedido seriam dois pedidos na conta do cliente.
function abrir(leadId, tipo, extra) {
  const t = String(tipo).toUpperCase();
  if (!TIPOS.includes(t)) throw new Error('Tipo de documento inválido: ' + tipo);
  const existente = achar(leadId, t);
  if (existente) return existente;

  const lead = store.get('leads', leadId);
  if (!lead) throw new Error('Documento sem lead: ' + leadId);
  if (!lead.doc_seq) throw new Error('Lead #' + leadId + ' não tem número — abra a oportunidade antes');

  return store.insert('documents', Object.assign({
    lead_id: Number(leadId),
    tipo: t,
    seq: Number(lead.doc_seq),
    sku: lead.doc_sku || null,
    codigo: docnum.formatar(t, lead.doc_seq, lead.doc_sku),
    status: ABERTO,
    closed_at: null,
    motivo: null,
  }, extra || {}));
}

// Fechar devolve o que aconteceu em vez de lançar: quem chama precisa saber se o pedido
// ficou de pé porque uma regra barrou, e isso não é erro de programação — é o processo.
// `entrega` só é exigida no PV: { chave, book } — a prova de que o cliente recebeu.
// Um texto livre qualquer NÃO serve como prova; era assim antes e deixava fechar o PV
// com "pagamento confirmado", o que marcaria como entregue um pedido sem chave nenhuma.
function fechar(leadId, tipo, motivo, entrega) {
  const t = String(tipo).toUpperCase();
  if (!TIPOS.includes(t)) return { ok: false, razao: 'tipo de documento inválido' };
  // Documento órfão (lead apagado) não pode continuar mudando de estado em silêncio.
  if (!store.get('leads', leadId)) return { ok: false, razao: 'lead inexistente' };

  const doc = achar(leadId, t);
  if (!doc) return { ok: false, razao: 'documento inexistente' };
  if (doc.status === FECHADO) return { ok: true, doc, jaEstava: true };

  if (t === 'PV') {
    // A regra central do desenho de 09/09. Sem isto, um pedido pago apareceria concluído
    // com o cliente ainda sem a chave na mão.
    const pc = achar(leadId, 'PC');
    if (pc && pc.status !== FECHADO) {
      return { ok: false, razao: 'o pedido de compra ainda está aberto — a chave não voltou do fornecedor' };
    }
    const e = entrega || {};
    if (!String(e.chave || '').trim()) {
      return { ok: false, razao: 'o PV só fecha com a chave de licença registrada' };
    }
    if (!e.book) {
      return { ok: false, razao: 'o PV só fecha com o book de instalação enviado junto da chave' };
    }
  }

  const atualizado = store.update('documents', doc.id, {
    status: FECHADO, closed_at: store.now(), motivo: motivo || null,
    // Guarda a PROVA, não a chave: o valor da licença não fica repetido no histórico.
    entrega: t === 'PV' ? { chave_registrada: true, book: true, em: store.now() } : null,
  });
  return { ok: true, doc: atualizado };
}

// Um pedido está concluído quando PV e PC fecharam. O FIN corre por fora: a Nexxus já
// entregou ao cliente antes de pagar a fatura do fornecedor, e é assim mesmo.
function entregue(leadId) {
  const pv = achar(leadId, 'PV');
  return !!(pv && pv.status === FECHADO);
}

// Para a tela: o verde/vermelho que o Ítalo pediu ao lado de cada documento.
function resumo(leadId) {
  const docs = doLead(leadId);
  if (!docs.length) return null;
  return docs
    .sort((a, b) => TIPOS.indexOf(a.tipo) - TIPOS.indexOf(b.tipo))
    .map(d => ({
      tipo: d.tipo, codigo: d.codigo, status: d.status,
      aberto: d.status === ABERTO,
      closed_at: d.closed_at, motivo: d.motivo,
    }));
}

module.exports = { TIPOS, ABERTO, FECHADO, doLead, achar, abrir, fechar, entregue, resumo };
