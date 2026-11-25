#!/usr/bin/env node
/**
 * 发布前检查.mjs —— 出包/推仓库前扫一遍红线
 * 用法：node 工具\发布前检查.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..')

const RULES = [
  ['本机绝对路径 <工作台>', /<盘根>:\\\\DSH/i],
  ['本机用户目录 <用户目录>', /<盘根>:\\\\Users/i],
  ['会话 id', /session-[0-9a-f]{8}/i],
  ['密钥', /sk-[A-Za-z0-9]{16,}/],
  ['服务器 IP', /47\.108\.201\.6/],
]
const SKIP_DIR = new Set(['node_modules', '.git', '发布', 'dist', '引擎', '引擎数据', '工作区', 'data', 'captures', 'attachments', 'sessions', '_归档'])
const SKIP_EXT = /(\.png|\.jpg|\.jpeg|\.gif|\.webp|\.ico|\.woff2?|\.ttf|\.mp4|\.zip|\.7z|\.exe|\.dll)$/i
// 备份/日志不进包，也不该算红线：`xxx.json.bak-memsync-20261125…` 这类是运行时自己留的底
const SKIP_NAME = /(\.bak|\.log$|\.tmp$|\.orig$)/i
/** 这些文件里出现 session id 是设计需要（场景面板可以绑定某个具体会话），不算红线 */
const ALLOW_SESSION_ID = [/^外壳[\\/]scenarios[\\/].*\.json$/i]

let hits = 0
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name)) continue
    if (SKIP_NAME.test(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { walk(p); continue }
    if (SKIP_EXT.test(e.name)) continue
    let t
    try { t = fs.readFileSync(p, 'utf8') } catch { continue }
    const rel = path.relative(ROOT, p)
    for (const [name, re] of RULES) {
      if (name === '会话 id' && ALLOW_SESSION_ID.some((r) => r.test(rel))) continue
      const m = t.match(re)
      if (m) { console.log('✗ ' + rel + ' ← ' + name + '：' + m[0].slice(0, 30)); hits++ }
    }
  }
}
walk(ROOT)
console.log('')
if (hits) { console.log('命中 ' + hits + ' 处红线 ⇒ 不出包'); process.exit(1) }
console.log('✓ 红线检查通过（0 命中）')
