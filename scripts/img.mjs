#!/usr/bin/env node
// 免费文生图。两个供应商，都免费：
//   - 智谱 CogView-3-Flash（需免费 Key，**推荐**）：精确给足尺寸、上限 2.1 MP、只卡并发不卡日用量
//   - Pollinations（无需 Key，兜底）：有约 0.59 MP 上限且会**静默缩小**
//
// 实测要点（2026-10-03 / 10-05 验证）：
//  1. Pollinations 免费模型只剩 `sana`；老教程里的 turbo/flux 已失效（model=turbo 返回 500）。
//  2. Pollinations 必须显式带 width/height，否则返回 HTTP 200 + Content-Length: 0（空响应）。
//  3. 中文提示词会被拉向写实风，默认自动译成英文（走 text.pollinations.ai，同样免费无 Key）。
//  4. **Pollinations 免费档静默降采样**：请求 1024x1024 → 实际 768x768；1280x720 与 1920x1080
//     都 → 1024x576。三者恰好都是 589,824 像素，即上限约 0.59 MP。
//     **智谱不会缩水**：实测 2048x1024、1440x1440 都精确给足（2048x1024 = 2^21 正好卡上限）。
//  5. 两个免费档对**精确人数/数量**都不可靠：同一个「三个男生一个女生」的提示词，
//     Pollinations 5 次得 3/5～6/2/2/5 人；智谱一次得 5 人。需要精确人数必须上本地 + ControlNet。
//  6. 智谱返回的图片 URL 以 `.png` 结尾，**但字节其实是 JPEG**（实测魔数 FF D8 FF E0）。
//     所以落盘扩展名一律由字节推断，不信 URL、也不信 Content-Type。
//
// 用法：
//   node img.mjs "一只坐在雪地里的红狐狸" --size 1024x1024
//   node img.mjs "cyberpunk city" --provider pollinations --n 3 --out D:\pics
//   node img.mjs "测试" --dry-run
//
// 输出：stdout 打印 JSON（ok/provider/paths/actualSize...），进度信息走 stderr。

import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TXT_ENDPOINT = 'https://text.pollinations.ai/openai'
const DEFAULT_SIZE = '1024x1024'
const TIMEOUT_MS = 180_000
const KEY_FILE = path.join(homedir(), '.dsh', 'free-media-keys.json')

/**
 * 两个免费出图供应商。
 *
 * 为什么有第二个：Pollinations 免费档有**约 0.59 MP 的像素上限并把请求静默缩小**
 * （请求 1024x1024 实得 768x768）；而智谱免费的 `cogview-3-flash` **精确给足、不缩水**，
 * 上限 2^21 px（约 2.1 MP，是前者的 3.55 倍），且**只卡并发、不卡日用量**。
 * 代价只是要一个免费的智谱 Key（很多人已经有——本仓库的视频生成就用它）。
 *
 * 两个上限都是**实测**出来的，不是抄文档：
 *  - Pollinations：512 / 1024x1024 / 1280x720 / 1920x1080 各打一次，后三者恰好都是 589,824 px。
 *  - 智谱：故意传非法尺寸，服务端用错误码 1214 报出规则；再实测 2048x1024 与 1440x1440 均精确给足。
 */
const PROVIDERS = {
  pollinations: {
    label: 'Pollinations',
    kind: 'pollinations',
    endpoint: 'https://image.pollinations.ai/prompt',
    model: process.env.FREE_MEDIA_POLLINATIONS_MODEL || 'sana',
    needsKey: false,
    maxPixels: 589_824, // 实测上限，超出会被静默按比例缩小
    // Pollinations 会**接受**超额请求然后静默缩小，所以这里不能硬拦——
    // 硬拦会把「要个大图、让服务端缩」这个原本可用的行为变成报错。只警告。
    rejectOverPixels: false,
    multipleOf: 1,
    minSide: 64,
    maxSide: 4096,
    sizeNote: '免费档上限约 0.59 MP，超出会被静默缩小',
  },
  zhipu: {
    label: '智谱 CogView-3-Flash',
    kind: 'zhipu',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/images/generations',
    model: 'cogview-3-flash',
    needsKey: true,
    keyEnv: 'ZHIPU_API_KEY',
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    maxPixels: 2 ** 21, // 2,097,152；实测（错误码 1214 + 边界验证）
    rejectOverPixels: true, // 智谱是真的拒绝（HTTP 400 / 1214），所以提前拦下来给清楚的报错
    multipleOf: 16,
    minSide: 512,
    maxSide: 2880,
    sizeNote: '每边 512–2880 且须为 16 的倍数，总像素 ≤ 2^21',
  },
}

