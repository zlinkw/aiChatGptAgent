<h1 align="center">
  <img src="assets/logo.png" alt="ChatGPT2API" width="72" height="72" />
  <br />
  ChatGPT2API
</h1>

<p align="center">
  对 ChatGPT 官网图片生成 / 编辑能力的逆向封装。提供 OpenAI 兼容的图片 API、在线画图工作台、号池管理、邮箱注册流水线，开箱即用 Docker 自托管。
</p>

<p align="center">
  <img src="assets/hero.png" alt="ChatGPT2API" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/boteSu/aiChatGptAgent/releases">Releases</a> ·
  <a href="docs/android-integration.md">Android 集成</a> ·
  <a href="#api">API 参考</a>
</p>

---

> [!NOTE]
> 项目地址：[boteSu/aiChatGptAgent](https://github.com/boteSu/aiChatGptAgent)。聚焦前端 UI/UX、注册机、日志与图片管理等模块的增强与重构。

> [!WARNING]
> **免责声明**：本项目涉及对 ChatGPT 官网相关接口的逆向研究，仅供个人学习与非商业性技术交流。
>
> - 严禁用于任何商业用途、批量自动化滥用、套利倒卖或二次售卖。
> - 严禁用于生成、传播违法、暴力、色情、未成年人相关内容或诈骗、骚扰等不当用途。
> - 严禁任何违反 OpenAI 服务条款或当地法律法规的行为。
> - 使用者自行承担全部风险（账号限制、封禁、法律责任等）。继续使用即视为已同意本声明全部内容。

> [!IMPORTANT]
> 存在账号受限或封禁的风险，**请勿使用重要 / 常用 / 高价值账号** 进行测试。

> [!CAUTION]
> 旧版本存在已知漏洞，请尽快升级到最新版本。公网部署时请做好访问控制与隔离，避免暴露敏感信息。

## 目录

- [功能概览](#功能概览)
- [快速开始](#快速开始)
- [配置](#配置)
- [本地开发](#本地开发)
- [API](#api)
- [Android 客户端](#android-客户端)
- [截图](#截图)
- [License](#license)

## 功能概览

| 模块 | 能力 |
|---|---|
| **OpenAI 兼容 API** | `/v1/images/generations`、`/v1/images/edits`、`/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/models` |
| **在线画图工作台** | 文生图、图片编辑、多图组图编辑、参考图上传、会话历史、服务端图片缓存 |
| **号池管理** | 自动刷新邮箱 / 类型 / 额度，自动剔除失效 Token，限流账号定时检查、轮询调度、批量导入与清理 |
| **注册机** | ChatGPT 邮箱注册流水线，支持启动 / 停止 / 重置，SSE 实时进度回传 |
| **日志管理** | 按级别（debug/info/warning/error）与时间范围筛选，实时刷新与历史回看 |
| **图片管理** | 缓存图片浏览、标签、按日期检索、单图删除与批量清理 |
| **配置与备份** | 二级权限（admin / user）、多种存储后端、HTTP/SOCKS 代理、Cloudflare R2 自动备份、敏感词过滤、可选 AI 自动审查 |

### API 兼容细节

- 文本类接口（`chat/completions`、`responses`、`messages`）的 `model` 字段直接透传给上游，可用模型范围由账号在 ChatGPT 网页端的权限决定。
- 图片类接口仅识别 `gpt-image-2`（映射到上游 `gpt-5-3` slug）与 `codex-gpt-image-2`（走 Codex 画图通道），其他模型名走图片接口会回落到 `auto`。
- 支持 `n` 参数一次返回多张生成结果（后端限制 `1-4`）。
- Codex 画图仅 `Plus` / `Team` / `Pro` 订阅可用，与官网画图共用账号但额度独立。

### 账号导入方式

支持 4 种导入方式，号池页面切换面板即可：

1. 本地 CPA JSON 文件导入
2. 远程 CPA 服务器导入
3. `sub2api` 服务器导入
4. `access_token` 直接导入

## 快速开始

支持 `linux/amd64` 与 `linux/arm64`，x86 服务器与 Apple Silicon / ARM Linux 均可。

```bash
git clone https://github.com/boteSu/aiChatGptAgent.git
cd aiChatGptAgent
cp config.example.json config.json   # 首次部署，改 auth-key 为强随机字符串
docker compose up -d
```

部署完成，打开 `http://localhost:3001` 即可使用。API Base 为 `http://localhost:3001/v1`。

```bash
docker compose logs -f      # 查看日志
docker compose restart      # 重启
docker compose pull         # 拉取最新镜像
docker compose down         # 停止并移除容器
```

<details>
<summary>从源码本地构建（开发者）</summary>

适合需要修改代码 / 自定义 UI 的开发者。

```bash
git clone https://github.com/boteSu/aiChatGptAgent.git
cd aiChatGptAgent

# 构建前端
cd web && npm install && npm run build && cd ..
rm -rf web_dist && cp -r web/out web_dist

# 启动（容器名 chatgpt2api-local）
docker compose -f docker-compose.local.yml up -d --build
```

修改后端代码：`docker restart chatgpt2api-local`

修改前端源码：

```bash
cd web && rm -rf .next out && npm run build && cd ..
rm -rf web_dist && cp -r web/out web_dist
docker restart chatgpt2api-local
```

> [!TIP]
> 不要用 `docker compose build --no-cache`，容器内无法访问 Google Fonts 会导致构建失败。前端构建始终在宿主机完成。

</details>

## 配置

### `config.json`

核心运行参数，可在 Web 设置页修改，也可直接编辑文件后重启。仓库提供 `config.example.json` 作为模板，首次部署时复制一份：

```bash
cp config.example.json config.json
```

`config.json` 已加入 `.gitignore`，本地修改不会被提交。

| 字段 | 说明 |
|---|---|
| `auth-key` | 全局根 key（admin），用于访问 API 与 Web 面板 |
| `refresh_account_interval_minute` | 账号自动刷新间隔（分钟） |
| `image_retention_days` | 图片缓存保留天数 |
| `image_poll_timeout_secs` | 图片生成轮询超时（秒） |
| `auto_remove_invalid_accounts` | 自动剔除失效账号 |
| `auto_remove_rate_limited_accounts` | 自动剔除限流账号 |
| `proxy` | 全局代理（http/https/socks5/socks5h） |
| `base_url` | 公网访问基础 URL，用于生成图片直链 |
| `image_account_concurrency` | 单账号图片生成并发数 |
| `account_route_strategy` | 号池调度策略（`round_robin` 等） |
| `ai_review` | 可选的 AI 自动内容审查 |
| `backup` | Cloudflare R2 自动备份（加密、轮换、按模块勾选） |

### 环境变量

完整示例见 [`.env.example`](.env.example)。

| 变量 | 说明 |
|---|---|
| `CHATGPT2API_AUTH_KEY` | 覆盖 `config.json` 的 `auth-key` |
| `CHATGPT2API_BASE_URL` | 公网访问基础 URL |
| `STORAGE_BACKEND` | 存储后端类型：`json` / `sqlite` / `postgres` / `git` |
| `DATABASE_URL` | sqlite/postgres 连接串 |
| `GIT_REPO_URL` / `GIT_TOKEN` / `GIT_BRANCH` / `GIT_FILE_PATH` | Git 存储后端配置 |

### 存储后端

| 类型 | 用途 |
|---|---|
| `json` | 默认。本地 JSON 文件，零配置，适合单机 |
| `sqlite` | 本地数据库，支持事务，适合中小规模号池 |
| `postgres` | 外部 PostgreSQL（支持 Supabase），适合多节点共享 |
| `git` | Git 私有仓库存储，天然版本化与异地备份 |

PostgreSQL 配置示例：

```yaml
environment:
  - STORAGE_BACKEND=postgres
  - DATABASE_URL=postgresql://user:password@host:5432/dbname
```

Git 配置示例：

```yaml
environment:
  - STORAGE_BACKEND=git
  - GIT_REPO_URL=https://github.com/your-username/your-private-repo.git
  - GIT_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  - GIT_BRANCH=main
  - GIT_FILE_PATH=accounts.json
```

## 本地开发

不需要 Docker、希望直接跑源码调试时使用此方式。

### 后端（Python 3.13 + uv）

```bash
git clone https://github.com/boteSu/aiChatGptAgent.git
cd aiChatGptAgent
uv sync
uv run main.py
# 默认监听 :80，可通过 main.py 中的 uvicorn 参数调整
```

### 前端（Next.js + bun / npm）

```bash
cd web
bun install        # 或 npm install
bun run dev        # 或 npm run dev
# 默认监听 :3000，会自动代理到后端
```

## API

所有 AI 接口都需要请求头：

```http
Authorization: Bearer <auth-key>
```

<details>
<summary><code>GET /v1/models</code></summary>
<br>

返回当前可用模型列表，可接入 Cherry Studio、New API 等上游或客户端。

```bash
curl http://localhost:3001/v1/models \
  -H "Authorization: Bearer <auth-key>"
```

返回示例（具体取决于账号权限）：`gpt-image-2`、`codex-gpt-image-2`、`auto`、`gpt-5`、`gpt-5-1`、`gpt-5-2`、`gpt-5-3`、`gpt-5-3-mini`、`gpt-5-mini`。

</details>

<details>
<summary><code>POST /v1/images/generations</code> · 文生图</summary>
<br>

```bash
curl http://localhost:3001/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <auth-key>" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "一只漂浮在太空里的猫",
    "n": 1,
    "response_format": "b64_json"
  }'
```

| 字段 | 说明 |
|---|---|
| `model` | 图片模型，推荐 `gpt-image-2` |
| `prompt` | 图片生成提示词 |
| `n` | 生成数量，`1-4` |
| `response_format` | 默认 `b64_json` |

</details>

<details>
<summary><code>POST /v1/images/edits</code> · 图片编辑</summary>
<br>

`multipart/form-data` 上传参考图：

```bash
curl http://localhost:3001/v1/images/edits \
  -H "Authorization: Bearer <auth-key>" \
  -F "model=gpt-image-2" \
  -F "prompt=把这张图改成赛博朋克夜景风格" \
  -F "n=1" \
  -F "image=@./input.png"
```

| 字段 | 说明 |
|---|---|
| `model` | 图片模型，`gpt-image-2` |
| `prompt` | 图片编辑提示词 |
| `n` | 生成数量，`1-4` |
| `image` | 待编辑图片文件 |

</details>

<details>
<summary><code>POST /v1/chat/completions</code> · 图片场景的 Chat Completions</summary>
<br>

仅适配图片生成场景，不是完整通用聊天代理。

```bash
curl http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <auth-key>" \
  -d '{
    "model": "gpt-image-2",
    "messages": [
      { "role": "user", "content": "生成一张雨夜东京街头的赛博朋克猫" }
    ],
    "n": 1
  }'
```

</details>

<details>
<summary><code>POST /v1/responses</code> · 图片工具调用</summary>
<br>

仅适配带 `image_generation` 工具的请求，不是完整 Responses API 代理。

```bash
curl http://localhost:3001/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <auth-key>" \
  -d '{
    "model": "gpt-5",
    "input": "生成一张未来感城市天际线图片",
    "tools": [{ "type": "image_generation" }]
  }'
```

</details>

## Android 客户端

配套安卓客户端 **Draw**，覆盖文生图、图生图、画廊、作品管理。

> [!NOTE]
> 客户端为闭源发布，仅以 APK 形式提供。后端 API 完全开源，欢迎参考 [`docs/android-integration.md`](docs/android-integration.md) 自行实现。

### 下载安装

1. 在 [Releases](https://github.com/boteSu/aiChatGptAgent/releases) 下载最新 `Draw-vX.Y.Z.apk`
2. 启动后填写：
   - **后端地址**：你部署的 ChatGPT2API 实例（如 `https://api.example.com`）
   - **访问密钥**：管理员根 key 或 user 密钥

### 主要能力

- 文生图 / 图生图，支持参考图、风格预设、比例与张数选择
- 公共画廊：浏览社区作品、一键复用 prompt、本人发布的可撤回
- 我的作品：本地缓存 + 云端归属合并，重装 / 换设备不丢图
- 后台生成：弹窗收起后任务继续跑，完成时全局 Toast 通知
- 自动刷新可用额度，密钥失效或后端不可达时自动跳回登录页

### 兼容性

| 项 | 要求 |
|---|---|
| Android 最低版本 | 8.0（API 26） |
| 后端版本 | 至少需要支持 `/v1/images/*`、`/api/gallery/*`、`/api/me/images` 等接口 |
| 网络 | HTTPS 建议套反向代理；HTTP 仅建议局域网调试 |

## 截图

号池管理：

![accounts](assets/accounts.png)

在线画图：

![image-studio](assets/image-studio.png)

设计工具：

![design](assets/design.png)

注册机：

![register](assets/register.png)

日志管理：

![logs](assets/logs.png)

图片管理：

![image-manager](assets/image-manager.png)

## 交流群

有问题先看 README 与 [Issue](https://github.com/boteSu/aiChatGptAgent/issues)，确实搞不定的可以加群交流。

> [!WARNING]
> 请勿在群内传播账号、密钥等敏感信息。

<p align="center">
  <img src="assets/qq-group.png" alt="QQ 交流群" width="280" />
  <br />
  QQ 群号：805700149
</p>

## 赞赏支持

如果这个项目对你有帮助，欢迎请作者喝杯咖啡 ☕ 谢谢大家的支持！

<p align="center">
  <img src="assets/wechat-pay.jpg" alt="微信赞赏" width="280" />
</p>

## License

[MIT](LICENSE)。本项目仅供学习与技术交流，使用者需自行承担因使用本项目而产生的全部责任与风险。
