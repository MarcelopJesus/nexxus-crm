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
    return { ok: true, repetido: true, pv: documentos.achar(leadId, 'PV'), pc: documentos.achar(leadId, 'PC'),
      pvs: documentos.doTipo(leadId, 'PV'), pcs: documentos.doTipo(leadId, 'PC') };
  }

  // Um PV por produto, todos no mesmo instante: o dinheiro entrou pelo carrinho inteiro.
  const itens = itensDoLead(lead);
  const pvs = itens.map(it => documentos.abrir(leadId, 'PV', null, it.sku));
  registrar(deps, leadId, 'pagamento_ok', pvs.map(d => d.codigo).join(', '));
  registrar(deps, leadId, 'vendas_avisa', ligado() ? null : 'rascunho — aguardando liberação do fluxo');
  registrar(deps, leadId, 'vendas_compras');

  // Um PC por produto: cada um pode ir para um fornecedor diferente, e a resposta de cada
  // fornecedor fecha só o PC dele (é pelo código com o SKU que ela é casada na volta).
  const pcs = [];
  const emails = [];
  for (const it of itens) {
    const pc = documentos.abrir(leadId, 'PC', null, it.sku);
    const { produto, fornecedor } = produtoEFornecedor(it);
    const email = textoPedidoDeCompra(lead, produto, fornecedor, it);
    const para = `Para o fornecedor${fornecedor ? ' (' + fornecedor.name + ')' : ''} — ${email.assunto}\n\n${email.corpo}`;
    // Sem fornecedor cadastrado a resposta dele nunca será aceita (remetenteEhDoFornecedor
    // é fail-closed). Melhor avisar agora do que descobrir quando a chave não andar.
    const semFornecedor = fornecedor ? '' : ' ATENÇÃO: produto sem fornecedor cadastrado — cadastre antes de enviar, senão a resposta não será reconhecida.';

    if (ligado()) {
      // ⚠️ O envio real ao fornecedor AINDA NÃO EXISTE: depende da caixa @compras, que é
      // tarefa do Marcelo (fase 4 do plano). Ligar o freio hoje libera o fluxo, mas o
      // e-mail continua saindo como rascunho — e o texto abaixo diz isso em vez de mentir
      // "enviado", que faria alguém parar de cobrar o fornecedor achando que já pediu.
      registrar(deps, leadId, 'compras_pede', `${pc.codigo} — PRONTO PARA ENVIO (a caixa @compras ainda não existe)`);
      deps.log(leadId, null, 'email_rascunho', para);
      deps.notify('fluxo_rascunho', `Pedido de compra ${pc.codigo} pronto para envio — falta a caixa @compras.${semFornecedor}`, leadId);
    } else {
      // Fail-closed: sem o freio ligado o pedido de compra fica escrito e visível, esperando
      // um humano. É melhor o pedido parar aqui do que sair sozinho para o fornecedor.
      registrar(deps, leadId, 'compras_pede', `${pc.codigo} — RASCUNHO, não enviado (FLUXO_POS_PAGAMENTO desligado)`);
      deps.log(leadId, null, 'email_rascunho', para);
      deps.notify('fluxo_rascunho', `Pedido de compra ${pc.codigo} pronto para revisão — nada foi enviado ao fornecedor.${semFornecedor}`, leadId);
    }
    pcs.push(pc);
    emails.push(email);
  }

  // `enviado` é sempre false até a caixa @compras existir. O campo continua aqui para
  // quem chama saber que NADA saiu — não é o mesmo que o freio estar ligado.
  // `pv`/`pc`/`email` (o primeiro) ficam por compatibilidade com o pedido de um produto só.
  return { ok: true, pv: pvs[0], pc: pcs[0], email: emails[0], pvs, pcs, emails, enviado: false, liberado: ligado() };
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

  const texto = (entrada && entrada.texto) || '';
  const chave = extrairChave(texto);

  registrar(deps, leadId, 'fornecedor_devolve', chave ? 'chave recebida' : 'sem chave reconhecível no e-mail');

  // A fatura abre o ciclo financeiro, que corre por fora e não segura a entrega.
  if (pareceFatura(texto)) {
    const fin = documentos.abrir(leadId, 'FIN', null, pc.sku || null);
    deps.log(leadId, null, 'doc', `Ciclo financeiro ${fin.codigo} aberto — fatura do fornecedor recebida. Fecha quando for paga e o comprovante voltar.`);
  }

  // Etapa 6: o double-check. Divergência PARA aqui e chama gente — não entrega, não fecha.
  const conferencia = conferir(lead, { chave, qty: entrada && entrada.qty, sku: (entrada && entrada.sku) || (entrada && entrada.skus && entrada.skus[0]), seq: entrada && entrada.seq }, item);
  if (!conferencia.ok) {
    deps.log(leadId, null, 'fluxo', `[compras] Conferência REPROVADA: ${conferencia.problemas.join('; ')}. Nada foi entregue ao cliente.`);
    deps.notify('fluxo_divergencia', `Pedido ${pc.codigo}: o que o fornecedor mandou não bate — ${conferencia.problemas.join('; ')}.`, leadId);
    return { ok: false, razao: 'divergência na conferência', problemas: conferencia.problemas, chave: null };
  }
  registrar(deps, leadId, 'compras_confere', 'quantidade, produto e número conferem');

  // A chave voltou e confere: o pedido de compra cumpriu o papel dele.
  documentos.fechar(leadId, 'PC', 'chave recebida do fornecedor e conferida', null, pc.sku || null);

  // Etapa 7: a entrega. O e-mail com chave + book é para o CLIENTE — não sai sem a caixa
  // @vendas existir. Sem entrega confirmada, o PV continua aberto, que é a regra.
  const entrega = { assunto: `Sua licença — pedido ${docnum.formatar('PV', lead.doc_seq, pc.sku)}`, chave, sku: pc.sku || null };
  deps.log(leadId, null, 'email_rascunho', `Para o cliente — ${entrega.assunto}\n\nChave de licença registrada. Falta anexar o book de instalação e enviar pela caixa @vendas.`);
  deps.notify('fluxo_entrega', `Pedido ${pc.codigo} conferido: chave pronta para ir ao cliente. Falta a caixa @vendas.`, leadId);

  return { ok: true, chave, entrega, pvFechado: false };
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

module.exports = { ETAPAS, etapa, ligado, registrar, itensDoLead, escolherPC, conferir, textoPedidoDeCompra, aoConfirmarPagamento,
  extrairChave, candidatosDeChave, pareceFatura, aoReceberDoFornecedor, confirmarEntregaAoCliente, remetenteEhDoFornecedor };
