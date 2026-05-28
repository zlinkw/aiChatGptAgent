# SMSPro API 接入文档 v1

> **极简版**：每个接口都是 `GET` 一个 URL，把兑换码放进 URL 路径，响应是纯文本。
> 适合自动化注册机、批量验证脚本，任何能发 HTTP 请求的语言/工具都能 10 秒接入。

---

## 目录

- [0. 基础信息](#0-基础信息)
- [1. `GET /api/v1/activate/{code}`](#1-getapi-v1-activate-code)
- [2. `GET /api/v1/status/{code}`](#2-getapi-v1-status-code)
- [3. `GET /api/v1/next/{code}`](#3-getapi-v1-next-code)
- [4. `GET /api/v1/change/{code}`](#4-getapi-v1-change-code)
- [5. 错误码完整列表](#5-错误码完整列表)
- [6. 完整接入流程](#6-完整接入流程)
- [7. IP 速率限制](#7-ip-速率限制)
- [8. 业务规则](#8-业务规则)
- [9. 客户端示例代码](#9-客户端示例代码)

---

## 0. 基础信息

### 0.1 Base URL
```
https://smspro.11451495.xyz
```

### 0.2 鉴权
**兑换码本身就是 URL 的一部分**，没有 Header / Query / Body，直接放路径里：

```
https://smspro.11451495.xyz/api/v1/{action}/{code}
```

`{action}` 是 `activate`、`status`、`next`、`change` 之一。

### 0.3 响应规范

| HTTP 状态 | 响应体（纯文本）|
|---|---|
| 200 OK | 业务返回值：手机号 / SMS 列表 / `ok` 等 |
| 400 Bad Request | 错误码字符串（如 `not_found`、`exhausted`） |
| 429 Too Many Requests | `rate_limited:Nm`（N 是剩余分钟数） |

**Content-Type 都是 `text/plain; charset=utf-8`**。客户端可以直接当字符串处理，不需要 JSON 解析。

### 0.4 同一兑换码网页 + API 共享状态

下游客户的密钥既能丢到 https://smspro.11451495.xyz/ 网页用，也能通过 API 调用——状态完全同步。

---

## 1. `GET /api/v1/activate/{code}`

### 1.1 用途
激活兑换码并取得一个号码。**幂等**——已激活时直接返回当前号码，不会重复扣额度。

### 1.2 请求

```
GET /api/v1/activate/{code}
```

### 1.3 curl 示例
```bash
curl https://smspro.11451495.xyz/api/v1/activate/7c1d8b3f9a5e2d4f6b8c1a3e5d7f9b2c
```

### 1.4 成功响应（HTTP 200）
```
+13125550842
```

只有这一行，就是 E.164 格式的手机号，可以直接复制粘贴到注册表单。

### 1.5 失败响应

| HTTP | 响应体 | 含义 |
|---|---|---|
| 400 | `not_found` | 兑换码不存在 |
| 400 | `exhausted` | 兑换码已用完或已失效 |
| 400 | `expired` | 兑换码被运营暂停 |
| 400 | `pool_unavailable` | 池容量不足 |
| 400 | `over_max_price` | 当前服务报价超过此码限价 |
| 400 | `invalid_code` | 兑换码格式不对 |
| 429 | `rate_limited:1m` | 同 IP 请求频率超限 |

---

## 2. `GET /api/v1/status/{code}`

### 2.1 用途
轮询当前状态，返回**所有已收到的验证码**（按时间顺序，每行一条）。

**推荐轮询频率**：每 3-5 秒一次（超过 5 次/秒会被限速）。

### 2.2 请求
```
GET /api/v1/status/{code}
```

### 2.3 curl 示例
```bash
curl https://smspro.11451495.xyz/api/v1/status/7c1d8b3f9a5e2d4f6b8c1a3e5d7f9b2c
```

### 2.4 成功响应（HTTP 200）

**场景 A：还没收到任何短信** → 响应体为空字符串：
```

```

**场景 B：收到 1 条** →
```
123456
```

**场景 C：收到 2 条** →
```
123456
789012
```

**场景 D：收到 3 条（满）** →
```
123456
789012
345678
```

### 2.5 客户端判断「新短信到达」

每次轮询时记录列表长度。下次返回的行数变多了，最后一行就是新的：

```python
last_count = 0
while True:
    text = requests.get(f"{BASE}/api/v1/status/{code}").text
    codes = [c for c in text.split("\n") if c]
    if len(codes) > last_count:
        print(f"新短信: {codes[-1]}")
        last_count = len(codes)
    time.sleep(3)
```

### 2.6 失败响应

| HTTP | 响应体 |
|---|---|
| 400 | `not_found` / `expired` / `invalid_code` |
| 429 | `rate_limited:Nm` |

注意：status 返回**空字符串**表示"激活了但还没收到短信"，不是错误。

---

## 3. `GET /api/v1/next/{code}`

### 3.1 用途
触发同号 resend，请求下一条短信。第 1 条短信由 `/activate` 等到后自动到达；第 2、3 条需要主动调这个接口触发。

### 3.2 调用前置条件
- 兑换码已激活
- 上一条短信已到（即 `status` 已经能查到至少 1 条）
- 兑换码还有剩余次数

### 3.3 请求
```
GET /api/v1/next/{code}
```

### 3.4 curl 示例
```bash
curl https://smspro.11451495.xyz/api/v1/next/7c1d8b3f9a5e2d4f6b8c1a3e5d7f9b2c
```

### 3.5 成功响应（HTTP 200）
```
ok
```

触发成功后，继续轮询 `/status/{code}`，行数会增加 1（新短信到达时）。

### 3.6 失败响应

| HTTP | 响应体 | 含义 |
|---|---|---|
| 400 | `not_activated` | 兑换码还没激活 |
| 400 | `not_ready` | 当前还在等上一条短信 |
| 400 | `exhausted` | 兑换码次数已用完 |
| 400 | `pool_error` | 暂时无法接码 |
| 400 | `stale_state` | 订单状态变更（短信刚到），刷新后处理 |
| 429 | `rate_limited:Nm` |

---

## 4. `GET /api/v1/change/{code}`

### 4.1 用途
当号码 5 分钟没收到任何短信时，可以更换为一个新号码。

**关键保证**：永远不会双重占用额度。

### 4.2 调用前置条件
- 当前号码分配 **≥ 5 分钟**
- 当前号码 **0 条短信** 收到（收过就锁定）
- 兑换码 `status` ≠ `exhausted` / `expired`

**重要**：换号成功后 **15 分钟倒计时会重新计算**（每次换号都给一个全新的 15 分钟窗口）。

### 4.3 请求
```
GET /api/v1/change/{code}
```

### 4.4 curl 示例
```bash
curl https://smspro.11451495.xyz/api/v1/change/7c1d8b3f9a5e2d4f6b8c1a3e5d7f9b2c
```

### 4.5 成功响应（HTTP 200）
```
+16462017854
```

新号码（E.164 格式）。

### 4.5.1 换号失败时的自动重置

如果换号过程中**池容量不足**导致换号失败，系统会**自动把卡密重置为未激活状态**，你直接重新调 `/activate/{code}` 即可。响应仍是 HTTP 400 + `pool_unavailable`，但 code 在后端已经恢复到可用状态。

### 4.6 失败响应

| HTTP | 响应体 | 含义 |
|---|---|---|
| 400 | `not_activated` | 兑换码还没激活 |
| 400 | `too_soon` | 号码分配不足 5 分钟 |
| 400 | `not_eligible` | 当前号码已收过短信，不能换号 |
| 400 | `exhausted` | 兑换码已用完 |
| 400 | `cancel_rejected` | 号码暂时无法更换，当前号仍有效 |
| 400 | `stale_state` | 状态变更，刷新后重试 |
| 429 | `rate_limited:Nm` |

---

## 5. 错误码完整列表

所有 4xx/5xx 响应的 body 都是 ASCII 错误码字符串：

| HTTP | 错误码 | 适用场景 | 处理建议 |
|---|---|---|---|
| 400 | `not_found` | 兑换码不存在 | 检查 code 是否拼对 |
| 400 | `empty_code` | 兑换码为空 | URL 拼写错误 |
| 400 | `invalid_code` | 兑换码格式不对 | 长度应为 32 位 hex |
| 400 | `exhausted` | 已用完或已失效 | 该码无法继续使用 |
| 400 | `expired` | 被运营暂停 | 联系客服 |
| 400 | `pool_unavailable` | 池容量不足 | 等几分钟再试 |
| 400 | `pool_error` | 暂时无法接码 | 等几分钟再试 |
| 400 | `over_max_price` | 服务报价超限 | 联系运营 |
| 400 | `not_activated` | 还没调过 activate | 先调 activate |
| 400 | `not_ready` | 当前还在等短信 | 继续轮询 status |
| 400 | `too_soon` | 不足 5 分钟 | 等满 5 分钟再换号 |
| 400 | `not_eligible` | 已收过短信不能换号 | 用 next 在同号上继续 |
| 400 | `cancel_rejected` | 号码暂时无法更换 | 稍后重试 |
| 400 | `stale_state` | 并发竞态 | status 刷新后重试 |
| 429 | `rate_limited:Nm` | IP 请求频率超限 | 等 N 分钟（或减慢请求） |

---

## 6. 完整接入流程

```
┌──────────────────────────────────────────────────────────────────┐
│  伪代码（接 3 条 SMS）                                              │
├──────────────────────────────────────────────────────────────────┤
│  CODE = "7c1d8b3f..."                                              │
│  BASE = "https://smspro.11451495.xyz"                              │
│                                                                    │
│  # 1. 激活拿号                                                       │
│  phone = GET(BASE/api/v1/activate/CODE)                            │
│  # phone = "+13125550842"                                          │
│  把 phone 填到注册表单                                                │
│                                                                    │
│  # 2. 等第 1 条短信                                                  │
│  seen = 0                                                          │
│  while True:                                                       │
│      sms_text = GET(BASE/api/v1/status/CODE)                       │
│      codes = sms_text.split("\n").filter(non_empty)                │
│      if len(codes) > seen:                                         │
│          new_code = codes[-1]                                      │
│          seen = len(codes)                                         │
│          break                                                      │
│      sleep(3)                                                       │
│                                                                    │
│  # 3. 第 2、3 条                                                    │
│  for i in (2, 3):                                                  │
│      GET(BASE/api/v1/next/CODE)  # → "ok"                          │
│      while True:                                                    │
│          codes = GET(BASE/api/v1/status/CODE).split("\n")...       │
│          if len(codes) >= i:                                       │
│              print(f"第 {i} 条: {codes[-1]}")                       │
│              break                                                  │
│          sleep(3)                                                   │
│                                                                    │
│  ┌─ 异常路径 ────────────────────────────────────────────────────┐ │
│  │ 5 分钟没收到任何短信？                                          │ │
│  │   phone = GET(BASE/api/v1/change/CODE)  # 拿到新的号码          │ │
│  │   重新回步骤 2                                                  │ │
│  │ HTTP 429？                                                     │ │
│  │   响应 "rate_limited:Nm" → 等 N 分钟再继续                      │ │
│  │ HTTP 400 + "exhausted"？                                       │ │
│  │   该码已用完，结束                                                │ │
│  └────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

---

## 7. IP 速率限制

| 触发 | 动作 |
|---|---|
| 同 IP 1 秒内超过 **5 次** 请求 | 多余的返回 `429 rate_limited:1m` |

如需高频接入，联系运营加白名单（可调到 50~100 req/sec）。

---

## 8. 业务规则

| 项 | 值 |
|---|---|
| 兑换码寿命 | 激活后 **15 分钟** 硬过期 |
| 每码 SMS 数 | **3 条** |
| 同号续接 | `/next` 在同号上接第 2、3 条短信，不重新计费 |
| 换号最小等待 | 号码分配后 **≥ 5 分钟** |
| 换号资格 | 当前号 **0 短信**（收过就锁） |
| 换号后总时长 | **重置**——换号成功后重新算 15 分钟 |
| 推荐轮询间隔 | **3-5 秒** |
| 数据保留 | **15 天**（兑换码/号码/短信记录） |
| 状态共享 | 网页 + API 完全共享同一份状态 |

---

## 9. 客户端示例代码

### 9.1 Python（最简版）

```python
import time
import requests

BASE = "https://smspro.11451495.xyz/api/v1"
CODE = "7c1d8b3f9a5e2d4f6b8c1a3e5d7f9b2c"


def call(action: str) -> str:
    """统一调用：成功返回 body 文本，失败抛异常。"""
    r = requests.get(f"{BASE}/{action}/{CODE}", timeout=20)
    if r.status_code == 429:
        # 解析 retry-after
        raise RuntimeError(f"被限速: {r.text}")
    if r.status_code != 200:
        raise RuntimeError(f"接口失败 ({r.status_code}): {r.text}")
    return r.text


def wait_sms(target_count: int, timeout: float = 600) -> str:
    """轮询直到收到第 target_count 条短信，返回最新的 code。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        text = call("status")
        codes = [c for c in text.split("\n") if c]
        if len(codes) >= target_count:
            return codes[target_count - 1]
        time.sleep(3)
    raise TimeoutError("等待短信超时")


# === 完整流程 ===
phone = call("activate")
print(f"取得号码: {phone}")

print(f"第 1 条: {wait_sms(1)}")

call("next")
print(f"第 2 条: {wait_sms(2)}")

call("next")
print(f"第 3 条: {wait_sms(3)}")
```

### 9.2 Node.js

```javascript
const BASE = "https://smspro.11451495.xyz/api/v1";
const CODE = "7c1d8b3f9a5e2d4f6b8c1a3e5d7f9b2c";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(action) {
  const r = await fetch(`${BASE}/${action}/${CODE}`);
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status}: ${text}`);
  return text;
}

async function waitSms(targetCount, timeoutMs = 600_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const text = await call("status");
    const codes = text.split("\n").filter(Boolean);
    if (codes.length >= targetCount) return codes[targetCount - 1];
    await sleep(3000);
  }
  throw new Error("等待短信超时");
}

(async () => {
  console.log("号码:", await call("activate"));
  console.log("第 1 条:", await waitSms(1));

  for (const n of [2, 3]) {
    await call("next");
    console.log(`第 ${n} 条:`, await waitSms(n));
  }
})();
```

### 9.3 Go

```go
package main

import (
    "fmt"
    "io"
    "net/http"
    "strings"
    "time"
)

const (
    base = "https://smspro.11451495.xyz/api/v1"
    code = "7c1d8b3f9a5e2d4f6b8c1a3e5d7f9b2c"
)

func call(action string) (string, error) {
    r, err := http.Get(fmt.Sprintf("%s/%s/%s", base, action, code))
    if err != nil { return "", err }
    defer r.Body.Close()
    body, _ := io.ReadAll(r.Body)
    if r.StatusCode != 200 {
        return "", fmt.Errorf("%d: %s", r.StatusCode, body)
    }
    return string(body), nil
}

func waitSms(target int) (string, error) {
    for i := 0; i < 200; i++ {
        text, err := call("status")
        if err != nil { return "", err }
        codes := []string{}
        for _, c := range strings.Split(text, "\n") {
            if c != "" { codes = append(codes, c) }
        }
        if len(codes) >= target { return codes[target-1], nil }
        time.Sleep(3 * time.Second)
    }
    return "", fmt.Errorf("等待超时")
}

func main() {
    phone, _ := call("activate")
    fmt.Println("号码:", phone)

    sms1, _ := waitSms(1)
    fmt.Println("第 1 条:", sms1)

    for _, n := range []int{2, 3} {
        call("next")
        sms, _ := waitSms(n)
        fmt.Printf("第 %d 条: %s\n", n, sms)
    }
}
```

### 9.4 Shell（curl + jq 都不需要）

```bash
#!/bin/bash
CODE="7c1d8b3f9a5e2d4f6b8c1a3e5d7f9b2c"
BASE="https://smspro.11451495.xyz/api/v1"

PHONE=$(curl -s "$BASE/activate/$CODE")
echo "号码: $PHONE"

# 等第 1 条
LAST=0
while true; do
    TEXT=$(curl -s "$BASE/status/$CODE")
    COUNT=$(echo "$TEXT" | grep -c .)
    if [ "$COUNT" -gt "$LAST" ]; then
        echo "第 $COUNT 条: $(echo "$TEXT" | tail -n1)"
        LAST=$COUNT
        [ "$COUNT" -ge 3 ] && break
        curl -s "$BASE/next/$CODE" > /dev/null
    fi
    sleep 3
done
```

---

## 10. 联系方式

- 网页：https://smspro.11451495.xyz/
- 文档在线版：https://smspro.11451495.xyz/api/v1/docs
- 文档 Markdown 版（喂给 AI）：https://smspro.11451495.xyz/api/v1/docs.md
- 运营对接：（你的渠道）

---

> 文档版本 v1，最后更新 2026-05。
