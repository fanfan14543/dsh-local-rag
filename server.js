'use strict';

const readline = require('readline');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');
const store = require('./lib/store');
const { smartSearch } = require('./lib/search');

const RAG_DIR = path.join(os.homedir(), '.dsh', 'rag');
const DB = path.join(RAG_DIR, 'index.db');
const NODE = process.execPath;
const VERSION = '0.1.0';

let db = null;
function getDb() {
  if (!db) db = store.open(DB);
  return db;
}

function log(...a) { process.stderr.write('[rag] ' + a.join(' ') + '\n'); }

const SOURCE_IDS = ['session', 'doc', 'skill', 'persona'];

const TOOLS = [
  {
    name: 'rag_search',
    description:
      '在本地资料库里做全文检索（中文按二字组切分，SQLite FTS5 + BM25 排序）。' +
      '资料库包含：历史会话记录、工作区文档、技能库、人设与记忆文件。' +
      '当需要回忆以前聊过什么、翻某个项目的旧决定、查文档里的细节时用它。' +
      '返回按相关度排序的片段，带来源和 id，可用 rag_open 取上下文。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词，自然语言即可，中文英文混排也行。' },
        top_k: { type: 'integer', description: '返回条数，默认 6，最大 30。' },
        source: {
          type: 'string',
          description: '限定来源，可选 session / doc / skill / persona，不填则全库搜。',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'rag_open',
    description: '取某一条检索结果的相邻片段（前后各若干块），用于看完整上下文。id 来自 rag_search 的返回。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'rag_search 返回的 id。' },
        span: { type: 'integer', description: '前后各扩展几块，默认 1，最大 5。' },
      },
      required: ['id'],
    },
  },
  {
    name: 'rag_index',
    description:
      '增量更新索引：只重建有改动的内容，没变的文件跳过。' +
      '首次建库或改动很多时用命令行跑全量更快。' +
      '不传 source 则更新全部四类来源。',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: '只更新某一类来源，可选 session / doc / skill / persona。',
        },
      },
    },
  },
  {
    name: 'rag_stats',
    description: '查看索引状态：总块数、文本量、各类来源的块数、上次构建时间。',
    inputSchema: { type: 'object', properties: {} },
  },
];

function fmtRows(rows) {
  if (!rows.length) {
    return '没有命中。可能索引还没建（先看 rag_stats），或换个说法、去掉限定来源再试。';
  }
  return rows.map((r, i) => {
    const when = r.ts ? new Date(Number(r.ts)).toISOString().slice(0, 10) : '';
    const body = String(r.body || '').replace(/\s+/g, ' ').trim().slice(0, 520);
    return `[${i + 1}] ${r.source} · ${r.title || '(无标题)'}${when ? ' · ' + when : ''} · id=${r.id}\n${body}`;
  }).join('\n\n---\n\n');
}

function callTool(name, args) {
  const a = args || {};
  if (name === 'rag_search') {
    const q = String(a.query || '').trim();
    if (!q) return '缺少 query。';
    const src = a.source && SOURCE_IDS.includes(String(a.source)) ? [String(a.source)] : null;
    const rows = smartSearch(getDb(), q, a.top_k || 6, src);
    return fmtRows(rows);
  }

  if (name === 'rag_open') {
    const id = Number(a.id);
    if (!Number.isFinite(id)) return 'id 必须是数字。';
    const span = Math.max(0, Math.min(5, Number(a.span) || 1));
    const d = getDb();
    const row = d.prepare('SELECT id, source, ref, title, chunk, ts FROM docs WHERE id = ?').get(id);
    if (!row) return `找不到 id=${id}。`;
    const lo = Math.max(0, Number(row.chunk) - span);
    const hi = Number(row.chunk) + span;
    const sib = d.prepare(
      'SELECT id, chunk, body FROM docs WHERE ref = ? AND chunk BETWEEN ? AND ? ORDER BY chunk'
    ).all(row.ref, lo, hi);
    const head = `来源 ${row.source} · ${row.title || '(无标题)'} · ref=${row.ref}`;
    const body = sib.map((s) => `-- 块${s.chunk}${s.id === id ? '（命中）' : ''} --\n${s.body}`).join('\n\n');
    return head + '\n\n' + body;
  }

  if (name === 'rag_index') {
    const src = a.source && SOURCE_IDS.includes(String(a.source)) ? String(a.source) : '';
    const argv = [path.join(RAG_DIR, 'build.js')];
    if (src) argv.push('--only=' + src);
    const r = spawnSync(NODE, ['--no-warnings'].concat(argv), {
      cwd: RAG_DIR, encoding: 'utf8', timeout: 10 * 60 * 1000,
    });
    const out = ((r.stdout || '') + (r.stderr || '')).trim();
    if (db) { try { db.close(); } catch { /* ignore */ } db = null; }
    return '索引更新完成：\n' + out.split('\n').slice(-14).join('\n');
  }

  if (name === 'rag_stats') {
    try {
      const s = store.stats(getDb());
      const lines = [
        `总块数：${s.chunks}`,
        `文本量：${(s.bytes / 1048576).toFixed(2)} MB`,
        `上次构建：${s.builtAt || '未知'}`,
        '来源分布：',
      ].concat(s.sources.map((x) => `  ${x.source}: ${x.chunks} 块`));
      const size = fs.existsSync(DB) ? (fs.statSync(DB).size / 1048576).toFixed(1) + ' MB' : '未建';
      lines.push(`库文件：${size}`);
      return lines.join('\n');
    } catch (e) {
      return '索引尚不可用：' + e.message;
    }
  }

  return '未知工具：' + name;
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch (e) {
    log('bad json');
    return;
  }
  const isNotification = msg.id === undefined || msg.id === null;
  const method = msg.method;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'dsh-local-rag', version: VERSION },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    let text;
    try {
      text = callTool(name, args);
    } catch (e) {
      send({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: '工具出错：' + e.message }], isError: true },
      });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(text) }] } });
    return;
  }

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  if (!isNotification) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found: ' + method } });
  }
});

rl.on('close', () => {
  if (db) { try { db.close(); } catch { /* ignore */ } }
  process.exit(0);
});

log('ready, db=' + DB);
