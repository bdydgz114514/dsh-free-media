#!/usr/bin/env node
// 免费视频生成（需要免费注册拿 Key，无需付费、无需信用卡）
//
// 两个供应商：
//   zhipu（默认）智谱 CogVideoX-Flash —— 官方文档明确列为免费视频生成模型。
//                契约取自官方 OpenAPI：
//                  POST https://open.bigmodel.cn/api/paas/v4/videos/generations
//                  GET  https://open.bigmodel.cn/api/paas/v4/async-result/{id}
//                Key 申请：https://bigmodel.cn/usercenter/proj-mgmt/apikeys
//   agnes       Agnes AI agnes-video-v2.0 —— 免费开放，OpenAI 兼容。
//                 契约：POST /v1/videos  ->  GET /v1/videos/{id}
//                Key 申请：https://agnes-ai.com/
//
// ✅ 已端到端实跑通过（2026-10-03，智谱 cogvideox-flash，真实免费 Key）：
//    5s 视频约 41 秒出片，落盘 1280x960 h264 / 5.108s / 无音轨，响应另带 cover_image_url 封面。
//    免费档画面右下角有「AI生成」烧入水印。
//    注意：请求的 fps=30 与产物容器实际 r_frame_rate(37/1) 不一致，断言产物规格请用 ffprobe。
//    cogvideox-flash 契约里没有 duration 字段，免费档时长不可调。
//    若上游返回体与契约不符，脚本会把原始响应打印出来，便于定位。
//
// 用法：
//   node vgen.mjs "一只猫在玩球" --provider zhipu
//   node vgen.mjs "镜头缓慢推进" --image D:\pics\a.jpg      # 图生视频
//   node vgen.mjs "测试" --dry-run                          # 只看请求，不发送

import { mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const PROVIDERS = {
  zhipu: {
    label: '智谱 CogVideoX-Flash（免费）',
    createUrl: 'https://open.bigmodel.cn/api/paas/v4/videos/generations',
    resultUrl: (id) => `https://open.bigmodel.cn/api/paas/v4/async-result/${encodeURIComponent(id)}`,
    model: 'cogvideox-flash',
    keyEnv: 'ZHIPU_API_KEY',
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    supportsImage: true,
    sizes: ['720x480', '1024x1024', '1280x960', '960x1280', '1920x1080', '1080x1920', '2048x1080', '3840x2160'],
    defaultSize: '1280x960',
    note: '免费档默认带水印；关闭水印需在个人中心签署免责声明。prompt 上限 512 字符。',
  },
  agnes: {
    label: 'Agnes AI agnes-video-v2.0（免费）',
    createUrl: 'https://apihub.agnes-ai.com/v1/videos',
    resultUrl: (id) => `https://apihub.agnes-ai.com/v1/videos/${encodeURIComponent(id)}`,
    model: 'agnes-video-v2.0',
    keyEnv: 'AGNES_API_KEY',
    keyUrl: 'https://agnes-ai.com/',
    supportsImage: true,
    sizes: null,
    defaultSize: '1280x720',
    note: '官方声明免费但无 SLA，高峰期可能 500/502/503。',
  },
}

const TXT_ENDPOINT = 'https://text.pollinations.ai/openai'
const KEY_FILE = path.join(homedir(), '.dsh', 'free-media-keys.json')

// ---------- 参数 ----------

function parseArgs(argv) {
  const opts = {
    prompt: '',
    provider: 'zhipu',
    out: 'generate/video',
    size: null,
    fps: 30,
    quality: 'speed',
    withAudio: false,
    noWatermark: false,
    image: null,
    key: null,
    pollMs: 5000,
    timeoutMs: 600_000,
    translate: false,
    dryRun: false,
    verbose: false,
    resubmit: false,
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
      case '--provider': case '-p': opts.provider = next(); break
      case '--out': case '-o': opts.out = next(); break
      case '--size': case '-s': opts.size = next(); break
      case '--fps': opts.fps = Number(next()); break
      case '--quality': opts.quality = next(); break
      case '--with-audio': opts.withAudio = true; break
      case '--no-watermark': opts.noWatermark = true; break
      case '--image': case '-i': opts.image = next(); break
      case '--key': case '-k': opts.key = next(); break
      case '--poll': opts.pollMs = Math.max(1000, Number(next())); break
      case '--timeout': opts.timeoutMs = Math.max(10_000, Number(next())); break
      case '--translate': opts.translate = true; break
      case '--resubmit': opts.resubmit = true; break
      case '--dry-run': opts.dryRun = true; break
      case '--verbose': case '-v': opts.verbose = true; break
      case '-h': case '--help': usage(); process.exit(0); break
      default:
        if (a.startsWith('--')) fail(`未知参数：${a}`)
        words.push(a)
    }
  }
  opts.prompt = words.join(' ').trim()
  if (!PROVIDERS[opts.provider]) fail(`未知 provider：${opts.provider}（可选：${Object.keys(PROVIDERS).join(' / ')}）`)
  return opts
}

