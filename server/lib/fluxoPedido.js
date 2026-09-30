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
const mailer = require('./mailer');
const { ehCaixaPropria } = require('./caixasProprias');

// Três posições (29/09):
//   off   — o padrão. Tudo vira rascunho na timeline, nada sai.
//   teste — os e-mails saem de verdade, mas SÓ para os endereços de FLUXO_EMAIL_PERMITIDOS
//           (e para as nossas próprias caixas). Destinatário fora da lista vira rascunho.
//           É o modo de ensaiar o fluxo em produção com o Ítalo no papel de fabricante sem
//           arriscar um pedido de compra chegando a um fornecedor de verdade.
//   on    — sai para quem o pedido mandar.
function modo() {
  const v = String(process.env.FLUXO_POS_PAGAMENTO || '').trim().toLowerCase();
  return v === 'on' || v === 'teste' ? v : 'off';
}

function ligado() {
  return modo() !== 'off';
}

function enderecoDe(texto) {
  const m = String(texto || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(texto || '')).trim().toLowerCase();
}

function permitidosNoTeste() {
  return String(process.env.FLUXO_EMAIL_PERMITIDOS || '')
    .split(',').map(enderecoDe).filter(e => e.includes('@'));
}

// Pode sair e-mail para este endereço agora? Devolve o motivo quando não pode — é esse
// texto que vai para a timeline, para ninguém achar que o fornecedor já foi cobrado.
function motivoParaNaoEnviar(para) {
  const m = modo();
  if (m === 'off') return 'FLUXO_POS_PAGAMENTO desligado';
  const alvo = enderecoDe(para);
  if (!alvo.includes('@')) return 'sem endereço de e-mail';
  if (m === 'teste' && !ehCaixaPropria(alvo) && !permitidosNoTeste().includes(alvo)) {
    return `modo teste: ${alvo} não está em FLUXO_EMAIL_PERMITIDOS`;
  }
  return null;
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

// Os produtos do pedido. Carrinho com dois produtos = um OP e dois PV (09/09): o lead é a
// oportunidade, e cada item ganha o próprio PV e o próprio PC, com o SKU no sufixo.
// Lead antigo (ou pedido de um produto só sem a lista) vira um item só, montado dos campos
// do próprio lead — é o comportamento de antes, intacto.
function itensDoLead(lead) {
  if (!lead) return [];
  if (Array.isArray(lead.itens) && lead.itens.length) {
    return lead.itens.map(i => ({
      sku: docnum.normalizaSku(i.sku) || null,
      product_id: i.product_id || null,
      qty: Number(i.qty || 1),
      nome: i.nome || null,
    }));
  }
  return [{ sku: lead.doc_sku || null, product_id: lead.product_id || null,
    qty: Number(lead.qty || 1), nome: lead.requested_software || null }];
}

function itemPorSku(lead, sku) {
  const s = docnum.normalizaSku(sku) || null;
  return itensDoLead(lead).find(i => i.sku === s) || null;
}

function produtoEFornecedor(item) {
  const produto = item && item.product_id ? store.get('products', item.product_id) : null;
  const fornecedor = produto && produto.supplier_id ? store.get('suppliers', produto.supplier_id) : null;
  return { produto, fornecedor };
}

// Etapa 6: o double-check. É a razão de o compras não falar direto com o cliente.
// Divergência NÃO entrega e NÃO fecha nada: para e chama gente.
// `item` é o produto do carrinho que está sendo conferido; omitido, vale o do lead.
function conferir(lead, recebido, item) {
  const problemas = [];
  const it = item || itensDoLead(lead)[0] || {};
  const pedido = { qty: Number(it.qty || 0), produto: it.sku || null, seq: Number(lead.doc_seq || 0) };
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
function textoPedidoDeCompra(lead, produto, fornecedor, item) {
  const it = item || itensDoLead(lead)[0] || {};
  const seq = Number(lead && lead.doc_seq);
  const pc = Number.isInteger(seq) && seq > 0 ? docnum.formatar('PC', seq, it.sku) : '(sem número)';
  const nomeProduto = (produto && produto.name) || it.nome || lead.requested_software || 'licença';
  const qtd = Number(it.qty || 1);
  // O fornecedor precisa saber para ONDE mandar a fatura: é a caixa do financeiro (Fred),
  // que o CRM também lê e onde a fatura abre o NXT-FIN.
  const financeiro = caixaDe('financeiro');
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
    financeiro ? `  • a fatura, para o nosso financeiro: ${financeiro}` : `  • a fatura, para o nosso e-mail financeiro.`,
    ``,
    `Por favor, cite o número ${pc} na resposta — é por ele que conciliamos o pedido.`,
    ``,
    `Obrigado,`,
    `Nexxus Tech`,
  ].join('\n');
  return { assunto, corpo, codigo: pc };
}

function contatoDoLead(lead) {
  const ct = lead && lead.contact_id ? store.get('contacts', lead.contact_id) : null;
  return { nome: (ct && ct.name) || null, email: (ct && ct.email) || null };
}

function codigosDoPedido(lead) {
  const seq = Number(lead && lead.doc_seq);
  const ok = Number.isInteger(seq) && seq > 0;
  return {
    op: ok ? docnum.formatar('OP', seq) : `lead #${lead && lead.id}`,
    pvs: ok ? itensDoLead(lead).map(i => docnum.formatar('PV', seq, i.sku)) : [],
  };
}

// Etapa 2 — o aviso instantâneo ao cliente (pendência M45): "isso aí tem que ser instantâneo".
function textoAvisoCliente(lead) {
  const { nome } = contatoDoLead(lead);
  const { pvs } = codigosDoPedido(lead);
  const ref = pvs.join(', ') || codigosDoPedido(lead).op;
  const produtos = itensDoLead(lead).map(i => `  • ${i.qty}x ${i.nome || i.sku || 'licença'}`).join('\n');
  return {
    assunto: `Pagamento confirmado — pedido ${ref}`,
    corpo: [
      `Olá${nome ? ', ' + nome : ''},`,
      ``,
      `Recebemos o seu pagamento. Obrigado pela compra!`,
      ``,
      `Já estamos gerando a sua licença junto ao fabricante:`,
      produtos,
      ``,
      `Assim que ela chegar, enviamos a chave e o guia de instalação neste mesmo e-mail.`,
      `Número do seu pedido: ${ref} — se precisar falar com a gente, é só responder citando esse número.`,
    ].join('\n'),
  };
}

// Etapa 3 — vendas passa o pedido para compras. É e-mail interno entre as caixas dos
// agentes: fica o rastro no Outlook, e a leitura das caixas ignora remetente próprio.
function textoVendasParaCompras(lead) {
  const { op, pvs } = codigosDoPedido(lead);
  const { nome, email } = contatoDoLead(lead);
  const produtos = itensDoLead(lead).map(i => `  • ${i.qty}x ${i.nome || i.sku || 'licença'}${i.sku ? ' (' + i.sku + ')' : ''}`).join('\n');
  return {
    assunto: `Pedido pago ${pvs.join(', ') || op} — solicitar licença ao fabricante`,
    corpo: [
      `Compras,`,
      ``,
      `Pagamento confirmado para ${nome || 'o cliente'}${email ? ' (' + email + ')' : ''}. Favor solicitar a licença:`,
      produtos,
      ``,
      `Oportunidade: ${op}`,
      `Pedido(s) de venda: ${pvs.join(', ') || '—'}`,
      ``,
      `Vendas`,
    ].join('\n'),
  };
}

// Etapa 6 → 7 — compras devolve para vendas. A chave NÃO vai neste e-mail: ela já está
// registrada no CRM, e cada cópia a mais é uma cópia a mais de uma licença paga.
function textoComprasParaVendas(lead, pc) {
  return {
    assunto: `Licença conferida — ${pc.codigo}`,
    corpo: [
      `Vendas,`,
      ``,
      `O fabricante devolveu a licença do pedido ${pc.codigo}. Conferi quantidade, produto e número do pedido: está tudo certo.`,
      `A chave está registrada no CRM. Pode entregar ao cliente.`,
      ``,
      `Compras`,
    ].join('\n'),
  };
}

// Etapa 7 — a entrega. Com o link do book no produto, o e-mail leva os dois; sem ele, leva
// só a chave e o PV continua aberto (a regra de 09/09: PV fecha com chave + book).
function textoEntregaCliente(lead, pc, chave, produto) {
  const { nome } = contatoDoLead(lead);
  const pv = docnum.formatar('PV', lead.doc_seq, pc.sku);
  const nomeProduto = (produto && produto.name) || 'seu software';
  const book = produto && produto.book_url ? String(produto.book_url) : null;
  return {
    assunto: `Sua licença — pedido ${pv}`,
    book,
    corpo: [
      `Olá${nome ? ', ' + nome : ''},`,
      ``,
      `Sua licença de ${nomeProduto} chegou:`,
      ``,
      `Chave de licença: ${chave}`,
      ``,
      book ? `Guia de instalação: ${book}` : `O guia de instalação segue em um próximo e-mail.`,
      ``,
      `Número do pedido: ${pv}. Qualquer dúvida, é só responder este e-mail.`,
    ].join('\n'),
  };
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
    return { ok: true, repetido: true, pv: documentos.achar(leadId, 'PV'), pc: documentos.achar(leadId, 'PC'),
      pvs: documentos.doTipo(leadId, 'PV'), pcs: documentos.doTipo(leadId, 'PC') };
  }

  // Um PV por produto, todos no mesmo instante: o dinheiro entrou pelo carrinho inteiro.
  const itens = itensDoLead(lead);
  const pvs = itens.map(it => documentos.abrir(leadId, 'PV', null, it.sku));
  registrar(deps, leadId, 'pagamento_ok', pvs.map(d => d.codigo).join(', '));
  // Um PC por produto: cada um pode ir para um fornecedor diferente, e a resposta de cada
  // fornecedor fecha só o PC dele (é pelo código com o SKU que ela é casada na volta).
  const pcs = itens.map(it => documentos.abrir(leadId, 'PC', null, it.sku));
  const emails = itens.map((it, i) => {
    const { produto, fornecedor } = produtoEFornecedor(it);
    return Object.assign(textoPedidoDeCompra(lead, produto, fornecedor, it), { fornecedor, pc: pcs[i] });
  });

  if (!ligado()) {
    // Fail-closed: sem o freio ligado o pedido de compra fica escrito e visível, esperando
    // um humano. É melhor o pedido parar aqui do que sair sozinho para o fornecedor.
    registrar(deps, leadId, 'vendas_avisa', 'rascunho — aguardando liberação do fluxo');
    registrar(deps, leadId, 'vendas_compras');
    for (const email of emails) {
      const { fornecedor, pc } = email;
      const semFornecedor = fornecedor ? '' : ' ATENÇÃO: produto sem fornecedor cadastrado — cadastre antes de enviar, senão a resposta não será reconhecida.';
      registrar(deps, leadId, 'compras_pede', `${pc.codigo} — RASCUNHO, não enviado (FLUXO_POS_PAGAMENTO desligado)`);
      deps.log(leadId, null, 'email_rascunho', `Para o fornecedor${fornecedor ? ' (' + fornecedor.name + ')' : ''} — ${email.assunto}\n\n${email.corpo}`);
      deps.notify('fluxo_rascunho', `Pedido de compra ${pc.codigo} pronto para revisão — nada foi enviado ao fornecedor.${semFornecedor}`, leadId);
    }
    return { ok: true, pv: pvs[0], pc: pcs[0], email: emails[0], pvs, pcs, emails, envios: [], enviado: false, liberado: false };
  }

  // Freio ligado (teste ou on): as etapas 2, 3 e 4 viram e-mails de verdade. Aqui só se
  // MONTA a lista — quem envia é despachar(), que é assíncrona e registra cada etapa só
  // depois de saber se o e-mail saiu.
  const { email: emailCliente } = contatoDoLead(lead);
  const aviso = textoAvisoCliente(lead);
  const interno = textoVendasParaCompras(lead);
  const envios = [
    { etapa: 'vendas_avisa', area: 'vendas', para: emailCliente, destino: 'cliente', assunto: aviso.assunto, corpo: aviso.corpo },
    { etapa: 'vendas_compras', area: 'vendas', para: caixaDe('compras'), destino: 'compras', assunto: interno.assunto, corpo: interno.corpo,
      semEndereco: 'a caixa de compras (EMAIL_FROM_COMPRAS) não está configurada' },
  ].concat(emails.map(e => ({
    etapa: 'compras_pede', area: 'compras', para: e.fornecedor && e.fornecedor.email ? e.fornecedor.email : null,
    destino: 'fornecedor' + (e.fornecedor ? ' (' + e.fornecedor.name + ')' : ''), assunto: e.assunto, corpo: e.corpo,
    codigo: e.pc.codigo,
    semEndereco: e.fornecedor ? `fornecedor ${e.fornecedor.name} sem e-mail cadastrado` : 'produto sem fornecedor cadastrado',
  })));
  return { ok: true, pv: pvs[0], pc: pcs[0], email: emails[0], pvs, pcs, emails, envios: enfileirar(leadId, envios), enviado: false, liberado: true };
}