// ---------- 参数解析 ----------

function parseArgs(argv) {
  const opts = {
    prompt: '',
    out: 'generate/image',
    size: DEFAULT_SIZE,
    provider: 'auto', // auto = 有智谱 Key 就用智谱（更好），否则 Pollinations
    model: null,      // null = 用所选 provider 的默认模型
    key: null,
    seed: null,
    n: 1,
    translate: null, // null = 自动（含中日韩字符时翻译）
    dryRun: false,
    verbose: false,
    delayMs: 8000, // 多张之间的间隔；免费档限流很紧，连发必吃 402
    retries: 4,
  }
  const words = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) fail(`参数 ${a} 缺少取值`)
      return v
    }
    switch (a) {
      case '--out': case '-o': opts.out = next(); break
      case '--size': case '-s': opts.size = next(); break
      case '--provider': case '-p': opts.provider = next(); break
      case '--model': case '-m': opts.model = next(); break
      case '--key': case '-k': opts.key = next(); break
      case '--seed': opts.seed = Number(next()); break
      case '--n': opts.n = Math.max(1, Number(next())); break
      case '--retries': opts.retries = Math.max(1, Number(next())); break
      case '--delay': opts.delayMs = Math.max(0, Number(next())); break
      case '--verbose': case '-v': opts.verbose = true; break
      case '--translate': opts.translate = true; break
      case '--no-translate': opts.translate = false; break
      case '--dry-run': opts.dryRun = true; break
      case '-h': case '--help': usage(); process.exit(0); break
      default:
        if (a.startsWith('--')) fail(`未知参数：${a}`)
        words.push(a)
    }
  }
  opts.prompt = words.join(' ').trim()
  if (!['auto', ...Object.keys(PROVIDERS)].includes(opts.provider)) {
    fail(`--provider 只能是 auto / ${Object.keys(PROVIDERS).join(' / ')}，收到：${opts.provider}`)
  }
  return opts
}

function usage() {
  process.stdout.write(`免费文生图

用法: node img.mjs "<提示词>" [选项]

选项:
  -o, --out <目录>      输出目录（默认 generate/image，相对当前目录）
  -s, --size <WxH>      请求尺寸（默认 1024x1024）
      --provider <名>   auto（默认）/ zhipu / pollinations
                        auto = 有智谱 Key 就用 zhipu（更推荐），否则 pollinations
  -m, --model <名称>    覆盖默认模型（zhipu=cogview-3-flash，pollinations=sana）
  -k, --key <Key>       智谱 Key（否则读 ZHIPU_API_KEY 或 ~/.dsh/free-media-keys.json）
      --seed <数字>     随机种子
      --n <数量>        生成张数（默认 1）
      --delay <毫秒>    多张之间的间隔（默认 8000）
      --translate       强制把提示词译成英文
      --no-translate    不翻译
      --retries <次数>  失败重试次数（默认 4）
      --dry-run         只打印将发出的请求，不出图
  -v, --verbose         把进度打印到 stderr（默认静默）
  -h, --help            显示本帮助

两个供应商的实测差异：
  zhipu (cogview-3-flash)  精确给足尺寸，上限 2^21 px ≈ 2.1 MP；只卡并发，不卡日用量
  pollinations (sana)      上限约 0.59 MP，**超出会被静默缩小**（请求 1024 实得 768）

无论哪个，产物真实尺寸都以输出里的 actualSize 为准，不要拿 size（请求值）当规格。
  - 免费档限流很紧，HTTP 402/429 是常态，默认会自动退避重试；连发多张请保留 --delay。
  - 两个免费档对「几个人/几个物体」这类精确计数都不可靠，别用它做需要精确数量的图。
`)
}

function fail(msg) {
  process.stderr.write(`错误：${msg}\n`)
  process.exit(2)
}

