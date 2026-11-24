#!/usr/bin/env node
/**
 * 记忆同步.mjs —— 把 dsh 引擎的真实运行状态灌进工作台「记忆神经元」面板。
 *
 * 为什么需要它：
 *   面板读的是 引擎数据\.dsh\场景记忆\_共享记忆\记忆地图.json（renderers.js:17994 + 18106/18112）。
 *   那个文件里的 dataSources 一直空着，所以面板只有一张 2026-11-16 手画的地图。
 *   引擎里真正发生的事（会话、工作区、技能、token 账）全在 storages\ 和 sessions\ 里，面板一个都看不见。
 *
 * v2（2026-11-25）：
 *   · 修 workspace 读取 —— 旧版找 ws.workspaces / ws.items，真实结构是 tables.workspaces（以 id 为键的对象），
 *     所以工作区一直是 0 个、会话只能按 cwd 猜分组。
 *   · 新增会话标题 + 简略内容 —— projcache 的 rows.title.val 只是 system prompt 开头的字符串，
 *     不是标题。真标题在 sessions\**\session.v4.jsonl.zstd 里：头 64KB 有 session 头 / 子代理 label /
 *     第一条用户消息；尾 240KB 有最后一条 assistant 正文。所以按需切片解压（不读整文件）。
 *   · 摘要缓存 —— _共享记忆\.摘要缓存.json，按 (size, mtime) 命中就复用，别每次重解 400 个存档。
 *
 * 它做什么：
 *   只读引擎数据，只写 _共享记忆\记忆地图.json 的 dataSources 段 + 同目录 引擎会话.json（明细）+ .摘要缓存.json。
 *   areas 段原样保留，绝不改 场景私有记忆.md。
 *
 * 用法：
 *   node 工具\记忆同步.mjs            # 同步并落盘（首次会备份 记忆地图.json）
 *   node 工具\记忆同步.mjs --check    # 只打印，不写盘
 *   node 工具\记忆同步.mjs --json     # 打印生成的 dataSources
 *   node 工具\记忆同步.mjs --fresh    # 忽略摘要缓存，全部重解
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const HOME = path.join(ROOT, '引擎数据', '.dsh');
const MEM = path.join(HOME, '场景记忆', '_共享记忆');
const MAP_FILE = path.join(MEM, '记忆地图.json');
const DETAIL_FILE = path.join(MEM, '引擎会话.json');
const CACHE_FILE = path.join(MEM, '.摘要缓存.json');
const PROJ_CACHE = path.join(HOME, 'storages', 'session_projcache', 'sessions');
const WORKSPACE_FILE = path.join(HOME, 'storages', 'workspace.json');
const SESS_ARCHIVE = path.join(HOME, 'sessions');
const SKILLS_DIR = path.join(HOME, 'skills');
const LEDGER = path.join(HOME, 'storages', 'cost-meter', 'ledger.json');

const CHECK = process.argv.includes('--check');
const AS_JSON = process.argv.includes('--json');
const FRESH = process.argv.includes('--fresh');

const HEAD_BYTES = 256 * 1024;    // 会话头 + session/title（dsh 自动标题在第一轮结束后写入，位置靠前但要够长）
const TAIL_BYTES = 240 * 1024;    // 最后几条 assistant 正文
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);   // zstd 帧头，多帧追加

const rd = (p) => { try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return ''; } };
const rj = (p) => { try { return JSON.parse(rd(p)); } catch { return null; } };
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
const size = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
const iso = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '');
const normId = (s) => String(s || '').replace(/^session-/, '');

/* ---------- 0. 多帧 zstd 切片解压 ---------- */
function frames(buf) {
  const idx = [];
  let p = 0;
  while (true) { const i = buf.indexOf(MAGIC, p); if (i < 0) break; idx.push(i); p = i + 4; }
  let txt = '';
  for (let k = 0; k < idx.length; k++) {
    const seg = buf.subarray(idx[k], k + 1 < idx.length ? idx[k + 1] : buf.length);
    try { txt += zlib.zstdDecompressSync(seg).toString('utf8'); } catch { /* 截断帧跳过 */ }
  }
  return txt;
}
function slice(file, from, len) {
  let fd = 0;
  try {
    const st = fs.statSync(file);
    const start = from === 'tail' ? Math.max(0, st.size - len) : 0;
    const n = Math.min(len, st.size - start);
    const b = Buffer.alloc(n);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, b, 0, n, start);
    return b;
  } catch { return Buffer.alloc(0); } finally { if (fd) try { fs.closeSync(fd); } catch { } }
}
const headText = (f) => frames(slice(f, 'head', HEAD_BYTES));
const tailText = (f) => frames(slice(f, 'tail', TAIL_BYTES));

