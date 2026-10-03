---
name: free-media
description: 免费多模态三件套——文生图（零 Key）、视频理解（抽帧，零 Key）、视频生成（智谱 CogVideoX-Flash / Agnes，免费注册拿 Key）。同时注册 free_image_generate / video_extract_frames / free_video_generate 三个工具。
whenToUse: 用户要求生成图片/画图/配图、生成视频/文生视频/图生视频，或要求理解/总结/问答一个视频时。
---

# free-media：免费的多模态能力

本插件同时提供**三个原生工具**和**三个可直接跑的脚本**。优先用工具；工具不够灵活时（需要组合、自定义参数）直接用脚本。

脚本位于本 skill 的基目录下 `scripts/`（加载时上方会给出基目录，把相对路径解析到那里）。

| 脚本 | 等价工具 | 要不要 Key |
|---|---|---|
| `scripts/img.mjs` | `free_image_generate` | **不要** |
| `scripts/vframes.mjs` | `video_extract_frames` | **不要** |
| `scripts/vgen.mjs` | `free_video_generate` | 要（免费注册） |

依赖：Node ≥ 18（用到全局 `fetch`）、`ffmpeg`/`ffprobe` 在 PATH。可用 `FFMPEG_PATH` / `FFPROBE_PATH` 覆盖。

---

## 一、文生图（免费、无需 Key）

```powershell
node scripts/img.mjs "一只坐在雪地里的红狐狸" --size 1024x1024
node scripts/img.mjs "cyberpunk city" --n 2 --out D:\pics
node scripts/img.mjs "测试" --dry-run
```

stdout 是 JSON，`paths` 给出落盘绝对路径；用 `read_image` 看结果。

### 三个已实测的坑

1. **免费模型只剩 `sana`**。老教程里的 `turbo` / `flux` 已失效——`model=turbo` 返回 HTTP 500，`/models` 现在只返回 `["sana"]`。
2. **必须带 `width`/`height`**。缺了会返回 **HTTP 200 + Content-Length: 0** 的空响应（脚本已固定带上，并把「响应过小」当失败重试）。
3. **中文提示词会被拉向写实风**。脚本检测到中日韩字符时**默认自动译成英文**，翻译走 `text.pollinations.ai`（同样免费、无需 Key）。用 `--no-translate` 关掉。

### 限流是常态

HTTP **402 / 429 很常见**，不是被封。脚本按 15s→30s→45s→60s 退避（默认 4 次），多张之间默认间隔 8s。**并发连发会自己把自己限流住。**

### 要「不限量」就上本地

`stable-diffusion.cpp` 走 Vulkan 后端，N 卡 / A 卡 / 核显都能用（29MB 引擎 + 2GB 模型）；而 ComfyUI 的一键安装包只支持 N 卡。若本机没有 ROCm（Windows 上消费级 A 卡基本如此），不要走 PyTorch ROCm 路线。

---

## 二、视频理解（免费、无需 Key）

把视频拆成**带时间码的帧**，再由支持读图的模型逐帧看。零成本、零外部依赖。

```powershell
node scripts/vframes.mjs video.mp4                            # 每秒 1 帧
node scripts/vframes.mjs video.mp4 --mode scene --scene 0.3   # 按镜头切换
node scripts/vframes.mjs video.mp4 --mode key                 # 仅关键帧
node scripts/vframes.mjs video.mp4 --grid                     # 额外拼联络表
```

### 推荐工作流

1. 先 `--grid` 或小 `--max` 跑一次，**只看联络表**建立整体印象（最省 token）。
2. 再针对用户真正关心的时间段抽细，用 `read_image` 逐帧看。
3. 回答时**带上时间码**——时间码来自 `manifest.json`，不要编。

### 模式选择（已实测）

- `interval`：时间码精确到秒（6s 视频 → 6 帧，0/1/2/3/4/5s）。问「第几秒发生了什么」用这个。
- `scene`：在硬切处精确命中（阈值 0.3 → 命中 3s、6s）。**不产出 t=0 首帧**（首帧没有「变化」可检测），需要首帧就补 `interval`。
- `key`：只取 I 帧，最省，但位置由编码器决定，可能漏内容。

### 局限（回答时必须说明）

- **丢音轨**：抽帧不含声音。用户问「说了什么」时明确告知需另配 ASR，**不要根据画面猜台词**。
- **丢时序**：帧是离散快照，帧间运动与短暂事件会漏。
- **上下文成本**：每帧都占 token，默认 `--max 24` 就是防这个。

---

## 三、视频生成（需要免费注册的 Key）

**能白嫖的云端文生视频只有两个**（Veo、百炼、硅基流动、模搭、Pollinations 的视频模型要么无免费层、要么明确 `paid_only`）：

| 供应商 | 模型 | Key 申请 |
|---|---|---|
| 智谱（默认） | `cogvideox-flash` | https://bigmodel.cn/usercenter/proj-mgmt/apikeys |
| Agnes AI | `agnes-video-v2.0` | https://agnes-ai.com/ |

```powershell
node scripts/vgen.mjs "一只猫在玩球" --dry-run          # 先看请求体
node scripts/vgen.mjs "一只猫在玩球" --provider zhipu    # 需要 Key
node scripts/vgen.mjs "镜头缓慢推进" --image a.jpg       # 图生视频
```

Key 三选一（优先级从高到低）：`--key <值>` → 环境变量 `ZHIPU_API_KEY` / `AGNES_API_KEY` → 文件 `~/.dsh/free-media-keys.json`，形如 `{"zhipu":"xxx","agnes":"yyy"}`。

### 已实测（2026-10-03，智谱 cogvideox-flash，真实免费 Key）

| | 文生视频 | 图生视频 |
|---|---|---|
| 全流程耗时 | **41 秒** | **53 秒** |
| 产物 | 1280x960 h264，5.108s，约 1.05 MB | 同规格，约 1.65 MB |
| 音轨 | 无（未请求音效） | 无 |
| 水印 | 右下角烧入「AI生成」（免费档默认） | 同 |

两个容易误判的点：

- **`fps=30` 是请求值，不是产物值**：实际容器 `r_frame_rate` 为 `37/1`。断言产物规格一律以 `ffprobe` 为准。
- **免费档时长不可调**：`cogvideox-flash` 契约里**没有 `duration` 字段**（只有付费的 Vidu 系列有），产物固定约 5.1 秒。

其他：prompt **上限 512 字符**；`--no-watermark` 需先在智谱个人中心签署免责声明；Key 文件带不带 BOM 都能读。

---

## 常见问题

**出图报 402 / 429？** 免费档限流，正常。等半分钟再来，或减少张数。

**出图报 500？** 极可能是模型名失效。用默认的 `sana`。

**抽帧找不到 ffmpeg？** 用 `FFMPEG_PATH` / `FFPROBE_PATH` 指路径。

**抽帧的 `time_s` 是 null？** 该 ffmpeg 的 `showinfo` 输出格式与预期不同。按帧序号和 `fpsUsed` 估算（第 n 帧 ≈ (n-1)/fps 秒），并说明是估算值。

**视频生成一直排队？** 免费档排队正常。脚本超时会打印任务 `id`，拿 `id` 稍后再查（智谱：`GET /api/paas/v4/async-result/{id}`），**不要盲目重提**。
