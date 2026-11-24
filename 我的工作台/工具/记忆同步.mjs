#!/usr/bin/env node
/**
 * 记忆同步.mjs —— 把 dsh 引擎的真实运行状态灌进工作台「记忆神经元」面板。
 *
 * 为什么需要它：
 *   面板读的是 引擎数据\.dsh\场景记忆\_共享记忆\记忆地图.json（renderers.js:17994 + 18106）。
 *   那个文件里的 dataSources 一直空着，所以面板只有一张 2026-11-16 手画的地图。
 *   引擎里真正发生的事（47 个会话、11 个工作区、4 个技能、token 账）全在
 *   storages\session_projcache 和 storages\workspace.json 里，面板一个都看不见。
 *
 * 它做什么：
 *   只读引擎数据，只写 _共享记忆\记忆地图.json 的 dataSources 段 + 同目录 引擎会话.json（明细）。
 *   areas 段原样保留，绝不改 场景私有记忆.md。
 *
 * 用法：
 *   node 工具\记忆同步.mjs            # 同步并落盘（首次会备份 记忆地图.json）
 *   node 工具\记忆同步.mjs --check    # 只打印，不写盘
 *   node 工具\记忆同步.mjs --json     # 打印生成的 dataSources
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const HOME = path.join(ROOT, '引擎数据', '.dsh');
const MEM = path.join(HOME, '场景记忆', '_共享记忆');
const MAP_FILE = path.join(MEM, '记忆地图.json');
const DETAIL_FILE = path.join(MEM, '引擎会话.json');
const PROJ_CACHE = path.join(HOME, 'storages', 'session_projcache', 'sessions');
const WORKSPACE_FILE = path.join(HOME, 'storages', 'workspace.json');
const SESS_ARCHIVE = path.join(HOME, 'sessions');
const SKILLS_DIR = path.join(HOME, 'skills');
const LEDGER = path.join(HOME, 'storages', 'cost-meter', 'ledger.json');

const CHECK = process.argv.includes('--check');
const AS_JSON = process.argv.includes('--json');

const rd = (p) => { try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return ''; } };
const rj = (p) => { try { return JSON.parse(rd(p)); } catch { return null; } };
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
const size = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
const iso = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '');

/* ---------- 1. 会话（session_projcache 是引擎自己的会话索引缓存） ---------- */
function readSessions() {
  let files = [];
  try { files = fs.readdirSync(PROJ_CACHE).filter((f) => /^session-.*\.json$/.test(f)); } catch { }

  const ctx = new Map();   // cwd → 该目录下所有会话
  const out = [];
  for (const f of files) {
    const p = path.join(PROJ_CACHE, f);
    const j = rj(p);
    if (!j || !j.record) continue;
    const rec = j.record;
    const rows = rec.rows || {};
    const num = (k) => (rows[k] && typeof rows[k].seq === 'number' ? rows[k].seq : 0);
    const id = f.replace(/\.json$/, '');

    let seq = 0;
    for (const k of Object.keys(rows)) seq = Math.max(seq, num(k));

    const goalVal = rows.goal && rows.goal.val;
    const cur = goalVal && goalVal.current;
    const item = {
      id,
      title: (rows.title && rows.title.val) || '(未命名)',
      cwd: (rec.identity && rec.identity.cwd) || '',
      createdAt: iso(rec.identity && rec.identity.createdAt),
      seq,
      goal: (cur && (cur.objective || cur.text || cur.title)) || '',
      archived: false,
      sandbox: (rows.sandboxMode && rows.sandboxMode.val) || '',
      mtime: iso(mtime(p)),
      kb: +(size(p) / 1024).toFixed(1),
    };
    out.push(item);
    if (item.cwd) {
      if (!ctx.has(item.cwd)) ctx.set(item.cwd, []);
      ctx.get(item.cwd).push(item);
    }
  }

  // 归档标记来自 workspace.json（引擎 UI 的"已归档"就是它）
  const ws = rj(WORKSPACE_FILE);
  const archived = new Set((ws && ws.global && ws.global.archivedSessionIds) || []);
  out.forEach((s) => { s.archived = archived.has(s.id); });

  // 工作区：id → 目录（workspace.json 的 workspaces 段结构兜底处理）
  const workspaces = [];
  const wsList = (ws && (ws.workspaces || ws.items)) || [];
  if (Array.isArray(wsList)) {
    wsList.forEach((w) => {
      if (!w) return;
      const dir = w.cwd || w.path || w.root || '';
      if (!dir) return;
      workspaces.push({
        id: w.id || dir,
        name: w.name || path.basename(dir),
        path: dir,
        sessions: (ctx.get(dir) || []).length,
        default: !!(ws.global && ws.global.defaultWorkspaceId === w.id),
      });
    });
  }
  if (!workspaces.length) {
    for (const [dir, list] of ctx) workspaces.push({ id: dir, name: path.basename(dir), path: dir, sessions: list.length, default: false });
  }

  // 全量事件档案（sessions\*.zstd）—— 面板点"会话档案"时给人一个体量感
  let archiveFiles = 0, archiveBytes = 0;
  (function walk(d) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { archiveFiles++; archiveBytes += size(p); }
    }
  })(SESS_ARCHIVE);

  out.sort((a, b) => (b.mtime > a.mtime ? 1 : -1));
  return {
    items: out,
    active: out.filter((s) => !s.archived).length,
    archivedCount: out.filter((s) => s.archived).length,
    workspaces,
    archiveFiles,
    archiveMB: +(archiveBytes / 1048576).toFixed(1),
  };
}

