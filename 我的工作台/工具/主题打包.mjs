#!/usr/bin/env node
// 主题打包 / 分发（2026-11-25）
//
// 两套主题，同一套"一个目录 + 一张图 + 一份 json"的格式：
//
//   整窗主题   外壳\skins\<id>\            { skin.json, bg.jpg, skin.css(可选), icons\*.ico }
//   卡片主题   外壳\skins\_cards\<panelId>\ { card.json, bg.jpg }
//
// 这个脚本干的事：把任意目录里的图片，按"文件名 = 卡片 id"的规矩自动分配到各张卡片，
// 或者用 --panel/--file 显式指定；也能反过来列出当前有哪些卡片主题、哪些卡片还没有。
//
// 用法：
//   node 工具\主题打包.mjs --list                     看当前卡片主题
//   node 工具\主题打包.mjs --panels                   列出所有可用的卡片 id（从场景 json 里扫）
//   node 工具\主题打包.mjs --from "D:\某个图库"        按文件名自动配对（cmd-neuron.jpg → cmd-neuron）
//   node 工具\主题打包.mjs --from "D:\图库" --dry      只看会配成什么，不动手
//   node 工具\主题打包.mjs --panel cmd-neuron --file "D:\x\a.jpg" --opacity 0.3 --fit cover
//   node 工具\主题打包.mjs --panel cmd-neuron --clear  去掉这张卡片的背景
//   node 工具\主题打包.mjs --all --from "D:\图库"      同一张图铺给所有卡片（取目录里第一张图）
//
// 想手动来也完全可以：往 外壳\skins\_cards\<panelId>\ 里丢一张 bg.jpg +
//   card.json 写 {"panelId":"cmd-neuron","file":"bg.jpg","opacity":0.35}，刷新界面就生效。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKINS = path.join(ROOT, '外壳', 'skins');
const CARDS = path.join(SKINS, '_cards');
const SCEN = path.join(ROOT, '外壳', 'scenarios');
const IMG = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d = '') => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

function panels() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(SCEN).filter((f) => f.toLowerCase().endsWith('.json')); } catch { /* 没场景目录 */ }
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8')); } catch { continue; }
    for (const p of (j.panels || [])) {
      if (!p || !p.id) continue;
      out.push({ panelId: String(p.id), title: String(p.title || ''), type: String(p.type || ''), scene: String(j.name || f) });
    }
  }
  // 场景面板编辑弹层改过的面板存在 data\panel-overrides 之类的地方，这里只管场景 json 里的
  return out;
}

function readCard(pid) {
  const dir = path.join(CARDS, safe(pid));
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'card.json'), 'utf8').replace(/^\uFEFF/, ''));
    const f = j.file ? path.join(dir, String(j.file)) : '';
    return { dir, json: j, file: f, exists: !!f && fs.existsSync(f) };
  } catch { return null; }
}
const safe = (pid) => String(pid || '').replace(/[^\w.-]/g, '_');

function listCards() {
  let dirs = [];
  try { dirs = fs.readdirSync(CARDS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* 空 */ }
  if (!dirs.length) { console.log('还没有任何卡片主题。用 --from 或 --panel/--file 建一个。'); return; }
  console.log('当前卡片主题：');
  for (const d of dirs) {
    const t = readCard(d);
    if (!t) { console.log(`  ${d}  ⚠ card.json 读不出来`); continue; }
    const op = Number(t.json.opacity);
    console.log(`  ${d.padEnd(14)} ${String(t.json.name || '').padEnd(18)} 浓淡 ${Math.round((Number.isFinite(op) ? op : 0.35) * 100)}%  ${t.json.fit || 'cover'}  ${t.exists ? '' : '⚠ 图文件缺失'}  → ${path.basename(t.file || '')}`);
  }
  const have = new Set(dirs.map(safe));
  const miss = panels().filter((p) => !have.has(safe(p.panelId)));
  if (miss.length) {
    console.log('\n还没配背景的卡片（可以拿 --panel 逐个配）：');
    for (const p of miss) console.log(`  ${p.panelId.padEnd(14)} ${p.title}  [${p.type}]  场景「${p.scene}」`);
  }
}

function writeCard(pid, srcFile, opts = {}) {
  const dir = path.join(CARDS, safe(pid));
  fs.mkdirSync(dir, { recursive: true });
  const cur = readCard(pid);
  const pOp = (opts.opacity === '' || opts.opacity == null) ? null : Number(opts.opacity);
  const pFit = (opts.fit === '' || opts.fit == null) ? null : String(opts.fit);
  const opacity = (pOp != null && Number.isFinite(pOp)) ? pOp : (cur && Number.isFinite(Number(cur.json.opacity)) ? Number(cur.json.opacity) : 0.35);
  const fit = pFit || (cur && cur.json.fit) || 'cover';
  const accent = opts.accent != null ? opts.accent : ((cur && cur.json.accent) || '');
  let file = cur && cur.json.file ? String(cur.json.file) : '';
  if (srcFile) {
    const ext = (path.extname(srcFile) || '.jpg').toLowerCase();
    const want = 'bg' + ext;
    for (const f of fs.readdirSync(dir)) {
      if (/^bg\./i.test(f) && f.toLowerCase() !== want) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
    }
    fs.copyFileSync(srcFile, path.join(dir, want));
    file = want;
  }
  if (!file) return null;
  const next = {
    panelId: String(pid),
    name: srcFile ? path.basename(srcFile) : ((cur && cur.json.name) || path.basename(file)),
    file,
    opacity: Math.max(0, Math.min(1, opacity)),
    accent,
    fit,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'card.json'), JSON.stringify(next, null, 2), 'utf8');
  return { dir, next };
}

