#!/usr/bin/env node
/**
 * 同步仓库.mjs —— 把本地在跑的工作台源码，同步进 GitHub 仓库的 clone（我的工作台/ 目录）
 *
 * 为什么需要它：
 *   真实运行时目录 D:\AAAlingmindu_wb 里混着 引擎数据 / data / 备份 / node_modules / 日志，
 *   不可能整目录 push。这个脚本只挑「源码该进版本控制的那部分」，并顺手删掉仓库里已经不该存在的文件。
 *
 * 用法：
 *   node 工具\同步仓库.mjs                 干跑（只报告差异，不动磁盘）
 *   node 工具\同步仓库.mjs --push          同步 + git add/commit/push（自动生成提交说明）
 *   node 工具\同步仓库.mjs --push "说明"    同步 + 指定提交说明
 *   node 工具\同步仓库.mjs --repo D:\xxx    换仓库位置（默认 D:\git\lingmindu-workbench）
 *
 * 环境变量：WB_REPO 可替代 --repo
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.dirname(HERE) // D:\AAAlingmindu_wb

const argv = process.argv.slice(2)
const FLAG_PUSH = argv.includes('--push')
const idxRepo = argv.indexOf('--repo')
const REPO = (idxRepo >= 0 && argv[idxRepo + 1]) || process.env.WB_REPO || 'D:\\git\\lingmindu-workbench'
const DEST = path.join(REPO, '我的工作台')
const MSG =
  (() => {
    const i = argv.indexOf('--push')
    const m = i >= 0 ? argv[i + 1] : null
    return m && !m.startsWith('--') ? m : null
  })() || `同步工作台源码 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`

/** 要同步的顶层项：[源相对路径, 目标相对路径, 递归?] */
const MAP = [
  ['外壳', '外壳', false], // 只取顶层文件 + 下面白名单的子目录
  ['工具', '工具', true],
  ['keepalive', 'keepalive', true],
  ['说明', '说明', true],
  ['插件/启动动画', '插件/启动动画', true],
]
/** 外壳 下允许递归的子目录 */
const SHELL_SUBS = ['renderer', 'scenarios', 'scripts']
/** 根目录单文件 */
const ROOT_FILES = ['启动.vbs', 'launch-inner.cmd', '.gitignore']

/** 文件名级排除 */
const EXCLUDE_NAMES = [/\.bak/i, /^server\.log/i, /\.log$/i, /^Thumbs\.db$/i, /^desktop\.ini$/i]
/** 目录名级排除 */
const EXCLUDE_DIRS = new Set(['node_modules', 'data', 'captures', 'dist', 'sessions', 'attachments', '引擎', '引擎数据'])
/** 路径级排除（相对 我的工作台/ 用 / 分隔） */
const EXCLUDE_PATHS = [
  '外壳/renderer/assets/boot-video.mp4', // 12.75MB，与上游模板里的完全相同
  '外壳/renderer/assets/boot-video-720p.mp4', // 2.47MB，同上
]

const norm = (p) => p.split(path.sep).join('/')
const skipName = (n) => EXCLUDE_NAMES.some((re) => re.test(n))

/** 收集源侧要同步的文件：返回 Map<目标相对路径(用/) , 绝对源路径> */
function collect() {
  const out = new Map()
  const addDir = (srcDir, relBase, recursive) => {
    for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (skipName(ent.name)) continue
      const abs = path.join(srcDir, ent.name)
      const rel = relBase ? `${relBase}/${ent.name}` : ent.name
      if (ent.isDirectory()) {
        if (EXCLUDE_DIRS.has(ent.name)) continue
        if (recursive) addDir(abs, rel, true)
      } else if (ent.isFile()) {
        if (EXCLUDE_PATHS.includes(norm(rel))) continue
        out.set(norm(rel), abs)
      }
    }
  }
  for (const [srcRel, dstRel, recursive] of MAP) {
    const srcDir = path.join(SRC, srcRel)
    if (!fs.existsSync(srcDir)) continue
    addDir(srcDir, dstRel, recursive)
    // 外壳：补白名单子目录
    if (srcRel === '外壳') {
      for (const sub of SHELL_SUBS) {
        const sp = path.join(srcDir, sub)
        if (fs.existsSync(sp)) addDir(sp, `${dstRel}/${sub}`, true)
      }
    }
  }
  for (const f of ROOT_FILES) {
    const abs = path.join(SRC, f)
    if (fs.existsSync(abs)) out.set(norm(f), abs)
  }
  return out
}

