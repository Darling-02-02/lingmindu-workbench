#!/usr/bin/env node
// 会话整理：把「未命名」「未分组」的会话在 dsh 侧归档，让神经元和侧边栏工作区对齐。
//
//   node 工具\会话整理.mjs            # 只报告（不改任何东西）
//   node 工具\会话整理.mjs --apply    # 真的归档（走 workspace/archiveSession）
//   node 工具\会话整理.mjs --cwd D:\x # 只看某个 cwd 的
//   node 工具\会话整理.mjs --keep 5   # 最近 N 条不动（默认 3，刚开的会话别急着归档）
//   node 工具\会话整理.mjs --json
//
// 判定：
//   未命名 = projections.values.title 为空，或 blank===true（一次都没说话的会话）
//   未分组 = sessionId 不在 `storages\workspace.json` 任何工作区（tables.workspaces[*].sessionIds）里
//   已归档 = global.archivedSessionIds 里有它（不动）
//
// 归档走 dsh 的 rpc（`/api/workspace/archiveSession`），和 UI 里「归档」是同一件事。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const HOME = process.env.DSH_CUSTOMER_HOME || path.join(ROOT, '引擎数据', '.dsh');
const PORT = Number(process.env.DSH_PORT || 3093);
const BASE = 'http://127.0.0.1:' + PORT;
const WS_FILE = path.join(HOME, 'storages', 'workspace.json');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const JSONOUT = argv.includes('--json');
function flag(name, dflt) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const ONLY_CWD = typeof flag('cwd', '') === 'string' ? String(flag('cwd', '')) : '';
const KEEP_FRESH = Number(flag('keep', 3)) || 0;
const AGE_DAYS = Number(flag('age', 0)) || 0;      // >0 时只整理 N 天前的
const log = (...a) => { if (!JSONOUT) console.log(...a); };

// ---------- token / rpc ----------
function readToken() {
  const f = path.join(ROOT, '外壳', 'data', 'engine-token.json');
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    if (j && j.token) return j.token;
  } catch (e) { /* 回落 server.log */ }
  try {
    const logtxt = fs.readFileSync(path.join(ROOT, '外壳', 'server.log'), 'utf8');
    const m = logtxt.match(/dsh web:\s*http:\/\/127\.0\.0\.1:\d+\/\?token=([A-Za-z0-9_\-]{16,})/g);
    if (m && m.length) return m[m.length - 1].split('token=')[1];
  } catch (e) { /* ignore */ }
  throw new Error('找不到引擎 token（外壳\\data\\engine-token.json 或 外壳\\server.log）——引擎是不是没在跑？');
}

let cookie = '';
async function auth() {
  const r = await fetch(BASE + '/?token=' + encodeURIComponent(readToken()), { redirect: 'manual' });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
  cookie = String(sc[0] || '').split(';')[0];
  if (!cookie) throw new Error('换 cookie 失败（HTTP ' + r.status + '）');
}
async function rpc(method, args) {
  const r = await fetch(BASE + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'wb-clean', method, payload: { args } }),
  });
  const txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch (e) { throw new Error(method + ' 返回非 JSON：' + txt.slice(0, 200)); }
  if (j && j.error) throw new Error(method + ' → ' + (j.error.code || '') + ' ' + (j.error.message || JSON.stringify(j.error).slice(0, 200)));
  return j;
}

// ---------- 工作区表 ----------
function readWorkspaces() {
  const j = JSON.parse(fs.readFileSync(WS_FILE, 'utf8').replace(/^\uFEFF/, ''));
  const t = (j.tables && j.tables.workspaces) || {};
  const def = (j.global && j.global.defaultWorkspaceId) || '';
  const arch = new Set(((j.global && j.global.archivedSessionIds) || []).map(String).map(String));
  const bare = (s) => String(s).replace(/^session-/, '');
  const archBare = new Set([...arch].map(bare));
  const inWs = new Set();
  const own = {};
  Object.keys(t).forEach((id) => {
    const w = t[id] || {};
    (w.sessionIds || []).forEach((sid) => {
      inWs.add(bare(sid));
      if (!own[bare(sid)]) own[bare(sid)] = { id, title: w.title || id, path: w.path || '' };
    });
  });
  return { t, def, archBare, inWs, own };
}

