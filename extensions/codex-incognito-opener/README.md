# Codex Pool 自动授权助手 (v2)

让 codex-pool 页面里的「打开授权页」按钮**完全自动化**：
- 自动开 Chrome 隐私窗口
- 自动填邮箱密码登录 ChatGPT
- 自动点"继续 → 同意"完成 device 授权
- 完成后自动关闭隐私窗口

每个号 0 点击，平均 5-10 秒完成。

## 安装

1. Chrome 地址栏输 `chrome://extensions/`
2. 右上角打开「**开发者模式**」
3. 点「**加载已解压的扩展程序**」，选这个目录：
   ```
   /Users/sion/Documents/dev/注册机/ChatGPT2API-main/extensions/codex-incognito-opener
   ```
4. 在扩展卡片上点「详细信息」→ 打开 **「在隐身模式下允许」** ⚠️ **必做**

## 配置（关键）

在扩展卡片上找到 **「扩展程序选项」** 链接（或者扩展工具栏图标 → 右键「选项」），打开设置页：

| 字段 | 说明 |
|------|------|
| ChatGPT2API 服务地址 | 默认 `http://127.0.0.1:3001`，按你部署改 |
| Admin Key | 你 `config.json` 里的 `auth-key` 值 |
| 自动填邮箱密码 | 推荐打开 |
| 自动点继续/同意 | 推荐打开 |
| 授权完成自动关闭 | 推荐打开 |

填好点保存。

## 使用

1. 打开 `http://localhost:3001/codex-pool`
2. 输入数字 → 点「+ 生成 N 个」
3. 点任意卡片的「打开授权页」
4. **隐私窗自动弹出 → 自动填邮箱 → 自动登录 → 自动同意 → 自动关闭**
5. 一气呵成

## 工作原理

```
codex-pool 页面 (localhost:3001)
    └─ content_pool.js: 拦截"打开授权页"点击 → background
                                                    ↓
                                              开隐身窗 → auth.openai.com/codex/device?user_code=XXXX
                                                    ↓
                                              content_auth.js
                                              ├─ 调 background → /api/codex/pool/login/claim-credential 拿账号
                                              ├─ 跳到 /log-in 后自动填邮箱 → 点继续
                                              ├─ 跳到密码页自动填密码 → 点登录
                                              ├─ 跳到 /codex/device 同意页自动点继续
                                              └─ 看到"已成功授权" → background 关闭窗口
```

## 常见问题

**Q: 隐私窗弹出了但没自动填**  
A: 1) 选项里 admin key 没填或填错 2) 数据库里没有可用候选账号（账号没存密码）

**Q: 隐私窗里说"为 Codex 启用设备代码授权"被红框拦了**  
A: 这个号的 ChatGPT 设置里设备代码授权开关没开。需要在 `chatgpt.com/#settings/Security` 里开。一次性，每个号开一次。

**Q: 一直停在登录页填邮箱按继续后没反应**  
A: 可能触发了 hCaptcha 真人验证。手动过验证就行。

**Q: 自动同意一直不点**  
A: 有些版本按钮文字不是"继续/同意"——把页面上能点的紫色/蓝色按钮主动点一下，或者刷新一下。

## 卸载

`chrome://extensions/` → 找到这个扩展 → 移除。