function usage() {
  process.stdout.write(`免费视频生成（需免费注册的 Key）

用法: node vgen.mjs "<提示词>" [选项]

选项:
  -p, --provider <名>  zhipu（默认，智谱 CogVideoX-Flash）/ agnes
  -o, --out <目录>     输出目录（默认 generate/video）
  -s, --size <WxH>     分辨率（zhipu 默认 1280x960）
      --fps <数字>     帧率，zhipu 可选 30 / 60（默认 30）
      --quality <档>   zhipu：speed（默认）/ quality
      --with-audio     让 zhipu 生成 AI 音效
      --no-watermark   关闭水印（需先在智谱个人中心签署免责声明）
  -i, --image <路径>   图生视频：本机图片，会转成 base64 上传
  -k, --key <Key>     直接给 Key（否则读环境变量或 ~/.dsh/free-media-keys.json）
      --poll <毫秒>    轮询间隔（默认 5000）
      --timeout <毫秒> 等待上限（默认 600000，即 10 分钟）
      --translate      先把提示词译成英文（免费）
      --dry-run        只打印请求体，不发送
  -v, --verbose        打印轮询进度到 stderr
  -h, --help           显示本帮助

Key 放哪（三选一，优先级从高到低）：
  1. --key 参数
  2. 环境变量 ZHIPU_API_KEY / AGNES_API_KEY
  3. ${KEY_FILE}
     形如 {"zhipu":"xxx","agnes":"yyy"}

免费额度、模型名、水印政策都可能变；报错时脚本会打印上游原始响应。
`)
}

function fail(msg) {
  process.stderr.write(`错误：${msg}\n`)
  process.exit(2)
}
function log(opts, msg) { if (opts.verbose) process.stderr.write(msg + '\n') }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- Key 解析 ----------

async function resolveKey(opts) {
  if (opts.key) return opts.key.trim()
  const envName = PROVIDERS[opts.provider].keyEnv
  if (process.env[envName]) return process.env[envName].trim()
  if (existsSync(KEY_FILE)) {
    try {
      // 注意：Windows PowerShell 的 Set-Content -Encoding utf8 会带 BOM，
      // 直接 JSON.parse 会失败，所以先剥掉 BOM。
      const raw = (await readFile(KEY_FILE, 'utf8')).replace(/^\uFEFF/, '').trim()
      const j = JSON.parse(raw)
      const v = j?.[opts.provider]
      if (typeof v === 'string' && v.trim()) return v.trim()
      log(opts, `  [Key] ${KEY_FILE} 里没有 "${opts.provider}" 字段`)
    } catch (e) {
      log(opts, `  [Key] 读取 ${KEY_FILE} 失败：${e.message}`)
    }
  }
  return null
}

// ---------- 免费翻译 ----------

const hasCJK = (s) => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(s)

async function translate(text, opts) {
  try {
    const res = await fetch(TXT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai-fast',
        messages: [{ role: 'user', content: 'Translate into English. Output ONLY the translation:\n\n' + text }],
        max_tokens: 400,
      }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) return text
    const d = await res.json()
    const c = d?.choices?.[0]?.message?.content
    return typeof c === 'string' && c.trim() ? c.trim() : text
  } catch { return text }
}

// ---------- HTTP ----------

async function postJson(url, key, body, opts) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 保持 null */ }
  if (!res.ok) {
    const detail = json ? JSON.stringify(json) : text.slice(0, 800)
    throw new Error(`创建任务失败 HTTP ${res.status}：${detail}`)
  }
  if (!json) throw new Error(`创建任务返回非 JSON：${text.slice(0, 800)}`)
  return json
}

