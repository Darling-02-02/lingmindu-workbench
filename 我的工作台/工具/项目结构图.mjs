#!/usr/bin/env node
/**
 * 项目结构图（graphify 集成）
 * ---------------------------------------------------------------------------
 * 把工作台里每个工作区（= 一个真实项目目录）跑一遍 [graphify](https://github.com/Graphify-Labs/graphify)，
 * 产出三样东西，全部落在**工作台自己的缓存目录**里，不往项目仓库里塞任何文件：
 *
 *   <外壳>\data\project-maps\<工作区名>\
 *     graph.html     交互式知识图谱（vis.js，点节点/搜索/按社区上色）
 *     tree.html      D3 可折叠树 —— 「项目结构图」就是它：文件 → 符号逐层展开
 *     graph.json     原始图（节点/边/社区），可以拿来做查询
 *     meta.json      这份图的元信息（路径、构建时间、节点数、是否过期）
 *
 * 为什么要这么绕一层缓存：graphify 默认在**被分析的目录里**建 `graphify-out/`，
 * 那是用户自己的 git 仓库，工作台不该往里写东西（会脏 working tree、还会被误提交）。
 * 所以统一 `--out <缓存>`，把产物全挡在项目外面。
 *
 * 用法：
 *   node 工具\项目结构图.mjs --list [--json]         # 列所有工作区：有没有图、多少节点、是否过期
 *   node 工具\项目结构图.mjs --all [--stale]         # 全部重建（--stale 只做缺失/过期的）
 *   node 工具\项目结构图.mjs --ws "AAA刷B站"          # 只做这一个（按标题或 id 前缀匹配）
 *   node 工具\项目结构图.mjs --path D:\xxx --name 名字  # 任意目录，不必是工作区
 *   node 工具\项目结构图.mjs --clean                 # 清掉缓存里所有图
 *
 * 关键设计：
 *   1. **不需要任何 API key**。`--code-only` 只走本地 tree-sitter AST 抽符号和调用关系，
 *      不碰 LLM（docs/图片才需要模型，工作台这里不做，省得绑死一个 key）。
 *   2. **离线可用**。graphify 生成的 html 原本从 CDN 拉 vis-network / d3，这里生成后
 *      把 CDN 地址替换成 `../_vendor/*.js`（首次运行时下载一次存在缓存根目录），
 *      断网也能打开图。
 *   3. **增量**。graphify 自己有 manifest + AST cache，同一目录第二次跑只处理变了的文件；
 *      所以「自动重建」不需要我们自己算 diff，只要判断"源码最新时间 > 图构建时间"就够了。
 *   4. 找不到 graphify 时不会炸掉整个工作台：打印怎么装（`pip install graphifyy`），退出码 2。
 */
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));   // <根>\工具
const ROOT = path.dirname(HERE);                             // D:\AAAlingmindu_wb
const HOME = path.join(ROOT, '引擎数据', '.dsh');            // dsh 的 home（工作区清单在这）
const MAP_ROOT = path.join(ROOT, '外壳', 'data', 'project-maps');
const VENDOR = path.join(MAP_ROOT, '_vendor');
const WS_JSON = path.join(HOME, 'storages', 'workspace.json');

// 扫描源码时跳过的目录：不跳的话 node_modules 一项就能把 3 秒撑成 10 分钟，
// 而且图中的"结构"会被几万个第三方文件淹掉，完全看不出自己的项目长什么样。
const SKIP_DIR = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache', 'coverage',
  '.idea', '.vscode', 'graphify-out', '.gradle', '.cargo', 'Pods', 'DerivedData', '.DS_Store',
]);
const CODE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.h',
  '.cpp', '.hpp', '.cc', '.rb', '.cs', '.kt', '.scala', '.php', '.swift', '.lua', '.sh',
  '.ps1', '.bat', '.cmd', '.sql', '.vue', '.svelte', '.dart', '.ex', '.exs', '.zig', '.jl',
]);

// ---------- 命令行参数 ----------
const argv = process.argv.slice(2);
function flag(name, dflt) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return (v && v.charAt(0) !== '-') ? v : true;
}
const has = (name) => argv.indexOf('--' + name) >= 0;

