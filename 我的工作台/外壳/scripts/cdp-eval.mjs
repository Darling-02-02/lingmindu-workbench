// 通用 CDP 求值工具：node cdp-eval.mjs "<js表达式>" [port] [targetType]
// 端口默认自动探测：壳用 9224（9223 在本机被一次强杀留下的僵尸 LISTEN 占了），再退 9223/9222。
// 表达式太长 / 含空白和引号（PowerShell 会重新分词）时，写成文件再传 @文件路径，省掉转义地狱。
import fs from 'node:fs';
const rawArg = process.argv[2];
const expr = rawArg && rawArg.startsWith('@') ? fs.readFileSync(rawArg.slice(1), 'utf8') : rawArg;
async function pickPort() {
  let pref = 0;
  try {
    const fs = await import('node:fs');
    const f = new URL('../data/debug-port.txt', import.meta.url);
    if (fs.existsSync(f)) pref = Number(String(fs.readFileSync(f, 'utf8')).trim()) || 0;
  } catch (e) { /* no file, just scan */ }
  const ports = pref ? [pref] : [];
  for (let p = 9226; p <= 9240; p += 1) if (p !== pref) ports.push(p);
  for (const p of ports) {
    try { const r = await fetch('http://127.0.0.1:' + p + '/json/version', { signal: AbortSignal.timeout(1200) }); if (r.ok) return p; } catch (e) { /* next */ }
  }
  return 9226;
}
const port = Number(process.argv[3] || 0) || await pickPort();
const typeWanted = process.argv[4] || 'page';
if (!expr) { console.error('用法: node cdp-eval.mjs "<js>" [port] [page|webview]'); process.exit(1); }

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = typeWanted === 'all' ? list : list.find((t) => t.type === typeWanted);
if (!target) { console.error('no target', typeWanted); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0;
const pend = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) {
    const { res, rej } = pend.get(m.id); pend.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r));

if (process.env.METRICS === '1') {
  await send('Performance.enable');
  const before = (await send('Performance.getMetrics')).metrics.reduce((a, m) => (a[m.name] = m.value, a), {});
  await new Promise((r) => setTimeout(r, 3000));
  const after = (await send('Performance.getMetrics')).metrics.reduce((a, m) => (a[m.name] = m.value, a), {});
  const keys = ['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','LayoutCount','RecalcStyleCount','Nodes','JSHeapUsedSize','Documents'];
  console.log('3 秒内 V8/Blink 计数：');
  for (const k of keys) {
    if (after[k] === undefined) continue;
    const d = after[k] - before[k];
    console.log('  ' + k.padEnd(20) + (k.endsWith('Count') || k === 'Nodes' || k === 'Documents' ? d.toFixed(0) : (d * 1000).toFixed(0) + ' ms'));
  }
}

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(r.result.value ?? r.result.description, null, 2));
ws.close();