async function getJson(url, key) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 保持 null */ }
  return { status: res.status, ok: res.ok, json, text }
}

function pickId(obj) {
  // 不同实现用的字段名不一，逐个试
  for (const k of ['id', 'task_id', 'request_id', 'taskId']) {
    if (typeof obj?.[k] === 'string' && obj[k]) return obj[k]
  }
  return null
}

function pickStatus(obj) {
  for (const k of ['task_status', 'status', 'state', 'taskStatus']) {
    if (typeof obj?.[k] === 'string' && obj[k]) return obj[k].toUpperCase()
  }
  return null
}

function pickVideoUrl(obj) {
  // 智谱：video_result[].url；OpenAI 风格：data[].url / output[].url / url
  const arrs = [obj?.video_result, obj?.data, obj?.output, obj?.videos, obj?.results]
  for (const a of arrs) {
    if (Array.isArray(a)) {
      for (const it of a) {
        const u = it?.url || it?.video_url || it?.videoUrl
        if (typeof u === 'string' && u) return u
      }
    }
  }
  for (const k of ['url', 'video_url', 'videoUrl']) {
    if (typeof obj?.[k] === 'string' && obj[k]) return obj[k]
  }
  return null
}

function pickCoverUrl(obj) {
  const arrs = [obj?.video_result, obj?.data, obj?.output]
  for (const a of arrs) {
    if (Array.isArray(a)) {
      for (const it of a) {
        const u = it?.cover_image_url || it?.cover_url || it?.coverImageUrl
        if (typeof u === 'string' && u) return u
      }
    }
  }
  return null
}

async function download(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(600_000) })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 1024) throw new Error(`下载内容过小（${buf.length} 字节）`)
  await writeFile(dest, buf)
  return buf.length
}