function log(opts, msg) {
  if (opts.verbose) process.stderr.write(msg + '\n')
}

// 免费档最常见的失败是 402/429（限流），需要比 5xx 更长的退避。
// 注意：`retries` 只是给调用方看梯度的长度，不参与计算——避免误以为它能改变退避曲线。
function backoffMs(status, attempt) {
  const isRateLimit = status === 402 || status === 429
  if (isRateLimit) {
    const ladder = [15_000, 30_000, 45_000, 60_000]
    return ladder[Math.min(attempt - 1, ladder.length - 1)]
  }
  return Math.min(3000 * attempt, 15_000)
}

/** 不可重试的错误（例如请求本身有问题），立刻抛出而不是白等 4 轮退避。 */
function fatal(message) {
  const e = new Error(message)
  e.fatal = true
  return e
}

/**
 * 从图片字节里读出**真实**宽高。
 *
 * 为什么必须有这个：免费档会**静默降采样**，而且不报错。
 * 实测（2026-10-03）：
 *   请求 512x512   → 512x512
 *   请求 1024x1024 → 768x768
 *   请求 1280x720  → 1024x576
 *   请求 1920x1080 → 1024x576
 * 后三者恰好都是 589,824 像素 —— 免费档有约 0.59 MP 的上限并按比例缩放。
 * 只报告「请求的尺寸」会让调用方对产物规格产生错误认知，所以这里直接从字节里量。
 */
function imageSize(buf) {
  if (!buf || buf.length < 24) return null

  // PNG：89 50 4E 47 0D 0A 1A 0A | 长度(4) | 'IHDR' | 宽(4) | 高(4)
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }

  // JPEG：扫描 SOF0..SOF15（排除 C4 霍夫曼表 / C8 / CC 算术编码表）
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      const marker = buf[i + 1]
      if (marker === 0xff) { i++; continue }                       // 填充字节
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      const len = buf.readUInt16BE(i + 2)
      if (len < 2) return null
      const isSOF = marker >= 0xc0 && marker <= 0xcf
        && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSOF) {
        // 段内布局：标记(2) 长度(2) 精度(1) 高(2) 宽(2)
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      }
      i += 2 + len
    }
    return null
  }

  // WebP：RIFF....WEBP + 具体的块类型
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16)
    if (fmt === 'VP8X') {
      // 24 位小端、存的是「值 - 1」
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16))
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
      return { width: w, height: h }
    }
    if (fmt === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
    }
    if (fmt === 'VP8L') {
      const b = buf.readUInt32LE(21)
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
    }
  }

  return null
}

// ---------- 工具 ----------

const hasCJK = (s) => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(s)

function parseSize(size) {
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size.trim())
  if (!m) fail(`尺寸格式应为 WxH（如 1024x1024），收到：${size}`)
  return { w: Number(m[1]), h: Number(m[2]) }
}

/**
 * 按所选供应商的**实测**约束校验尺寸。**抛 Error，不直接退出进程**——
 * 早期版本在这里调 `fail()`（内部 process.exit），导致这个纯函数根本无法被单测
 * （断言捕获不到 exit，只会把测试进程一起带走）。CLI 语义交给 main() 去做。
 *
 * 两类错误要区别对待：
 *  - 服务端**一定会拒**的（智谱：每边范围 / 16 倍数 / 像素上限，错误码 1214）→ 抛错，让 main 提前给出清楚提示；
 *  - 服务端**会接受但静默缩小**的（Pollinations 的像素上限）→ 只警告，不能拦，
 *    否则「要个大图、让服务端缩」这个原本可用的行为会变成报错。
 */
