#!/usr/bin/env node
// 免费视频理解（第一段）：把视频拆成带时间码的帧，交给支持读图的模型。
//
// 零 API、零 Key、零新依赖——只用本机 ffmpeg/ffprobe。
// 局限（务必向使用者说明）：
//   - 丢失音轨：问"说了什么"需另配 ASR，本脚本不处理音频。
//   - 丢失时序：帧是离散快照，快速动作与短暂事件可能被漏掉。
//
// 用法：
//   node vframes.mjs video.mp4                          # 每秒 1 帧，缩放 512
//   node vframes.mjs video.mp4 --mode scene --scene 0.3 # 按镜头切换抽帧
//   node vframes.mjs video.mp4 --mode key               # 只取关键帧（I 帧）
//   node vframes.mjs video.mp4 --fps 2 --max 40
//   node vframes.mjs video.mp4 --grid                   # 额外拼一张联络表
//
// 输出：stdout 打印 JSON（含每帧的路径与时间码）；进度走 stderr（需 --verbose）。
// 产物：<out>/f01.jpg… 与 <out>/manifest.json

import { mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe'

// ---------- 参数 ----------

function parseArgs(argv) {
  const opts = {
    video: '',
    out: 'generate/video-frames',
    mode: 'interval', // interval | scene | key
    fps: 1,
    scene: 0.3,
    scale: 512,
    max: 24,
    grid: false,
    verbose: false,
    keep: true,
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
      case '--mode': opts.mode = next(); break
      case '--fps': opts.fps = Number(next()); break
      case '--scene': opts.scene = Number(next()); break
      case '--scale': opts.scale = Number(next()); break
      case '--max': opts.max = Number(next()); break
      case '--grid': opts.grid = true; break
      case '--verbose': case '-v': opts.verbose = true; break
      case '-h': case '--help': usage(); process.exit(0); break
      default:
        if (a.startsWith('--')) fail(`未知参数：${a}`)
        words.push(a)
    }
  }
  opts.video = words.join(' ').trim()
  if (!['interval', 'scene', 'key'].includes(opts.mode)) fail(`--mode 只能是 interval/scene/key，收到：${opts.mode}`)
  return opts
}

function usage() {
  process.stdout.write(`免费视频抽帧（只用本机 ffmpeg，无需任何 API）

用法: node vframes.mjs <视频文件> [选项]

选项:
  -o, --out <目录>    帧输出目录（默认 generate/video-frames）
      --mode <模式>   interval（默认，固定间隔）/ scene（镜头切换）/ key（仅关键帧）
      --fps <数字>    interval 模式的采样帧率（默认 1）
      --scene <阈值>  scene 模式的切换阈值 0–1（默认 0.3，越小抽得越多）
      --scale <像素>  帧的短边像素（默认 512）
      --max <数量>    最大帧数上限（默认 24，防止 token 爆炸）
      --grid          额外用 ffmpeg 拼一张联络表（概览用，省 token）
  -v, --verbose       把进度打印到 stderr（默认静默）
  -h, --help          显示本帮助

典型配合：抽完帧后用 read_image 逐帧看，或先看 --grid 的联络表建立整体印象。
`)
}

function fail(msg) {
  process.stderr.write(`错误：${msg}\n`)
  process.exit(2)
}
function log(opts, msg) { if (opts.verbose) process.stderr.write(msg + '\n') }

// ---------- ffmpeg/ffprobe 封装 ----------

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => { stdout += d.toString() })
    p.stderr.on('data', (d) => { stderr += d.toString() })
    p.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + '\n' + e.message }))
    p.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function ffprobeJson(file) {
  const r = await run(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration,size,format_name',
    '-show_entries', 'stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,channels,sample_rate',
    '-of', 'json', file,
  ])
  if (r.code !== 0) return { error: r.stderr.trim() || `ffprobe 退出码 ${r.code}` }
  try { return JSON.parse(r.stdout) } catch (e) { return { error: `ffprobe 输出解析失败：${e.message}` } }
}