// Endereço da caixa própria de uma área — só quando ela existe de verdade. Sem a caixa
// @compras, o e-mail "vendas → compras" iria para o remetente genérico, que é a própria
// caixa de vendas falando com ela mesma: melhor não mandar e dizer por quê.
function caixaDe(area) {
  const c = mailer.caixasConfiguradas()[area];
  return c && c.propria ? enderecoDe(c.endereco) : null;
}

function escapaHtml(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// Quebra de linha vira <br> de verdade: o Outlook ignora o white-space:pre-wrap e emendava
// o e-mail inteiro num parágrafo só (visto no ensaio de 29/09).
function paraHtml(texto) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">${escapaHtml(texto).replace(/\r?\n/g, '<br>')}</div>`;
}

// ---- A fila de e-mails do fluxo ----
//
// Cada e-mail vira um registro em `fluxo_envios` ANTES de sair, no mesmo passo síncrono
// que abre PV/PC. O motivo: o Render reinicia o servidor a cada deploy, e um envio que só
// existisse na memória sumiria em silêncio — com o `jaRodou` impedindo refazer, o pedido
// de compra nunca sairia e ninguém saberia (achado da revisão de 29/09).
//
// Estados: pendente → enviando → enviado | rascunho. Quem fica em `enviando` quando o
// servidor cai NÃO é reenviado sozinho (pode já ter saído): vira rascunho com aviso, e uma
// pessoa confere a caixa de enviados antes de mandar de novo pelo botão.
const FILA = 'fluxo_envios';