// ---------- 主流程 ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const prov = PROVIDERS[opts.provider]

  if (!opts.prompt && !opts.image) { usage(); fail('至少需要提示词或 --image') }

  let prompt = opts.prompt
  if (opts.translate && prompt && hasCJK(prompt)) {
    log(opts, '翻译提示词…')
    prompt = await translate(prompt, opts)
    log(opts, `  → ${prompt}`)
  }
  if (opts.provider === 'zhipu' && prompt.length > 512) {
    fail(`智谱 prompt 上限 512 字符，当前 ${prompt.length} 字符。请精简，或加 --translate 后重试。`)
  }

  const size = opts.size || prov.defaultSize
  if (prov.sizes && !prov.sizes.includes(size)) {
    fail(`${opts.provider} 的 size 只能是：${prov.sizes.join(' / ')}（收到 ${size}）`)
  }

  // 组装请求体
  const body = { model: prov.model, prompt }
  if (opts.provider === 'zhipu') {
    if (size) body.size = size
    if (opts.fps) body.fps = opts.fps
    if (opts.quality) body.quality = opts.quality
    if (opts.withAudio) body.with_audio = true
    if (opts.noWatermark) body.watermark_enabled = false
  } else {
    if (size) body.size = size
  }

  // 图生视频
  if (opts.image) {
    const imgPath = path.resolve(process.cwd(), opts.image)
    if (!existsSync(imgPath)) fail(`找不到图片：${imgPath}`)
    const st = await stat(imgPath)
    if (st.size > 5 * 1024 * 1024) fail(`图片超过 5MB（${(st.size / 1048576).toFixed(1)}MB）：${imgPath}`)
    const ext = path.extname(imgPath).toLowerCase().replace('.', '') || 'png'
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
    const b64 = (await readFile(imgPath)).toString('base64')
    body.image_url = `data:${mime};base64,${b64}`
    log(opts, `图生视频：${imgPath}（${(st.size / 1024).toFixed(1)} KB）`)
  }

  const outDir = path.resolve(process.cwd(), opts.out)

  // dry-run：脱敏后打印
  if (opts.dryRun) {
    const shown = JSON.parse(JSON.stringify(body))
    if (shown.image_url) shown.image_url = String(shown.image_url).slice(0, 60) + `…(base64 共 ${body.image_url.length} 字符)`
    process.stdout.write(JSON.stringify({
      ok: true, dryRun: true, provider: opts.provider, providerLabel: prov.label,
      createUrl: prov.createUrl, resultUrlTemplate: prov.resultUrl('{id}'),
      body: shown, outDir, note: prov.note,
    }, null, 2) + '\n')
    return
  }

  const key = await resolveKey(opts)
  if (!key) {
    fail(
      `没有找到 ${opts.provider} 的 Key。\n` +
      `  1) 去 ${prov.keyUrl} 免费注册并创建 Key\n` +
      `  2) 然后任选一种方式给我：\n` +
      `     - 设环境变量 ${prov.keyEnv}\n` +
      `     - 或写入 ${KEY_FILE}：{"${opts.provider}":"你的Key"}\n` +
      `     - 或运行时加 --key <你的Key>`
    )
  }

  log(opts, `[${prov.label}] 创建任务…`)
  const created = await postJson(prov.createUrl, key, body, opts)
  const id = pickId(created)
  if (!id) {
    process.stderr.write('创建任务成功，但响应里找不到任务 id。原始响应：\n' + JSON.stringify(created, null, 2) + '\n')
    process.exit(1)
  }
  log(opts, `  任务 id = ${id}，开始轮询（最多 ${Math.round(opts.timeoutMs / 1000)}s）…`)

  const started = Date.now()
  let last = null
  let videoUrl = null
  while (Date.now() - started < opts.timeoutMs) {
    await sleep(opts.pollMs)
    const r = await getJson(prov.resultUrl(id), key)
    if (!r.ok) {
      log(opts, `  轮询 HTTP ${r.status}，继续等…`)
      continue
    }
    const status = pickStatus(r.json)
    last = r.json
    log(opts, `  [${Math.round((Date.now() - started) / 1000)}s] 状态：${status || '(未知)'}`)

    if (status && ['SUCCESS', 'SUCCEEDED', 'COMPLETED', 'SUCCESSFUL'].includes(status)) {
      videoUrl = pickVideoUrl(r.json)
      if (!videoUrl) {
        process.stderr.write('任务成功但找不到视频 URL。原始响应：\n' + JSON.stringify(r.json, null, 2) + '\n')
        process.exit(1)
      }
      break
    }
    if (status && ['FAIL', 'FAILED', 'ERROR', 'CANCELLED'].includes(status)) {
      process.stderr.write('任务失败。原始响应：\n' + JSON.stringify(r.json, null, 2) + '\n')
      process.exit(1)
    }
    // 有些实现直接在轮询响应里给 url，即使 status 字段缺失
    const maybe = pickVideoUrl(r.json)
    if (maybe && !status) { videoUrl = maybe; break }
  }

  if (!videoUrl) {
    process.stderr.write(
      `等待超时（${Math.round(opts.timeoutMs / 1000)}s）。任务 id = ${id}\n` +
      `视频可能还在排队。最后一次响应：\n${JSON.stringify(last, null, 2)}\n` +
      `可用同一 id 稍后再查（智谱：GET ${prov.resultUrl(id)}）。\n`
    )
    process.exit(1)
  }

  await mkdir(outDir, { recursive: true })
  const stamp = (() => {
    const d = new Date(); const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  })()
  const videoFile = path.join(outDir, `${stamp}-${opts.provider}.mp4`)
  log(opts, `下载视频…`)
  const bytes = await download(videoUrl, videoFile)

  let coverFile = null
  const coverUrl = pickCoverUrl(last)
  if (coverUrl) {
    try {
      coverFile = path.join(outDir, `${stamp}-cover.jpg`)
      await download(coverUrl, coverFile)
    } catch (e) { log(opts, `  封面下载失败：${e.message}`); coverFile = null }
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    provider: opts.provider,
    providerLabel: prov.label,
    model: prov.model,
    taskId: id,
    promptUsed: prompt,
    size,
    elapsedMs: Date.now() - started,
    video: videoFile,
    videoBytes: bytes,
    // 刻意不写 `cover: null`：调用方的 output.schema 是单类型 JSON Schema，
    // 不支持 null，留 null 会被宿主校验拒绝。没封面就让该键不出现。
    ...(coverFile ? { cover: coverFile } : {}),
    videoUrl,
    note: prov.note,
  }, null, 2) + '\n')
}

main().catch((e) => {
  process.stderr.write(`未捕获错误：${e?.stack || e}\n`)
  process.exit(1)
})