// ---------- 主流程 ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.video) { usage(); fail('缺少视频文件路径') }

  const video = path.resolve(process.cwd(), opts.video)
  const probe = await ffprobeJson(video)
  if (probe.error) fail(`无法读取视频：${probe.error}`)

  const vstream = (probe.streams || []).find((s) => s.codec_type === 'video')
  if (!vstream) fail('该文件里没有视频流')
  const astream = (probe.streams || []).find((s) => s.codec_type === 'audio')

  const duration = Number(probe.format?.duration || 0)
  const srcW = vstream.width
  const srcH = vstream.height

  const outDir = path.resolve(process.cwd(), opts.out)
  await mkdir(outDir, { recursive: true })
  // 清掉上一次的帧，避免新旧混在一起
  for (const f of await readdir(outDir).catch(() => [])) {
    if (/^f\d+\.(jpg|png)$/i.test(f) || f === 'manifest.json' || f === 'grid.jpg') {
      await rm(path.join(outDir, f), { force: true })
    }
  }

  // 计算实际采样帧率，保证不超过 --max
  let fps = opts.fps
  if (opts.mode === 'interval' && duration > 0) {
    const capped = opts.max / duration
    if (capped < fps) {
      log(opts, `时长 ${duration.toFixed(1)}s，为不超过 ${opts.max} 帧，采样率从 ${fps} 降到 ${capped.toFixed(3)}`)
      fps = capped
    }
  }

  const scaleFilter = opts.scale > 0
    ? `scale=${opts.scale}:${opts.scale}:force_original_aspect_ratio=decrease`
    : null

  let vf
  if (opts.mode === 'interval') {
    vf = [`fps=${fps}`]
  } else if (opts.mode === 'scene') {
    vf = [`select='gt(scene,${opts.scene})'`]
  } else {
    vf = [`select='eq(pict_type\\,I)'`]
  }
  if (scaleFilter) vf.push(scaleFilter)
  vf.push('showinfo')

  const pattern = path.join(outDir, 'f%03d.jpg')
  const args = ['-y', '-v', 'info', '-i', video, '-vf', vf.join(','), '-vsync', 'vfr', '-frames:v', String(opts.max), '-q:v', '3', pattern]

  log(opts, `抽帧中… mode=${opts.mode} ${opts.mode === 'interval' ? `fps=${fps.toFixed(3)}` : ''} max=${opts.max}`)
  const r = await run(FFMPEG, args)
  if (r.code !== 0) {
    fail(`ffmpeg 失败（退出码 ${r.code}）：\n${r.stderr.split('\n').slice(-12).join('\n')}`)
  }

  // 从 showinfo 输出里取每帧的 pts_time，和落盘顺序一一对应
  const times = []
  for (const line of r.stderr.split('\n')) {
    const m = /pts_time:([0-9.]+)/.exec(line)
    // showinfo 的逐帧行一定带 " n:" 字段，避免误抓汇总行
    if (m && /\sn:\s*\d+/.test(line)) times.push(Number(m[1]))
  }

  const files = (await readdir(outDir))
    .filter((f) => /^f\d{3}\.jpg$/i.test(f))
    .sort()

  const frames = files.map((f, i) => ({
    index: i + 1,
    file: path.join(outDir, f),
    // 同样不写 null：拿不到时间码就省略该键（调用方按估算值处理）
    ...(times[i] !== undefined ? { time_s: Number(times[i].toFixed(3)) } : {}),
  }))

  // 可选：联络表（一张图看全局，省 token）
  let gridFile = null
  if (opts.grid && files.length > 0) {
    const cols = Math.min(4, files.length)
    const rows = Math.ceil(files.length / cols)
    const tile = [`scale=320:-1`, `tile=${cols}x${rows}`]
    gridFile = path.join(outDir, 'grid.jpg')
    const gr = await run(FFMPEG, ['-y', '-v', 'error', '-i', path.join(outDir, 'f%03d.jpg'), '-vf', tile.join(','), '-frames:v', '1', '-q:v', '3', gridFile])
    if (gr.code !== 0) { log(opts, `联络表生成失败：${gr.stderr.trim()}`); gridFile = null }
    else log(opts, `联络表：${gridFile}`)
  }

  // 刻意不写 `key: null`：调用方（DSH 工具）的 output.schema 是**单类型** JSON Schema，
  // 不支持 ["number","null"] 这种联合类型，留下 null 会被宿主校验直接拒绝
  // （实测报错：`"value.fpsUsed" must be a number`）。不适用就让该键根本不出现。
  const manifest = {
    video,
    ...(duration ? { duration_s: Number(duration.toFixed(3)) } : {}),
    source: { width: srcW, height: srcH, videoCodec: vstream.codec_name },
    hasAudio: Boolean(astream),
    mode: opts.mode,
    ...(opts.mode === 'interval' ? { fpsUsed: Number(fps.toFixed(4)) } : {}),
    ...(opts.mode === 'scene' ? { sceneThreshold: opts.scene } : {}),
    frameCount: frames.length,
    outDir,
    ...(gridFile ? { gridFile } : {}),
    frames,
    caveats: [
      astream ? '本脚本只抽帧、不处理音轨；涉及"说了什么"的问题需另配 ASR。' : '该视频无音轨。',
      '帧是离散快照，帧间运动与短暂事件可能遗漏。',
    ],
  }
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n')
}

main().catch((e) => {
  process.stderr.write(`未捕获错误：${e?.stack || e}\n`)
  process.exit(1)
})