function enfileirar(leadId, envios) {
  return (envios || []).map(e => store.insert(FILA, Object.assign({}, e, {
    lead_id: Number(leadId), status: 'pendente', motivo: null, message_id: null, tentativas: 0,
  })));
}

function doLead(leadId, status) {
  return store.find(FILA, r => r.lead_id === Number(leadId) && (!status || r.status === status))
    .sort((a, b) => a.id - b.id);
}

/**
 * Envia, em ordem, os registros da fila, e só então registra cada etapa.
 *
 * Um e-mail que não pode sair (freio, lista do modo teste, sem endereço, sem book) ou que
 * o provedor recusa vira RASCUNHO + aviso no sino, e a etapa é registrada dizendo isso. O
 * laço não para: o aviso ao cliente não ter saído não é motivo para o fornecedor não ser
 * cobrado.
 *
 * deps: { log, notify, logEmailOut(leadId, to, assunto, corpo, messageId), enviar(opts) }
 */
async function despachar(deps, leadId, registros) {
  const resultado = [];
  for (const reg of registros || []) {
    const e = store.get(FILA, reg.id);
    if (!e || e.status !== 'pendente') continue;   // outro despacho já pegou este
    // A entrega é montada na hora: a chave vem do PC (não fica copiada na fila) e o book
    // pode ter sido cadastrado depois de o e-mail ter virado rascunho.
    const pronto = e.tipo === 'entrega' ? montarEntrega(e) : { envio: e };
    const env = pronto.envio;
    const motivo = pronto.motivo || (env.para ? motivoParaNaoEnviar(env.para) : (env.semEndereco || 'sem endereço de e-mail'));
    let r = null;
    if (!motivo) {
      store.update(FILA, e.id, { status: 'enviando', tentativas: (e.tentativas || 0) + 1 });
      try {
        r = await deps.enviar({ to: enderecoDe(env.para), subject: env.assunto, html: paraHtml(env.corpo), area: env.area });
      } catch (err) {
        r = { sent: false, reason: err.message };
      }
    }
    const saiu = !!(r && r.sent);
    const corpoLog = env.ocultarNoLog || env.corpo;
    if (saiu) {
      store.update(FILA, e.id, { status: 'enviado', motivo: null, message_id: r.id || null, enviado_em: store.now() });
      deps.logEmailOut(leadId, enderecoDe(env.para), env.assunto, corpoLog, r.id || null);
      if (e.tipo === 'entrega') aoEntregar(deps, leadId, e, env, r);
      else registrar(deps, leadId, e.etapa, `e-mail enviado para ${e.destino} (${enderecoDe(env.para)})`);
    } else {
      const porque = motivo || `o envio falhou (${(r && (r.reason || r.status)) || 'sem resposta do provedor'})`;
      store.update(FILA, e.id, { status: 'rascunho', motivo: porque });
      registrar(deps, leadId, e.etapa, `RASCUNHO, não enviado — ${porque}`);
      deps.log(leadId, null, 'email_rascunho', `Para ${e.destino}${env.para ? ' <' + enderecoDe(env.para) + '>' : ''} — ${env.assunto}\n\n${corpoLog}`);
      deps.notify(motivo ? 'fluxo_rascunho' : 'fluxo_falha_envio',
        `${e.codigo ? e.codigo + ': ' : ''}e-mail para ${e.destino} não saiu — ${porque}. Está como rascunho; depois de corrigir, use "Reenviar e-mails do fluxo" no card.`, leadId);
    }
    resultado.push({ etapa: e.etapa, destino: e.destino, enviado: saiu, motivo: saiu ? null : (motivo || 'falha no envio') });
  }
  return resultado;
}

