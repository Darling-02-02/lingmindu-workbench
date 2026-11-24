// 对壳的主页面做 3 秒 CPU 采样，输出 self-time 最高的函数
// 用法: node cdp-prof.mjs [port] [seconds]
const port = Number(process.argv[2] || 9223);
const seconds = Number(process.argv[3] || 3);

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(1); }
console.error('target: ' + page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
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

await send('Profiler.enable');
await send('Profiler.setSamplingInterval', { interval: 200 });
await send('Profiler.start');
await new Promise((r) => setTimeout(r, seconds * 1000));
const { profile } = await send('Profiler.stop');

// 聚合 self time
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
for (let i = 0; i < profile.samples.length; i++) {
  const id = profile.samples[i];
  const dt = profile.timeDeltas[i] || 0;
  self.set(id, (self.get(id) || 0) + dt);
}
const total = [...self.values()].reduce((a, b) => a + b, 0) || 1;

const rows = [...self.entries()]
  .map(([id, us]) => {
    const n = byId.get(id) || {};
    const cf = n.callFrame || {};
    return {
      us,
      pct: (us / total) * 100,
      name: cf.functionName || '(anonymous)',
      url: (cf.url || '').replace(/^file:\/\/\//, '').replace(/^.*[\\/]/, ''),
      line: (cf.lineNumber ?? -1) + 1,
    };
  })
  .filter((r) => r.pct > 1)
  .sort((a, b) => b.us - a.us)
  .slice(0, 18);

console.log(`采样 ${seconds}s，总样本时长 ${(total / 1000).toFixed(0)} ms\n`);
console.log('  占比   自身耗时   函数                                 位置');
for (const r of rows) {
  console.log(`  ${r.pct.toFixed(1).padStart(5)}%  ${(r.us / 1000).toFixed(0).padStart(6)}ms   ${r.name.padEnd(34).slice(0, 34)} ${r.url}:${r.line}`);
}

// 按 URL 汇总
const byUrl = new Map();
for (const r of rows) byUrl.set(r.url, (byUrl.get(r.url) || 0) + r.pct);
console.log('\n按文件汇总:');
for (const [u, p] of [...byUrl.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${p.toFixed(1).padStart(5)}%  ${u}`);

ws.close();
