'use strict';
// As caixas dos agentes, só os endereços, lidas das mesmas variáveis do mailer. Serve a
// duas regras: e-mail vindo de uma delas nunca é conversa de cliente ou fornecedor (é o
// CRM falando com ele mesmo — sem isto, vendas → compras voltava pela leitura da caixa
// da Cora como "resposta"), e no modo teste do fluxo as caixas próprias sempre recebem.
// Fica fora do mailer.js porque os testes trocam o mailer inteiro por um falso.
const VARIAVEIS = ['EMAIL_FROM', 'EMAIL_FROM_VENDAS', 'EMAIL_FROM_COMPRAS', 'EMAIL_FROM_FINANCEIRO'];

function enderecoDe(texto) {
  const m = String(texto || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(texto || '')).trim().toLowerCase();
}

function caixasProprias() {
  const e = process.env;
  const brutos = VARIAVEIS.map(n => e[n]).concat(String(e.EMAIL_INBOX_MAILBOXES || '').split(','));
  return [...new Set(brutos.map(enderecoDe).filter(x => x.includes('@')))];
}

function ehCaixaPropria(endereco) {
  const alvo = enderecoDe(endereco);
  return !!alvo && caixasProprias().includes(alvo);
}

module.exports = { caixasProprias, ehCaixaPropria, enderecoDe };