// ---------- 找 graphify ----------
// 优先 `python -m graphify`：不依赖 PATH（pip 会把 exe 装到 %APPDATA%\Python\Python3xx\Scripts，
// 那个目录默认不在 PATH 里，用户按 pip 的提示手动加过才会 `graphify` 直接可用）。
function findGraphify() {
  const cands = [];
  const py = process.env.GRAPHIFY_PYTHON || process.env.PYTHON || 'python';
  cands.push({ cmd: py, pre: ['-m', 'graphify'] });
  // %APPDATA%\Python\Python3xx\Scripts\graphify.exe —— 版本号没法猜，直接扫
  try {
    const base = path.join(process.env.APPDATA || '', 'Python');
    fs.readdirSync(base).filter((d) => /^Python3\d+$/.test(d)).forEach((d) => {
      const exe = path.join(base, d, 'Scripts', 'graphify.exe');
      if (fs.existsSync(exe)) cands.push({ cmd: exe, pre: [] });
    });
  } catch (e) { /* 没有那个目录就算了 */ }
  cands.push({ cmd: 'graphify', pre: [] });

  for (const c of cands) {
    const r = spawnSync(c.cmd, c.pre.concat(['--help']), { encoding: 'utf8', timeout: 60000, windowsHide: true });
    if (r.status === 0 && String(r.stdout || '').indexOf('Usage: graphify') >= 0) return c;
  }
  return null;
}

function runG(g, args, opt) {
  opt = opt || {};
  const r = spawnSync(g.cmd, g.pre.concat(args), {
    encoding: 'utf8',
    timeout: opt.timeout || 1800000,      // 大项目 AST 抽一遍可能几分钟，给到 30 分钟
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    cwd: opt.cwd || ROOT,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    out: String(r.stdout || ''),
    err: String(r.stderr || '') || (r.error ? String(r.error.message) : ''),
    ms: 0,
  };
}

// ---------- 工作区清单 ----------
function loadWorkspaces() {
  const raw = JSON.parse(fs.readFileSync(WS_JSON, 'utf8'));
  const tables = (raw && raw.tables && raw.tables.workspaces) || {};
  const out = [];
  Object.keys(tables).forEach((id) => {
    const w = tables[id] || {};
    if (!w.path) return;
    out.push({ id: id, title: w.title || path.basename(w.path), path: w.path, sessions: (w.sessionIds || []).length });
  });
  // 会话多的排前面：说明那是他天天在用的项目，先给它出图
  out.sort((a, b) => b.sessions - a.sessions);
  return out;
}

// 目录名：工作区标题里去掉 Windows 非法字符；重名时后面补 id 前 8 位（不能靠标题赌唯一）
function keyOf(title, id) {
  const safe = String(title).replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'ws';
  return safe;
}
function uniqueKey(list) {
  const seen = new Map();
  list.forEach((w) => {
    const k = keyOf(w.title, w.id);
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    w.key = n === 1 ? k : k + '-' + String(w.id).slice(0, 8);
  });
  return list;
}

// ---------- 源码最新时间 ----------
// 用途：判断"图是不是过时了"。只看代码文件的 mtime —— 图里也只有代码符号，
// 文档/图片改动不会影响这份 code-only 图。
function newestSource(dir, maxFiles) {
  let newest = 0, count = 0;
  const stack = [dir];
  const limit = maxFiles || 20000;    // 防止超大目录把这一步变成瓶颈
  while (stack.length && count < limit) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) {
      if (count >= limit) break;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name)) continue;
        stack.push(p);
      } else if (e.isFile()) {
        if (!CODE_EXT.has(path.extname(e.name).toLowerCase())) continue;
        count++;
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs > newest) newest = st.mtimeMs;
        } catch (e2) { /* ignore */ }
      }
    }
  }
  return { newest: newest, files: count };
}