/** 仓库侧现有文件 */
function existing() {
  const out = new Set()
  const walk = (dir, relBase) => {
    if (!fs.existsSync(dir)) return
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relBase ? `${relBase}/${ent.name}` : ent.name
      if (ent.isDirectory()) walk(path.join(dir, ent.name), rel)
      else out.add(norm(rel))
    }
  }
  walk(DEST, '')
  return out
}

const src = collect()
const dst = existing()

const added = []
const changed = []
const same = []
for (const [rel, abs] of src) {
  const target = path.join(DEST, rel)
  if (!dst.has(rel)) {
    added.push(rel)
    continue
  }
  const a = fs.statSync(abs)
  const b = fs.statSync(target)
  if (a.size !== b.size) changed.push(rel)
  else if (!fs.readFileSync(abs).equals(fs.readFileSync(target))) changed.push(rel)
  else same.push(rel)
}
const removed = [...dst].filter((rel) => !src.has(rel))

const kb = (n) => `${(n / 1024).toFixed(1)}KB`
let totalBytes = 0
for (const [, abs] of src) totalBytes += fs.statSync(abs).size

console.log(`源    : ${SRC}`)
console.log(`目标  : ${DEST}`)
console.log(`比对  : 共 ${src.size} 个文件 / ${(totalBytes / 1024 / 1024).toFixed(2)}MB`)
console.log(`  新增 ${added.length}`)
for (const r of added.slice(0, 40)) console.log(`    + ${r}`)
if (added.length > 40) console.log(`    …还有 ${added.length - 40} 个`)
console.log(`  修改 ${changed.length}`)
for (const r of changed.slice(0, 40)) console.log(`    M ${r}`)
if (changed.length > 40) console.log(`    …还有 ${changed.length - 40} 个`)
console.log(`  删除 ${removed.length}`)
for (const r of removed.slice(0, 40)) console.log(`    - ${r}`)
if (removed.length > 40) console.log(`    …还有 ${removed.length - 40} 个`)
console.log(`  未变 ${same.length}`)

if (!FLAG_PUSH) {
  console.log('\n干跑结束。要真同步并推送：node 工具\\同步仓库.mjs --push "提交说明"')
  process.exit(0)
}

if (!fs.existsSync(path.join(REPO, '.git'))) {
  console.error(`\n✗ ${REPO} 不是 git 仓库。先 clone：`)
  console.error(`  git clone https://github.com/Darling-02-02/lingmindu-workbench.git "${REPO}"`)
  process.exit(1)
}

// 1) 复制新增/修改
fs.mkdirSync(DEST, { recursive: true })
let copied = 0
for (const rel of [...added, ...changed]) {
  const target = path.join(DEST, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(src.get(rel), target)
  copied++
}
// 2) 删除多余
const prunedDirs = []
for (const rel of removed) {
  const target = path.join(DEST, rel)
  try {
    fs.unlinkSync(target)
    let d = path.dirname(target)
    while (d.length > DEST.length && fs.readdirSync(d).length === 0) {
      fs.rmdirSync(d)
      prunedDirs.push(norm(path.relative(DEST, d)))
      d = path.dirname(d)
    }
  } catch {}
}
console.log(`\n已写盘：复制 ${copied} 个，删除 ${removed.length} 个，清空目录 ${prunedDirs.length} 个`)

if (copied === 0 && removed.length === 0) {
  console.log('无变化，跳过提交。')
  process.exit(0)
}

// 3) 提交推送
const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
try {
  git('add', '-A')
  const dirty = git('status', '--porcelain').trim()
  if (!dirty) {
    console.log('git 里没有实际变化，跳过提交。')
    process.exit(0)
  }
  git('commit', '-q', '-m', MSG)
  const log = git('log', '--oneline', '-1').trim()
  console.log(`已提交：${log}`)
  const pushOut = execFileSync('git', ['push', 'origin', 'HEAD:main'], {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  console.log(`已推送：${(pushOut || '').trim() || 'ok'}`)
  console.log(`仓库：https://github.com/Darling-02-02/lingmindu-workbench`)
} catch (e) {
  console.error('\n✗ git 步骤失败：')
  console.error((e.stderr || e.stdout || e.message || '').toString().trim())
  console.error('\n提示：github.com 直连常常超时，先设一次代理：')
  console.error('  git config --global http.https://github.com.proxy http://127.0.0.1:7890')
  process.exit(1)
}