function validateSize(prov, w, h, opts) {
  const { minSide, maxSide, multipleOf, maxPixels, sizeNote } = prov
  const bad = (why) => {
    throw new Error(`${prov.label} 不接受 ${w}x${h}：${why}。规则：${sizeNote}`)
  }
  if (w < minSide || h < minSide || w > maxSide || h > maxSide) {
    bad(`每边需在 ${minSide}–${maxSide} 之间`)
  }
  if (w % multipleOf !== 0 || h % multipleOf !== 0) bad(`长宽须为 ${multipleOf} 的整数倍`)
  if (w * h > maxPixels) {
    if (prov.rejectOverPixels) {
      bad(`总像素 ${w * h} 超过上限 ${maxPixels}（≈${(maxPixels / 1e6).toFixed(2)} MP）`)
    }
    log(
      opts,
      `  ⚠ ${w}x${h}（${w * h} 像素）超过 ${prov.label} 的约 ${(maxPixels / 1e6).toFixed(2)} MP 上限，` +
      `服务端会静默缩小。想要精确尺寸请用 --provider zhipu（上限 2.1 MP）。`
    )
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 由**字节魔数**判断真实图片格式。
 *
 * 为什么不能信 URL / Content-Type：实测智谱返回的图片 URL 以 `.png` 结尾，
 * 字节却是 JPEG（FF D8 FF E0）——照 URL 存成 .png 会让下游读图工具直接拒绝打开。
 */
function detectFormat(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: '.png', mime: 'image/png' }
  if (buf[0] === 0xff && buf[1] === 0xd8) return { ext: '.jpg', mime: 'image/jpeg' }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { ext: '.webp', mime: 'image/webp' }
  if (buf.toString('ascii', 0, 3) === 'GIF') return { ext: '.gif', mime: 'image/gif' }
  return null
}

/** Content-Type 作为**兜底**（魔数认不出来时用）。 */
function extFromContentType(ct) {
  const t = (ct || '').toLowerCase()
  if (t.includes('png')) return '.png'
  if (t.includes('webp')) return '.webp'
  if (t.includes('gif')) return '.gif'
  if (t.includes('jpeg') || t.includes('jpg')) return '.jpg'
  return '.jpg'
}

/** 取真实扩展名：魔数优先，其次 Content-Type，最后退回 .jpg。 */
function resolveExt(buf, contentType) {
  return detectFormat(buf)?.ext ?? extFromContentType(contentType)
}

function slugify(s, max = 40) {
  const cleaned = s
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return (cleaned || 'image').slice(0, max)
}

function timestamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function fetchWithTimeout(url, init = {}, ms = TIMEOUT_MS) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ac.signal })
  } finally {
    clearTimeout(t)
  }
}

// ---------- 免费翻译（同样无需 Key） ----------