// ---------- main ----------
const bare = (s) => String(s).replace(/^session-/, '');
await auth();
const res = await rpc('session/list', { _request: {} });
const items = (res && res.result && res.result.value && res.result.value.items) || [];
const ws = readWorkspaces();
const now = Date.now();

const rows = items.map((x) => {
  const sid = String(x.sessionId);
  const b = bare(sid);
  const vals = (x.projections && x.projections.values) || {};
  const title = String(vals.title || '').trim();
  const cwd = String(x.cwd || '');
  const ageH = Math.round((now - Number(x.updatedAt || 0)) / 3600000);
  return {
    id: sid, bare: b, title, cwd, blank: !!x.blank, running: !!x.running,
    turns: (vals.sessionStats && vals.sessionStats.turns) || 0,
    updatedAt: Number(x.updatedAt || 0), ageH,
    archived: ws.archBare.has(b),
    group: ws.own[b] || null,
    unnamed: !title || !!x.blank,
    ungrouped: !ws.inWs.has(b),
  };
}).filter((r) => (ONLY_CWD ? r.cwd.toLowerCase() === ONLY_CWD.toLowerCase() : true));

// 最近的 KEEP_FRESH 条不动
const byFresh = rows.slice().sort((a, b) => b.updatedAt - a.updatedAt);
const fresh = new Set(byFresh.slice(0, KEEP_FRESH).map((r) => r.bare));

const todo = rows.filter((r) => {
  if (r.archived || r.running) return false;
  if (fresh.has(r.bare)) return false;
  if (!(r.unnamed || r.ungrouped)) return false;
  if (AGE_DAYS > 0 && r.ageH < AGE_DAYS * 24) return false;
  return true;
});

const tally = {
  total: rows.length,
  archived: rows.filter((r) => r.archived).length,
  unnamed: rows.filter((r) => r.unnamed && !r.archived).length,
  ungrouped: rows.filter((r) => r.ungrouped && !r.archived).length,
  todo: todo.length,
};

if (JSONOUT) {
  console.log(JSON.stringify({ tally, todo }, null, 2));
} else {
  log('会话 ' + tally.total + ' 条：已归档 ' + tally.archived + '，未命名 ' + tally.unnamed + '，未分组 ' + tally.ungrouped);
  log('这次要归档 ' + todo.length + ' 条（最近 ' + KEEP_FRESH + ' 条不动，running 不动）');
  const show = todo.slice(0, 40);
  show.forEach((r) => {
    const why = [r.unnamed ? '未命名' : '', r.ungrouped ? '未分组' : ''].filter(Boolean).join('+');
    log('  [' + why + '] ' + r.bare.slice(0, 8) + '  ' + (r.title || '(空)').slice(0, 30).padEnd(32) + ' ' + r.cwd.replace(/^[A-Z]:\\/, '').slice(0, 46) + '  ' + r.ageH + 'h 前');
  });
  if (todo.length > show.length) log('  …还有 ' + (todo.length - show.length) + ' 条');
}

if (APPLY && todo.length) {
  let ok = 0, bad = 0;
  for (const r of todo) {
    try {
      await rpc('workspace/archiveSession', { request: { sessionId: r.id } });
      ok++;
    } catch (e) {
      // 有些会话要带 stopActivity 才肯归档
      try {
        await rpc('workspace/archiveSession', { request: { sessionId: r.id, stopActivity: true } });
        ok++;
      } catch (e2) {
        bad++;
        log('  ✗ ' + r.bare.slice(0, 8) + ' ' + e2.message);
      }
    }
  }
  log('\n归档完成：成功 ' + ok + '，失败 ' + bad);
  if (ok && !JSONOUT) log('接着跑 `node 工具\\记忆同步.mjs` 让神经元立刻看到（或面板点 ↻ 重读）。');
} else if (!APPLY && todo.length) {
  log('\n（这是只读报告。确认要归档就加 --apply）');
}