function clearCard(pid) {
  const dir = path.join(CARDS, safe(pid));
  if (!fs.existsSync(dir)) return false;
  for (const f of fs.readdirSync(dir)) {
    if (/^bg(\.|$)/i.test(f) || f === 'card.json') { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
  }
  try { fs.rmdirSync(dir); } catch { /* 还有别的文件就留着 */ }
  return true;
}

function imagesIn(dir) {
  let out = [];
  try {
    out = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && IMG.test(d.name))
      .map((d) => path.join(dir, d.name));
  } catch { /* 目录不在 */ }
  return out.sort();
}

// ---------- 主流程 ----------
if (has('--panels')) {
  const all = panels();
  console.log(`场景里共有 ${all.length} 张卡片：`);
  for (const p of all) console.log(`  ${p.panelId.padEnd(14)} ${p.title}  [${p.type}]  场景「${p.scene}」`);
  process.exit(0);
}

if (has('--clear')) {
  const pid = val('--panel');
  if (!pid) { console.error('--clear 要带 --panel <面板id>'); process.exit(1); }
  console.log(clearCard(pid) ? `已去掉 ${pid} 的背景` : `${pid} 本来就没有背景`);
  process.exit(0);
}

const one = val('--file');
const pidOne = val('--panel');
if (pidOne && one) {
  if (!fs.existsSync(one)) { console.error('图不存在：' + one); process.exit(1); }
  const r = writeCard(pidOne, one, { opacity: val('--opacity', ''), fit: val('--fit', ''), accent: val('--accent', '') });
  console.log(r ? `✔ ${pidOne} ← ${path.basename(one)}\n  ${path.join(r.dir, 'card.json')}` : '写失败');
  process.exit(0);
}

const from = val('--from');
if (from) {
  if (!fs.existsSync(from)) { console.error('目录不存在：' + from); process.exit(1); }
  const imgs = imagesIn(from);
  if (!imgs.length) { console.error('这个目录里没有图片：' + from); process.exit(1); }
  // 无扩展名的图原文，按文件名（不含扩展名）配对面板 id
  const byPanel = new Map();
  for (const f of imgs) byPanel.set(path.basename(f, path.extname(f)), f);
  const known = panels();
  const knownIds = new Set(known.map((p) => p.panelId));
  const dry = has('--dry');
  const all = has('--all');
  const hit = [];

  if (all) {
    // 同一张图铺给所有卡片：取目录里第一张
    for (const p of known) hit.push({ panelId: p.panelId, file: imgs[0] });
  } else {
    for (const [name, file] of byPanel) {
      // 允许 "cmd-neuron" 精确配对，也允许 "3-cmd-neuron"、"cmd-neuron@灰夜" 这种带前缀/后缀的写法
      let pid = name;
      if (!knownIds.has(pid)) {
        const suffix = [...knownIds].find((k) => name.endsWith(k) || name.startsWith(k));
        if (suffix) pid = suffix;
      }
      if (!knownIds.has(pid) && !has('--force')) continue;
      hit.push({ panelId: pid, file });
    }
  }

  if (!hit.length) {
    console.log('没有一张图能对上卡片 id。当前卡片 id：');
    for (const p of known) console.log('  ' + p.panelId + '   ' + p.title);
    console.log('\n把图改名成 <卡片id>.jpg 再跑，或用 --panel X --file 图.jpg 显式指定。');
    process.exit(0);
  }
  console.log((dry ? '（干跑，不写盘）' : '') + `将分配 ${hit.length} 张：`);
  for (const h of hit) {
    console.log(`  ${h.panelId.padEnd(14)} ← ${path.basename(h.file)}`);
    if (!dry) writeCard(h.panelId, h.file, { opacity: val('--opacity', ''), fit: val('--fit', '') });
  }
  if (!dry) console.log('\n界面里刷新一下（F5）就生效；或对着卡片标题右键调浓淡。');
  process.exit(0);
}

listCards();
