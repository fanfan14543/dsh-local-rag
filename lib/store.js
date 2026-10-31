'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const { indexText } = require('./tokenize');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  ref TEXT NOT NULL,
  title TEXT,
  chunk INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  ts INTEGER DEFAULT 0,
  mtime INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_docs_ref ON docs(ref, chunk);
CREATE INDEX IF NOT EXISTS ix_docs_source ON docs(source);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(body_index, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`;

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

function metaGet(db, k, dflt) {
  const r = db.prepare('SELECT v FROM meta WHERE k = ?').get(k);
  if (!r) return dflt;
  try { return JSON.parse(r.v); } catch { return r.v; }
}

function metaSet(db, k, v) {
  db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(k, JSON.stringify(v));
}

function sourceStat(db, ref) {
  return db.prepare('SELECT MAX(mtime) AS mtime, COUNT(*) AS n FROM docs WHERE ref = ?').get(ref);
}

function dropRef(db, ref) {
  const rows = db.prepare('SELECT id FROM docs WHERE ref = ?').all(ref);
  for (const r of rows) db.prepare('DELETE FROM docs_fts WHERE rowid = ?').run(r.id);
  db.prepare('DELETE FROM docs WHERE ref = ?').run(ref);
  return rows.length;
}

const insertDocStmt = (db) => db.prepare(
  'INSERT INTO docs(source, ref, title, chunk, body, ts, mtime) VALUES(?,?,?,?,?,?,?)'
);
const insertFtsStmt = (db) => db.prepare(
  'INSERT INTO docs_fts(rowid, body_index) VALUES(?, ?)'
);

function addChunks(db, { source, ref, title, chunks, ts, mtime }) {
  let added = 0;
  const insDoc = insertDocStmt(db);
  const insFts = insertFtsStmt(db);
  for (let i = 0; i < chunks.length; i++) {
    const body = chunks[i];
    if (!body || body.length < 12) continue;
    const info = insDoc.run(source, ref, title || '', i, body, ts || 0, mtime || 0);
    const id = Number(info.lastInsertRowid);
    insFts.run(id, indexText(body));
    added++;
  }
  return added;
}

function search(db, expr, limit, sourceFilter) {
  if (!expr) return [];
  let sql = `
    SELECT d.id, d.source, d.ref, d.title, d.chunk, d.body, d.ts,
           bm25(docs_fts) AS score
    FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid
    WHERE docs_fts MATCH ?`;
  const params = [expr];
  if (sourceFilter && sourceFilter.length) {
    sql += ` AND d.source IN (${sourceFilter.map(() => '?').join(',')})`;
    params.push(...sourceFilter);
  }
  sql += ' ORDER BY score LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

function stats(db) {
  const total = db.prepare('SELECT COUNT(*) AS n, SUM(LENGTH(body)) AS bytes FROM docs').get();
  const bySource = db.prepare('SELECT source, COUNT(*) AS n FROM docs GROUP BY source ORDER BY n DESC').all();
  return {
    chunks: Number(total.n || 0),
    bytes: Number(total.bytes || 0),
    sources: bySource.map((r) => ({ source: r.source, chunks: Number(r.n) })),
    builtAt: metaGet(db, 'builtAt', null),
    version: metaGet(db, 'version', null),
  };
}

module.exports = { open, metaGet, metaSet, sourceStat, dropRef, addChunks, search, stats };
