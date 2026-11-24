#!/usr/bin/env node
/**
 * 接口体检 —— 逐个探 DSH 引擎的 /api/<method>，看工作区/会话相关接口是不是真的活着。
 *
 *   node 工具\接口体检.mjs            # 只读探测（不建、不改、不归档）
 *   node 工具\接口体检.mjs --write    # 加测写接口（会建一个 "接口体检-<时间>" 会话，测完归档）
 *   node 工具\接口体检.mjs --json     # 机器可读
 *
 * 判据：HTTP 200 且 body 里没有 {error}，且有 result 或明确空结果 = OK；
 *       400/404 + "unknown method" = 引擎没有这个方法；其它算 FAIL 并把原文打出来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const HOME = process.env.DSH_CUSTOMER_HOME || path.join(ROOT, '引擎数据', '.dsh');
const TOKEN_FILE = path.join(ROOT, '外壳', 'data', 'engine-token.json');
const LOG = path.join(ROOT, '外壳', 'server.log');

const args = process.argv.slice(2);
const DO_WRITE = args.includes('--write');
const AS_JSON = args.includes('--json');

function readToken() {
  try {
    const j = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8').replace(/^\uFEFF/, ''));
    if (j && j.token) return { base: `http://127.0.0.1:${j.port || 3093}`, token: j.token, from: 'engine-token.json' };
  } catch (e) { /* 往下走 */ }
  try {
    const txt = fs.readFileSync(LOG, 'utf8');
    const re = /dsh web:\s*(http:\/\/127\.0\.0\.1:(\d+))\/\?token=([A-Za-z0-9_\-]{16,})/g;
    let m; let last = null;
    while ((m = re.exec(txt))) last = m;
    if (last) return { base: last[1], token: last[3], from: 'server.log', port: Number(last[2]) };
  } catch (e) { /* ignore */ }
  return null;
}

const auth = readToken();
if (!auth) {
  console.error('读不到引擎 token：先跑 node 工具\\引擎常驻.mjs status，确认 3093 在跑。');
  process.exit(2);
}

let cookie = '';
async function login() {
  const r = await fetch(auth.base + '/?token=' + encodeURIComponent(auth.token), { redirect: 'manual' });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
  cookie = sc.map((s) => String(s).split(';')[0]).join('; ');
  return { status: r.status, cookie: !!cookie };
}

