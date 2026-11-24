#!/usr/bin/env node
// ============================================================================
// 每日计划（2026-11-25）
//
// 两件事共用一个文件：
//   ① 固定计划 routine —— 每天（或指定的星期几）固定时间要做的事，比如 08:30 晨间三件事
//   ② 自己的项目 project —— 没有固定时间、但要在某天之前做完的事，比如「毕设点云跑完」
//
// 数据：<home>\场景记忆\_共享记忆\每日计划.json
//       纯 JSON、UTF-8、无 BOM；人和 AI 都能直接改，脚本只是方便入口。
//       神经元面板（renderers.js 的 neuron）直接读这个文件画「今日计划」链，
//       所以这里写进去的东西会当场出现在图上（点 ⟳ 重读即可）。
//
// 用法：
//   node 工具\每日计划.mjs                     今天该干什么（默认）
//   node 工具\每日计划.mjs --week              未来 7 天各有什么
//   node 工具\每日计划.mjs --json              原样输出 JSON（给别的脚本吃）
//   node 工具\每日计划.mjs --seed              第一次用：写一份示例进去（已存在就不动）
//   node 工具\每日计划.mjs --add "标题" [--time 08:30] [--days 1,3,5] [--kind project]
//                             [--due 2026-12-05] [--note "备注"] [--id 自定义id]
//   node 工具\每日计划.mjs --done <id>         今天标记完成
//   node 工具\每日计划.mjs --undone <id>       撤销今天的完成
//   node 工具\每日计划.mjs --remove <id>       删掉一条
//   node 工具\每日计划.mjs --check             只校验不写盘
//
// 参数说明：
//   --time  HH:MM，留空 = 不限时间（项目类一般留空，按 due 排）
//   --days  1=周一 … 7=周日，逗号分隔；留空 = 每天
//   --kind  routine（固定计划，默认） / project（项目）
//   --due   YYYY-MM-DD，project 用；过了这天会标「已逾期」
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const HOME = process.env.DSH_CUSTOMER_HOME || path.join(ROOT, '引擎数据', '.dsh');
const MEM = path.join(HOME, '场景记忆', '_共享记忆');
const FILE = path.join(MEM, '每日计划.json');

const DOW_CN = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const KIND_CN = { routine: '固定', project: '项目', once: '一次性' };

function pad(n) { return String(n).padStart(2, '0'); }
function dateKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function isoDow(d) { const w = d.getDay(); return w === 0 ? 7 : w; }
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}
function daysBetween(a, b) { return Math.round((b - a) / 86400000); }

function emptyPlan() {
  return { version: 1, updatedAt: new Date().toISOString(), items: [] };
}

function readPlan() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, '');
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.items)) return emptyPlan();
    return j;
  } catch (e) {
    if (e && e.code !== 'ENOENT') console.error('[每日计划] 读不了 ' + FILE + '：' + e.message + '（当成空计划继续）');
    return emptyPlan();
  }
}

function writePlan(plan) {
  plan.updatedAt = new Date().toISOString();
  fs.mkdirSync(MEM, { recursive: true });
  if (fs.existsSync(FILE)) {
    const bak = FILE + '.bak-plan-' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    try { fs.copyFileSync(FILE, bak); } catch (e) { /* 备份失败不挡写 */ }
  }
  fs.writeFileSync(FILE, JSON.stringify(plan, null, 2) + '\n', 'utf8');
}

// 一条计划今天是否"该出现"
function activeToday(it, today, dow) {
  if (!it || !it.title) return false;
  if (it.since && dateKey(new Date(it.since)) > dateKey(today)) return false;   // 还没开始
  if (it.until) {
    const u = parseDate(it.until);
    if (u && today > u) return false;                                          // 已经结束
  }
  const days = Array.isArray(it.days) ? it.days.map(Number).filter((n) => n >= 1 && n <= 7) : [];
  const kind = it.kind || 'routine';
  if (kind === 'project') {
    // 项目：没完成就一直出现
    return !doneOn(it, today);
  }
  if (!days.length) return true;   // 每天
  return days.indexOf(dow) >= 0;
}

