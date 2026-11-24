// 通用 CDP 求值工具：node cdp-eval.mjs "<js表达式>" [port] [targetType]
const expr = process.argv[2];
const port = Number(process.argv[3] || 9223);
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
