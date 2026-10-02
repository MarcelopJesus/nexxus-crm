// sessao.js — confere o token contra o cadastro atual: usuário desativado ou com senha trocada
// depois da emissão perde o acesso na hora, sem esperar os 7 dias do token.
'use strict';
const store = require('./store');
const { verify } = require('./auth');

function usuarioDoToken(token) {
  const t = token ? verify(token) : null;
  if (!t) return null;
  const u = store.get('users', t.id);
  if (!u || !u.active) return null;
  if (u.sessoes_validas_desde && (t.iat || 0) < u.sessoes_validas_desde) return null;
  return Object.assign({}, t, { area: u.area, role: u.role });
}

module.exports = { usuarioDoToken };
