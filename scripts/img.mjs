#!/usr/bin/env node
// 免费文生图：Pollinations（无需 API Key）
//
// 实测要点（2026-10-03 验证）：
//  1. 免费模型只剩 `sana`；老教程里的 turbo/flux 已失效（model=turbo 返回 500）。
//  2. 必须显式带 width/height，否则服务端返回 HTTP 200 + Content-Length: 0（空响应）。
//  3. 中文提示词会被服务端拉向写实风，默认自动译成英文（走 text.pollinations.ai，同样免费无 Key）。
//
// 用法：
//   node img.mjs "一只坐在雪地里的红狐狸" --size 1024x1024
//   node img.mjs "cyberpunk city" --n 3 --out D:\pics
//   node img.mjs "测试" --dry-run
//
// 输出：stdout 打印 JSON（ok/paths/...），进度信息走 stderr。

import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const IMG_ENDPOINT = 'https://image.pollinations.ai/prompt'
const TXT_ENDPOINT = 'https://text.pollinations.ai/openai'
const DEFAULT_MODEL = 'sana'
const DEFAULT_SIZE = '1024x1024'
const TIMEOUT_MS = 180_000

// ---------- 参数解析 ----------

function parseArgs(argv) {
  const opts = {
    prompt: '',
    out: 'generate/image',
    size: DEFAULT_SIZE,
    model: DEFAULT_MODEL,
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
      case '--model': case '-m': opts.model = next(); break
      case '--seed': opts.seed = Number(next()); break
      case '--n': opts.n = Math.max(1, Number(next())); break
      case '--retries': opts.retries = Math.max(1, Number(next())); break
      case '--delay': opts.delayMs = Math.max(0, Number(next())); break
      case '--verbose': case '-v': opts.verbose = true; break
      case '--translate': opts.translate = true; break
      case '--no-translate': opts.translate = false; break
      case '--dry-run': opts.dryRun = true; break
      case '--json': opts.verbose = false; break
      case '-h': case '--help': usage(); process.exit(0); break
      default:
        if (a.startsWith('--')) fail(`未知参数：${a}`)
        words.push(a)
    }
  }
  opts.prompt = words.join(' ').trim()
  return opts
}