let rpcSeq = 0;
// 注意：payload.args 必须是**单个 plain object**（实测引擎回 "Remote payload must contain exactly one plain-object args field"）
async function rpc(method, argsObj) {
  const body = { type: 'client-request', rpcId: 'probe' + (++rpcSeq), method, payload: { args: argsObj || {} } };
  const r = await fetch(auth.base + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', cookie },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 json */ }
  return { http: r.status, json, text };
}

// 探测表：[方法, 读写, args 构造, 该方法的 args 外壳字段名]
// 实测：session/list 的 descriptor 认 `_request`，其余工作区/会话方法认 `request` —— 写错字段名会回
//   gateway/arguments-invalid（说明方法存在、参数不对），404 not found 才是真没这个方法。
const ARG = (k, v) => ({ [k]: v });
const PROBES = [
  ['session/list', 'read', () => ARG('_request', {}), '_request'],
  ['session/search', 'read', () => ARG('request', { query: '', limit: 1 }), 'request'],
  ['workspace/create', 'write', null, 'request'],
  ['workspace/rename', 'write', null, 'request'],
  ['workspace/pinSession', 'write', null, 'request'],
  ['workspace/archiveSession', 'write', null, 'request'],
  ['workspace/unarchiveSession', 'write', null, 'request'],
  ['session/create', 'write', null, 'request'],
  ['session/rename', 'write', null, 'request'],
];
// 已知不存在的方法（留档，避免以后又去试）
const ABSENT = ['workspace/list', 'workspace/remove', 'session/info', 'session/archive', 'session/delete', 'session/messages', 'session/history', 'session/recent'];

function classify(res) {
  if (res.http === 200) {
    const j = res.json || {};
    const r = j.result || {};
    const err = r.error || j.error;
    if (err) {
      const msg = typeof err === 'string' ? err : (err.message || JSON.stringify(err));
      if (/unknown method|no such method/i.test(msg)) return { verdict: 'NO-METHOD', detail: msg };
      if (/arguments-invalid|do not match the descriptor/i.test(msg)) return { verdict: 'ARGS-BAD', detail: msg };
      return { verdict: 'ERR', detail: msg.slice(0, 140) };
    }
    return { verdict: 'OK', detail: '', value: r.value };
  }
  const t = (res.text || '').replace(/\s+/g, ' ').slice(0, 160);
  if (res.http === 404 && /not found|unknown/i.test(t)) return { verdict: 'NO-METHOD', detail: t };
  return { verdict: 'FAIL ' + res.http, detail: t };
}

const out = { auth: { base: auth.base, from: auth.from }, rows: [] };

await login();

// 1) 文件层：workspace.json 结构是否可读
try {
  const ws = JSON.parse(fs.readFileSync(path.join(HOME, 'storages', 'workspace.json'), 'utf8').replace(/^\uFEFF/, ''));
  const t = (ws.tables && ws.tables.workspaces) || {};
  const ids = Object.keys(t);
  out.workspaceFile = {
    ok: ids.length > 0,
    workspaces: ids.length,
    defaultWorkspaceId: ws.global && ws.global.defaultWorkspaceId,
    archivedSessions: (ws.global && ws.global.archivedSessionIds || []).length,
    withPath: ids.filter((k) => t[k] && t[k].path).length,
    withSessions: ids.filter((k) => t[k] && (t[k].sessionIds || []).length).length,
  };
} catch (e) {
  out.workspaceFile = { ok: false, error: String(e.message || e) };
}

// 2) rpc 层逐个探
for (const [method, mode, mk] of PROBES) {
  if (mode === 'write' && !DO_WRITE) {
    out.rows.push({ method, mode, verdict: 'SKIP', detail: '加 --write 才测' });
    continue;
  }
  if (!mk) {
    out.rows.push({ method, mode, verdict: 'SKIP', detail: '写链路在下面单独跑' });
    continue;
  }
  const res = await rpc(method, mk());
  const c = classify(res);
  out.rows.push({ method, mode, verdict: c.verdict, detail: c.detail, http: res.http, value: c.value });
}

// 2b) 用 session/list 返回的东西证明"接口真的在干活"（不只是 200）
{
  const sl = out.rows.find((r) => r.method === 'session/list');
  if (sl && sl.verdict === 'OK' && sl.value && Array.isArray(sl.value.items)) {
    const it = sl.value.items;
    const fields = it.length ? Object.keys(it[0]) : [];
    out.sessionList = {
      ok: true,
      items: it.length,
      running: it.filter((x) => x.running).length,
      blank: it.filter((x) => x.blank).length,
      withCwd: it.filter((x) => !!x.cwd).length,
      fields,
      newest: it.slice(0, 3).map((x) => ({ id: String(x.sessionId).replace(/^session-/, '').slice(0, 8), updatedAt: x.updatedAt })),
    };
  } else if (sl) {
    out.sessionList = { ok: false, verdict: sl.verdict, detail: sl.detail };
  }
}

// 3) 写链路（--write）：建 → 改名 → 归档，一条链验证三个接口并清理现场
if (DO_WRITE) {
  const wsJson = JSON.parse(fs.readFileSync(path.join(HOME, 'storages', 'workspace.json'), 'utf8').replace(/^\uFEFF/, ''));
  const tables = (wsJson.tables && wsJson.tables.workspaces) || {};
  const list = Object.keys(tables).map((k) => ({ id: k, ...tables[k] }));
  const target = list.find((w) => /AAAlingmindu_wb/.test(w.path || '')) || list.find((w) => w.path) || null;
  const chain = { workspace: target ? { id: target.id, path: target.path } : null };

  const c1 = await rpc('session/create', { request: { workspaceId: target && target.id } });
  const sid = c1.json && c1.json.result && c1.json.result.value && c1.json.result.value.sessionId;
  chain.create = { ...classify(c1), sessionId: sid || null, http: c1.http, sample: (c1.text || '').slice(0, 220) };

  if (sid) {
    await new Promise((r) => setTimeout(r, 800));
    const c2 = await rpc('session/rename', { request: { sessionId: sid, title: '接口体检-' + new Date().toISOString().slice(11, 19) } });
    chain.rename = { ...classify(c2), http: c2.http, sample: (c2.text || '').slice(0, 220) };

    const c3 = await rpc('workspace/archiveSession', { request: { sessionId: sid } });
    let c3b = c3;
    if (c3.http !== 200 || (c3.json && c3.json.error)) {
      await new Promise((r) => setTimeout(r, 500));
      c3b = await rpc('workspace/archiveSession', { request: { sessionId: sid, stopActivity: true } });
    }
    chain.archive = { ...classify(c3b), http: c3b.http, sample: (c3b.text || '').slice(0, 220) };

    // 用文件判据复核归档是否真的落盘
    try {
      const after = JSON.parse(fs.readFileSync(path.join(HOME, 'storages', 'workspace.json'), 'utf8').replace(/^\uFEFF/, ''));
      const arch = (after.global && after.global.archivedSessionIds) || [];
      chain.archivedOnDisk = arch.includes(sid);
    } catch (e) { chain.archivedOnDisk = null; }
    chain.sessionId = sid;
  }
  out.writeChain = chain;
}

if (AS_JSON) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log('引擎 ' + auth.base + '（token 来自 ' + auth.from + '）\n');
  const wf = out.workspaceFile;
  console.log('【文件层】storages\\workspace.json  ' + (wf.ok ? 'OK' : 'FAIL'));
  if (wf.ok) {
    console.log('   工作区 ' + wf.workspaces + ' 个（有 path ' + wf.withPath + ' / 有会话 ' + wf.withSessions
      + '）· 默认 ' + (wf.defaultWorkspaceId || '').slice(0, 8) + '… · 已归档会话 ' + wf.archivedSessions);
  } else {
    console.log('   ' + wf.error);
  }
  console.log('\n【接口层】');
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
  for (const r of out.rows) {
    console.log('   ' + pad(r.method, 28) + pad(r.mode, 7) + r.verdict + (r.detail ? '  — ' + r.detail : ''));
  }
  if (out.sessionList) {
    const s = out.sessionList;
    console.log('\n【session/list 实证】' + (s.ok
      ? '返回 ' + s.items + ' 条会话 · 跑着 ' + s.running + ' · 空会话 ' + s.blank + ' · 有 cwd ' + s.withCwd
        + '\n   字段：' + s.fields.join(', ')
      : '不可用（' + s.verdict + '）'));
  }
  console.log('\n【已知不存在】' + ABSENT.join('、'));
  console.log('   （404 not found；engine 用 workspace.json + 上面那批方法，没有 list/delete 这类）');
  if (out.writeChain) {
    const c = out.writeChain;
    console.log('\n【写链路】建 → 改名 → 归档');
    console.log('   工作区 ' + (c.workspace ? c.workspace.path : '（未找到）'));
    for (const k of ['create', 'rename', 'archive']) {
      if (!c[k]) continue;
      console.log('   ' + pad(k, 9) + c[k].verdict + (c[k].sample ? '  — ' + (c[k].sample || '').replace(/\s+/g, ' ').slice(0, 100) : ''));
    }
    if (c.sessionId) console.log('   会话 ' + c.sessionId + ' · 归档落盘：' + (c.archivedOnDisk ? '是' : '否'));
  }
}