// Etapa 7 montada na hora do envio.
function montarEntrega(e) {
  const lead = store.get('leads', e.lead_id);
  const pc = lead ? documentos.achar(e.lead_id, 'PC', e.pc_sku || null) : null;
  const chave = pc && pc.chave_licenca;
  if (!lead || !pc || !chave) return { envio: e, motivo: 'a chave de licença não está registrada no pedido de compra' };
  const item = itemPorSku(lead, pc.sku) || itensDoLead(lead)[0];
  const { produto } = produtoEFornecedor(item);
  const carta = textoEntregaCliente(lead, pc, chave, produto);
  const envio = Object.assign({}, e, { assunto: carta.assunto, corpo: carta.corpo,
    ocultarNoLog: carta.corpo.split(chave).join('[chave registrada — oculta no histórico]'), book: carta.book });
  // Sem o book o PV não fecha (regra de 09/09). Mandar a chave sozinha deixaria o pedido
  // aberto para sempre: não existe caminho que mande o book depois. Segura e pede o link.
  if (!carta.book) {
    return { envio, motivo: `o produto ${(produto && produto.name) || pc.sku || ''} está sem o link do book de instalação — cadastre em Catálogo & Regras` };
  }
  return { envio };
}

function aoEntregar(deps, leadId, e, env, r) {
  const pc = documentos.achar(leadId, 'PC', e.pc_sku || null);
  const fechou = documentos.fechar(leadId, 'PV', 'chave e book entregues ao cliente',
    { chave: pc && pc.chave_licenca, book: !!env.book, messageId: r.id || '' }, e.pc_sku || null);
  if (fechou.ok) {
    registrar(deps, leadId, 'vendas_entrega', `e-mail enviado para ${enderecoDe(env.para)}`);
    deps.notify('pedido_entregue', `Pedido ${fechou.doc.codigo} entregue ao cliente — ciclo de venda fechado.`, leadId);
  } else {
    deps.log(leadId, null, 'fluxo', `[vendas] Chave enviada ao cliente (${enderecoDe(env.para)}), mas o pedido de venda continua ABERTO: ${fechou.razao}.`);
    deps.notify('fluxo_entrega', `Pedido ${e.codigo || ''}: chave entregue, pedido de venda ainda aberto — ${fechou.razao}.`, leadId);
  }
}