function doneOn(it, d) {
  const k = dateKey(d);
  const log = it && it.logs && it.logs[k];
  return !!(log && log.done);
}

function sortKey(it) {
  const t = String(it.time || '');
  return /^\d{1,2}:\d{2}$/.test(t) ? t.padStart(5, '0') : '99:99';
}

function dueHint(it, today) {
  if (!it.due) return '';
  const d = parseDate(it.due);
  if (!d) return '';
  const n = daysBetween(today, d);
  if (n < 0) return ' ⚠ 已逾期 ' + (-n) + ' 天';
  if (n === 0) return ' ⏰ 就是今天';
  if (n <= 3) return ' ⏰ 还剩 ' + n + ' 天';
  return ' 截止 ' + it.due.slice(5) + '（还剩 ' + n + ' 天）';
}

function printToday(plan) {
  const today = new Date();
  const dow = isoDow(today);
  const list = (plan.items || []).filter((it) => activeToday(it, today, dow)).sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  const done = list.filter((it) => doneOn(it, today)).length;
  console.log('');
  console.log('今天 ' + dateKey(today) + '（' + DOW_CN[dow] + '）共 ' + list.length + ' 项，已完成 ' + done + ' 项');
  console.log('─'.repeat(72));
  if (!list.length) {
    console.log('  （空）用 --add "标题" --time 08:30 加一条，或 --seed 先写份示例');
  }
  list.forEach((it) => {
    const mark = doneOn(it, today) ? '[x]' : '[ ]';
    const time = /^\d{1,2}:\d{2}$/.test(String(it.time || '')) ? String(it.time).padStart(5, '0') : ' -- ';
    const kind = KIND_CN[it.kind || 'routine'] || it.kind;
    const days = Array.isArray(it.days) && it.days.length ? '（' + it.days.map((d) => DOW_CN[d]).join('') + '）' : '';
    console.log('  ' + mark + ' ' + time + '  ' + it.title + '   [' + kind + days + ']' + dueHint(it, today));
    if (it.note) console.log('            ' + it.note);
    console.log('            id=' + it.id);
  });
  // 项目里"不是今天该出现但还活着"的，单独提醒一句，别让人忘了
  const frozen = (plan.items || []).filter((it) => (it.kind === 'project') && !activeToday(it, today, dow));
  if (frozen.length) {
    console.log('');
    console.log('已完成 / 冻结的项目 ' + frozen.length + ' 个（--done 过的不再出现，想复活用 --undone）');
  }
  console.log('');
}

function printWeek(plan) {
  const base = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    const dow = isoDow(d);
    const list = (plan.items || []).filter((it) => activeToday(it, d, dow)).sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
    const tag = i === 0 ? '今天' : (i === 1 ? '明天' : DOW_CN[dow]);
    console.log('· ' + dateKey(d) + ' ' + tag.padEnd(3, ' ') + '  ' + (list.length ? list.map((x) => (x.time ? x.time + ' ' : '') + x.title).join(' / ') : '—'));
  }
  console.log('');
}

function newId(plan) {
  let n = 1;
  const has = new Set((plan.items || []).map((x) => String(x.id)));
  while (has.has('p' + n)) n++;
  return 'p' + n;
}

function seedPlan() {
  if (fs.existsSync(FILE)) { console.log('[每日计划] 已经存在，不动它：' + FILE); return; }
  const plan = emptyPlan();
  plan.items = [
    { id: 'p1', title: '晨间三件事：看今天计划 / 清消息 / 定一件事', time: '08:30', days: [1, 2, 3, 4, 5], kind: 'routine', note: '固定计划，改 --days 就能调', logs: {} },
    { id: 'p2', title: '晚上的复盘：今天干成了什么、卡在哪', time: '21:00', days: [1, 2, 3, 4, 5, 6, 7], kind: 'routine', note: '', logs: {} },
    { id: 'p3', title: '示例项目：把某件事做完（改成你自己的）', time: '', days: [], kind: 'project', due: '', note: '项目类没有固定时间，按截止日期排；做完用 --done p3', logs: {} },
  ];
  writePlan(plan);
  console.log('[每日计划] 已写入示例：' + FILE);
  printToday(plan);
}

