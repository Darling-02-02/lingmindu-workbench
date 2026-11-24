// CDP 截图：node cdp-shot.mjs <输出png> [port] [targetType] [clipSelector]
import fs from 'node:fs';
const out = process.argv[2] || 'shot.png';
async function pickPort() {
  for (const p of [9224, 9223, 9222]) {
    try { const r = await fetch('http://127.0.0.1:' + p + '/json/version'); if (r.ok) return p; } catch (e) { /* 试下一个 */ }
  }
  return 9224;
}
const port = Number(process.argv[3] || 0) || await pickPort();
const typeWanted = process.argv[4] || 'page';
const sel = process.argv[5] || '';

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = list.find((t) => t.type === typeWanted);
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
  if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
});
await new Promise((r) => ws.addEventListener('open', r));

let clip;
if (sel) {
  const r = await send('Runtime.evaluate', {
    expression: `(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;var r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`,
    returnByValue: true,
  });
  const b = r.result.value;
  if (b && b.width > 4) clip = { ...b, scale: 1 };
}
const shot = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('已保存 ' + out + (clip ? `（裁剪 ${Math.round(clip.width)}×${Math.round(clip.height)}）` : '（整页）'));
ws.close();