// Ao subir o servidor: o que ficou `pendente` sai agora; o que ficou `enviando` vira
// rascunho com aviso (pode ter saído — reenviar às cegas mandaria duas vezes).
function retomarPendentes(deps) {
  const interrompidos = store.find(FILA, r => r.status === 'enviando');
  for (const r of interrompidos) {
    const porque = 'o servidor reiniciou no meio do envio — pode ter saído; confira a caixa de enviados antes de reenviar';
    store.update(FILA, r.id, { status: 'rascunho', motivo: porque });
    deps.log(r.lead_id, null, 'fluxo', `[${(etapa(r.etapa) || {}).agente || 'sistema'}] E-mail para ${r.destino} interrompido: ${porque}.`);
    deps.notify('fluxo_falha_envio', `E-mail do fluxo para ${r.destino} interrompido — ${porque}.`, r.lead_id);
  }
  const pendentes = store.find(FILA, r => r.status === 'pendente');
  const porLead = {};
  for (const r of pendentes) (porLead[r.lead_id] = porLead[r.lead_id] || []).push(r);
  return Object.entries(porLead).map(([leadId, regs]) => ({ leadId: Number(leadId), registros: regs.sort((a, b) => a.id - b.id) }));
}

// Botão "Reenviar e-mails do fluxo": o que virou rascunho volta para a fila. Depois de
// cadastrar o e-mail do fornecedor, o book, ou de trocar o freio de teste para on.
function paraReenviar(leadId) {
  const rascunhos = doLead(leadId, 'rascunho');
  for (const r of rascunhos) store.update(FILA, r.id, { status: 'pendente' });
  return rascunhos;
}


// ---- Etapas 5 a 7: a volta do fornecedor ----

// Tira a chave de licença do corpo do e-mail. Deliberadamente CONSERVADOR: só aceita o
// que estiver rotulado ("chave: XXX", "license key: XXX"). Um e-mail de fornecedor tem
// número de nota, CNPJ e código de produto no meio do texto — adivinhar qual deles é a
// licença entregaria lixo ao cliente.
//
// Três coisas que a revisão mostrou serem obrigatórias aqui, todas com o mesmo motivo —
// chave errada é pior que chave nenhuma, porque vira e-mail entregue ao cliente com uma
// licença que não ativa:
//   - o último caractere tem que ser alfanumérico, senão a pontuação da frase entra junto
//   - a captura não pode parar no primeiro espaço ou quebra de linha: chave partida em
//     duas linhas ou com marcação HTML no meio virava metade da chave
//   - duas chaves no mesmo e-mail ("key: VELHA (cancelada). Replacement key: NOVA") NÃO
//     podem ser resolvidas no chute: viram ambiguidade
const RE_ROTULO = /(?:chave(?:\s+de\s+licen[çc]a)?|licen[çc]a|license\s*key|serial|activation\s*key)\s*[:\-–]\s*/gi;

// Limpa marcação e junta o que a formatação partiu, antes de procurar a chave.
function normalizaCorpo(texto) {
  return String(texto || '')
    .replace(/<[^>]+>/g, '')           // marcação HTML no meio da chave
    .replace(/&nbsp;/gi, ' ')
    .replace(/\r/g, '');
}

// Um candidato é a sequência de caracteres de chave logo depois do rótulo, aceitando que
// ela venha quebrada por espaço ou fim de linha — desde que os pedaços sejam claramente
// parte da chave (blocos alfanuméricos separados por espaço único ou quebra simples).
// Um pedaço só continua a chave se ele PARECE chave: maiúsculas e dígitos, nada de
// palavra comum. Sem esse filtro, "chave: ABC-123. Abraços" engolia a despedida.
const PEDACO_DE_CHAVE = /^[A-Z0-9][A-Z0-9\-_]{1,}$/;

