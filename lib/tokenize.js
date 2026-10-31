'use strict';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const ALNUM = /[A-Za-z][A-Za-z0-9_\-]{1,}/g;

function tokens(text) {
  const out = [];
  const s = String(text == null ? '' : text);
  let m;
  HAN.lastIndex = 0;
  while ((m = HAN.exec(s))) {
    const h = m[0];
    if (h.length === 1) { out.push(h); continue; }
    for (let i = 0; i < h.length - 1; i++) out.push(h.slice(i, i + 2));
  }
  ALNUM.lastIndex = 0;
  while ((m = ALNUM.exec(s))) out.push(m[0].toLowerCase());
  return out;
}

function indexText(text) {
  return tokens(text).join(' ');
}

function queryExpr(q) {
  const uniq = [...new Set(tokens(q))];
  if (!uniq.length) return '';
  const picked = uniq.slice(0, 32);
  return picked.map((x) => '"' + x.replace(/"/g, '""') + '"').join(' OR ');
}

module.exports = { tokens, indexText, queryExpr };
