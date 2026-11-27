// CDP 截图：node cdp-shot.mjs <输出png> [port] [targetType] [clipSelector]
import fs from 'node:fs';
const out = process.argv[2] || 'shot.png';
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
// ⚠️ fromSurface:true（默认）只抓合成 surface，某些 GPU 配置下会丢掉窗口的根背景层
// （html/body 的 background 完全不出现，截图里全黑，但真实屏幕是有的）。
// 用 SHOT_NOSURFACE=1 走渲染进程本地合成，能把根背景抓出来。
const shot = await send('Page.captureScreenshot', {
  format: 'png',
  fromSurface: process.env.SHOT_NOSURFACE ? false : true,
  ...(clip ? { clip } : {}),
});
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('已保存 ' + out + (clip ? `（裁剪 ${Math.round(clip.width)}×${Math.round(clip.height)}）` : '（整页）'));
ws.close();