// ---------------- 参数解析 ----------------
const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : undefined;
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 34).join('\n'));
  process.exit(0);
}

const plan = readPlan();
const today = new Date();

if (argv.includes('--seed')) { seedPlan(); process.exit(0); }

if (argv.includes('--json')) { console.log(JSON.stringify(plan, null, 2)); process.exit(0); }

if (argv.includes('--week')) { printWeek(plan); process.exit(0); }

if (argv.includes('--check')) {
  const bad = [];
  (plan.items || []).forEach((it) => {
    if (!it.id) bad.push('有一条缺 id：' + JSON.stringify(it.title));
    if (!it.title) bad.push(it.id + ' 缺标题');
    if (it.time && !/^\d{1,2}:\d{2}$/.test(it.time)) bad.push(it.id + ' 的 time 不是 HH:MM：' + it.time);
    if (it.due && !parseDate(it.due)) bad.push(it.id + ' 的 due 不是 YYYY-MM-DD：' + it.due);
    if (it.kind && !KIND_CN[it.kind]) bad.push(it.id + ' 的 kind 不认识：' + it.kind);
  });
  console.log(bad.length ? ('✗ ' + bad.length + ' 处问题：\n  ' + bad.join('\n  ')) : ('✓ ' + (plan.items || []).length + ' 条计划格式没问题：' + FILE));
  process.exit(bad.length ? 1 : 0);
}

if (flag('add')) {
  const title = String(flag('add'));
  if (title === 'true' || !title.trim()) { console.error('--add 后面要跟标题'); process.exit(2); }
  const daysRaw = flag('days');
  const days = (typeof daysRaw === 'string')
    ? daysRaw.split(',').map((s) => Number(s.trim())).filter((n) => n >= 1 && n <= 7)
    : [];
  const kind = (typeof flag('kind') === 'string' ? String(flag('kind')) : 'routine');
  if (!KIND_CN[kind]) { console.error('--kind 只能是 routine / project / once'); process.exit(2); }
  const time = (typeof flag('time') === 'string') ? String(flag('time')) : '';
  if (time && !/^\d{1,2}:\d{2}$/.test(time)) { console.error('--time 要写成 HH:MM，例如 08:30'); process.exit(2); }
  const due = (typeof flag('due') === 'string') ? String(flag('due')) : '';
  if (due && !parseDate(due)) { console.error('--due 要写成 YYYY-MM-DD'); process.exit(2); }
  const item = {
    id: (typeof flag('id') === 'string' ? String(flag('id')) : newId(plan)),
    title: title.trim(),
    time,
    days,
    kind,
    due,
    note: (typeof flag('note') === 'string' ? String(flag('note')) : ''),
    since: dateKey(today),
    until: '',
    logs: {},
  };
  if ((plan.items || []).some((x) => String(x.id) === item.id)) { console.error('id 重复了：' + item.id); process.exit(2); }
  plan.items.push(item);
  writePlan(plan);
  console.log('[每日计划] 已加：' + item.id + '  ' + item.title);
  printToday(plan);
  process.exit(0);
}

if (flag('done') || flag('undone') || flag('remove')) {
  const which = flag('done') || flag('undone') || flag('remove');
  const id = String(which);
  const it = (plan.items || []).filter((x) => String(x.id) === id)[0];
  if (!it) { console.error('没有这条：' + id + '（先不带参数跑一次看 id）'); process.exit(2); }
  if (flag('remove')) {
    plan.items = plan.items.filter((x) => String(x.id) !== id);
    writePlan(plan);
    console.log('[每日计划] 已删：' + id + '  ' + it.title);
    process.exit(0);
  }
  const k = dateKey(today);
  it.logs = it.logs || {};
  it.logs[k] = it.logs[k] || {};
  it.logs[k].done = !!flag('done');
  it.logs[k].at = new Date().toISOString();
  writePlan(plan);
  console.log('[每日计划] ' + (flag('done') ? '完成' : '撤销') + '：' + id + '  ' + it.title + '（' + k + '）');
  printToday(plan);
  process.exit(0);
}

printToday(plan);
