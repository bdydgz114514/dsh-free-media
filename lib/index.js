/**
 * dsh-free-media — 宿主半边（host half）
 *
 * 设计约束（都是实测踩出来的，改动前请先读）：
 *
 * 1. **不 import 任何 `@deepseek-ai/*` 包。**
 *    第三方插件的模块位置在 `<profile>/node_modules/<pkg>/lib/`，而 profile 的
 *    pnpm 配置是 `autoInstallPeers: false` + `nodeLinker: hoisted`，宿主包并不在那里。
 *    实测 `import.meta.resolve('@deepseek-ai/dsh-tools')` 从该位置直接
 *    ERR_MODULE_NOT_FOUND。一旦顶层 import 失败，插件加载失败会连累整个启动
 *    （DSH 的启动是全有或全无）。所以这里只用 node 内置模块，服务一律通过 ctx 拿。
 *
 * 2. **工具定义必须用「标准 JSON Schema」，不是 schemastery 的 spec 形式。**
 *    官方 `defineTool()` 会先做 `parameterSchemaSpecToJsonSchema()` 再把结果交给注册表，
 *    也就是说注册表收到的是标准 JSON Schema。我们绕过 defineTool，就得自己给出
 *    标准形式（`required` 是**字符串数组**，不是每个属性上的 `required: true`）。
 *
 * 3. **出网交给子进程里的 node 脚本。** 宿主求值环境没有 fetch；
 *    打包内的 scripts/*.mjs 只用 node 内置能力，出网、重试、落盘都在里面。
 */

import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/** Stable Loader identity. */
export const name = 'free-media'

/** Services this plugin consumes. 两个都要：一个注册 skill，一个注册工具。 */
export const inject = ['tools', 'skills']

/** 插件包根目录（lib/ 的上一级）。scripts/ 与 skills/ 都在这里。 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS_DIR = path.join(PACKAGE_ROOT, 'scripts')

const SKILL_NAME = 'free-media'

// ---------------------------------------------------------------------------
// 子进程执行
// ---------------------------------------------------------------------------

/**
 * 跑一个打包内的 node 脚本，解析它 stdout 上的 JSON。
 *
 * 不开 shell（argv 数组直传），因此参数里带引号/空格/特殊字符都不会被二次解释。
 */
function runScript(scriptFile, argv, { cwd, signal, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(SCRIPTS_DIR, scriptFile)
    if (!existsSync(scriptPath)) {
      reject(new Error(`打包内缺少脚本：${scriptPath}（插件安装不完整？）`))
      return
    }

    const child = spawn(process.execPath, [scriptPath, ...argv], {
      cwd: cwd && existsSync(cwd) ? cwd : undefined,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      fn(arg)
    }

    const onAbort = () => {
      try { child.kill() } catch { /* 已经退出了 */ }
      finish(reject, new Error('调用被取消'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })

    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已经退出了 */ }
      finish(reject, new Error(
        `脚本超时（${Math.round(timeoutMs / 1000)}s）：${scriptFile}\n` +
        `若是视频生成排队，请稍后用同一任务 id 再查，不要盲目重提。\n` +
        `最近的进度输出：\n${tail(stderr, 800)}`
      ))
    }, timeoutMs)

    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', (e) => finish(reject, new Error(`无法启动 node：${e.message}`)))
    child.on('close', (code) => {
      if (code === 0) {
        try {
          finish(resolve, JSON.parse(stdout))
        } catch (e) {
          finish(reject, new Error(
            `脚本退出码 0，但 stdout 不是合法 JSON：${e.message}\n` +
            `stdout 前 500 字：\n${tail(stdout, 500)}`
          ))
        }
        return
      }
      finish(reject, new Error(
        `脚本退出码 ${code}：${scriptFile}\n` +
        `${tail(stderr, 1200) || tail(stdout, 600) || '(无输出)'}`
      ))
    })
  })
}

function tail(s, n) {
  if (!s) return ''
  const t = s.trim()
  return t.length <= n ? t : '…' + t.slice(-n)
}

/** 会话工作目录；拿不到时退回宿主进程 cwd。 */
function workspaceCwd(exec) {
  return exec?.agent?.session?.header?.cwd ?? process.cwd()
}

/** 文本内容块。 */
const text = (s) => [{ type: 'text', text: String(s) }]