function usage() {
  process.stdout.write(`免费文生图（Pollinations，无需 Key）

用法: node img.mjs "<提示词>" [选项]

选项:
  -o, --out <目录>      输出目录（默认 generate/image，相对当前目录）
  -s, --size <WxH>      尺寸（默认 1024x1024）
  -m, --model <名称>    模型（默认 sana，免费档目前仅此一个）
      --seed <数字>     随机种子
      --n <数量>        生成张数（默认 1）
      --delay <毫秒>    多张之间的间隔（默认 8000）
      --translate       强制把提示词译成英文
      --no-translate    不翻译
      --retries <次数>  失败重试次数（默认 4）
      --dry-run         只打印将发出的请求，不出图
  -v, --verbose         把进度打印到 stderr（默认静默）
  -h, --help            显示本帮助

注意：免费档限流很紧，HTTP 402/429 是常态。默认会自动退避重试，
连发多张时请保留 --delay，否则容易自己把自己限流住。
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
function backoffMs(status, attempt, retries) {
  const isRateLimit = status === 402 || status === 429
  if (isRateLimit) {
    const ladder = [15_000, 30_000, 45_000, 60_000]
    return ladder[Math.min(attempt - 1, ladder.length - 1)]
  }
  return Math.min(3000 * attempt, 15_000)
}

// ---------- 工具 ----------

const hasCJK = (s) => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(s)

function parseSize(size) {
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size.trim())
  if (!m) fail(`尺寸格式应为 WxH（如 1024x1024），收到：${size}`)
  const w = Number(m[1])
  const h = Number(m[2])
  if (w < 64 || h < 64 || w > 4096 || h > 4096) fail(`尺寸超出合理范围（64–4096）：${size}`)
  return { w, h }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function extFromContentType(ct) {
  const t = (ct || '').toLowerCase()
  if (t.includes('png')) return '.png'
  if (t.includes('webp')) return '.webp'
  if (t.includes('jpeg') || t.includes('jpg')) return '.jpg'
  return '.jpg'
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
  const u = new URL(`${IMG_ENDPOINT}/${encodeURIComponent(prompt)}`)
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
        // 402/429/5xx 是免费档的常态限流，退避重试
        if ([402, 429, 500, 502, 503, 504].includes(res.status) && attempt < opts.retries) {
          const wait = backoffMs(res.status, attempt, opts.retries)
          log(opts, `  第 ${attempt} 次失败（${lastErr}），${Math.round(wait / 1000)}s 后重试`)
          await sleep(wait)
          continue
        }
        throw new Error(lastErr)
      }
      const ct = res.headers.get('content-type') || ''
      if (!ct.startsWith('image/')) {
        lastErr = `Content-Type 不是图片：${ct || '(空)'}`
        throw new Error(lastErr)
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
      return { buf, ext: extFromContentType(ct), contentType: ct }
    } catch (e) {
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
  const { w, h } = parseSize(opts.size)

  // 中文提示词：默认自动翻译
  let prompt = opts.prompt
  const wantTranslate = opts.translate === null ? hasCJK(prompt) : opts.translate
  if (wantTranslate && hasCJK(prompt)) {
    log(opts, '检测到中日韩文字，先免费翻译成英文…')
    const r = await translateToEnglish(prompt, opts)
    prompt = r.text
  }

  const outDir = path.resolve(process.cwd(), opts.out)
  const baseSeed = Number.isFinite(opts.seed) ? opts.seed : Math.floor(Math.random() * 1e9)

  const planned = []
  for (let i = 0; i < opts.n; i++) {
    planned.push(buildUrl({ prompt, w, h, model: opts.model, seed: baseSeed + i }))
  }

  if (opts.dryRun) {
    const out = {
      ok: true,
      dryRun: true,
      promptOriginal: opts.prompt,
      promptUsed: prompt,
      model: opts.model,
      size: `${w}x${h}`,
      outDir,
      urls: planned.map(String),
    }
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
    return
  }

  await mkdir(outDir, { recursive: true })

  const results = []
  for (let i = 0; i < planned.length; i++) {
    const url = planned[i]
    if (i > 0 && opts.delayMs > 0) {
      log(opts, `  等待 ${Math.round(opts.delayMs / 1000)}s 再发下一张（免费档限流）`)
      await sleep(opts.delayMs)
    }
    log(opts, `[${i + 1}/${planned.length}] 出图中… ${opts.model} ${w}x${h}`)
    const t0 = Date.now()
    try {
      const { buf, ext } = await generateOne(url, opts)
      const file = path.join(outDir, `${timestamp()}-${slugify(prompt)}-${i + 1}${ext}`)
      await writeFile(file, buf)
      const elapsed = Date.now() - t0
      log(opts, `  ✓ ${file}  ${(buf.length / 1024).toFixed(1)} KB  ${(elapsed / 1000).toFixed(1)}s`)
      results.push({ ok: true, path: file, bytes: buf.length, elapsedMs: elapsed, url: String(url) })
    } catch (e) {
      log(opts, `  ✗ 失败：${e.message}`)
      results.push({ ok: false, error: e.message, url: String(url) })
    }
  }

  const out = {
    ok: results.some((r) => r.ok),
    promptOriginal: opts.prompt,
    promptUsed: prompt,
    model: opts.model,
    size: `${w}x${h}`,
    outDir,
    paths: results.filter((r) => r.ok).map((r) => r.path),
    results,
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  if (!out.ok) process.exit(1)
}

main().catch((e) => {
  process.stderr.write(`未捕获错误：${e?.stack || e}\n`)
  process.exit(1)
})
