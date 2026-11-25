// 工作区归组：把「不在任何工作区」的会话按 cwd 挂回对应的工作区
//
// 为什么要有这个脚本：
//   dsh 侧栏把会话显示在哪个工作区，看的是 `workspace.json` 里
//   `tables.workspaces[id].sessionIds` 这份**显式名单**，不是会话的 cwd。
//   而 dsh 只在「新建会话时带了 workspaceId」那一刻往名单里写一次；
//   之后再没有 API 能把老会话搬进工作区（workspace/addSession / moveSession 全部 404，
//   workspace/pinSession 只改 global.pinnedSessionIds，不是归属）。
//   引擎运行期间内存里那份 store 会把磁盘覆盖回去，所以**只能在引擎没跑时改盘**。
//
// 用法：
//   node 工具\工作区归组.mjs                          # 干跑：只报告能归谁
//   node 工具\工作区归组.mjs --apply                  # 真写：按 cwd 自动归到同 path 的工作区
//   node 工具\工作区归组.mjs --apply --from D:\AAAdafeiyu --to 91b2b920-...  # 把某目录下的会话塞进指定工作区
//   node 工具\工作区归组.mjs --apply --include-archived  # 连已归档的一起归（默认也归，因为它们本来就不显示）
//
// 幂等：已经在名单里的会话不会重复加。

import fs from 'node:fs';
import path from 'node:path';

const SHELL = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const HOME = path.join(SHELL, '引擎数据', '.dsh');
const WS_FILE = path.join(HOME, 'storages', 'workspace.json');
const SESS_DIR = path.join(HOME, 'storages', 'session_projcache', 'sessions');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const ONCE = argv.includes('--once');
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : '';
};
const FROM_CWD = argOf('--from');
const TO_WS = argOf('--to');
const TO_PATH = argOf('--to-path');
const ONCE_MARK = path.join(HOME, 'storages', '.regroup-once.done');

if (ONCE && fs.existsSync(ONCE_MARK)) {
  console.log('一次性归组已经做过了（' + path.basename(ONCE_MARK) + '），跳过。');
  process.exit(0);
}

if (!fs.existsSync(WS_FILE)) {
  console.error('找不到 workspace.json：' + WS_FILE);
  process.exit(1);
}

const ws = JSON.parse(fs.readFileSync(WS_FILE, 'utf8').replace(/^\uFEFF/, ''));
const tables = ws.tables && ws.tables.workspaces;
if (!tables) {
  console.error('workspace.json 结构不认识（没有 tables.workspaces）');
  process.exit(1);
}

// 现有归属
const owner = new Map();
for (const [wid, w] of Object.entries(tables)) {
  for (const sid of (w.sessionIds || [])) {
    owner.set(String(sid).replace(/^session-/, ''), wid);
  }
}

// 会话索引 → {id, cwd}
const sessions = [];
for (const f of fs.readdirSync(SESS_DIR)) {
  if (!/^session-.*\.json$/.test(f)) continue;
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(SESS_DIR, f), 'utf8')); } catch { continue; }
  const id = f.replace(/^session-/, '').replace(/\.json$/, '');
  const cwd = (j.record && j.record.identity && j.record.identity.cwd) || '';
  sessions.push({ id, cwd });
}

// 决定「谁归哪儿」
const plan = new Map(); // workspaceId -> sessionId[]
const addTo = (wid, sid) => {
  if (!plan.has(wid)) plan.set(wid, []);
  plan.get(wid).push(sid);
};

if (TO_WS || TO_PATH) {
  let wid = TO_WS;
  if (!wid && TO_PATH) {
    const want = path.resolve(TO_PATH).toLowerCase();
    for (const [id, w] of Object.entries(tables)) {
      if (w.path && path.resolve(String(w.path)).toLowerCase() === want) { wid = id; break; }
    }
    if (!wid) {
      console.error('--to-path 没有对应的工作区（先去 dsh 里建：' + TO_PATH + '）');
      process.exit(1);
    }
  }
  if (!tables[wid]) {
    console.error('--to 指向的工作区不存在：' + wid);
    process.exit(1);
  }
  const hit = sessions.filter((s) => !owner.has(s.id) && (!FROM_CWD || s.cwd === FROM_CWD));
  hit.forEach((s) => addTo(wid, s.id));
  console.log('指定归组：cwd=' + (FROM_CWD || '(不限)') + ' → ' + tables[wid].title + '，命中 ' + hit.length + ' 条');
} else {
  const byPath = new Map();
  for (const [wid, w] of Object.entries(tables)) {
    if (!w.path) continue;
    byPath.set(path.resolve(String(w.path)).toLowerCase(), wid);
  }
  const orphan = sessions.filter((s) => !owner.has(s.id));
  for (const s of orphan) {
    if (!s.cwd) continue;
    const wid = byPath.get(path.resolve(s.cwd).toLowerCase());
    if (wid) addTo(wid, s.id);
  }
  console.log('按 cwd 归组：未归属会话 ' + orphan.length + ' 条，能归到工作区的 ' + [...plan.values()].reduce((a, b) => a + b.length, 0) + ' 条');
}

if (!plan.size) {
  console.log('没有需要归组的会话。');
  process.exit(0);
}

for (const [wid, ids] of plan) {
  console.log('  ' + (tables[wid].title || wid) + '  ← ' + ids.length + ' 条');
}

if (!APPLY) {
  console.log('\n[dry] 加 --apply 真写磁盘（引擎必须在停止状态，否则会被内存态覆盖）');
  process.exit(0);
}

const bak = WS_FILE + '.bak-regroup-' + new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
fs.copyFileSync(WS_FILE, bak);
console.log('\n备份 → ' + path.basename(bak));

const now = new Date().toISOString();
let total = 0;
for (const [wid, ids] of plan) {
  const w = tables[wid];
  const before = (w.sessionIds || []).length;
  const set = new Set((w.sessionIds || []).map((x) => String(x).replace(/^session-/, '')));
  for (const id of ids) set.add(id);
  w.sessionIds = [...set];
  w.updatedAt = now;
  total += w.sessionIds.length - before;
}
if (!Array.isArray(ws.global.workspaceIds)) ws.global.workspaceIds = [];
for (const wid of plan.keys()) if (!ws.global.workspaceIds.includes(wid)) ws.global.workspaceIds.push(wid);

// --unarchive：把这些会话同时从「已归档」里放出来，否则归了组也看不见（侧栏默认不列已归档）
let unarchived = 0;
if (argv.includes('--unarchive')) {
  const all = Array.isArray(ws.global.archivedSessionIds) ? ws.global.archivedSessionIds : [];
  const want = new Set();
  for (const ids of plan.values()) for (const id of ids) want.add('session-' + String(id).replace(/^session-/, ''));
  const keep = all.filter((x) => {
    const k = 'session-' + String(x).replace(/^session-/, '');
    if (want.has(k)) { unarchived += 1; return false; }
    return true;
  });
  ws.global.archivedSessionIds = keep;
}

fs.writeFileSync(WS_FILE, JSON.stringify(ws, null, 2), 'utf8');
console.log('已写入，新增归属 ' + total + ' 条' + (unarchived ? '，取消归档 ' + unarchived + ' 条' : '') + '。');

if (ONCE) {
  try {
    fs.writeFileSync(ONCE_MARK, new Date().toISOString() + '\n' + [...plan.keys()].join(','), 'utf8');
    console.log('已记下一次性标记：' + path.basename(ONCE_MARK));
  } catch { /* 标记写不了就下次再跑一遍，反正幂等 */ }
}
