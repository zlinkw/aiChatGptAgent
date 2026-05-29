"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  CheckCircle2,
  Copy,
  ExternalLink,
  LoaderCircle,
  Plus,
  Power,
  RefreshCw,
  Trash2,
  XCircle,
  AlertCircle,
  Layers,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { httpRequest } from "@/lib/request";
import { cn } from "@/lib/utils";

interface CodexAccount {
  file: string;
  email: string;
  account_id: string;
  expired: string;
  last_refresh: string;
  disabled: boolean;
  type: string;
  plan: string;
}

interface DeviceLoginSession {
  device_auth_id: string;
  user_code: string;
  verification_url: string;
  verification_url_with_code?: string;
  interval: number;
  expires_at: string;
}

type LoginStatus =
  | { status: "pending" }
  | { status: "ok"; email: string; plan: string; auth_file: string }
  | { status: "error"; error: string };

interface BatchSlot extends DeviceLoginSession {
  status: LoginStatus["status"];
  email?: string;
  error?: string;
  // 后端按"还没入池且有密码"挑的建议账号
  suggested_email?: string;
  suggested_password?: string;
}

const POLL_INTERVAL_MS = 4000;

function CodexPoolContent() {
  const [items, setItems] = useState<CodexAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [batchSlots, setBatchSlots] = useState<BatchSlot[]>([]);
  const [batchCount, setBatchCount] = useState<number>(5);
  const pollerRef = useRef<NodeJS.Timeout | null>(null);
  const didLoad = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await httpRequest<{ items: CodexAccount[] }>("/api/codex/pool");
      setItems(res.items || []);
    } catch {
      toast.error("加载号池失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (didLoad.current) return;
    didLoad.current = true;
    void load();
  }, [load]);

  useEffect(() => {
    return () => {
      if (pollerRef.current) clearInterval(pollerRef.current);
    };
  }, []);

  const stopPolling = () => {
    if (pollerRef.current) {
      clearInterval(pollerRef.current);
      pollerRef.current = null;
    }
  };

  // 批量轮询：对所有 status=pending 的 slot 一起轮询
  const pollBatchOnce = async () => {
    setBatchSlots((prev) => {
      // 找出所有 pending 的 slot，并行 poll
      const pendings = prev.filter((s) => s.status === "pending");
      if (pendings.length === 0) {
        stopPolling();
        return prev;
      }
      void Promise.all(
        pendings.map(async (slot) => {
          try {
            const res = await httpRequest<LoginStatus>("/api/codex/pool/login/poll", {
              method: "POST",
              body: { device_auth_id: slot.device_auth_id, user_code: slot.user_code },
            });
            if (res.status === "ok") {
              setBatchSlots((s2) =>
                s2.map((x) =>
                  x.device_auth_id === slot.device_auth_id
                    ? { ...x, status: "ok", email: res.email }
                    : x
                )
              );
              toast.success(`${res.email} 已入池`);
              void load();
            } else if (res.status === "error") {
              setBatchSlots((s2) =>
                s2.map((x) =>
                  x.device_auth_id === slot.device_auth_id
                    ? { ...x, status: "error", error: res.error }
                    : x
                )
              );
            }
          } catch {
            // 静默 - 下次再试
          }
        })
      );
      return prev;
    });
  };

  const startBatch = async (count: number) => {
    setBusy(true);
    try {
      // 同时拉候选账号 + 启动 N 个 device code
      const [batchRes, candRes] = await Promise.all([
        httpRequest<{
          items: (DeviceLoginSession & { status: string; error?: string })[];
        }>("/api/codex/pool/login/start-batch", {
          method: "POST",
          body: { count },
        }),
        httpRequest<{ items: { email: string; password: string }[] }>(
          "/api/codex/pool/candidates"
        ).catch(() => ({ items: [] })),
      ]);
      const candidates = candRes.items || [];
      const newSlots: BatchSlot[] = (batchRes.items || []).map((item, idx) => {
        const cand = candidates[idx];
        if (item.status === "error") {
          return {
            device_auth_id: "",
            user_code: "",
            verification_url: "",
            interval: 0,
            expires_at: "",
            status: "error" as const,
            error: item.error,
          };
        }
        return {
          ...item,
          status: "pending" as const,
          suggested_email: cand?.email,
          suggested_password: cand?.password,
        };
      });
      setBatchSlots(newSlots);
      const okCount = newSlots.filter((s) => s.status === "pending").length;
      const matchCount = newSlots.filter((s) => s.suggested_email).length;
      toast.success(
        `已生成 ${okCount} 个授权码${matchCount ? `，自动匹配了 ${matchCount} 个账号` : "（数据库里没有可用候选账号）"}`
      );

      stopPolling();
      pollerRef.current = setInterval(() => {
        void pollBatchOnce();
      }, POLL_INTERVAL_MS);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`启动失败：${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const cancelBatch = async () => {
    stopPolling();
    const pendings = batchSlots.filter((s) => s.status === "pending");
    await Promise.all(
      pendings.map((s) =>
        httpRequest("/api/codex/pool/login/cancel", {
          method: "POST",
          body: { device_auth_id: s.device_auth_id },
        }).catch(() => null)
      )
    );
    setBatchSlots([]);
  };

  const cancelOneSlot = async (deviceAuthId: string) => {
    try {
      await httpRequest("/api/codex/pool/login/cancel", {
        method: "POST",
        body: { device_auth_id: deviceAuthId },
      });
    } catch {
      // 忽略
    }
    setBatchSlots((prev) => prev.filter((s) => s.device_auth_id !== deviceAuthId));
  };

  const toggleAccount = async (file: string, currentDisabled: boolean) => {
    const action = currentDisabled ? "enable" : "disable";
    try {
      await httpRequest(`/api/codex/pool/${encodeURIComponent(file)}/${action}`, {
        method: "POST",
        body: {},
      });
      toast.success(currentDisabled ? "已启用" : "已禁用");
      void load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`操作失败：${msg}`);
    }
  };

  const deleteAccount = async (file: string, email: string) => {
    if (
      !confirm(
        `确定从号池移除 ${email}？\n\n这只是从 CLIProxyAPI 池里删除 token 文件，原 ChatGPT 账号不受影响。`
      )
    ) {
      return;
    }
    try {
      await httpRequest(`/api/codex/pool/${encodeURIComponent(file)}`, { method: "DELETE" });
      toast.success("已从号池移除");
      void load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`删除失败：${msg}`);
    }
  };

  const copy = (text: string, label = "已复制") => {
    void navigator.clipboard.writeText(text);
    toast.success(label);
  };

  const activeCount = items.filter((i) => !i.disabled).length;
  const disabledCount = items.length - activeCount;
  const pendingCount = batchSlots.filter((s) => s.status === "pending").length;
  const okCount = batchSlots.filter((s) => s.status === "ok").length;

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-4">
      {/* 页头 */}
      <div className="flex items-center gap-3">
        <div className="grid size-10 place-items-center rounded-xl bg-kiro-gradient shadow-lg shadow-violet-500/30">
          <Bot className="size-5 text-white" />
        </div>
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight text-foreground">Codex 号池</h1>
          <p className="text-[13px] text-muted-foreground">
            把 ChatGPT 账号通过 OAuth 注入 CLIProxyAPI，让客户端 Codex CLI / claude-code 直接使用号池
          </p>
        </div>
      </div>

      {/* 状态卡片 */}
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="text-[11px] text-muted-foreground mb-1">号池规模</div>
          <div className="text-[14px] font-semibold text-foreground">{items.length} 个号</div>
          <div className="text-[11px] text-muted-foreground mt-1">
            {activeCount} 启用 · {disabledCount} 禁用
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="text-[11px] text-muted-foreground mb-1">支持模型</div>
          <div className="text-[14px] font-semibold text-foreground">gpt-5.5 / gpt-5.4-mini</div>
          <div className="text-[11px] text-muted-foreground mt-1">原生 function call · Codex CLI 真 agent</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="text-[11px] text-muted-foreground mb-1">客户端配置</div>
          <div className="text-[14px] font-semibold font-data text-foreground truncate">/v1/responses + tools</div>
          <div className="text-[11px] text-muted-foreground mt-1">配 OPENAI_BASE_URL = 本服务地址</div>
        </div>
      </div>

      {/* 批量授权 */}
      <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="flex items-center gap-2">
              <Layers className="size-4 text-primary" />
              <span className="text-[14px] font-semibold text-foreground">批量添加号</span>
            </div>
            <p className="text-[12px] text-muted-foreground mt-1.5">
              一次性生成 N 个授权码，每个号在<span className="text-foreground font-semibold">无痕窗口</span>里登一次即可。
              点开"打开授权页"会带上预填码，省得你输入。后台并行轮询，授权完成自动入池。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={30}
              value={batchCount}
              onChange={(e) => setBatchCount(Math.max(1, Math.min(30, Number(e.target.value) || 1)))}
              disabled={busy || batchSlots.length > 0}
              className="h-9 w-20 text-center"
            />
            <Button
              onClick={() => void startBatch(batchCount)}
              disabled={busy || batchSlots.length > 0}
              className="h-9 rounded-lg"
            >
              {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
              生成 {batchCount} 个
            </Button>
            {batchSlots.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => void cancelBatch()} className="h-9">
                清空
              </Button>
            )}
          </div>
        </div>

        {batchSlots.length > 0 && (
          <>
            <div className="mb-3 flex items-center gap-2 text-[12px] text-muted-foreground">
              <LoaderCircle className={cn("size-3.5", pendingCount > 0 && "animate-spin")} />
              {pendingCount > 0 ? (
                <>
                  等待 <span className="font-semibold text-foreground">{pendingCount}</span> 个号授权
                  · 已完成 <span className="font-semibold text-emerald-600">{okCount}</span> 个
                  · 每 {Math.round(POLL_INTERVAL_MS / 1000)} 秒查一次
                </>
              ) : (
                <>所有任务已完成（{okCount} 成功）</>
              )}
            </div>

            <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
              {batchSlots.map((slot, idx) => (
                <div
                  key={slot.device_auth_id || `error-${idx}`}
                  className={cn(
                    "rounded-lg border p-3",
                    slot.status === "ok" && "border-emerald-200 bg-emerald-50/40 dark:border-emerald-900 dark:bg-emerald-950/20",
                    slot.status === "error" && "border-rose-200 bg-rose-50/40 dark:border-rose-900 dark:bg-rose-950/20",
                    slot.status === "pending" && "border-violet-200 bg-violet-50/40 dark:border-violet-900 dark:bg-violet-950/20"
                  )}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-semibold text-muted-foreground">
                      #{idx + 1}
                    </span>
                    {slot.status === "pending" && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-violet-700 dark:text-violet-300">
                        <LoaderCircle className="size-3 animate-spin" />
                        等待中
                      </span>
                    )}
                    {slot.status === "ok" && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                        <CheckCircle2 className="size-3" />
                        已入池
                      </span>
                    )}
                    {slot.status === "error" && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-rose-700 dark:text-rose-300">
                        <AlertCircle className="size-3" />
                        失败
                      </span>
                    )}
                  </div>

                  {slot.status === "pending" && (
                    <>
                      <div className="mb-2">
                        <div className="text-[10px] text-muted-foreground mb-1">授权码</div>
                        <div className="flex items-center gap-1">
                          <code className="flex-1 rounded bg-card px-2 py-1.5 font-data text-[14px] font-bold tracking-[0.2em] text-violet-700 dark:text-violet-300 text-center">
                            {slot.user_code}
                          </code>
                          <button
                            type="button"
                            onClick={() => copy(slot.user_code, "已复制授权码")}
                            className="cursor-pointer rounded p-1 text-muted-foreground hover:text-foreground"
                          >
                            <Copy className="size-3.5" />
                          </button>
                        </div>
                      </div>

                      {/* 建议账号：邮箱 + 密码，方便扫码时复制粘贴 */}
                      {slot.suggested_email ? (
                        <div className="mb-2 rounded border border-border bg-card/60 p-2">
                          <div className="text-[10px] text-muted-foreground mb-1">建议登录账号</div>
                          <div className="space-y-1">
                            <div className="flex items-center gap-1">
                              <code className="flex-1 truncate font-data text-[11px] text-foreground">
                                {slot.suggested_email}
                              </code>
                              <button
                                type="button"
                                onClick={() =>
                                  slot.suggested_email && copy(slot.suggested_email, "已复制邮箱")
                                }
                                className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
                                title="复制邮箱"
                              >
                                <Copy className="size-3" />
                              </button>
                            </div>
                            <div className="flex items-center gap-1">
                              <code className="flex-1 truncate font-data text-[11px] text-foreground">
                                {slot.suggested_password}
                              </code>
                              <button
                                type="button"
                                onClick={() =>
                                  slot.suggested_password && copy(slot.suggested_password, "已复制密码")
                                }
                                className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
                                title="复制密码"
                              >
                                <Copy className="size-3" />
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="mb-2 rounded border border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30 p-2 text-[11px] text-amber-700 dark:text-amber-300">
                          数据库里没有匹配的账号（密码不存在或都已入池），需要你手动登录
                        </div>
                      )}

                      <div className="flex items-center gap-1">
                        <a
                          href={slot.verification_url_with_code || slot.verification_url}
                          target="_blank"
                          rel="noreferrer"
                          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md bg-violet-600 hover:bg-violet-700 px-3 py-1.5 text-[12px] font-semibold text-white"
                        >
                          <ExternalLink className="size-3.5" />
                          打开授权页
                        </a>
                        <button
                          type="button"
                          onClick={() => void cancelOneSlot(slot.device_auth_id)}
                          className="cursor-pointer rounded p-1.5 text-muted-foreground hover:text-rose-600"
                          title="跳过这个"
                        >
                          <XCircle className="size-4" />
                        </button>
                      </div>
                    </>
                  )}

                  {slot.status === "ok" && (
                    <div className="text-[12px] text-emerald-800 dark:text-emerald-200 truncate">
                      {slot.email}
                    </div>
                  )}

                  {slot.status === "error" && (
                    <div className="text-[11px] text-rose-700 dark:text-rose-300 line-clamp-2">
                      {slot.error}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* 操作小贴士 */}
            <div className="mt-4 rounded-lg border border-border bg-secondary/30 p-3">
              <div className="text-[12px] font-semibold mb-1.5">📌 操作建议</div>
              <ul className="space-y-1 text-[11px] text-muted-foreground">
                <li>• 用<span className="text-foreground font-semibold">无痕/隐私窗口</span>每个号登一次，避免 cookie 串掉</li>
                <li>• 第一次登某个号需要先在 Settings → Security 里开"为 Codex 启用设备代码授权"</li>
                <li>• 点"打开授权页"已经预填好了授权码，浏览器里只需点继续 → 同意</li>
                <li>• 后台并行轮询，谁先扫好谁先入池</li>
              </ul>
            </div>
          </>
        )}
      </section>

      {/* 当前号池 */}
      <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-[14px] font-semibold text-foreground">当前号池</div>
            <p className="text-[12px] text-muted-foreground mt-0.5">
              直接读 CLIProxyAPI 的 auths 目录，删除/禁用立即生效（自动 hot-reload）
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} className="h-9 rounded-lg">
            <RefreshCw className="size-4" />
            刷新
          </Button>
        </div>

        {items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border py-8 text-center text-[13px] text-muted-foreground">
            号池里还没有账号 — 点上方"批量添加号"开始
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-[11px] text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-2 py-2 text-left">邮箱</th>
                  <th className="px-2 py-2 text-left">套餐</th>
                  <th className="px-2 py-2 text-left">状态</th>
                  <th className="px-2 py-2 text-left">最近刷新</th>
                  <th className="px-2 py-2 text-left">过期时间</th>
                  <th className="px-2 py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.file} className="border-b border-border last:border-b-0">
                    <td className="px-2 py-2 font-data">{item.email || "-"}</td>
                    <td className="px-2 py-2">
                      <span className="rounded-full bg-secondary/40 px-2 py-0.5 text-[11px] font-semibold">
                        {item.plan || "free"}
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      {item.disabled ? (
                        <span className="inline-flex items-center gap-1 text-[12px] text-rose-600">
                          <XCircle className="size-3.5" /> 已禁用
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[12px] text-emerald-600">
                          <CheckCircle2 className="size-3.5" /> 已启用
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-[11px] text-muted-foreground">
                      {item.last_refresh?.slice(0, 19).replace("T", " ") || "-"}
                    </td>
                    <td className="px-2 py-2 text-[11px] text-muted-foreground">
                      {item.expired?.slice(0, 19).replace("T", " ") || "-"}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          className={cn(
                            "cursor-pointer rounded p-1.5",
                            item.disabled
                              ? "text-muted-foreground hover:text-emerald-600"
                              : "text-muted-foreground hover:text-rose-600"
                          )}
                          title={item.disabled ? "启用" : "禁用"}
                          onClick={() => void toggleAccount(item.file, item.disabled)}
                        >
                          <Power className="size-4" />
                        </button>
                        <button
                          type="button"
                          className="cursor-pointer rounded p-1.5 text-muted-foreground hover:text-rose-600"
                          title="移除"
                          onClick={() => void deleteAccount(item.file, item.email)}
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 客户端接入提示 */}
      <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="text-[14px] font-semibold text-foreground mb-2">客户端接入</div>
        <p className="text-[12px] text-muted-foreground mb-3">
          号池里只要有 1 个启用号，下方的客户端就能立刻使用。中转链路：
          <span className="ml-1 font-data">客户端 → 本服务 (/v1/*) → CLIProxyAPI → OpenAI Codex 通道</span>
        </p>
        <div className="grid gap-2 md:grid-cols-2">
          <div className="rounded-lg border border-border bg-secondary/30 p-3">
            <div className="text-[12px] font-semibold mb-2">Codex CLI</div>
            <code className="block whitespace-pre font-data text-[11px] text-foreground">
{`# ~/.codex/config.toml
model = "gpt-5.5"
model_provider = "self"

[model_providers.self]
name = "self"
base_url = "<本服务>/v1"
wire_api = "responses"
requires_openai_auth = true

# ~/.codex/auth.json
{ "OPENAI_API_KEY": "<你的客户端 Key>" }`}
            </code>
          </div>
          <div className="rounded-lg border border-border bg-secondary/30 p-3">
            <div className="text-[12px] font-semibold mb-2">aider / cursor / OpenAI SDK</div>
            <code className="block whitespace-pre font-data text-[11px] text-foreground">
{`OPENAI_BASE_URL=<本服务>/v1
OPENAI_API_KEY=<你的客户端 Key>

# 选用 model
gpt-5.5
gpt-5.4-mini`}
            </code>
          </div>
        </div>
      </section>
    </div>
  );
}

export default function CodexPoolPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);

  if (isCheckingAuth || !session || session.role !== "admin") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <CodexPoolContent />;
}
