#!/usr/bin/env node
/**
 * 引擎常驻管家（2026-11-23）
 * ---------------------------------------------------------------
 * 为什么需要它：
 *   壳（外壳/main.js）现在默认**关窗不杀引擎**（DSH_KEEP_ENGINE=1），
 *   所以引擎可以活在壳之外。但"壳从没开过，引擎却要在线"这种情况，得有人先把它拉起来。
 *   这个脚本就是那个人 —— 它不依赖 Electron，纯 node，可以被计划任务/开机自启直接调用。
 *
 * 用法：
 *   node 工具\引擎常驻.mjs status      # 引擎活着吗、token 有没有、日志在哪
 *   node 工具\引擎常驻.mjs start       # 没跑就 detached 拉起（已跑则什么都不做）
 *   node 工具\引擎常驻.mjs stop        # 停掉（按端口找 PID，连子进程一起）
 *   node 工具\引擎常驻.mjs restart
 *   node 工具\引擎常驻.mjs token       # 只打印 token（给别的脚本用）
 *
 * 与外壳的约定（两边必须一致，改一边就要改另一边）：
 *   DSH_HOME   = <根>\引擎数据\.dsh
 *   CLI 入口   = <根>\引擎\apps\cli\lib\bin.js
 *   token 文件 = <根>\外壳\data\engine-token.json   {"token":"…","port":"3093","at":"…"}
 *   引擎输出   = <根>\外壳\data\engine.out.log
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);                       // <根>
const HARNESS = path.join(ROOT, '引擎');
const CLI = path.join(HARNESS, 'apps', 'cli', 'lib', 'bin.js');
const SHELL_DIR = path.join(ROOT, '外壳');
const DSH_HOME = path.join(ROOT, '引擎数据', '.dsh');
const PORT = String(process.env.DSH_PORT || '3093');
const TOKEN_FILE = path.join(SHELL_DIR, 'data', 'engine-token.json');
const OUT_LOG = path.join(SHELL_DIR, 'data', 'engine.out.log');
const NPM_BIN = path.join(process.env.USERPROFILE || process.env.HOME || '', 'AppData', 'Roaming', 'npm');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 探活 ----------
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: Number(port) });
    const done = (v) => { try { s.destroy(); } catch { /* ignore */ } resolve(v); };
    s.setTimeout(1200, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

// 按端口找监听进程（Windows：Get-NetTCPConnection 比 netstat 解析稳）
function pidOnPort(port) {
  try {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command',
      `(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`
    ], { encoding: 'utf8', windowsHide: true });
    const n = Number(String(ps.stdout || '').trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

function readToken() {
  try {
    const j = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    return (j && String(j.port) === PORT && j.token) ? String(j.token) : '';
  } catch { return ''; }
}

function writeToken(tok, at) {
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: tok, port: PORT, at: at || new Date().toISOString() }, null, 2) + '\n', 'utf8');
  } catch { /* ignore */ }
}

// ---------- 从引擎输出里抠 token ----------
// 引擎启动时会打印 http://127.0.0.1:<port>/?token=<tok>
const TOKEN_RE = new RegExp(`http:\\/\\/127\\.0\\.0\\.1:${PORT}\\/\\?token=([A-Za-z0-9_\\-]+)`);

async function waitForToken(fromPos, timeoutMs) {
  const t0 = Date.now();
  let pos = fromPos;
  while (Date.now() - t0 < timeoutMs) {
    let size = 0;
    try { size = fs.statSync(OUT_LOG).size; } catch { /* 还没生成 */ }
    if (size > pos) {
      let buf = '';
      try {
        const len = Math.min(size - pos, 512 * 1024);
        const fd = fs.openSync(OUT_LOG, 'r');
        const b = Buffer.allocUnsafe(len);
        fs.readSync(fd, b, 0, len, pos);
        fs.closeSync(fd);
        buf = b.toString('utf8');
        pos += len;
      } catch { /* ignore */ }
      const m = buf.match(TOKEN_RE);
      if (m) { writeToken(m[1]); return m[1]; }
    }
    await sleep(400);
  }
  return '';
}