function candidatosDeChave(texto) {
  const limpo = normalizaCorpo(texto);
  const achados = [];
  RE_ROTULO.lastIndex = 0;
  let m;
  while ((m = RE_ROTULO.exec(limpo)) !== null) {
    const resto = limpo.slice(m.index + m[0].length);
    const pedacos = resto.split(/[ \n]+/);
    const partes = [];
    for (let i = 0; i < pedacos.length; i++) {
      const cru = pedacos[i];
      const limpoPedaco = cru.replace(/[^A-Za-z0-9\-_.]+$/, '');   // tira pontuação de frase
      if (i === 0) {
        if (!/^[A-Za-z0-9]/.test(limpoPedaco)) break;
        partes.push(limpoPedaco);
        // A chave continua na próxima linha só quando esta terminou pendurada num hífen.
        if (!/[-_]$/.test(limpoPedaco)) {
          // sem hífen pendurado, ainda pode haver bloco seguinte em caixa alta (chave em
          // grupos: "ABCD 1234 EFGH"); o filtro abaixo decide.
        }
        continue;
      }
      // Um código nosso (NXT-PC-0042-AMPLER) logo abaixo da chave é CITAÇÃO do pedido, não
      // continuação da chave — colado, virava "AAAA-1234NXT-PC-0042-AMPLER" e ia ao cliente.
      if (docnum.extrair(limpoPedaco)) break;
      if (PEDACO_DE_CHAVE.test(limpoPedaco)) partes.push(limpoPedaco);
      else break;
    }
    const chave = partes.join('').replace(/[.\-_]+$/, '');
    if (chave.length >= 6) achados.push(chave);
  }
  return [...new Set(achados)];
}

function extrairChave(texto) {
  const c = candidatosDeChave(texto);
  return c.length === 1 ? c[0] : null;   // zero ou ambíguo = null, e null vira divergência
}

// A fatura vem no mesmo e-mail ou em outro, para o financeiro. Serve para abrir o NXT-FIN.
const SINAL_FATURA = /(fatura|invoice|nota\s*fiscal|boleto|cobran[çc]a)/i;
// Rodapé jurídico é a armadilha: "esta mensagem não constitui fatura nem cobrança" abria
// um ciclo financeiro do nada. Frase negada não conta.
const NEGACAO_FATURA = /\b(n[ãa]o\s+(?:[a-zçãéêíóú]+\s+){0,3}(?:constitui|[ée]|ser[áa]|representa|vale\s+como)|sem)\s+(?:uma\s+)?(?:fatura|invoice|nota\s*fiscal|boleto|cobran[çc]a)/i;

// Só o que o fornecedor escreveu, sem o nosso e-mail citado embaixo. No ensaio de 29/09 a
// resposta do Ítalo trazia o pedido de compra inteiro citado ("…a fatura, para o nosso
// e-mail financeiro"), e isso abriu um NXT-FIN sem fatura nenhuma. O código NXT-PC da
// citação continua valendo para casar o pedido — isso é feito antes, no texto inteiro.
const INICIO_CITACAO = [
  /^_{5,}\s*$/m,                                                      // separador do Outlook
  /^-{2,}\s*(?:original message|mensagem original|forwarded message|mensagem encaminhada)/im,
  /^\s*(?:de|from)\s*:[^\n]*\n(?:[^\n]*\n){0,3}?\s*(?:enviad[oa](?: em)?|sent|data|date)\s*:/im,
  /^\s*(?:em|on)\b[^\n]{0,200}(?:escreveu|wrote)\s*:?\s*$/im,
];
function semCitacao(texto) {
  let t = normalizaCorpo(texto);
  let corte = t.length;
  for (const re of INICIO_CITACAO) {
    const m = t.match(re);
    if (m && m.index < corte) corte = m.index;
  }
  t = t.slice(0, corte);
  return t.split('\n').filter(l => !/^\s*>/.test(l)).join('\n');
}

function pareceFatura(texto) {
  if (!texto) return false;
  const t = normalizaCorpo(texto);
  if (NEGACAO_FATURA.test(t)) return false;
  return SINAL_FATURA.test(t);
}

/**
 * O remetente é mesmo o fornecedor deste pedido?
 *
 * Sem esta conferência, QUALQUER pessoa com um domínio próprio e SPF/DKIM em ordem podia
 * mandar "NXT-PC-0042 — license key: FALSA", e o CRM fecharia o pedido de compra e
 * mandaria a chave falsa para o cliente. Autenticação de e-mail prova de onde a mensagem
 * saiu, não que quem mandou é o nosso fornecedor.
 *
 * Fail-closed: fornecedor sem e-mail/domínio cadastrado NÃO tem resposta aceita. Melhor o
 * e-mail cair no caminho normal (um humano lê) do que fechar pedido no escuro.
 */
function remetenteEhDoFornecedor(lead, from, item) {
  const remetente = String(from || '').trim().toLowerCase();
  if (!remetente.includes('@')) return { ok: false, razao: 'remetente inválido' };
  const dominio = remetente.split('@').pop();

  // No carrinho com dois produtos, o fornecedor que vale é o do produto deste PC.
  const { fornecedor } = produtoEFornecedor(item || itensDoLead(lead)[0]);
  if (!fornecedor) return { ok: false, razao: 'pedido sem fornecedor cadastrado' };

  const permitidos = []
    .concat(fornecedor.email ? [String(fornecedor.email).toLowerCase()] : [])
    .concat(fornecedor.dominio ? [String(fornecedor.dominio).toLowerCase()] : [])
    .concat(fornecedor.domain ? [String(fornecedor.domain).toLowerCase()] : []);
  if (!permitidos.length) {
    return { ok: false, razao: `fornecedor ${fornecedor.name} está sem e-mail/domínio cadastrado` };
  }

  const bate = permitidos.some(p => {
    const alvo = p.replace(/^@/, '');
    return remetente === alvo || dominio === alvo || dominio.endsWith('.' + alvo);
  });
  return bate ? { ok: true, fornecedor } : { ok: false, razao: `remetente ${remetente} não é do fornecedor ${fornecedor.name}` };
}

