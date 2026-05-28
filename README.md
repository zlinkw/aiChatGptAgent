<h1 align="center">ChatGPT2API</h1>

<p align="center">
  把 ChatGPT 官网的画图能力变成标准 API，Docker 一键跑起来。
</p>

<p align="center">
  <img src="assets/hero.png" alt="ChatGPT2API" width="100%" />
</p>

---

## 它能干什么

- 🎨 **画图 API** — 兼容 OpenAI `/v1/images/generations` 和 `/v1/images/edits`，对接 Cherry Studio、New API 等客户端直接用
- 💬 **聊天 API** — `/v1/chat/completions`、`/v1/messages`，支持中转 Claude / Gemini / DeepSeek
- 🖌️ **在线画图工作台** — 网页上直接画，支持文生图、图生图、多图编辑
- 🎯 **设计工具** — AI 辅助 UI 设计
- 📦 **号池管理** — 批量导入账号，自动轮询、自动剔除失效的
- 🤖 **注册机** — 自动注册 ChatGPT 账号
- 📊 **日志 & 图片管理** — 全部可视化

## 三步部署

```bash
git clone https://github.com/boteSu/aiChatGptAgent.git
cd aiChatGptAgent
cp config.example.json config.json   # ← 打开改一下 auth-key
docker compose up -d
```

打开 **http://localhost:3001** 就能用了。

升级：`docker compose pull && docker compose up -d`

## 怎么用

部署好之后，在你的 AI 客户端里填：

| 配置项 | 填什么 |
|---|---|
| API Base URL | `http://你的IP:3001/v1` |
| API Key | 你在 config.json 里设的 `auth-key` |
| 模型 | `gpt-image-2`（画图）或 `auto`（文本） |

支持的客户端：Cherry Studio、ChatBox、New API、NextChat、OpenCat、任何支持 OpenAI API 的工具。

## API 速查

```
GET  /v1/models              → 可用模型列表
POST /v1/images/generations  → 文生图
POST /v1/images/edits        → 图生图
POST /v1/chat/completions    → 聊天（图片/文本）
POST /v1/messages            → Anthropic 兼容
POST /v1/responses           → Responses API
```

所有请求加 Header：`Authorization: Bearer <你的auth-key>`

## 配置说明

编辑 `config.json` 或在 Web 设置页改，改完 `docker compose restart` 生效。

| 字段 | 干什么的 |
|---|---|
| `auth-key` | 你的管理员密码，访问 API 和网页都靠它 |
| `proxy` | 代理地址（http/socks5），没梯子填这个 |
| `base_url` | 公网域名，用于生成图片直链 |
| `auto_remove_invalid_accounts` | 失效账号自动踢掉 |

更多配置看 Web 面板的设置页，都有中文说明。

## 账号导入

号池页面支持 4 种方式：

1. **本地文件** — 上传 CPA 格式的 JSON
2. **远程 CPA 服务器** — 填地址自动拉取
3. **sub2api** — 填 sub2api 服务器地址
4. **直接粘贴** — 粘 access_token 就行

## 截图

号池管理：

![accounts](assets/accounts.png?v=2)

在线画图：

![image-studio](assets/image-studio.png?v=2)

设计工具：

![design](assets/design.png)

注册机：

![register](assets/register.png?v=2)

日志管理：

![logs](assets/logs.png?v=2)

图片管理：

![image-manager](assets/image-manager.png?v=2)

## 交流 & 赞赏

<p align="center">
  <img src="assets/qq-group.png" alt="QQ 交流群" width="280" />
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <img src="assets/wechat-pay.jpg" alt="微信赞赏" width="280" />
  <br />
  QQ 群：805700149 &nbsp;&nbsp;|&nbsp;&nbsp; 微信赞赏
</p>

> [!WARNING]
> 请勿在群内传播账号、密钥等敏感信息。

## License

[MIT](LICENSE) — 仅供学习与技术交流，风险自负。
