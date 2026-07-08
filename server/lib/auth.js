// auth.js — hashing de senha (scrypt) e tokens assinados (HMAC) sem dependências.
'use strict';
const crypto = require('crypto');
const SECRET = process.env.JWT_SECRET || 'nexxus-crm-dev-secret-change-me';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 32).toString('hex');
  const a = Buffer.from(hash, 'hex'); const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function b64u(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
function sign(payload) {
  const body = { ...payload, iat: Date.now(), exp: Date.now() + 7 * 86400000 };
  const data = b64u(body);
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}
function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  if (sig !== expected) return null;
  try {
    const body = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (body.exp && Date.now() > body.exp) return null;
    return body;
  } catch { return null; }
}
module.exports = { hashPassword, verifyPassword, sign, verify };
