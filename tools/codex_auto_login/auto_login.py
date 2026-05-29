"""Codex 号池自动登录 worker。

不进 Docker，跑在你 Mac 主机上。Playwright 真浏览器自动完成 30 个号的扫码授权。

工作流程：
  1. 调 ChatGPT2API 的 /api/codex/pool/login/start-batch 创建 N 个 device_code
  2. 调 /api/codex/pool/candidates 拿候选账号（邮箱+密码）
  3. 给每个 device_code + 账号配对：
       - 用 Playwright 开一个隐私浏览器
       - 打开 https://auth.openai.com/codex/device?user_code=XXXX-YYYY
       - 自动填邮箱 / 密码 / 点继续
       - 自动同意 device authorization
       - 关闭浏览器
  4. 服务端轮询 device_code 的 token endpoint，自动落盘到 cliproxy/auths/

并发策略：默认 1 个浏览器实例串行跑（最稳），可改 --workers N 并发。

用法：
  pip install playwright requests
  playwright install chromium

  python tools/codex_auto_login/auto_login.py \\
    --base-url http://127.0.0.1:3001 \\
    --admin-key chatgpt2api \\
    --count 10 \\
    --workers 1

  # 也可在交互模式下启动：
  python tools/codex_auto_login/auto_login.py
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any

import requests


# ---------- ChatGPT2API API client ----------

class ApiClient:
    def __init__(self, base_url: str, admin_key: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.headers = {
            "Authorization": f"Bearer {admin_key}",
            "Content-Type": "application/json",
        }

    def list_pool(self) -> list[dict]:
        r = requests.get(f"{self.base_url}/api/codex/pool", headers=self.headers, timeout=30)
        r.raise_for_status()
        return r.json().get("items", [])

    def candidates(self) -> list[dict]:
        r = requests.get(f"{self.base_url}/api/codex/pool/candidates", headers=self.headers, timeout=30)
        r.raise_for_status()
        return r.json().get("items", [])

    def start_batch(self, count: int) -> list[dict]:
        r = requests.post(
            f"{self.base_url}/api/codex/pool/login/start-batch",
            headers=self.headers,
            json={"count": count},
            timeout=30,
        )
        r.raise_for_status()
        return r.json().get("items", [])

    def poll(self, device_auth_id: str, user_code: str, email: str = "") -> dict:
        r = requests.post(
            f"{self.base_url}/api/codex/pool/login/poll",
            headers=self.headers,
            json={"device_auth_id": device_auth_id, "user_code": user_code, "email": email},
            timeout=60,
        )
        r.raise_for_status()
        return r.json()

    def cancel(self, device_auth_id: str) -> None:
        try:
            requests.post(
                f"{self.base_url}/api/codex/pool/login/cancel",
                headers=self.headers,
                json={"device_auth_id": device_auth_id},
                timeout=15,
            )
        except Exception:
            pass


# ---------- Playwright 浏览器自动化 ----------

async def run_one(
    *,
    api: ApiClient,
    device_auth_id: str,
    user_code: str,
    email: str,
    password: str,
    headless: bool,
    log_prefix: str = "",
) -> dict:
    """跑完整一轮：开浏览器 → 登录 → 同意 → 关闭 → 后台 poll 拿 token。

    返回 {"status": "ok", "email": ...} 或 {"status": "error", "error": ...}
    """
    from playwright.async_api import async_playwright, TimeoutError as PWTimeout

    auth_url = f"https://auth.openai.com/codex/device?user_code={user_code}"
    settings_url = "https://chatgpt.com/#settings/Security"

    log = lambda msg: print(f"{log_prefix}{msg}", flush=True)

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=headless,
            args=["--disable-blink-features=AutomationControlled"],
        )
        # 每个号一个独立 context，cookie 完全隔离
        context = await browser.new_context(
            viewport={"width": 1280, "height": 900},
            locale="en-US",
            timezone_id="America/Los_Angeles",
        )
        page = await context.new_page()

        try:
            # 1) 开 device 授权页
            log(f"打开授权页 user_code={user_code}")
            await page.goto(auth_url, wait_until="domcontentloaded", timeout=60_000)

            # 2) 跑直到看到 callback 或同意完成
            success = await _drive_login_and_consent(page, email, password, log)

            if not success:
                return {"status": "error", "error": "登录或同意流程超时"}

            # 3) 等服务端 poll 到 token（最多等 30 秒）
            log("浏览器流程完成，等服务端拉 token")
            for i in range(15):
                await asyncio.sleep(2)
                try:
                    poll_res = await asyncio.to_thread(api.poll, device_auth_id, user_code, email)
                except Exception as e:
                    log(f"  poll 异常: {e}")
                    continue
                status = poll_res.get("status")
                if status == "ok":
                    log(f"✅ {poll_res.get('email')} 已入池")
                    return {"status": "ok", "email": poll_res.get("email")}
                if status == "error":
                    return {"status": "error", "error": poll_res.get("error", "")}
            return {"status": "error", "error": "service poll timeout"}

        except PWTimeout as e:
            return {"status": "error", "error": f"playwright timeout: {e}"}
        except Exception as e:
            return {"status": "error", "error": f"{type(e).__name__}: {e}"}
        finally:
            try:
                await context.close()
            except Exception:
                pass
            try:
                await browser.close()
            except Exception:
                pass


async def _drive_login_and_consent(page, email: str, password: str, log) -> bool:
    """通用循环：检测当前页面状态，做相应动作。最多 240 秒。"""
    from playwright.async_api import TimeoutError as PWTimeout

    deadline = time.monotonic() + 240
    last_url = ""
    same_url_count = 0

    while time.monotonic() < deadline:
        await page.wait_for_load_state("domcontentloaded", timeout=15_000).catch() if False else None
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=10_000)
        except PWTimeout:
            pass

        url = page.url
        if url == last_url:
            same_url_count += 1
        else:
            same_url_count = 0
            last_url = url
            log(f"  当前页面: {url[:120]}")

        # 判断状态
        # 1) 已经在 deviceauth/callback 或显示成功
        if "deviceauth/callback" in url or "device-success" in url:
            log("  ✓ 已到 callback")
            return True

        try:
            body_text = (await page.locator("body").inner_text(timeout=2000)).lower()
        except Exception:
            body_text = ""

        # 检测"已成功授权"提示
        if any(k in body_text for k in ["已成功授权", "successfully authorized", "device authorized", "you may close"]):
            log("  ✓ 同意完成，看到成功提示")
            return True

        # 2) 邮箱页
        email_input = page.locator('input[type="email"], input[name="email"]').first
        if await email_input.count() > 0 and await email_input.is_visible():
            log(f"  填邮箱 {email}")
            try:
                await email_input.fill(email)
                await asyncio.sleep(0.5)
                # 找继续按钮
                btn = await _find_submit_button(page)
                if btn:
                    await btn.click()
                    log("  ✓ 已点继续")
                    await asyncio.sleep(2)
                    continue
            except Exception as e:
                log(f"  填邮箱失败: {e}")

        # 3) 密码页
        pwd_input = page.locator('input[type="password"]').first
        if await pwd_input.count() > 0 and await pwd_input.is_visible():
            log(f"  填密码")
            try:
                await pwd_input.fill(password)
                await asyncio.sleep(0.5)
                btn = await _find_submit_button(page)
                if btn:
                    await btn.click()
                    log("  ✓ 已点登录")
                    await asyncio.sleep(2)
                    continue
            except Exception as e:
                log(f"  填密码失败: {e}")

        # 4) consent 页 — 找继续/同意按钮
        for label in ["继续", "Continue", "同意", "Authorize", "Allow", "授权"]:
            try:
                btn = page.get_by_role("button", name=label).first
                if await btn.count() > 0 and await btn.is_visible():
                    await btn.click(timeout=3000)
                    log(f"  ✓ 已点 [{label}]")
                    await asyncio.sleep(2)
                    break
            except Exception:
                continue

        # 5) "为 Codex 启用设备代码授权"被红框拦
        if "启用设备代码授权" in body_text or "enable device code authorization" in body_text:
            log("  ⚠️ 该号未开'设备代码授权'开关，跳过")
            return False

        # 6) hCaptcha / Cloudflare challenge
        if "just a moment" in body_text or "请稍候" in body_text:
            log("  ⏳ Cloudflare challenge 中，等 8 秒")
            await asyncio.sleep(8)
            continue

        # 卡死了
        if same_url_count > 8:
            log("  ⚠️ 页面 16 秒没变化，放弃")
            return False

        await asyncio.sleep(1.5)

    return False


async def _find_submit_button(page):
    """找页面里第一个能点的"继续/登录/继续/Continue/Sign in"按钮。"""
    candidates_role = ["Continue", "Sign in", "Log in", "Next", "继续", "登录", "下一步"]
    for label in candidates_role:
        try:
            btn = page.get_by_role("button", name=label).first
            if await btn.count() > 0 and await btn.is_visible():
                return btn
        except Exception:
            pass
    # 兜底：找 type=submit
    try:
        btn = page.locator('button[type="submit"]').first
        if await btn.count() > 0 and await btn.is_visible():
            return btn
    except Exception:
        pass
    return None


# ---------- 主流程 ----------

async def run_batch(args: argparse.Namespace) -> None:
    api = ApiClient(args.base_url, args.admin_key)

    # 预检
    print(f"== Codex 号池自动登录 ==")
    print(f"   API:        {args.base_url}")
    print(f"   并发:       {args.workers}")
    print(f"   目标数量:   {args.count}")
    print(f"   headless:   {not args.headed}")
    print()

    # 拿候选号
    candidates = api.candidates()
    if not candidates:
        print("❌ 没有候选账号（accounts.db 里没有有密码且未入池的号）")
        return
    print(f"✓ 候选账号: {len(candidates)} 个")

    # 决定实际跑多少
    desired = min(args.count, len(candidates))
    print(f"✓ 本次会跑 {desired} 个")

    # 启动 N 个 device login
    print(f"\n→ 创建 {desired} 个 device code...")
    sessions = api.start_batch(desired)
    valid = [s for s in sessions if s.get("status") == "ready"]
    print(f"✓ 拿到 {len(valid)} 个有效 device code")

    if not valid:
        print("❌ 一个都没拿到，可能代理/CF 拦截，检查 ChatGPT2API 后端日志")
        return

    # pair: device_code <-> 候选号
    tasks = []
    for idx, s in enumerate(valid):
        if idx >= len(candidates):
            api.cancel(s["device_auth_id"])
            continue
        tasks.append({
            "idx": idx + 1,
            "device_auth_id": s["device_auth_id"],
            "user_code": s["user_code"],
            "email": candidates[idx]["email"],
            "password": candidates[idx]["password"],
        })

    print(f"\n→ 启动 {len(tasks)} 个浏览器任务，并发 {args.workers}\n")

    # 并发跑
    sem = asyncio.Semaphore(args.workers)
    results: list[dict] = []

    async def worker(task):
        async with sem:
            prefix = f"[#{task['idx']:>2}/{task['email'][:25]:<25}] "
            res = await run_one(
                api=api,
                device_auth_id=task["device_auth_id"],
                user_code=task["user_code"],
                email=task["email"],
                password=task["password"],
                headless=not args.headed,
                log_prefix=prefix,
            )
            res["task"] = task
            results.append(res)
            return res

    await asyncio.gather(*[worker(t) for t in tasks])

    # 汇总
    ok = [r for r in results if r["status"] == "ok"]
    failed = [r for r in results if r["status"] != "ok"]
    print()
    print("=" * 60)
    print(f"✓ 成功 {len(ok)} 个 / 失败 {len(failed)} 个 / 总计 {len(results)} 个")
    if failed:
        print("\n失败详情：")
        for r in failed:
            t = r.get("task") or {}
            print(f"  - {t.get('email')}: {r.get('error')}")
    print()


def main() -> None:
    parser = argparse.ArgumentParser(description="Codex 号池自动登录 worker（Playwright 真浏览器）")
    parser.add_argument("--base-url", default="http://127.0.0.1:3001", help="ChatGPT2API 服务地址")
    parser.add_argument("--admin-key", default="chatgpt2api", help="config.json 里的 auth-key")
    parser.add_argument("--count", type=int, default=5, help="本次要授权多少个号")
    parser.add_argument("--workers", type=int, default=1, help="并发浏览器数（默认 1，最稳）")
    parser.add_argument("--headed", action="store_true", help="显示浏览器窗口（调试用，默认无头）")
    args = parser.parse_args()

    asyncio.run(run_batch(args))


if __name__ == "__main__":
    main()
