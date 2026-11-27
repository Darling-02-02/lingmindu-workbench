// A/B 实验：往壳的主页面注入/撤销一段"降耗 CSS"，用来验证 rAF/动画/毛玻璃是不是 CPU 大头
// 用法: node perf-ab.mjs on|off [port]
const mode = process.argv[2] || 'on';
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

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(1); }

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

const CSS = `
/* 只用于 A/B 测量：停掉循环动画、去掉毛玻璃、压掉阴影重绘 */
*, *::before, *::after {
  animation-play-state: paused !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  transition: none !important;
  box-shadow: none !important;
  text-shadow: none !important;
  filter: none !important;
}`;

const expr = mode === 'off'
  ? `(() => { const s = document.getElementById('__perfab'); if (s) s.remove(); return 'removed'; })()`
  : `(() => {
       let s = document.getElementById('__perfab');
       if (!s) { s = document.createElement('style'); s.id = '__perfab'; document.head.appendChild(s); }
       s.textContent = ${JSON.stringify(CSS)};
       return 'applied';
     })()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
console.log(mode + ' → ' + JSON.stringify(r.result.value));
ws.close();
