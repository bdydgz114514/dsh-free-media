/**
 * dsh-free-media 的离线自测：不启动 DSH，用 mock ctx 验证插件到底注册了什么。
 *
 * 为什么需要它：宿主注册是「运行时才报错」的，schema 形式写错、SKILL.md frontmatter
 * 解析失败这类问题在安装后才暴露，代价很高。这里把它们提前到 `npm test`。
 *
 * 运行：node test/plugin.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, name, inject } from '../lib/index.js'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 收集注册结果的假 ctx。 */
function mockCtx() {
  const skills = []
  const tools = []
  const warnings = []
  return {
    skills: { register: (s) => { skills.push(s); return () => {} } },
    tools: { register: (d) => { tools.push(d); return () => {} } },
    logger: { warn: (m) => warnings.push(String(m)) },
    _skills: skills,
    _tools: tools,
    _warnings: warnings,
  }
}

test('插件元数据完整', () => {
  assert.equal(name, 'free-media')
  assert.ok(Array.isArray(inject), 'inject 必须是数组')
  assert.ok(inject.includes('tools'), 'inject 必须含 tools')
  assert.ok(inject.includes('skills'), 'inject 必须含 skills')
})

test('注册了 free-media skill，且 frontmatter 被正确剥离', () => {
  const ctx = mockCtx()
  apply(ctx)

  assert.equal(ctx._warnings.length, 0, `不该有警告：${ctx._warnings.join(' / ')}`)
  assert.equal(ctx._skills.length, 1, '应恰好注册 1 个 skill')

  const skill = ctx._skills[0]
  assert.equal(skill.name, 'free-media')
  assert.ok(skill.description && skill.description.length > 10, 'description 不能为空')
  assert.ok(skill.whenToUse, 'whenToUse 应被解析出来')
  assert.ok(skill.content.length > 500, 'skill 正文不应为空')
  assert.ok(!skill.content.startsWith('---'), 'frontmatter 必须已从正文剥离')
  assert.ok(!/^name:\s/m.test(skill.content.split('\n')[0] ?? ''), '正文首行不应还是 frontmatter')

  assert.equal(skill.source, 'bundled')
  assert.equal(skill.provider, 'free-media')
  assert.equal(skill.resourceBase?.kind, 'directory')
  assert.equal(skill.resourceBase?.path, PACKAGE_ROOT, 'resourceBase 必须指向包根目录')
})

test('注册了三个工具，名字与契约符合预期', () => {
  const ctx = mockCtx()
  apply(ctx)

  const names = ctx._tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['free_image_generate', 'free_video_generate', 'video_extract_frames'])
})

test('工具定义形状正确（这是最容易写错的地方）', () => {
  const ctx = mockCtx()
  apply(ctx)

  for (const tool of ctx._tools) {
    const at = `工具 ${tool.name}`

    assert.equal(typeof tool.description, 'string', `${at}: description 缺失`)
    assert.ok(tool.description.length > 20, `${at}: description 过短`)

    // parameters 必须是**标准 JSON Schema**：required 是字符串数组。
    // 官方 defineTool 会做 spec→JSON Schema 转换，我们绕过了它，所以必须自己给标准形式。
    const p = tool.parameters
    assert.equal(p.type, 'object', `${at}: parameters.type 必须是 object`)
    assert.ok(Array.isArray(p.required), `${at}: parameters.required 必须是数组（不是属性上的 required:true）`)
    assert.ok(p.properties && typeof p.properties === 'object', `${at}: parameters.properties 缺失`)
    for (const [key, prop] of Object.entries(p.properties)) {
      assert.notEqual(prop.required, true, `${at}: 属性 ${key} 用了 spec 形式的 required:true，应为标准 JSON Schema`)
      assert.ok(prop.type, `${at}: 属性 ${key} 缺少 type`)
    }
    // required 里点到的每个名字都得真有定义
    for (const req of p.required) {
      assert.ok(p.properties[req], `${at}: required 里的 ${req} 在 properties 中不存在`)
    }

    // output：schema + render 都是必需的
    assert.ok(tool.output, `${at}: output 缺失`)
    assert.equal(tool.output.schema.type, 'object', `${at}: output.schema.type 必须是 object`)
    assert.equal(typeof tool.output.render, 'function', `${at}: output.render 必须是函数`)

    // execute 必须是 async 函数
    assert.equal(typeof tool.execute, 'function', `${at}: execute 缺失`)
    assert.ok(tool.timeoutMs > 0, `${at}: timeoutMs 应为正数`)

    // render 不能抛，且必须返回内容块数组
    const rendered = tool.output.render({}, {
      ok: true, paths: [], frames: [], promptUsed: 'x', model: 'sana', size: '1x1',
      providerLabel: 'p', taskId: 't', elapsedMs: 1, videoBytes: 1, video: 'v',
      frameCount: 0, duration_s: 0, mode: 'interval', hasAudio: false, dryRun: false, body: {},
      provider: 'zhipu', createUrl: 'u', urls: [],
    })
    assert.ok(Array.isArray(rendered), `${at}: render 必须返回数组`)
    assert.ok(rendered.length > 0, `${at}: render 返回了空数组`)
    for (const block of rendered) {
      assert.equal(block.type, 'text', `${at}: 内容块类型应为 text`)
      assert.equal(typeof block.text, 'string', `${at}: 内容块 text 必须是字符串`)
    }

    // render 必须能扛住空值（回放旧会话时 value 可能不完整）
    assert.doesNotThrow(() => tool.output.render({}, undefined), `${at}: render(undefined) 抛异常了`)
  }
})