// ---------- start ----------
async function start() {
  if (await portOpen(PORT)) {
    const pid = pidOnPort(PORT);
    const tok = readToken();
    console.log(`已在运行：端口 ${PORT} 被 PID ${pid || '?'} 占着${tok ? '，token 文件有效' : '，但 token 文件缺失/过期（壳会走 /chat 保底）'}`);
    return 0;
  }
  if (!fs.existsSync(CLI)) {
    console.error(`找不到引擎入口：${CLI}`);
    return 2;
  }
  fs.mkdirSync(path.dirname(OUT_LOG), { recursive: true });
  const startPos = fs.existsSync(OUT_LOG) ? fs.statSync(OUT_LOG).size : 0;

  // node 优先用系统 node（引擎要求 node ^22.19 || >=24）
  const nodeExe = process.env.DSH_NODE && fs.existsSync(process.env.DSH_NODE) ? process.env.DSH_NODE : 'node';
  const env = {
    ...process.env,
    DSH_HOME,
    DSH_CUSTOMER_HOME: DSH_HOME,          // 与 launch-inner.cmd 同一个值：数据只认这一个 home
    Path: NPM_BIN + ';' + (process.env.Path || ''),
  };
  const out = fs.openSync(OUT_LOG, 'a');
  fs.appendFileSync(OUT_LOG, `\r\n===== ${new Date().toISOString()} 引擎常驻.mjs start =====\r\n`);
  const child = spawn(nodeExe, [CLI, 'web', '--no-open', '--port', PORT], {
    cwd: HARNESS,
    env,
    detached: true,                        // ★ 不跟本脚本绑定，脚本退出引擎继续跑
    windowsHide: true,
    stdio: ['ignore', out, out],
  });
  try { fs.closeSync(out); } catch { /* ignore */ }
  child.unref();
  console.log(`已拉起引擎：PID ${child.pid}（detached，输出见 ${path.relative(ROOT, OUT_LOG)}）`);

  process.stdout.write('等待引擎就绪');
  const tok = await waitForToken(startPos, 600_000);
  if (tok) {
    console.log(`\n就绪。token 已写入 ${path.relative(ROOT, TOKEN_FILE)}`);
    return 0;
  }
  console.log('\n600 秒内没抓到 token —— 引擎可能卡在启动中，看日志：');
  console.log('  ' + path.relative(ROOT, OUT_LOG));
  return 1;
}

// ---------- stop ----------
async function stop() {
  const pid = pidOnPort(PORT);
  if (!pid) { console.log(`端口 ${PORT} 没有监听进程，已经是停的`); return 0; }
  console.log(`停引擎：PID ${pid}（连带子进程）`);
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  // token 作废：留着会让下次壳启动拿旧 token 撞新引擎，白屏
  try { fs.rmSync(TOKEN_FILE, { force: true }); } catch { /* ignore */ }
  await sleep(600);
  console.log((await portOpen(PORT)) ? '仍在监听，稍等或手动 taskkill' : '已停止');
  return 0;
}

// ---------- status ----------
async function status() {
  const open = await portOpen(PORT);
  const pid = open ? pidOnPort(PORT) : 0;
  const tok = readToken();
  console.log('引擎常驻状态');
  console.log('  home      : ' + DSH_HOME);
  console.log('  入口      : ' + CLI + (fs.existsSync(CLI) ? '' : '  ← 不存在'));
  console.log('  端口      : ' + PORT + (open ? '  【在监听】' : '  【没在听】'));
  console.log('  进程 PID  : ' + (pid || '—'));
  console.log('  token     : ' + (tok ? tok.slice(0, 8) + '…' : '（无）'));
  console.log('  token 文件: ' + TOKEN_FILE);
  let logSize = 0;
  try { logSize = fs.statSync(OUT_LOG).size; } catch { /* none */ }
  console.log('  输出日志  : ' + OUT_LOG + (logSize ? `  (${(logSize / 1024).toFixed(0)} KB)` : '  （还没有）'));
  return open ? 0 : 1;
}

const cmd = (process.argv[2] || 'status').toLowerCase();
const table = { start, stop, status, restart: async () => { await stop(); return start(); } };
if (cmd === 'token') {
  const tok = readToken();
  if (tok) console.log(tok); else { console.error('没有可用 token'); process.exit(1); }
} else if (table[cmd]) {
  process.exitCode = await table[cmd]();
} else {
  console.error('用法: node 工具\\引擎常驻.mjs [status|start|stop|restart|token]');
  process.exitCode = 2;
}
