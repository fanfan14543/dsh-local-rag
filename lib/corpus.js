'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.text', '.json', '.yml', '.yaml',
  '.js', '.mjs', '.cjs', '.ts', '.py', '.csv', '.log', '.rst', '.org',
]);

const SKIP_DIR = new Set([
  'node_modules', '.git', '.cache', 'dist', 'build', '__pycache__',
  '.venv', 'venv', '.next', 'out', 'target', '.workbuddy',
]);

const NOISE_PREFIX = [
  'Instructions from', 'Web search is available', '<!--', '<environment',
  'You are an AI assistant', 'System:',
];

function readZstdFrames(file) {
  const b = fs.readFileSync(file);
  const offs = [];
  let i = 0;
  while (true) {
    const j = b.indexOf(MAGIC, i);
    if (j < 0) break;
    offs.push(j);
    i = j + 4;
  }
  const parts = [];
  for (let k = 0; k < offs.length; k++) {
    const s = offs[k];
    const e = k + 1 < offs.length ? offs[k + 1] : b.length;
    try { parts.push(zlib.zstdDecompressSync(b.subarray(s, e))); } catch { /* skip bad frame */ }
  }
  return Buffer.concat(parts).toString('utf8');
}

function textOf(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n');
  }
  if (Array.isArray(content.content)) return textOf(content.content);
  if (typeof content.text === 'string') return content.text;
  return '';
}

function isNoise(t) {
  return NOISE_PREFIX.some((p) => t.startsWith(p));
}

const INJECT_PREFIX = [
  'Current runtime context', '[SCHEDULE REMINDER', '[model changed',
  'Time sampled while preparing', '[Context:', 'The approval policy changed',
  '<system-reminder', '@C:\\', '<user_info',
];

function isInjection(t) {
  return INJECT_PREFIX.some((p) => t.startsWith(p));
}

function readSession(file) {
  const text = readZstdFrames(file);
  const msgs = [];
  let title = '';
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'user/message') {
      const raw = textOf(o.data && o.data.content).trim();
      if (!raw || raw.length < 6 || isNoise(raw)) continue;
      if (isInjection(raw)) {
        msgs.push('【用户】' + raw.slice(0, 220) + (raw.length > 220 ? '…' : ''));
        continue;
      }
      if (!title && raw.length >= 8) title = raw.replace(/\s+/g, ' ').slice(0, 44);
      msgs.push('【用户】' + raw);
    } else if (o.type === 'assistant/message') {
      const t = textOf(o.data && o.data.message && o.data.message.content).trim();
      if (!t || t.length < 6) continue;
      msgs.push('【她】' + t);
    }
  }
  return { msgs, title };
}

function chunkify(text, size, overlap) {
  const S = size || 1000;
  const O = overlap || 120;
  const paras = String(text).split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const chunks = [];
  let buf = '';
  for (const p of paras) {
    if (buf.length + p.length + 2 <= S) {
      buf = buf ? buf + '\n\n' + p : p;
      continue;
    }
    if (buf) chunks.push(buf);
    if (p.length <= S) { buf = p; continue; }
    let i = 0;
    while (i < p.length) {
      chunks.push(p.slice(i, i + S));
      i += S - O;
    }
    buf = '';
  }
  if (buf) chunks.push(buf);
  return chunks.filter((c) => c && c.length >= 12);
}

function listSessionFiles(sessionsRoot) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(sessionsRoot, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const projDir = path.join(sessionsRoot, d.name);
    let subs = [];
    try { subs = fs.readdirSync(projDir, { withFileTypes: true }); } catch { continue; }
    for (const s of subs) {
      if (!s.isDirectory()) continue;
      const f = path.join(projDir, s.name, 'session.v4.jsonl.zstd');
      if (fs.existsSync(f)) out.push({ sid: s.name, file: f });
    }
  }
  return out;
}

function walkFiles(root, maxBytes, acc, depth) {
  const D = depth || 0;
  if (D > 8) return;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.workbuddy') continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      walkFiles(full, maxBytes, acc, D + 1);
      continue;
    }
    if (!e.isFile()) continue;
    if (e.name.startsWith('_')) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    if (ext === '.log') continue;
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.size > (maxBytes || 2 * 1024 * 1024) || st.size < 40) continue;
    acc.push({ file: full, mtime: Math.round(st.mtimeMs), size: st.size });
  }
}

module.exports = {
  readZstdFrames, readSession, chunkify, listSessionFiles, walkFiles, TEXT_EXT,
};