/**
 * 递归去掉值为 null 的键。
 *
 * 为什么必须做：工具的 `output.schema` 用的是 **单类型** JSON Schema——
 * `JsonSchemaNode.type` 只能是一个字符串，不支持 `["number","null"]` 这种联合类型。
 * 于是脚本里那些「本模式不适用所以是 null」的字段（例如 scene 模式下的 `fpsUsed`、
 * 没生成联络表时的 `gridFile`）会直接撞上宿主校验：
 *   `tool "video_extract_frames" returned invalid output: "value.fpsUsed" must be a number`
 * 这在 mock 自测里发现不了，只有真跑一次工具才会暴露。
 *
 * 去掉 null 与「键不存在」对模型是等价的，声明里这些字段本来也都是可选的。
 */
function stripNulls(v) {
  if (Array.isArray(v)) return v.map(stripNulls)
  if (v !== null && typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) {
      if (val === null) continue
      out[k] = stripNulls(val)
    }
    return out
  }
  return v
}

/** 把 k=v 里 undefined/false 的参数略掉，保持 argv 干净。 */
function argvOf(pairs) {
  const out = []
  for (const [flag, value] of pairs) {
    if (value === undefined || value === null || value === false) continue
    if (value === true) { out.push(flag); continue }
    out.push(flag, String(value))
  }
  return out
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

export function apply(ctx) {
  // ---- 1) 注册 skill（这是「下载即用」的主体）----
  try {
    const skillFile = path.join(PACKAGE_ROOT, 'skills', SKILL_NAME, 'SKILL.md')
    const raw = readFileSync(skillFile, 'utf8')
    const { frontmatter, body } = splitFrontmatter(raw)
    ctx.skills.register({
      name: frontmatter.name || SKILL_NAME,
      description: frontmatter.description || '免费出图 / 视频理解 / 视频生成',
      ...(frontmatter.whenToUse ? { whenToUse: frontmatter.whenToUse } : {}),
      content: body,
      source: 'bundled',
      provider: 'free-media',
      // 让 skill 正文里的相对路径（scripts/img.mjs 等）能落到本包目录
      resourceBase: { kind: 'directory', path: PACKAGE_ROOT },
    })
  } catch (e) {
    ctx.logger?.warn?.(`[free-media] 注册 skill 失败：${e.message}`)
  }

  // ---- 2) 注册工具 ----
  // 每个工具独立 try/catch：任何一个注册失败都不该连累插件加载。
  const registerTool = (definition) => {
    try {
      ctx.tools.register(definition)
    } catch (e) {
      ctx.logger?.warn?.(`[free-media] 注册工具 ${definition.name} 失败：${e.message}`)
    }
  }

  // --- free_image_generate ---
  registerTool({
    name: 'free_image_generate',
    description:
      '免费文生图（不需要任何 API Key）。走 Pollinations 免费端点，' +
      '中文提示词会自动免费翻译成英文。产物落盘后返回绝对路径，可用 read_image 查看。' +
      '注意免费档限流较紧（HTTP 402/429 常见），脚本会自动退避重试；一次不要连发多张。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: '画面描述，中文或英文均可。' },
        size: { type: 'string', description: '尺寸 WxH，默认 1024x1024。' },
        out: { type: 'string', description: '输出目录；默认相对会话工作目录的 generate/image。' },
        n: { type: 'integer', description: '生成张数，默认 1。张数越多越容易触发限流。' },
        seed: { type: 'integer', description: '随机种子，用于复现同一张图。' },
        translate: { type: 'boolean', description: '强制把提示词译成英文；默认仅在含中日韩文字时翻译。' },
        dryRun: { type: 'boolean', description: '只打印将要发出的请求，不出图、不消耗额度。' },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          paths: { type: 'array', items: { type: 'string' } },
          promptUsed: { type: 'string' },
          model: { type: 'string' },
          size: { type: 'string' },
          outDir: { type: 'string' },
          dryRun: { type: 'boolean' },
          results: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
        required: ['ok'],
      },
      render: (_args, value) => {
        // 回放旧会话时 value 可能不完整，render 绝不能抛
        if (!value || typeof value !== 'object') return text('出图结果不可用（缺少记录内容）')
        if (value.dryRun) return text(`dry-run：将请求 ${value.urls?.join('\n') ?? value.promptUsed}`)
        const paths = value.paths ?? []
        if (!paths.length) {
          const err = value.results?.find?.((r) => !r.ok)?.error
          return text(`出图失败${err ? `：${err}` : ''}`)
        }
        return text(
          `出图成功（模型 ${value.model}，尺寸 ${value.size}）\n` +
          `实际提示词：${value.promptUsed}\n` +
          paths.map((p) => `- ${p}`).join('\n')
        )
      },
    },
    timeoutMs: 300_000,
    async execute(args, exec) {
      const argv = argvOf([
        ['--size', args.size],
        ['--out', args.out],
        ['--n', args.n],
        ['--seed', args.seed],
        ['--translate', args.translate],
        ['--dry-run', args.dryRun],
      ])
      return stripNulls(await runScript('img.mjs', [String(args.prompt), ...argv], {
        cwd: workspaceCwd(exec),
        signal: exec?.signal,
        timeoutMs: 300_000,
      }))
    },
  })

  // --- video_extract_frames ---
  registerTool({
    name: 'video_extract_frames',
    description:
      '把视频拆成带时间码的帧，用于视频理解（免费、零 API Key、只用本机 ffmpeg）。' +
      '返回每帧的绝对路径与 time_s；随后用 read_image 逐帧查看即可回答内容类问题。' +
      '局限：不含音轨（问“说了什么”需另配 ASR），且帧是离散快照、会漏帧间运动。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        video: { type: 'string', description: '本地视频文件路径。' },
        mode: {
          type: 'string',
          enum: ['interval', 'scene', 'key'],
          description:
            'interval=固定间隔（时间码最准，默认）；scene=按镜头切换（注意不产出 t=0 首帧）；key=仅关键帧（最省）。',
        },
        fps: { type: 'number', description: 'interval 模式的采样帧率，默认 1。' },
        scene: { type: 'number', description: 'scene 模式的切换阈值 0–1，默认 0.3，越小抽得越多。' },
        scale: { type: 'integer', description: '帧的短边像素，默认 512。' },
        max: { type: 'integer', description: '最大帧数上限，默认 24（防止 token 爆炸）。' },
        grid: { type: 'boolean', description: '额外拼一张联络表，先看整体印象最省 token。' },
        out: { type: 'string', description: '帧输出目录，默认 generate/video-frames。' },
      },
      required: ['video'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          video: { type: 'string' },
          duration_s: { type: 'number' },
          mode: { type: 'string' },
          fpsUsed: { type: 'number' },
          frameCount: { type: 'integer' },
          outDir: { type: 'string' },
          gridFile: { type: 'string' },
          hasAudio: { type: 'boolean' },
          frames: { type: 'array', items: { type: 'object', additionalProperties: true } },
          caveats: { type: 'array', items: { type: 'string' } },
        },
        required: ['frames'],
      },
      render: (_args, value) => {
        if (!value || typeof value !== 'object') return text('抽帧结果不可用（缺少记录内容）')
        const lines = [
          `抽出 ${value.frameCount ?? 0} 帧（${value.mode ?? '?'}，时长 ${value.duration_s ?? '?'}s${value.hasAudio ? '，含音轨但本工具不处理音频' : '，无音轨'}）`,
        ]
        if (value.gridFile) lines.push(`联络表：${value.gridFile}`)
        for (const f of value.frames ?? []) {
          lines.push(`- t=${f.time_s ?? '?'}s  ${f.file}`)
        }
        if (value.caveats?.length) lines.push(...value.caveats.map((c) => `⚠ ${c}`))
        return text(lines.join('\n'))
      },
    },
    timeoutMs: 600_000,
    async execute(args, exec) {
      const argv = argvOf([
        ['--mode', args.mode],
        ['--fps', args.fps],
        ['--scene', args.scene],
        ['--scale', args.scale],
        ['--max', args.max],
        ['--grid', args.grid],
        ['--out', args.out],
      ])
      return stripNulls(await runScript('vframes.mjs', [String(args.video), ...argv], {
        cwd: workspaceCwd(exec),
        signal: exec?.signal,
        timeoutMs: 600_000,
      }))
    },
  })

  // --- free_video_generate ---
  registerTool({
    name: 'free_video_generate',
    description:
      '免费文生视频 / 图生视频。默认用智谱 CogVideoX-Flash（官方免费模型，需免费注册的 Key）。' +
      '异步任务：先建任务再轮询，通常 40～60 秒出片，产物落盘 mp4 并附带封面。' +
      '免费档产物带「AI生成」水印、时长固定约 5 秒且不可调。' +
      '正式跑之前建议先 dryRun 看请求体。Key 从环境变量 ZHIPU_API_KEY 或 ~/.dsh/free-media-keys.json 读取。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: '视频描述（智谱上限 512 字符）。' },
        provider: { type: 'string', enum: ['zhipu', 'agnes'], description: '供应商，默认 zhipu。' },
        image: { type: 'string', description: '图生视频：本机图片路径，会自动转 base64 上传（≤5MB）。' },
        size: { type: 'string', description: '分辨率，智谱默认 1280x960。' },
        fps: { type: 'integer', description: '智谱可选 30 或 60，默认 30。注意这是请求值，产物实际帧率以 ffprobe 为准。' },
        out: { type: 'string', description: '输出目录，默认 generate/video。' },
        noWatermark: { type: 'boolean', description: '关闭水印（需先在智谱个人中心签署免责声明）。' },
        dryRun: { type: 'boolean', description: '只打印请求体，不创建任务、不排队。' },
        timeoutMs: { type: 'integer', description: '等待上限毫秒数，默认 600000（10 分钟）。' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          provider: { type: 'string' },
          model: { type: 'string' },
          taskId: { type: 'string' },
          video: { type: 'string' },
          videoBytes: { type: 'integer' },
          cover: { type: 'string' },
          elapsedMs: { type: 'integer' },
          dryRun: { type: 'boolean' },
          body: { type: 'object', additionalProperties: true },
        },
        required: ['ok'],
      },
      render: (_args, value) => {
        if (!value || typeof value !== 'object') return text('视频生成结果不可用（缺少记录内容）')
        if (value.dryRun) {
          return text(`dry-run（${value.providerLabel}）\nPOST ${value.createUrl}\n${JSON.stringify(value.body, null, 2)}`)
        }
        return text(
          `视频生成成功（${value.providerLabel}，任务 ${value.taskId}）\n` +
          `耗时 ${Math.round((value.elapsedMs ?? 0) / 1000)}s，${Math.round((value.videoBytes ?? 0) / 1024)} KB\n` +
          `${value.video}` +
          (value.cover ? `\n封面：${value.cover}` : '')
        )
      },
    },
    // 上游排队 + 轮询最长 10 分钟，这里要和脚本的 --timeout 对齐并留出余量
    timeoutMs: 780_000,
    async execute(args, exec) {
      const timeoutMs = args.timeoutMs ?? 600_000
      const argv = argvOf([
        ['--provider', args.provider],
        ['--image', args.image],
        ['--size', args.size],
        ['--fps', args.fps],
        ['--out', args.out],
        ['--no-watermark', args.noWatermark],
        ['--dry-run', args.dryRun],
        ['--timeout', timeoutMs],
      ])
      return stripNulls(await runScript('vgen.mjs', [String(args.prompt ?? ''), ...argv], {
        cwd: workspaceCwd(exec),
        signal: exec?.signal,
        timeoutMs: timeoutMs + 120_000,
      }))
    },
  })
}

/**
 * 拆出 SKILL.md 的 YAML frontmatter。
 * 只认 `key: value` 单行标量与 `>`/`|` 折叠块，够用且不引入 yaml 依赖。
 */
function splitFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!m) return { frontmatter: {}, body: raw.trim() }
  const frontmatter = {}
  const lines = m[1].split(/\r?\n/)
  let key = null
  let buf = []
  let block = false
  const flush = () => {
    if (key) frontmatter[key] = block ? buf.join(' ').trim() : buf.join(' ').trim()
    key = null
    buf = []
    block = false
  }
  for (const line of lines) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (kv && !block) {
      flush()
      key = kv[1]
      const v = kv[2].trim()
      if (v === '>' || v === '|' || v === '>-' || v === '|-') { block = true; buf = [] }
      else buf = [v.replace(/^["']|["']$/g, '')]
      continue
    }
    if (key) buf.push(line.trim())
  }
  flush()
  return { frontmatter, body: m[2].trim() }
}
