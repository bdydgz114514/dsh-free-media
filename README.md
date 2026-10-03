# dsh-free-media

**给 DeepSeek Harness 装上免费的图片生成、视频生成和视频理解。** MIT。

一个插件，三个工具，一份 skill。其中**两个工具完全不需要任何 API Key**。

| 工具 | 能力 | 要不要 Key | 实测状态 |
|---|---|---|---|
| `free_image_generate` | 文生图 | **不要** | ✅ 已实机出图 |
| `video_extract_frames` | 视频抽帧（视频理解） | **不要** | ✅ 已实机跑通 |
| `free_video_generate` | 文生视频 / 图生视频 | 要（免费注册） | ✅ 已端到端出片 |

另外附带一份 `free-media` skill：当工具不够灵活（需要组合、自定义参数、跑管道）时，agent 可以直接调用包内脚本。

---

## 为什么是这三个

市面上的免费方案要么需要 Key，要么已经失效，要么对 A 卡不可用。这个插件只保留**实测还在工作**的那些：

- **出图走 Pollinations 免费端点**，零 Key。注意：免费模型现在**只剩 `sana`**，老教程里的 `turbo` / `flux` 已失效（实测返回 HTTP 500）；而且**必须带 `width`/`height`**，否则会收到 HTTP 200 加一个 0 字节的空响应。这两点都已经在脚本里处理。
- **视频理解用 ffmpeg 抽帧 + 读图**：零外部依赖、零 Key、数据不出本机。能白嫖的云端 VLM 免费层要么大陆连不上（Gemini），要么默认会在额度用尽后转按量扣费（百炼）。
- **视频生成走智谱 `cogvideox-flash`**：官方文档把它归在 `models/free/` 下，大陆直连、无需信用卡。这是目前能确认真正免费的云端文生视频之一（Veo / 百炼 / 硅基流动 / 模搭 / Pollinations 的视频模型都没有免费层）。

中文提示词会**自动免费翻译成英文**（走 `text.pollinations.ai`，同样零 Key）——因为免费出图端点看到中文会整体滑向写实风。

---

## 安装

```bash
dsh plugin --profile <你的profile> add dsh-free-media
```

装完**重启 DSH**，并**新开一个会话**（DSH 的工具集在会话创建时快照，旧会话不会带上新工具）。

> **Desktop 应用用户注意**：`desktop` profile 由应用独占管理，命令行会报
> `profile "desktop" is managed exclusively by the Electron application`。
> 请改用图形界面：**设置 → 内置插件 → 添加插件**，或让 agent 用插件管理工具安装。

从本地源码装（开发用）：

```bash
dsh plugin --profile <profile> add -w /path/to/dsh-free-media
```

## 环境要求

- Node ≥ 18（脚本用到全局 `fetch`；DSH 本身要求更高）
- `ffmpeg` / `ffprobe` 在 PATH（只影响 `video_extract_frames`）。可用 `FFMPEG_PATH` / `FFPROBE_PATH` 覆盖
- 视频生成需要免费注册的 Key

---

## 视频生成的 Key

两个免费供应商二选一：

| 供应商 | 模型 | Key 申请 |
|---|---|---|
| 智谱（默认） | `cogvideox-flash` | https://bigmodel.cn/usercenter/proj-mgmt/apikeys |
| Agnes AI | `agnes-video-v2.0` | https://agnes-ai.com/ |

Key 三选一（优先级从高到低）：

1. 工具参数 `key` / 脚本 `--key`
2. 环境变量 `ZHIPU_API_KEY` / `AGNES_API_KEY`
3. 文件 `~/.dsh/free-media-keys.json`：`{"zhipu":"xxx","agnes":"yyy"}`

建议先 `dryRun: true`（或 `--dry-run`）看请求体，确认无误再实跑。

---

## 实测数据（2026-10-03）

出图：640×640 **3.2 秒**，中文提示词自动译成 `a red fox sitting in the snow`。

视频生成，两次完整成功：

| | 文生视频 | 图生视频 |
|---|---|---|
| 全流程耗时 | **41 秒** | **53 秒** |
| 产物 | 1280×960 h264，5.108s，约 1.05 MB | 同规格，约 1.65 MB |
| 附产物 | 封面 jpg（来自响应的 `cover_image_url`） | 同 |
| 水印 | 右下角烧入「AI生成」（免费档默认） | 同 |

抽帧：6 秒视频 → 6 帧，时间码精确 0/1/2/3/4/5 秒；`scene` 模式在硬切处精确命中 3s 与 6s。

**两个容易误判的点（已写进 skill）：**

- **`fps=30` 是请求值，不是产物值**——实际容器 `r_frame_rate` 是 `37/1`。断言产物规格一律以 `ffprobe` 为准。
- **免费档时长不可调**——`cogvideox-flash` 契约里没有 `duration` 字段（只有付费的 Vidu 系列有），产物固定约 5.1 秒。

---

## 局限（请如实告知用户）