test('打包内脚本齐全且语法可解析', () => {
  for (const f of ['img.mjs', 'vframes.mjs', 'vgen.mjs']) {
    const p = path.join(PACKAGE_ROOT, 'scripts', f)
    assert.ok(existsSync(p), `缺少 scripts/${f}`)
    const src = readFileSync(p, 'utf8')
    assert.ok(src.length > 1000, `scripts/${f} 内容异常短`)
    // 不能用 import() 检查：这三个脚本顶层就会执行 main()，import 等于真的去跑它。
    // 所以用 node --check 只做语法解析。
    const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' })
    assert.equal(r.status, 0, `scripts/${f} 语法错误：${r.stderr || r.stdout}`)
  }
})

test('抽帧输出里没有 null 值（宿主单类型 schema 不接受 null）', () => {
  // 这条测试是有来历的：插件第一次真跑时，scene 模式下的 fpsUsed 是 null，
  // 而 output.schema 声明它是 number，宿主直接拒绝：
  //   tool "video_extract_frames" returned invalid output: "value.fpsUsed" must be a number
  // mock ctx 的自测发现不了这个——只有真跑脚本 + 真校验输出才能。
  const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0
  if (!hasFfmpeg) {
    console.log('      SKIP：本机没有 ffmpeg，跳过抽帧集成测试')
    return
  }

  const tmp = mkdtempSync(path.join(tmpdir(), 'free-media-test-'))
  const vid = path.join(tmp, 'src.mp4')
  const gen = spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=3',
    '-pix_fmt', 'yuv420p', vid,
  ], { encoding: 'utf8' })
  assert.equal(gen.status, 0, `生成测试视频失败：${gen.stderr}`)

  for (const mode of ['interval', 'scene', 'key']) {
    const r = spawnSync(process.execPath, [
      path.join(PACKAGE_ROOT, 'scripts', 'vframes.mjs'), vid,
      '--mode', mode, '--scale', '160', '--max', '5',
      '--out', path.join(tmp, `frames-${mode}`),
    ], { encoding: 'utf8' })
    assert.equal(r.status, 0, `vframes ${mode} 退出码非 0：${r.stderr}`)

    const out = JSON.parse(r.stdout)
    const nullKeys = Object.entries(out).filter(([, v]) => v === null).map(([k]) => k)
    assert.deepEqual(nullKeys, [], `mode=${mode} 的顶层输出仍有 null 键：${nullKeys.join(', ')}`)

    for (const f of out.frames ?? []) {
      const fn = Object.entries(f).filter(([, v]) => v === null).map(([k]) => k)
      assert.deepEqual(fn, [], `mode=${mode} 的帧对象里有 null 键：${fn.join(', ')}`)
    }
    // 模式相关的键只在该模式出现
    if (mode === 'interval') assert.equal(typeof out.fpsUsed, 'number', 'interval 模式应给出 fpsUsed')
    else assert.ok(!('fpsUsed' in out), `${mode} 模式不该出现 fpsUsed`)
    if (mode === 'scene') assert.equal(typeof out.sceneThreshold, 'number', 'scene 模式应给出 sceneThreshold')
    else assert.ok(!('sceneThreshold' in out), `${mode} 模式不该出现 sceneThreshold`)
  }
})

test('SKILL.md 存在且 frontmatter 含必需字段', () => {
  const p = path.join(PACKAGE_ROOT, 'skills', 'free-media', 'SKILL.md')
  assert.ok(existsSync(p), '缺少 skills/free-media/SKILL.md')
  const raw = readFileSync(p, 'utf8')
  assert.match(raw, /^---\r?\n/, 'SKILL.md 必须以 frontmatter 开头')
  assert.match(raw, /\nname:\s*free-media/, 'frontmatter 缺少 name: free-media')
  assert.match(raw, /\ndescription:\s*\S/, 'frontmatter 缺少 description')
  assert.match(raw, /\nwhenToUse:\s*\S/, 'frontmatter 缺少 whenToUse')
})

test('契约里没有 import 任何 @deepseek-ai/* 包（这是硬约束）', () => {
  // 第三方插件的模块位置在 <profile>/node_modules/<pkg>/lib/，而 profile 的 pnpm 配置是
  // autoInstallPeers:false，宿主包不在那里。一旦顶层 import 失败，插件加载失败会连累整个启动。
  const src = readFileSync(path.join(PACKAGE_ROOT, 'lib', 'index.js'), 'utf8')
  const bad = [...src.matchAll(/from\s+['"](@deepseek-ai\/[^'"]+)['"]/g)].map((m) => m[1])
  assert.deepEqual(bad, [], `lib/index.js 不得 import 宿主包：${bad.join(', ')}`)
  const badDyn = [...src.matchAll(/import\(\s*['"](@deepseek-ai\/[^'"]+)['"]/g)].map((m) => m[1])
  assert.deepEqual(badDyn, [], `lib/index.js 不得动态 import 宿主包：${badDyn.join(', ')}`)
})