/* ---------- 1. 会话存档索引：sessionId(裸) → zstd 路径 ---------- */
function archiveIndex() {
  const map = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync(SESS_ARCHIVE, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return map; }
  for (const d1 of dirs) {
    const p1 = path.join(SESS_ARCHIVE, d1.name);
    let subs = [];
    try { subs = fs.readdirSync(p1, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
    for (const d2 of subs) {
      const f = path.join(p1, d2.name, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(f)) continue;
      map.set(normId(d2.name), f);
    }
  }
  return map;
}

/* ---------- 2. 内容清洗 ---------- */
const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c && (c.type === 'text' || c.text)).map((c) => String(c.text || '')).join('\n');
  if (content && typeof content === 'object') return String(content.text || content.value || '');
  return '';
};
const cleanMd = (s) => String(s || '')
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/`([^`]*)`/g, '$1')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/^\s{0,3}#{1,6}\s*/gm, '')
  .replace(/[*_~]{1,3}/g, '')
  .replace(/\|/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/* ---------- 3. 单个会话的标题 / 摘要 / 最后活动 ---------- */
function digestOf(file, keep) {
  const st = { size: size(file), mtime: mtime(file) };
  if (keep && !FRESH && keep.size === st.size && keep.mtime === st.mtime && keep.digest) return keep;

  let title = '';
  let digest = '';
  let lastAt = 0;
  let origin = '';
  let label = '';

  const head = headText(file);
  for (const line of head.split('\n')) {
    if (!line.startsWith('{')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'session') origin = o.origin || '';
    else if (o.type === 'subagent/descriptor') label = (o.data && o.data.label) || '';
    else if (o.type === 'session/title' && !title) title = String((o.data && (o.data.title || o.data.text)) || '');
    else if (o.type === 'user/message' && !title) {
      const t = cleanMd(textOf(o.data && o.data.content));
      // 跳过系统注入的 reminder / 环境说明
      if (t && !/^(<\w|系统提醒|System reminder|# AGENTS)/i.test(t)) title = clip(t, 44);
    }
  }

  const tail = tailText(file);
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.time && o.time > lastAt) lastAt = o.time;
    if (o.type === 'assistant/message' && !digest) {
      const t = cleanMd(textOf(o.data && o.data.message && o.data.message.content));
      if (t) digest = clip(t, 150);
    }
    if (digest && lastAt) break;
  }
  if (label && !title) title = label;
  return { ...st, title, digest, lastAt, origin, label };
}

/* ---------- 4. 会话（projcache 是引擎自己的会话索引缓存） ---------- */
function readSessions() {
  let files = [];
  try { files = fs.readdirSync(PROJ_CACHE).filter((f) => /^session-.*\.json$/.test(f)); } catch { }
  const cache = FRESH ? {} : (rj(CACHE_FILE) || {});
  const arch = archiveIndex();

  const ctx = new Map();
  const out = [];
  for (const f of files) {
    const p = path.join(PROJ_CACHE, f);
    const j = rj(p);
    if (!j || !j.record) continue;
    const rec = j.record;
    const rows = rec.rows || {};
    let seq = 0;
    for (const k of Object.keys(rows)) if (rows[k] && typeof rows[k].seq === 'number') seq = Math.max(seq, rows[k].seq);

    const goalVal = rows.goal && rows.goal.val;
    const cur = goalVal && goalVal.current;
    const id = f.replace(/\.json$/, '');
    const cwd = (rec.identity && rec.identity.cwd) || '';
    const tb = (rows.turnBoundary && rows.turnBoundary.val) || {};
    const cp = (rows.contextPressure && rows.contextPressure.val) || {};

    const zf = arch.get(normId(id));
    const dg = zf ? digestOf(zf, cache[id]) : { title: '', digest: '', lastAt: 0 };
    cache[id] = dg;

    const item = {
      id,
      short: normId(id).slice(0, 8),
      title: dg.title || (rows.title && rows.title.val) || '(未命名)',
      digest: dg.digest || '',
      agent: dg.label || '',
      origin: dg.origin || '',
      cwd,
      createdAt: iso(rec.identity && rec.identity.createdAt),
      lastAt: iso(dg.lastAt || mtime(p)),
      seq,
      turns: typeof tb.lastTurn === 'number' ? tb.lastTurn : 0,
      goal: (cur && (cur.objective || cur.text || cur.title)) || '',
      archived: false,
      sandbox: (rows.sandboxMode && rows.sandboxMode.val) || '',
      kb: +(size(p) / 1024).toFixed(1),
      archiveKB: zf ? +(size(zf) / 1024).toFixed(0) : 0,
      context: cp.contextWindow ? Math.round((cp.surfaceTokens / cp.contextWindow) * 100) : 0,
    };
    out.push(item);
    if (!ctx.has(cwd)) ctx.set(cwd, []);
    ctx.get(cwd).push(item);
  }

  // 归档标记来自 workspace.json
  const ws = rj(WORKSPACE_FILE) || {};
  const archived = new Set(((ws.global && ws.global.archivedSessionIds) || []).map(normId));
  out.forEach((s) => { s.archived = archived.has(normId(s.id)); });

  out.sort((a, b) => (b.lastAt > a.lastAt ? 1 : -1));
  return { items: out, cache, archived, ws, ctx };
}

/* ---------- 5. 工作区（tables.workspaces 是以 id 为键的对象，不是数组） ---------- */
function readWorkspaces(ws, items) {
  const tbl = (ws && ws.tables && ws.tables.workspaces) || {};
  const byId = new Map(items.map((s) => [normId(s.id), s]));
  const used = new Set();
  const out = [];

  for (const [id, v] of Object.entries(tbl)) {
    if (!v) continue;
    const dir = String(v.path || '');
    const ids = (Array.isArray(v.sessionIds) ? v.sessionIds : []).map(normId);
    const list = [];
    for (const sid of ids) {
      const s = byId.get(sid);
      if (!s) continue;
      used.add(sid);
      list.push(s);
    }
    list.sort((a, b) => (b.lastAt > a.lastAt ? 1 : -1));
    const active = list.filter((s) => !s.archived);
    out.push({
      id,
      title: String(v.title || path.basename(dir) || id.slice(0, 8)),
      path: dir,
      default: !!(ws && ws.global && ws.global.defaultWorkspaceId === id),
      createdAt: iso(v.createdAt),
      updatedAt: iso(v.updatedAt),
      sessionCount: ids.length,
      knownSessions: list.length,
      activeCount: active.length,
      lastAt: (list[0] && list[0].lastAt) || iso(v.updatedAt),
      // 神经元只画最近 8 条，其余在 detail 里报数
      sessions: list.slice(0, 8).map((s) => ({
        id: s.id, short: s.short, title: s.title, digest: s.digest,
        lastAt: s.lastAt, archived: s.archived, turns: s.turns, kb: s.kb,
      })),
    });
  }
  out.sort((a, b) => (b.lastAt > a.lastAt ? 1 : -1));

  // 没被任何工作区收的会话 → 「未分组」
  const loose = items.filter((s) => !used.has(normId(s.id)));
  if (loose.length) {
    out.push({
      id: '(ungrouped)',
      title: '未分组',
      path: '',
      default: false,
      createdAt: '',
      updatedAt: '',
      sessionCount: loose.length,
      knownSessions: loose.length,
      activeCount: loose.filter((s) => !s.archived).length,
      lastAt: loose[0].lastAt,
      sessions: loose.slice(0, 8).map((s) => ({
        id: s.id, short: s.short, title: s.title, digest: s.digest,
        lastAt: s.lastAt, archived: s.archived, turns: s.turns, kb: s.kb,
      })),
    });
  }
  return out;
}

/* ---------- 6. 技能 / token 账 ---------- */
function readSkills() {
  let ents = [];
  try { ents = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }); } catch { }
  return ents.filter((e) => e.isDirectory()).map((e) => {
    const p = path.join(SKILLS_DIR, e.name);
    const md = path.join(p, 'SKILL.md');
    const head = rd(md).split(/\r?\n/).find((l) => /^\s*description\s*:/.test(l)) || '';
    return { name: e.name, path: p, kb: +(size(md) / 1024).toFixed(1), desc: head.replace(/^\s*description\s*:\s*/, '').slice(0, 80) };
  });
}
function readLedger() {
  const j = rj(LEDGER);
  if (!j) return null;
  const s = (o) => (o && (o.total ?? o.sum ?? o.cost)) || 0;
  return {
    tokens: j.tokens != null ? j.tokens : s(j.usage),
    cost: j.cost != null ? j.cost : s(j.total),
    sessions: Array.isArray(j.sessions) ? j.sessions.length : (j.bySession ? Object.keys(j.bySession).length : 0),
  };
}

/* ---------- 组装 ---------- */
const t0 = Date.now();
const S = readSessions();
const W = readWorkspaces(S.ws, S.items);
const K = readSkills();
const L = readLedger();
const countDir = (p) => { try { return fs.readdirSync(p).length; } catch { return 0; } };
const mb = (p) => { let n = 0; (function w(d) { let e = []; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const x of e) { const q = path.join(d, x.name); if (x.isDirectory()) w(q); else n += size(q); } })(p); return +(n / 1048576).toFixed(1); };

let archiveFiles = 0, archiveBytes = 0;
(function walk(d) { let e = []; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const x of e) { const q = path.join(d, x.name); if (x.isDirectory()) walk(q); else { archiveFiles++; archiveBytes += size(q); } } })(SESS_ARCHIVE);

const active = S.items.filter((s) => !s.archived).length;
const dataSources = {
  sessions: {
    path: PROJ_CACHE,
    board: DETAIL_FILE,
    count: S.items.length,
    active,
    archived: S.items.length - active,
    archiveFiles,
    archiveMB: +(archiveBytes / 1048576).toFixed(1),
    note: `引擎侧 ${S.items.length} 个会话（活 ${active} / 归档 ${S.items.length - active}）；${W.length} 个工作区；全量事件档案 ${archiveFiles} 个 ${(archiveBytes / 1048576).toFixed(1)}MB`,
    items: S.items.slice(0, 60),
  },
  workspaces: {
    path: WORKSPACE_FILE,
    count: W.length,
    note: `${W.length} 个工作区，共 ${W.reduce((n, w) => n + w.knownSessions, 0)} 个已知会话`,
    items: W,
  },
  skills: { path: SKILLS_DIR, count: K.length, items: K, note: '引擎 .dsh\\skills 下真正被加载的场景技能' },
  tools: { path: path.join(ROOT, '工具'), count: countDir(path.join(ROOT, '工具')), note: '工作台自己的脚本（引擎常驻 / 记忆同步 / 发消息 …）' },
  plugins: { path: path.join(ROOT, '插件'), count: countDir(path.join(ROOT, '插件')), note: '外壳插件目录' },
  mcp: { path: path.join(HOME, 'mcp'), count: countDir(path.join(HOME, 'mcp')), note: 'MCP 服务（baidupan / windows-mcp）' },
  health: {
    path: MEM,
    count: 0,
    note: L ? `token 账：${L.tokens || '?'} tokens · 费用 ${L.cost || '?'} · 覆盖 ${L.sessions || '?'} 个会话` : '无 cost-meter 台账',
    ledger: L,
  },
};

const map = rj(MAP_FILE) || { areas: [] };
map.dataSources = dataSources;
map.syncedAt = new Date().toISOString();
map.syncedBy = '工具/记忆同步.mjs';

const summary = [
  `会话        ${S.items.length} 个（活 ${active} / 归档 ${S.items.length - active}）`,
  `工作区      ${W.length} 个`,
  `技能        ${K.length} 个`,
  `事件档案    ${archiveFiles} 个 / ${(archiveBytes / 1048576).toFixed(1)}MB`,
  `引擎数据    ${mb(HOME)}MB`,
  `token 账    ${L ? (L.tokens + ' tokens / ' + L.cost) : '无'}`,
  `耗时        ${((Date.now() - t0) / 1000).toFixed(2)}s`,
].join('\n  ');

if (AS_JSON) { console.log(JSON.stringify(dataSources, null, 2)); process.exit(0); }

if (CHECK) {
  console.log('【--check 只读，不写盘】\n  ' + summary);
  console.log('\n  dataSources 键: ' + Object.keys(dataSources).join(', '));
  console.log('\n  工作区 → 最近会话:');
  W.forEach((w) => {
    console.log(`    ◆ ${w.title}  (${w.knownSessions}/${w.sessionCount} 条, 活 ${w.activeCount})  ${w.path}`);
    w.sessions.slice(0, 3).forEach((s) => console.log(`        · ${s.short} ${s.title}  |  ${(s.digest || '').slice(0, 60)}`));
  });
  process.exit(0);
}

if (!fs.existsSync(MEM)) { console.error('记忆目录不存在：' + MEM); process.exit(1); }
if (fs.existsSync(MAP_FILE)) {
  const bak = MAP_FILE + '.bak-memsync-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.copyFileSync(MAP_FILE, bak);
  console.log('已备份 ' + path.basename(bak));
}
fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 1) + '\n', 'utf8');
fs.writeFileSync(DETAIL_FILE, JSON.stringify({ syncedAt: map.syncedAt, workspaces: W, sessions: S.items, skills: K }, null, 1) + '\n', 'utf8');
fs.writeFileSync(CACHE_FILE, JSON.stringify(S.cache), 'utf8');

console.log('已写入 记忆地图.json 的 dataSources + 引擎会话.json\n  ' + summary);
console.log('\n面板生效：切走再切回「命令」场景，或按顶栏 ⟳。');