/* ---------- 2. 技能（引擎真正加载的 skills 目录） ---------- */
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

/* ---------- 3. token 账（cost-meter） ---------- */
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

/* ---------- 组装 dataSources ---------- */
const S = readSessions();
const K = readSkills();
const L = readLedger();
const skillCount = (() => { try { return fs.readdirSync(SKILLS_DIR).length; } catch { return 0; } })();
const countDir = (p) => { try { return fs.readdirSync(p).length; } catch { return 0; } };
const mb = (p) => { let n = 0; (function w(d) { let e = []; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const x of e) { const q = path.join(d, x.name); if (x.isDirectory()) w(q); else n += size(q); } })(p); return +(n / 1048576).toFixed(1); };

const dataSources = {
  sessions: {
    path: PROJ_CACHE,
    board: DETAIL_FILE,
    count: S.items.length,
    active: S.active,
    archived: S.archivedCount,
    archiveFiles: S.archiveFiles,
    archiveMB: S.archiveMB,
    note: `引擎侧 ${S.items.length} 个会话（活 ${S.active} / 归档 ${S.archivedCount}）；全量事件档案 ${S.archiveFiles} 个文件 ${S.archiveMB}MB`,
    workspaces: S.workspaces,
    items: S.items.slice(0, 60),
    syncedAt: new Date().toISOString(),
  },
  skills: { path: SKILLS_DIR, count: skillCount, items: K, note: '引擎 .dsh\\skills 下真正被加载的场景技能' },
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

if (AS_JSON) { console.log(JSON.stringify(dataSources, null, 2)); process.exit(0); }

const summary = [
  `会话        ${S.items.length} 个（活 ${S.active} / 归档 ${S.archivedCount}）`,
  `工作区      ${S.workspaces.length} 个`,
  `技能        ${skillCount} 个`,
  `事件档案    ${S.archiveFiles} 个 / ${S.archiveMB}MB`,
  `引擎数据    ${mb(HOME)}MB`,
  `token 账    ${L ? (L.tokens + ' tokens / ' + L.cost) : '无'}`,
].join('\n  ');

if (CHECK) {
  console.log('【--check 只读，不写盘】\n  ' + summary);
  console.log('\n  dataSources 键: ' + Object.keys(dataSources).join(', '));
  console.log('  前 5 个会话:');
  S.items.slice(0, 5).forEach((s) => console.log(`    · ${s.title.padEnd(10)} seq=${String(s.seq).padStart(3)} ${s.mtime}  ${s.cwd}`));
  process.exit(0);
}

if (!fs.existsSync(MEM)) { console.error('记忆目录不存在：' + MEM); process.exit(1); }
if (fs.existsSync(MAP_FILE)) {
  const bak = MAP_FILE + '.bak-memsync-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.copyFileSync(MAP_FILE, bak);
  console.log('已备份 ' + path.basename(bak));
}
fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 1) + '\n', 'utf8');
fs.writeFileSync(DETAIL_FILE, JSON.stringify({ syncedAt: map.syncedAt, sessions: S.items, workspaces: S.workspaces, skills: K }, null, 1) + '\n', 'utf8');

console.log('已写入 记忆地图.json 的 dataSources + 引擎会话.json\n  ' + summary);
console.log('\n面板生效：切走再切回「命令」场景，或按顶栏 ⟳。');
