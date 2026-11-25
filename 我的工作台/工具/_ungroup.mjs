// 临时：算出「未分组」到底是哪些会话（磁盘 + 引擎两个口径）
import fs from 'node:fs';
import path from 'node:path';

const HOME = 'D:\\AAAlingmindu_wb\\引擎数据\\.dsh';
const ws = JSON.parse(fs.readFileSync(path.join(HOME, 'storages', 'workspace.json'), 'utf8'));
const assigned = new Set();
const wsList = [];
for (const [id, w] of Object.entries(ws.tables.workspaces || {})) {
  wsList.push({ id, title: w.title, path: w.path, n: (w.sessionIds || []).length });
  for (const s of w.sessionIds || []) assigned.add(s);
}
const archived = new Set(ws.global.archivedSessionIds || []);

const token = JSON.parse(fs.readFileSync('D:\\AAAlingmindu_wb\\外壳\\data\\engine-token.json', 'utf8')).token;
const base = 'http://127.0.0.1:3093';
const r1 = await fetch(base + '/?token=' + encodeURIComponent(token), { redirect: 'manual' });
const sc = r1.headers.getSetCookie ? r1.headers.getSetCookie() : [r1.headers.get('set-cookie')].filter(Boolean);
const cookie = sc.map((s) => String(s).split(';')[0]).join('; ');

let seq = 0;
async function rpc(method, argsObj) {
  const body = { type: 'client-request', rpcId: 'u' + (++seq), method, payload: { args: argsObj || {} } };
  const r = await fetch(base + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', cookie },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  return j;
}

const j = await rpc('session/list', { _request: {} });
const v = j.result && j.result.value;
const items = (v && v.items) || [];
const ungrouped = items.filter((it) => !assigned.has(it.sessionId));
const byCwd = {};
for (const it of ungrouped) {
  const c = it.cwd || '(none)';
  byCwd[c] = byCwd[c] || { total: 0, archived: 0, live: 0, titles: [] };
  byCwd[c].total++;
  if (archived.has(it.sessionId)) byCwd[c].archived++; else byCwd[c].live++;
  const t = (it.projections && it.projections.values && it.projections.values.title) || '(未命名)';
  if (byCwd[c].titles.length < 5) byCwd[c].titles.push(t.slice(0, 34));
}

const live = Object.entries(byCwd).filter(([, v]) => v.live > 0).sort((a, b) => b[1].live - a[1].live);
const liveItems = ungrouped.filter((it) => !archived.has(it.sessionId))
  .map((it) => ({ at: it.updatedAt, sid: String(it.sessionId).slice(-8), cwd: it.cwd }))
  .sort((a, b) => String(b.at).localeCompare(String(a.at)));
console.log(JSON.stringify({
  engineItems: items.length,
  archivedCount: archived.size,
  ungroupedTotal: ungrouped.length,
  ungroupedLive: liveItems.length,
  liveRecent: liveItems.slice(0, 6),
  liveOldest: liveItems.slice(-2),
  cwdCount: Object.keys(byCwd).length,
  liveByCwd: Object.fromEntries(live.map(([c, v]) => [c, { live: v.live, archived: v.archived }])),
}, null, 2));
