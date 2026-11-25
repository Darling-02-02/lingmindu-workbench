// 抓渲染层报错：连 CDP → 开 Runtime/Log → 重载页面 → 收集 N 秒内的异常与控制台错误。
// 用法：node 外壳\scripts\cdp-errors.mjs [秒数] [page|webview]
async function pickPort() {
  for (const p of [9226, 9225, 9224, 9223, 9222]) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(1200) });
      if (r.ok) return p;
    } catch (e) { /* 试下一个 */ }
  }
  throw new Error('CDP 端口都没开（9224/9223/9222）');
}

const port = await pickPort();
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const wantType = process.argv[3] || 'page';
const page = wantType === 'webview'
  ? list.find((t) => t.type === 'webview')
  : (list.find((t) => t.type === 'page' && /renderer\/index\.html/.test(t.url || '')) || list.find((t) => t.type === 'page'));
if (!page) throw new Error('没找到 target');
console.log('[cdp] ' + port + ' → ' + page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const send = (method, params) => ws.send(JSON.stringify({ id: ++id, method, params: params || {} }));

const bad = [];
const stackOf = (cs) => (cs || []).map((c) => `${c.functionName || '?'}@${c.url || ''}:${(c.lineNumber || 0) + 1}:${(c.columnNumber || 0) + 1}`).slice(0, 6).join(' <- ');

ws.addEventListener('open', () => {
  send('Runtime.enable');
  send('Log.enable');
  send('Page.enable');
  setTimeout(() => send('Page.reload', { ignoreCache: true }), 500);
});

ws.addEventListener('message', (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch (e) { return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails || {};
    bad.push('[exception] ' + (d.exception && (d.exception.description || d.exception.value) || d.text) + '\n    ' + stackOf(d.stackTrace && d.stackTrace.callFrames));
  } else if (m.method === 'Runtime.consoleAPICalled') {
    if (m.params.type === 'error' || m.params.type === 'warning') {
      const txt = (m.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(' ');
      bad.push('[' + m.params.type + '] ' + txt + '\n    ' + stackOf(m.params.stackTrace && m.params.stackTrace.callFrames));
    }
  } else if (m.method === 'Log.entryAdded') {
    const e = m.params.entry || {};
    if (e.level === 'error' || e.level === 'warning') bad.push('[log:' + e.level + '] ' + e.text + (e.url ? '  @' + e.url + ':' + e.lineNumber : ''));
  }
});

const secs = Number(process.argv[2] || 10);
setTimeout(() => {
  console.log('=== 收集到 ' + bad.length + ' 条 ===');
  console.log(bad.slice(0, 40).join('\n') || '（无）');
  ws.close();
  process.exit(0);
}, secs * 1000 + 900);