async function translateToEnglish(text, opts) {
  const body = {
    model: 'openai-fast',
    messages: [
      {
        role: 'user',
        content:
          'Translate the following image-generation prompt into English. Output ONLY the translation, ' +
          'no quotes, no explanation, keep any comma-separated tag structure:\n\n' + text,
      },
    ],
    max_tokens: 400,
  }
  try {
    const res = await fetchWithTimeout(TXT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 60_000)
    if (!res.ok) {
      log(opts, `  [翻译] 失败 HTTP ${res.status}，改用原文`)
      return { text, translated: false, reason: `HTTP ${res.status}` }
    }
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      log(opts, '  [翻译] 返回为空，改用原文')
      return { text, translated: false, reason: 'empty' }
    }
    const out = content.trim().replace(/^["'“”]|["'“”]$/g, '')
    log(opts, `  [翻译] ${text} → ${out}`)
    return { text: out, translated: true }
  } catch (e) {
    log(opts, `  [翻译] 异常 ${e.message}，改用原文`)
    return { text, translated: false, reason: e.message }
  }
}

// ---------- 出图 ----------

function buildUrl({ prompt, w, h, model, seed }) {
  const u = new URL(`${PROVIDERS.pollinations.endpoint}/${encodeURIComponent(prompt)}`)
  // 这两个参数是必须的：缺了会拿到 200 + 空 body。
  u.searchParams.set('width', String(w))
  u.searchParams.set('height', String(h))
  u.searchParams.set('model', model)
  u.searchParams.set('nologo', 'true')
  if (seed !== null && Number.isFinite(seed)) u.searchParams.set('seed', String(seed))
  return u
}

async function generateOne(url, opts) {
  let lastErr = 'unknown'
  for (let attempt = 1; attempt <= opts.retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'free-media-skill/1.0' } })
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`
        const retryable = [402, 429, 500, 502, 503, 504].includes(res.status)
        if (!retryable) {
          // 400/404 这类是请求本身的问题，重试只是白等
          throw fatal(`${lastErr}（不可重试：请求本身有问题，检查提示词/尺寸/模型名）`)
        }
        if (attempt < opts.retries) {
          const wait = backoffMs(res.status, attempt)
          log(opts, `  第 ${attempt} 次失败（${lastErr}），${Math.round(wait / 1000)}s 后重试`)
          await sleep(wait)
          continue
        }
        throw new Error(lastErr)
      }
      const ct = res.headers.get('content-type') || ''
      if (!ct.startsWith('image/')) {
        // 内容类型不对多半是被上游换成了错误页，属于请求问题
        throw fatal(`Content-Type 不是图片：${ct || '(空)'}`)
      }
      const buf = Buffer.from(await res.arrayBuffer())
      // 已实测的坑：HTTP 200 + Content-Length: 0 的空响应
      if (buf.length < 1024) {
        lastErr = `响应过小（${buf.length} 字节），疑似空图`
        if (attempt < opts.retries) {
          const wait = 5000 * attempt
          log(opts, `  第 ${attempt} 次拿到空响应，${wait / 1000}s 后重试`)
          await sleep(wait)
          continue
        }
        throw new Error(lastErr)
      }
      return { buf, ext: resolveExt(buf, ct), contentType: ct }
    } catch (e) {
      if (e.fatal) throw e
      lastErr = e.message
      if (attempt < opts.retries) {
        const wait = 5000 * attempt
        log(opts, `  第 ${attempt} 次异常（${lastErr}），${wait / 1000}s 后重试`)
        await sleep(wait)
        continue
      }
    }
  }
  throw new Error(`重试 ${opts.retries} 次后仍失败：${lastErr}`)
}

// ---------- 智谱 CogView ----------

/** Key 三选一：--key → 环境变量 → ~/.dsh/free-media-keys.json（与视频脚本共用同一个文件）。 */
async function resolveKey(opts, prov) {
  if (opts.key) return opts.key.trim()
  if (prov.keyEnv && process.env[prov.keyEnv]) return process.env[prov.keyEnv].trim()
  if (existsSync(KEY_FILE)) {
    try {
      // Windows PowerShell 的 Set-Content -Encoding utf8 会带 BOM，直接 JSON.parse 会失败
      const raw = (await readFile(KEY_FILE, 'utf8')).replace(/^\uFEFF/, '').trim()
      const v = JSON.parse(raw)?.['zhipu']
      if (typeof v === 'string' && v.trim()) return v.trim()
    } catch (e) {
      log(opts, `  [Key] 读取 ${KEY_FILE} 失败：${e.message}`)
    }
  }
  return null
}

/**
 * 生成一张智谱图。同步接口：一次请求直接拿 URL，再下载。
 *
 * 注意两个实测坑：
 *  1. 图片 URL 以 `.png` 结尾但字节是 JPEG → 扩展名由魔数决定，不信 URL。
 *  2. `watermark:false` 未签免责声明时不生效，产物仍带「AI生成」水印（URL 里能看到 `_watermark`）。
 */
async function generateZhipuOne({ prov, model, prompt, w, h, key, opts }) {
  const body = {
    model,
    prompt,
    size: `${w}x${h}`,
    watermark: false, // 需先在智谱个人中心签署免责声明才生效；不签就是带水印，属正常
  }
  let lastErr = 'unknown'
  for (let attempt = 1; attempt <= opts.retries; attempt++) {
    try {
      const res = await fetchWithTimeout(prov.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      }, 180_000)

      const text = await res.text()
      let json = null
      try { json = JSON.parse(text) } catch { /* 保持 null */ }

      if (!res.ok) {
        // 1302 = 并发超限（免费 V0 档图片并发只有 1）；1214 = 尺寸违规
        const code = json?.error?.code
        const msg = json?.error?.message || text.slice(0, 300)
        lastErr = `HTTP ${res.status}${code ? ` [${code}]` : ''}：${msg}`
        const retryable = res.status === 429 || String(code) === '1302' || res.status >= 500
        if (!retryable) throw fatal(lastErr)
        if (attempt < opts.retries) {
          const wait = backoffMs(res.status, attempt)
          log(opts, `  第 ${attempt} 次失败（${lastErr}），${Math.round(wait / 1000)}s 后重试`)
          await sleep(wait)
          continue
        }
        throw new Error(lastErr)
      }

      const url = json?.data?.[0]?.url
      if (typeof url !== 'string' || !url) {
        throw fatal(`响应里没有 data[0].url：${text.slice(0, 300)}`)
      }

      const imgRes = await fetchWithTimeout(url, {}, 180_000)
      if (!imgRes.ok) throw new Error(`下载图片失败 HTTP ${imgRes.status}`)
      const buf = Buffer.from(await imgRes.arrayBuffer())
      if (buf.length < 1024) throw new Error(`下载内容过小（${buf.length} 字节）`)

      const format = detectFormat(buf)
      if (!format) throw fatal('下载到的内容不是已知图片格式（魔数不匹配）')

      return { buf, ext: format.ext, contentType: format.mime }
    } catch (e) {
      if (e.fatal) throw e
      lastErr = e.message
      if (attempt < opts.retries) {
        const wait = 5000 * attempt
        log(opts, `  第 ${attempt} 次异常（${lastErr}），${wait / 1000}s 后重试`)
        await sleep(wait)
        continue
      }
    }
  }
  throw new Error(`重试 ${opts.retries} 次后仍失败：${lastErr}`)
}

// ---------- 主流程 ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.prompt) {
    usage()
    fail('缺少提示词')
  }

  // ---- 选供应商：auto = 有智谱 Key 就用智谱（尺寸不缩水），否则退回 Pollinations ----
  let provName = opts.provider
  let key = null
  if (provName === 'auto') {
    const zhipuKey = await resolveKey(opts, PROVIDERS.zhipu)
    if (zhipuKey) { provName = 'zhipu'; key = zhipuKey }
    else { provName = 'pollinations' }
    log(opts, `provider=auto → 选用 ${provName}（${PROVIDERS[provName].label}）`)
  }
  const prov = PROVIDERS[provName]
  if (prov.needsKey && !key) {
    key = await resolveKey(opts, prov)
    if (!key) {
      fail(
        `${prov.label} 需要 Key，但没找到。\n` +
        `  1) 去 ${prov.keyUrl} 免费注册并创建 Key\n` +
        `  2) 任选一种方式给我：环境变量 ${prov.keyEnv} / --key <值> / 写入 ${KEY_FILE}：{"zhipu":"你的Key"}\n` +
        `  或者：加 --provider pollinations 用无需 Key 的 Pollinations（但尺寸上限只有约 0.59 MP）。`
      )
    }
  }
  const model = opts.model || prov.model
  const { w, h } = parseSize(opts.size)
  try {
    validateSize(prov, w, h, opts)
  } catch (e) {
    fail(`${e.message}\n  提示：换 --provider pollinations 可放宽像素上限（但会静默缩小），或改用本地出图。`)
  }

  // 中文提示词：默认自动翻译（两个供应商看到中文都会跑偏）
  let prompt = opts.prompt
  const wantTranslate = opts.translate === null ? hasCJK(prompt) : opts.translate
  if (wantTranslate && hasCJK(prompt)) {
    log(opts, '检测到中日韩文字，先免费翻译成英文…')
    const r = await translateToEnglish(prompt, opts)
    prompt = r.text
  }

  const outDir = path.resolve(process.cwd(), opts.out)
  const baseSeed = Number.isFinite(opts.seed) ? opts.seed : Math.floor(Math.random() * 1e9)

  // Pollinations 走 GET URL；智谱走 POST，所以只有前者需要预先建 URL
  const planned = []
  for (let i = 0; i < opts.n; i++) {
    planned.push({
      index: i,
      seed: baseSeed + i,
      ...(prov.kind === 'pollinations'
        ? { url: String(buildUrl({ prompt, w, h, model, seed: baseSeed + i })) }
        : {}),
    })
  }

  if (opts.dryRun) {
    const out = {
      ok: true,
      dryRun: true,
      provider: provName,
      providerLabel: prov.label,
      model,
      promptOriginal: opts.prompt,
      promptUsed: prompt,
      size: `${w}x${h}`,
      outDir,
      ...(prov.kind === 'pollinations'
        ? { urls: planned.map((p) => p.url) }
        : {
            endpoint: prov.endpoint,
            body: { model, prompt, size: `${w}x${h}`, watermark: false },
            note: 'watermark:false 需先在智谱个人中心签署免责声明才生效；不签则产物带「AI生成」水印',
          }),
    }
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
    return
  }

  await mkdir(outDir, { recursive: true })

  const results = []
  for (const job of planned) {
    if (job.index > 0 && opts.delayMs > 0) {
      log(opts, `  等待 ${Math.round(opts.delayMs / 1000)}s 再发下一张（免费档限流）`)
      await sleep(opts.delayMs)
    }
    log(opts, `[${job.index + 1}/${planned.length}] 出图中… ${provName}/${model} ${w}x${h}`)
    const t0 = Date.now()
    try {
      const { buf, ext } = prov.kind === 'zhipu'
        ? await generateZhipuOne({ prov, model, prompt, w, h, key, opts })
        : await generateOne(job.url, opts)
      const file = path.join(outDir, `${timestamp()}-${slugify(prompt)}-${job.index + 1}${ext}`)
      await writeFile(file, buf)
      const elapsed = Date.now() - t0
      // 量一下真实尺寸：不能拿请求值当产物规格（Pollinations 会静默降采样）
      const actual = imageSize(buf)
      const sizeMatches = actual ? (actual.width === w && actual.height === h) : null
      if (actual && sizeMatches === false) {
        log(opts, `  ⚠ 请求 ${w}x${h}，实际得到 ${actual.width}x${actual.height}（服务端缩水了）`)
      }
      log(opts, `  ✓ ${file}  ${(buf.length / 1024).toFixed(1)} KB  ${(elapsed / 1000).toFixed(1)}s`)
      results.push({
        ok: true, path: file, bytes: buf.length, elapsedMs: elapsed,
        ...(job.url ? { url: job.url } : {}),
        ...(actual ? { actualSize: actual, sizeMatches } : {}),
      })
    } catch (e) {
      log(opts, `  ✗ 失败：${e.message}`)
      results.push({ ok: false, error: e.message, ...(job.url ? { url: job.url } : {}) })
    }
  }

  const firstOk = results.find((r) => r.ok)
  const out = {
    ok: results.some((r) => r.ok),
    provider: provName,
    providerLabel: prov.label,
    model,
    promptOriginal: opts.prompt,
    promptUsed: prompt,
    size: `${w}x${h}`,
    ...(firstOk?.actualSize ? { actualSize: firstOk.actualSize } : {}),
    ...(firstOk?.sizeMatches !== undefined ? { sizeMatches: firstOk.sizeMatches } : {}),
    ...(firstOk?.sizeMatches === false
      ? {
          sizeNote:
            `${prov.label} 把请求的 ${w}x${h} 缩成了 ${firstOk.actualSize.width}x${firstOk.actualSize.height}（${prov.sizeNote}）。` +
            `想要精确尺寸可换 --provider zhipu（上限 2^21 px），或改用本地出图。`,
        }
      : {}),
    outDir,
    paths: results.filter((r) => r.ok).map((r) => r.path),
    results,
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  if (!out.ok) process.exit(1)
}

export { imageSize, parseSize, buildUrl, slugify, extFromContentType, detectFormat, validateSize, PROVIDERS }

/**
 * 只在被直接执行时跑 main；被 import 时只暴露函数，方便单测 imageSize 这类纯函数。
 *
 * ⚠️ 必须用 realpathSync 比较，不能用 `import.meta.url === pathToFileURL(argv[1]).href`：
 * DSH 用 `link:` 方式安装插件时，宿主拿到的脚本路径是**符号链接路径**
 * （`…\profiles\desktop\node_modules\dsh-free-media\scripts\img.mjs`），
 * 而 Node 默认把 `import.meta.url` 解析成 **realpath**（`D:\…\projects\dsh-free-media\…`）。
 * 字符串比较会判定「不是直接执行」→ main() 从不运行 → **进程退出 0 但 stdout 为空**，
 * 调用方只会看到一句莫名其妙的「stdout 不是合法 JSON」。这个 bug 真的发生过。
 */
const invokedDirectly = (() => {
  const arg = process.argv[1]
  if (!arg) return false
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main().catch((e) => {
    process.stderr.write(`未捕获错误：${e?.stack || e}\n`)
    process.exit(1)
  })
}