// ---------- 离线化：把图里的 CDN 依赖换成本地文件 ----------
const CDN_MAP = [
  ['https://unpkg.com/vis-network@9.1.6/standalone/umd/vis-network.min.js', '../_vendor/vis-network.min.js'],
  ['https://d3js.org/d3.v7.min.js', '../_vendor/d3.v7.min.js'],
];
function inlineDeps(htmlPath) {
  let html;
  try { html = fs.readFileSync(htmlPath, 'utf8'); } catch (e) { return { ok: false, err: '读不到 ' + htmlPath }; }
  // vendor 在就用本地副本（离线可用）；不在就保留 CDN 原地址（有网也能开），不制造白屏
  const okPairs = CDN_MAP.filter((p) => fs.existsSync(path.join(VENDOR, path.basename(p[1]))));
  const keptCdn = CDN_MAP.filter((p) => !fs.existsSync(path.join(VENDOR, path.basename(p[1])))).map((p) => path.basename(p[1]));
  let hits = 0;
  okPairs.forEach((pair) => {
    if (html.indexOf(pair[0]) >= 0) {
      html = html.split(pair[0]).join(pair[1]);
      hits++;
    }
  });
  if (hits) {
    try { fs.writeFileSync(htmlPath, html, 'utf8'); } catch (e) { return { ok: false, err: String(e.message) }; }
  }
  return { ok: true, replaced: hits, vendorMissing: keptCdn };
}

// ---------- 构建一个 ----------
function buildOne(g, ws, opt) {
  opt = opt || {};
  const key = ws.key || keyOf(ws.title, ws.id);
  const dir = path.join(MAP_ROOT, key);
  const outDir = path.join(dir, 'graphify-out');
  const metaFile = path.join(dir, 'meta.json');
  const t0 = Date.now();

  if (!fs.existsSync(ws.path)) {
    const meta = { key: key, id: ws.id, title: ws.title, path: ws.path, builtAt: 0, nodes: 0, edges: 0, err: '目录不存在' };
    return meta;
  }
  // 先数一下有没有代码文件：纯文档/图片/数据目录（比如刷B站工作区、空项目）跑 graphify
  // 只会得到 "graph is empty — extraction produced no nodes"，白等十几秒，不如直接说清楚。
  const pre = newestSource(ws.path);
  if (!pre.files) {
    return { key: key, id: ws.id, title: ws.title, path: ws.path, builtAt: 0, nodes: 0, edges: 0,
      files: 0, err: '这个目录里没有代码文件（只有文档/图片/数据），画不出结构图' };
  }
  // 自动模式（--max-files）只画小项目：超大目录一次要吃十几分钟 CPU（实测 89370 个节点 819 秒），
  // 放在后台自动跑等于把机器占死 —— 这种交给用户手动点「⚙ 现在画一张」或 --force。
  if (!opt.force && opt.maxFiles && pre.files > opt.maxFiles) {
    return { key: key, id: ws.id, title: ws.title, path: ws.path, builtAt: 0, nodes: 0, edges: 0,
      files: pre.files, skipped: 'too-big',
      err: '目录里有 ' + pre.files + ' 个代码文件，超过自动上限 ' + opt.maxFiles + '（--ws 名字 --force 才画）' };
  }
  fs.mkdirSync(dir, { recursive: true });

  // ① 抽图（--code-only = 纯本地 AST，不调模型）
  const args = ['extract', ws.path, '--code-only', '--out', dir];
  if (opt.force) args.push('--force');
  const r1 = runG(g, args, { timeout: opt.timeout });
  const graphJson = path.join(outDir, 'graph.json');
  if (!fs.existsSync(graphJson)) {
    return { key: key, id: ws.id, title: ws.title, path: ws.path, builtAt: 0, nodes: 0, edges: 0,
      err: '抽图失败：' + (r1.err || r1.out || '').split('\n').filter(Boolean).slice(-3).join(' | ') };
  }

  let g1 = {};
  try { g1 = JSON.parse(fs.readFileSync(graphJson, 'utf8')); } catch (e) { /* 读不动就当 0 */ }
  const nodes = (g1.nodes || []).length;
  const edges = (g1.links || g1.edges || []).length;
  const communities = Array.isArray(g1.communities) ? g1.communities.length
    : (g1.metadata && g1.metadata.community_count) || 0;

  // ② 交互图 + 可折叠树
  runG(g, ['export', 'html', '--graph', graphJson], { timeout: 300000 });
  const srcHtml = path.join(outDir, 'graph.html');
  const html = path.join(dir, 'graph.html');
  if (fs.existsSync(srcHtml)) {
    fs.copyFileSync(srcHtml, html);
    inlineDeps(html);
  }
  const tree = path.join(dir, 'tree.html');
  const r3 = runG(g, ['tree', '--graph', graphJson, '--output', tree, '--label', ws.title], { timeout: 300000 });
  if (fs.existsSync(tree)) inlineDeps(tree);

  const src = newestSource(ws.path);
  const meta = {
    key: key,
    id: ws.id,
    title: ws.title,
    path: ws.path,
    builtAt: Date.now(),
    ms: Date.now() - t0,
    nodes: nodes,
    edges: edges,
    communities: communities,
    files: src.files,
    newestSource: src.newest,
    html: fs.existsSync(html) ? 'graph.html' : '',
    tree: fs.existsSync(tree) ? 'tree.html' : '',
    graph: 'graphify-out/graph.json',
    err: r3.ok ? '' : ('tree 生成失败：' + (r3.err || '').split('\n').filter(Boolean).slice(-2).join(' | ')),
  };
  try { fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8'); } catch (e) { /* ignore */ }
  return meta;
}

// ---------- 读缓存现状 ----------
function readMeta(key) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(MAP_ROOT, key, 'meta.json'), 'utf8'));
    const src = fs.existsSync(m.path || '') ? newestSource(m.path) : { newest: 0, files: 0 };
    m.srcNewest = src.newest;
    m.stale = !!(m.builtAt && src.newest > m.builtAt + 60000);   // 一分钟容差，免得刚跑完就判过期
    m.hasGraph = !!(m.builtAt && fs.existsSync(path.join(MAP_ROOT, key, 'graphify-out', 'graph.json')));
    return m;
  } catch (e) { return null; }
}