// Acha o PC aberto que um e-mail de fornecedor está respondendo.
//   sku citado  → o PC aberto daquele produto (ou nada, se não houver)
//   sem sku     → só serve se houver exatamente UM PC aberto no lead
//   dois ou mais SKUs citados → ambíguo, SEMPRE — mesmo que só um PC ainda esteja aberto:
//                               a chave pode ser do produto cujo PC já fechou
function escolherPC(leadId, sku, skus) {
  const abertos = documentos.doTipo(leadId, 'PC').filter(d => d.status === documentos.ABERTO);
  if (!documentos.doTipo(leadId, 'PC').length) return { pc: null, razao: 'não há pedido de compra para este lead' };
  const citados = [...new Set([].concat(skus || [], sku ? [sku] : []).map(x => docnum.normalizaSku(x)).filter(Boolean))];
  if (citados.length > 1) {
    return { pc: null, ambiguo: true, razao: `o e-mail cita ${citados.length} produtos (${citados.join(', ')}) — não dá para saber de qual é a chave` };
  }
  const s = citados[0] || '';
  if (s) {
    const pc = abertos.find(d => (d.sku || '') === s);
    return pc ? { pc } : { pc: null, razao: `não há pedido de compra aberto do produto ${s}` };
  }
  if (abertos.length === 1) return { pc: abertos[0] };
  if (!abertos.length) return { pc: null, razao: 'nenhum pedido de compra aberto' };
  return { pc: null, ambiguo: true,
    razao: `há ${abertos.length} pedidos de compra abertos (${abertos.map(d => d.codigo).join(', ')}) e o e-mail não cita o código com o produto` };
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

  // Qual PC o e-mail responde. Com um produto só não há dúvida. Com dois, o e-mail tem que
  // citar o código COM o SKU (NXT-PC-0042-AMPLER): adivinhar entregaria a chave do Ampler
  // no PV do 1Password.
  const escolha = escolherPC(leadId, entrada && entrada.sku, entrada && entrada.skus);
  if (!escolha.pc) {
    // Resposta de fornecedor que não encaixa em nenhum PC aberto não pode sumir em silêncio:
    // pode ser a chave que o cliente está esperando.
    const op = lead.doc_seq ? docnum.formatar('OP', lead.doc_seq) : `lead #${leadId}`;
    deps.log(leadId, null, 'fluxo', `[compras] E-mail do fornecedor não foi casado com um pedido de compra (${escolha.razao}). Nada foi fechado.`);
    deps.notify('fluxo_divergencia', `Resposta de fornecedor no pedido ${op} não foi casada — ${escolha.razao}. Confira à mão.`, leadId);
    return { ok: false, razao: escolha.razao, ambiguo: !!escolha.ambiguo };
  }
  const pc = escolha.pc;
  const item = itemPorSku(lead, pc.sku) || itensDoLead(lead)[0];

  // Só o fornecedor deste pedido fecha este pedido.
  const quem = remetenteEhDoFornecedor(lead, entrada && entrada.from, item);
  if (!quem.ok) {
    deps.log(leadId, null, 'fluxo', `[compras] E-mail citando ${pc.codigo} NÃO foi aceito como resposta do fornecedor: ${quem.razao}.`);
    deps.notify('fluxo_remetente', `E-mail citando ${pc.codigo} veio de remetente não reconhecido (${quem.razao}). Nada foi fechado — confira à mão.`, leadId);
    return { ok: false, razao: quem.razao, remetenteRecusado: true };
  }

  const texto = semCitacao((entrada && entrada.texto) || '');
  const chave = extrairChave(texto);

  // Sem chave, a frase da etapa ("devolveu a chave e a fatura") mentiria na timeline.
  if (chave) registrar(deps, leadId, 'fornecedor_devolve', 'chave recebida');
  else deps.log(leadId, null, 'fluxo', `[compras] O fornecedor respondeu ${pc.codigo} sem uma chave de licença reconhecível.`);

  // A fatura abre o ciclo financeiro, que corre por fora e não segura a entrega.
  if (pareceFatura(texto)) {
    const fin = documentos.abrir(leadId, 'FIN', null, pc.sku || null);
    deps.log(leadId, null, 'doc', `Ciclo financeiro ${fin.codigo} aberto — fatura do fornecedor recebida. Fecha quando for paga e o comprovante voltar.`);
  }

  // Fatura que chega antes da chave (a caixa do financeiro também é lida) não é
  // divergência: o FIN já foi aberto acima, e a chave ainda vai chegar.
  if (!chave && pareceFatura(texto)) {
    deps.log(leadId, null, 'fluxo', `[compras] Fatura de ${pc.codigo} recebida antes da chave — aguardando a chave do fornecedor.`);
    return { ok: false, razao: 'só a fatura, sem chave ainda', fatura: true, chave: null, envios: [] };
  }

  // Etapa 6: o double-check. Divergência PARA aqui e chama gente — não entrega, não fecha.
  const conferencia = conferir(lead, { chave, qty: entrada && entrada.qty, sku: (entrada && entrada.sku) || (entrada && entrada.skus && entrada.skus[0]), seq: entrada && entrada.seq }, item);
  if (!conferencia.ok) {
    deps.log(leadId, null, 'fluxo', `[compras] Conferência REPROVADA: ${conferencia.problemas.join('; ')}. Nada foi entregue ao cliente.`);
    deps.notify('fluxo_divergencia', `Pedido ${pc.codigo}: o que o fornecedor mandou não bate — ${conferencia.problemas.join('; ')}.`, leadId);
    // `pedirResposta`: quem chamou (api.js) põe a Cora para ler o e-mail e sugerir três
    // respostas ao fornecedor — o pedido não pode morrer aqui em silêncio.
    return { ok: false, razao: 'divergência na conferência', problemas: conferencia.problemas, chave: null,
      pedirResposta: true, pc, texto };
  }
  registrar(deps, leadId, 'compras_confere', 'quantidade, produto e número conferem');

  // A chave voltou e confere: o pedido de compra cumpriu o papel dele.
  // A chave fica guardada UMA vez, no próprio PC: é de lá que a entrega a lê na hora de
  // enviar (inclusive num reenvio depois de um deploy), sem cópia na fila de e-mails.
  const pcFechado = documentos.fechar(leadId, 'PC', 'chave recebida do fornecedor e conferida', null, pc.sku || null);
  if (pcFechado.ok && pcFechado.doc) store.update('documents', pcFechado.doc.id, { chave_licenca: chave });

  // Etapa 7: a entrega. O e-mail com chave + book é para o CLIENTE.
  const entrega = { assunto: `Sua licença — pedido ${docnum.formatar('PV', lead.doc_seq, pc.sku)}`, chave, sku: pc.sku || null };
  if (!ligado()) {
    deps.log(leadId, null, 'email_rascunho', `Para o cliente — ${entrega.assunto}\n\nChave de licença registrada. Falta anexar o book de instalação e enviar pela caixa @vendas.`);
    deps.notify('fluxo_entrega', `Pedido ${pc.codigo} conferido: chave pronta para ir ao cliente. Nada foi enviado (FLUXO_POS_PAGAMENTO desligado).`, leadId);
    return { ok: true, chave, entrega, envios: [], pvFechado: false, pc };
  }

  // Freio ligado: compras avisa vendas (interno) e vendas entrega ao cliente. A entrega é
  // montada na hora do envio (montarEntrega) e o PV só fecha com o id do provedor na mão.
  const interno = textoComprasParaVendas(lead, pc);
  const { email: emailCliente } = contatoDoLead(lead);
  const envios = enfileirar(leadId, [
    { etapa: 'compras_confere', area: 'compras', para: caixaDe('vendas'), destino: 'vendas', assunto: interno.assunto, corpo: interno.corpo,
      semEndereco: 'a caixa de vendas (EMAIL_FROM_VENDAS) não está configurada' },
    { etapa: 'vendas_entrega', tipo: 'entrega', pc_sku: pc.sku || null, area: 'vendas', para: emailCliente, destino: 'cliente',
      assunto: entrega.assunto, corpo: '', codigo: pc.codigo, semEndereco: 'o cliente não tem e-mail cadastrado' },
  ]);
  return { ok: true, chave, entrega, envios, pvFechado: false, pc };
}

/**
 * A entrega saiu de verdade: registra e fecha o PV. É o único caminho que fecha o pedido,
 * e exige a prova (chave + book) — pagar não é receber.
 */
// `sku` escolhe o PV no carrinho com dois produtos; omitido, é o PV do pedido de um produto.
function confirmarEntregaAoCliente(deps, leadId, prova, sku) {
  const r = documentos.fechar(leadId, 'PV', 'chave e book entregues ao cliente', prova, sku);
  if (!r.ok) return r;
  registrar(deps, leadId, 'vendas_entrega', 'chave e book enviados');
  deps.notify('pedido_entregue', `Pedido ${r.doc.codigo} entregue ao cliente — ciclo de venda fechado.`, leadId);
  return r;
}

module.exports = { ETAPAS, etapa, modo, ligado, motivoParaNaoEnviar, despachar, enfileirar, retomarPendentes, paraReenviar, registrar, itensDoLead, escolherPC, conferir, textoPedidoDeCompra, aoConfirmarPagamento,
  extrairChave, candidatosDeChave, pareceFatura, semCitacao, paraHtml, aoReceberDoFornecedor, confirmarEntregaAoCliente, remetenteEhDoFornecedor };