- **免费出图档会静默降采样**。实测：请求 512×512 得到 512×512，但请求 1024×1024 得到 **768×768**，
  请求 1280×720 和 1920×1080 都得到 **1024×576**——后三者恰好都是 589,824 像素，
  即免费档上限约 **0.59 MP**。所以返回值里 `size` 是**请求值**、`actualSize` 才是**真实值**，
  两者不一致时另有 `sizeNote` 说明。**断言产物规格请用 `actualSize`。**
- **免费出图档对精确计数不可靠**。同一个「三个男生和一个女生举起酒杯」的提示词，实测三次得到
  3 人 / 5～6 人 / 2 男 1 女，酒杯时有时无。需要精确人数或画面文字时不要用它。
- **抽帧不含音轨**。问「视频里说了什么」需要另配 ASR；**不要根据画面猜台词**。
- **抽帧丢时序**。帧是离散快照，帧间运动与短暂事件会漏。
- **免费档限流**。出图的 402/429 是常态而非封禁，脚本会自动退避（15s→30s→45s→60s）；连发多张会自己把自己限流住。
- **免费不等于有 SLA**。Agnes 官方明写免费计划不保证可用性；这类「免费 API」随时可能调整。视频生成失败时脚本会打印**上游原始响应**，不要只报「失败了」。
- **视频生成超时会给出任务 id**。拿 id 稍后再查，**不要盲目重提任务**。

---

## 开发

```bash
npm run check              # 四个文件的语法检查
npm test                   # 离线自测：用 mock ctx 验证插件注册了什么
node test/verify-package.mjs  # 用市场自己的模块校验包合规性
```

`npm test` 不启动 DSH，用 mock `ctx` 断言：skill 被注册、frontmatter 被正确剥离、
三个工具的 JSON Schema 形状正确、`render()` 面对空值不抛异常、以及
**`lib/index.js` 不含任何 `@deepseek-ai/*` import**。

最后一条是硬约束，原因见下。

### 实现约束（改代码前必读）

1. **绝不 import 任何 `@deepseek-ai/*` 包。**
   第三方插件的模块位置在 `<profile>/node_modules/<pkg>/lib/`，而 profile 的 pnpm 配置是
   `autoInstallPeers: false` + `nodeLinker: hoisted`，宿主包并不在那里。实测
   `import.meta.resolve('@deepseek-ai/dsh-tools')` 从该位置直接 `ERR_MODULE_NOT_FOUND`。
   顶层 import 失败就等于插件加载失败，而 **DSH 的启动是全有或全无**——一个坏插件会让整个
   profile 起不来。所以宿主代码只用 node 内置模块，服务一律经 `ctx` 取。

2. **工具定义必须用「标准 JSON Schema」。**
   官方 `defineTool()` 会先做 `parameterSchemaSpecToJsonSchema()` 再把结果交给注册表，
   也就是注册表收到的是标准形式。绕过 `defineTool` 就得自己给标准形式：
   `required` 是**字符串数组**，不是每个属性上的 `required: true`。
   `npm test` 里有断言专门守住这一点。

3. **出网交给子进程里的 node 脚本。**
   宿主求值环境没有 `fetch`；包内 `scripts/*.mjs` 只用 node 内置能力，
   出网、重试、落盘都在里面。参数以 argv 数组直传、不开 shell。

4. **脚本里的「是否被直接执行」判定必须用 `realpathSync` 比较。**
   以 `link:` 方式安装时，宿主拿到的是**符号链接路径**
   （`…\profiles\desktop\node_modules\dsh-free-media\scripts\img.mjs`），
   而 Node 默认把 `import.meta.url` 解析成 **realpath**（`D:\…\projects\dsh-free-media\…`）。
   早先写成 `import.meta.url === pathToFileURL(process.argv[1]).href`，两者不等
   → `main()` 从不运行 → **进程退出 0 但 stdout 为空**，调用方只看到一句
   「stdout 不是合法 JSON」。`test/plugin.test.mjs` 里有一条用目录 junction 复现该场景的回归测试。

5. **改了 `lib/` 必须重启 DSH 才生效**；改了 `scripts/` 立即可用。
   宿主半边是**进程启动时**加载进内存的，之后磁盘上的 `lib/` 变了也不会重载
   （插件的 disable/enable 也不够）。而脚本是每次调用新 spawn 的子进程，从磁盘现读。
   这个差异很容易让人误判「改了没生效 / 生效了」，排查时先分清改的是哪一半。

### 目录

```
dsh-free-media/
├── package.json          # dsh.bundle.patch + engines.dsh
├── cordis.patch.yml      # 挂载层（inject: tools, skills）
├── lib/index.js          # 宿主半边：注册 skill + 三个工具
├── scripts/              # 可独立运行的脚本（出网/重试/落盘都在这）
│   ├── img.mjs
│   ├── vframes.mjs
│   └── vgen.mjs
├── skills/free-media/SKILL.md
└── test/
    ├── plugin.test.mjs        # 离线自测（mock ctx）
    └── verify-package.mjs     # 用市场模块校验合规性
```

---

## License

MIT。本插件通过 HTTP 调用第三方免费服务（Pollinations / 智谱 / Agnes）；
提示词会发送给相应服务商，请自行评估数据敏感性。
