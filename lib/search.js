'use strict';

const { tokens } = require('./tokenize');
const store = require('./store');

const SOURCE_WEIGHT = {
  session: 1.45,
  persona: 1.6,
  doc: 0.75,
  skill: 0.6,
};

function quote(t) {
  return '"' + t.replace(/"/g, '""') + '"';
}

function weightOf(source) {
  return SOURCE_WEIGHT[source] || 1;
}

function rescore(rows) {
  for (const r of rows) r.weighted = Number(r.score) * weightOf(r.source);
  rows.sort((a, b) => a.weighted - b.weighted);
  return rows;
}

function smartSearch(db, query, limit, sources) {
  const uniq = [...new Set(tokens(query))].slice(0, 32);
  if (!uniq.length) return [];
  const lim = Math.max(1, Math.min(30, limit || 6));

  const andExpr = uniq.map(quote).join(' ');
  const strict = rescore(store.search(db, andExpr, lim * 2, sources));

  if (strict.length >= lim) return strict.slice(0, lim);

  const orExpr = uniq.map(quote).join(' OR ');
  const loose = rescore(store.search(db, orExpr, lim * 4, sources));

  const seen = new Set(strict.map((r) => r.id));
  const merged = strict.slice();
  for (const r of loose) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
  }
  merged.sort((a, b) => a.weighted - b.weighted);
  return merged.slice(0, lim);
}

module.exports = { smartSearch, SOURCE_WEIGHT };