function listAll() {
  const list = uniqueKey(loadWorkspaces());
  return list.map((w) => {
    const m = readMeta(w.key) || {};
    return {
      key: w.key, id: w.id, title: w.title, path: w.path, sessions: w.sessions,
      exists: fs.existsSync(w.path),
      hasGraph: !!m.hasGraph,
      nodes: m.nodes || 0, edges: m.edges || 0, communities: m.communities || 0,
      files: m.files || 0,
      builtAt: m.builtAt || 0,
      stale: !!m.stale,
      err: m.err || '',
    };
  });
}

function fmtTime(ms) { return ms ? new Date(ms).toLocaleString('sv-SE').slice(5, 16) : '—'; }

// ---------- 主流程 ----------
function main() {
  const asJson = has('json');

  if (has('clean')) {
    ['graphify-out', 'graph.html', 'tree.html', 'meta.json'].forEach((n) => {
      // 只清子目录内容，保留 _vendor（那是离线依赖，删了还得重下）
      fs.readdirSync(MAP_ROOT, { withFileTypes: true }).forEach((e) => {
        if (!e.isDirectory() || e.name.charAt(0) === '_') return;
        const p = path.join(MAP_ROOT, e.name, n);
        try { fs.rmSync(p, { recursive: true, force: true }); } catch (err) { /* ignore */ }
      });
    });
    console.log('已清空 ' + MAP_ROOT + ' 下的图（_vendor 保留）');
    return 0;
  }

  const rows = listAll();

  if (has('list') || (!has('all') && !has('ws') && !has('path'))) {
    if (asJson) { console.log(JSON.stringify({ ok: true, maps: rows, dir: MAP_ROOT }, null, 2)); return 0; }
    console.log('工作区结构图（缓存 ' + MAP_ROOT + '）\n');
    console.log('  ' + pad('工作区', 22) + pad('文件', 6) + pad('节点', 7) + pad('边', 7) + pad('构建于', 13) + '状态');
    rows.forEach((r) => {
      let st = '—';
      if (!r.exists) st = '目录不存在';
      else if (!r.hasGraph) st = '还没做';
      else if (r.stale) st = '过时了（源码比图新）';
      else st = '最新';
      if (r.err) st += '  ⚠ ' + r.err.slice(0, 40);
      console.log('  ' + pad(r.title, 22) + pad(String(r.files || '—'), 6) + pad(String(r.nodes || '—'), 7)
        + pad(String(r.edges || '—'), 7) + pad(fmtTime(r.builtAt), 13) + st);
    });
    console.log('\n  要出图：node 工具\\项目结构图.mjs --all --stale');
    return 0;
  }

  const g = findGraphify();
  if (!g) {
    const msg = '没找到 graphify。装一下：pip install graphifyy   （然后重跑本命令；'
      + ' 想指定解释器就设 GRAPHIFY_PYTHON=C:\\Python314\\python.exe）';
    if (asJson) console.log(JSON.stringify({ ok: false, err: msg }));
    else console.error(msg);
    return 2;
  }
  if (!fs.existsSync(VENDOR)) fs.mkdirSync(VENDOR, { recursive: true });

  // 后台画图不抢前台：把自己降到 Below Normal（Windows 上等价 /low）。
  // 大项目会慢一点，但用户点什么都不会卡 —— 这是"开机被拉满"的直接解药之一。
  try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { /* 平台不支持就算了 */ }
  const maxFiles = Number(flag('max-files', 0)) || 0;

  // ---- 单个工作区 ----
  if (has('ws')) {
    const want = String(flag('ws', '')).trim();
    const hit = rows.filter((r) => r.title === want || r.id === want || String(r.id).indexOf(want) === 0
      || r.key === want || r.title.indexOf(want) >= 0);
    if (!hit.length) {
      console.error('没有匹配的工作区：' + want + '\n可选：' + rows.map((r) => r.title).join(' / '));
      return 1;
    }
    const w = hit[0];
    console.log('[结构图] ' + w.title + ' → ' + w.path);
    const meta = buildOne(g, w, { force: has('force'), maxFiles: maxFiles });
    console.log(JSON.stringify(meta, null, 2));
    return meta.err ? 1 : 0;
  }

  // ---- 任意目录 ----
  if (has('path')) {
    const p = path.resolve(String(flag('path', '')));
    const w = { id: 'manual', title: String(flag('name', path.basename(p))), path: p, key: keyOf(String(flag('name', path.basename(p))), 'manual') };
    console.log('[结构图] ' + w.title + ' → ' + p);
    const meta = buildOne(g, w, { force: has('force'), maxFiles: maxFiles });
    console.log(JSON.stringify(meta, null, 2));
    return meta.err ? 1 : 0;
  }

  // ---- 全部 ----
  const staleOnly = has('stale');
  const todo = rows.filter((r) => r.exists && (!staleOnly || !r.hasGraph || r.stale));
  console.log('[结构图] 待处理 ' + todo.length + ' / ' + rows.length + ' 个工作区'
    + (staleOnly ? '（只做缺失或过时的）' : ''));
  let okN = 0, failN = 0;
  const results = [];
  for (const w of todo) {
    const t = Date.now();
    process.stdout.write('  · ' + pad(w.title, 22));
    const meta = buildOne(g, w, { force: has('force'), maxFiles: maxFiles });
    results.push(meta);
    if (meta.err) { failN++; console.log('✗ ' + meta.err.slice(0, 70)); }
    else { okN++; console.log('✓ ' + meta.nodes + ' 节点 / ' + meta.edges + ' 边 / ' + Math.round((Date.now() - t) / 1000) + 's'); }
  }
  console.log('[结构图] 完成：成功 ' + okN + '，失败 ' + failN);
  if (asJson) console.log(JSON.stringify({ ok: true, results: results }, null, 2));
  return failN ? 1 : 0;
}

function pad(s, n) {
  s = String(s);
  let w = 0;
  for (const ch of s) w += (ch.charCodeAt(0) > 255 ? 2 : 1);
  return s + ' '.repeat(Math.max(1, n - w));
}

process.exitCode = main();
