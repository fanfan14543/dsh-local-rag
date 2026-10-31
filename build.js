'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const store = require('./lib/store');
const corpus = require('./lib/corpus');

const HOME = os.homedir();
const DB = process.env.DSH_RAG_DB || path.join(HOME, '.dsh', 'rag', 'index.db');

// 额外要索引的目录（工作区文档、代码库）：
//   DSH_RAG_DOCS 环境变量优先（多个用系统路径分隔符隔开），
//   其次读 ~/.dsh/rag/config.json 里的 { "docs": ["D:/proj", "/home/me/notes"] }。
//   留空就只索引会话 / 技能 / 人设。
const CFG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, '.dsh', 'rag', 'config.json'), 'utf8')) || {}; }
  catch { return {}; }
})();
const DOC_ROOTS = (process.env.DSH_RAG_DOCS ? process.env.DSH_RAG_DOCS.split(path.delimiter) : (Array.isArray(CFG.docs) ? CFG.docs : [])).filter(Boolean);

const SOURCES = [
  { id: 'session', kind: 'sessions', root: path.join(HOME, '.dsh', 'sessions'), label: '会话记录' },
  ...(DOC_ROOTS.length ? [{ id: 'doc', kind: 'files', roots: DOC_ROOTS, label: '工作区文档' }] : []),
  { id: 'skill', kind: 'files', roots: [path.join(HOME, '.dsh', 'skills')], label: '技能库' },
  {
    id: 'persona', kind: 'files',
    roots: [
      path.join(HOME, '.dsh', 'persona-cards'),
      path.join(HOME, '.dsh', 'soul.md'),
      path.join(HOME, '.dsh', 'memory'),
    ],
    label: '人设与记忆',
  },
];

const args = process.argv.slice(2);
const onlyArg = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const FORCE = args.includes('--force');
const only = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim()).filter(Boolean)) : null;
const CHUNK = 1000;
const OVERLAP = 120;

function log(...a) { console.log(...a); }

const db = store.open(DB);
let totalAdded = 0, totalRefs = 0, skipped = 0;
const t0 = Date.now();

function handleSession(f) {
  const ref = 'session:' + f.sid;
  const st = fs.statSync(f.file);
  const mtime = Math.round(st.mtimeMs);
  const prev = store.sourceStat(db, ref);
  if (!FORCE && prev && prev.n > 0 && Number(prev.mtime) === mtime) { skipped++; return; }
  let r;
  try { r = corpus.readSession(f.file); } catch (e) { log('  读取失败', f.sid, e.message); return; }
  const msgs = r.msgs || [];
  if (!msgs.length) { skipped++; return; }
  const title = r.title || f.sid;
  const chunks = corpus.chunkify(msgs.join('\n\n'), CHUNK, OVERLAP);
  if (!chunks.length) { skipped++; return; }
  store.dropRef(db, ref);
  const n = store.addChunks(db, { source: 'session', ref, title, chunks, ts: mtime, mtime });
  totalAdded += n; totalRefs++;
  log('  会话', f.sid.slice(0, 20), '->', n, '块 |', title.replace(/\s+/g, ' ').slice(0, 30));
}

function handleFile(src, f) {
  const rel = f.file.replace(/\\/g, '/');
  const ref = 'file:' + rel;
  const prev = store.sourceStat(db, ref);
  if (!FORCE && prev && prev.n > 0 && Number(prev.mtime) === f.mtime) { skipped++; return; }
  let text;
  try { text = fs.readFileSync(f.file, 'utf8'); } catch { return; }
  const chunks = corpus.chunkify(text, CHUNK, OVERLAP);
  if (!chunks.length) { skipped++; return; }
  store.dropRef(db, ref);
  const n = store.addChunks(db, {
    source: src.id, ref, title: path.basename(f.file), chunks, ts: f.mtime, mtime: f.mtime,
  });
  totalAdded += n; totalRefs++;
}

db.exec('BEGIN');
try {
  for (const src of SOURCES) {
    if (only && !only.has(src.id)) continue;
    log('==', src.label, '(' + src.id + ')');
    if (src.kind === 'sessions') {
      const list = corpus.listSessionFiles(src.root);
      log('  会话文件', list.length);
      for (const f of list) handleSession(f);
    } else {
      const files = [];
      for (const root of src.roots) {
        if (!fs.existsSync(root)) continue;
        if (fs.statSync(root).isFile()) {
          const st = fs.statSync(root);
          if (st.size <= 2 * 1024 * 1024) files.push({ file: root, mtime: Math.round(st.mtimeMs), size: st.size });
        } else {
          corpus.walkFiles(root, 2 * 1024 * 1024, files, 0);
        }
      }
      log('  文件', files.length);
      for (const f of files) handleFile(src, f);
    }
  }
  store.metaSet(db, 'builtAt', new Date().toISOString());
  store.metaSet(db, 'version', 1);
  db.exec('COMMIT');
} catch (e) {
  try { db.exec('ROLLBACK'); } catch { /* ignore */ }
  console.error('索引失败:', e.message);
  process.exit(1);
}

const s = store.stats(db);
log('');
log('来源引用更新', totalRefs, '| 新增块', totalAdded, '| 跳过未变', skipped);
log('索引总量', s.chunks, '块 /', (s.bytes / 1048576).toFixed(1), 'MB 文本');
log('耗时', ((Date.now() - t0) / 1000).toFixed(1), 's');
for (const x of s.sources) log('  ', x.source.padEnd(10), x.chunks);
log('DB:', DB, '(' + (fs.statSync(DB).size / 1048576).toFixed(1) + 'MB)');
db.close();
