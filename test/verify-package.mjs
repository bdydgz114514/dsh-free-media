/**
 * 用**插件市场自己的模块**校验本包是否符合市场要求。
 *
 * 不自己写一套判断——市场怎么判，就用它的代码怎么判，避免「我以为合规」。
 * 市场没装时优雅跳过（退出码 0），所以在别人机器上跑也不会红。
 *
 * 运行：node test/verify-package.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 市场可能装在任一 profile 下；也允许用 DSH_MARKET_DIR 覆盖。 */
function findMarket() {
  if (process.env.DSH_MARKET_DIR) return process.env.DSH_MARKET_DIR
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const profiles = path.join(home, 'profiles')
  if (!existsSync(profiles)) return null
  for (const p of ['desktop', 'web', 'headless']) {
    const dir = path.join(profiles, p, 'node_modules', 'dshmarket')
    if (existsSync(path.join(dir, 'lib', 'check.js'))) return dir
  }
  return null
}

const marketDir = findMarket()
if (!marketDir) {
  console.log('SKIP: 未找到 dshmarket，跳过市场合规校验（不影响本包使用）')
  process.exit(0)
}

const check = await import(pathToFileURL(path.join(marketDir, 'lib', 'check.js')).href)
const compat = await import(pathToFileURL(path.join(marketDir, 'lib', 'discovery-compatibility.js')).href)

const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))

let failures = 0
const ok = (label, detail = '') => console.log(`PASS  ${label}${detail ? '  ' + detail : ''}`)
const bad = (label, detail = '') => { failures++; console.log(`FAIL  ${label}${detail ? '  ' + detail : ''}`) }

console.log(`用市场模块校验：${marketDir}\n`)

// --- 1) bundle 必须声明 patch，否则 profile 会启动失败 ---
const declaredPatch = manifest.dsh?.bundle?.patch
if (declaredPatch) ok('dsh.bundle.patch 已声明', declaredPatch)
else bad('dsh.bundle.patch 缺失', '— 市场判定会导致 profile 无法启动')

// --- 2) patch 文件必须存在且能解析成条目列表 ---
if (declaredPatch) {
  const patchPath = path.resolve(PACKAGE_ROOT, declaredPatch)
  if (!existsSync(patchPath)) {
    bad('patch 文件不存在', patchPath)
  } else {
    const parsed = check.parsePatchFile(patchPath)
    if (Array.isArray(parsed) && parsed.length > 0) {
      const insertRows = parsed.flatMap((p) => p?.insert ?? [])
      ok('patch 文件可解析', `${parsed.length} 个条目，insert 行 ${insertRows.length} 个`)
      const row = insertRows[0]
      if (row && row.name === manifest.name) ok('insert 行 name 与包名一致', row.name)
      else bad('insert 行 name 与包名不一致', `行内=${row?.name} 包名=${manifest.name}`)
      if (Array.isArray(row?.inject) && row.inject.length > 0) ok('insert 行声明了 inject', row.inject.join(', '))
      else bad('insert 行缺少 inject', '缺少它 apply 可能在服务就绪前跑，注册会丢')
    } else {
      bad('patch 文件不是合法的条目列表', String(parsed))
    }
  }
}

// --- 3) 宿主兼容性：用市场自己的推导 ---
const facts = compat.manifestFacts(manifest)
let hostPackages = new Set()
try {
  const dshInstall = process.env.DSH_INSTALL_DIR
    || path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh')
  if (existsSync(dshInstall)) {
    hostPackages = new Set(check.corePackageNames(dshInstall))
  }
} catch { /* 拿不到就用空集合 */ }

const hostVersion = process.env.DSH_VERSION || readHostVersion()
const verdict = compat.deriveHostCompatibility(facts, hostVersion, hostPackages)
console.log(`      宿主版本=${hostVersion ?? '未知'}  兼容性判定=${verdict.status}  依据=${verdict.basis}  要求=${verdict.requirement ?? '未声明'}`)
if (verdict.status === 'incompatible') bad('宿主兼容性', '市场会判为不兼容并拒绝安装')
else ok('宿主兼容性', verdict.status)

// --- 4) 点出真正会扣分的项：宿主 peer 不匹配 ---
const hostPeers = Object.keys(manifest.peerDependencies ?? {})
  .filter((n) => /^@deepseek-ai\/dsh(?:-|$)/.test(n))
const declaredHostPeers = hostPeers.filter((n) => hostPackages.has(n))
if (declaredHostPeers.length === 0) {
  ok('未声明会解析不到的宿主 peer', '本包零宿主 import，故不需要')
} else {
  for (const n of declaredHostPeers) {
    const v = compat.classifyPeer(manifest.name, n, manifest.peerDependencies[n], hostVersion, false)
    if (v.kind === 'risk') bad(`peer 风险：${n}`, JSON.stringify(v.risk))
    else ok(`peer 正常：${n}`, v.kind)
  }
}

// --- 5) files 白名单必须覆盖运行时要用的东西 ---
const files = manifest.files ?? []
for (const need of ['lib/', 'scripts/', 'skills/', 'cordis.patch.yml']) {
  if (files.includes(need)) ok(`files 含 ${need}`)
  else bad(`files 缺 ${need}`, '发布后运行时会缺文件')
}

console.log('')
if (failures > 0) {
  console.log(`结论：${failures} 项不合格，市场可能拒绝或安装后启动失败。`)
  process.exit(1)
}
console.log('结论：全部通过——可用于市场安装（本地或发布后）。')

function readHostVersion() {
  try {
    const dshInstall = process.env.DSH_INSTALL_DIR
      || path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh')
    const pj = path.join(dshInstall, 'package.json')
    if (existsSync(pj)) return JSON.parse(readFileSync(pj, 'utf8')).version
  } catch { /* ignore */ }
  return null
}
