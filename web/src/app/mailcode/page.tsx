"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Copy,
  LoaderCircle,
  Mail,
  MailPlus,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useAuthGuard } from "@/lib/use-auth-guard";
import {
  createTempMailbox,
  fetchMailCode,
  type MailCodeMessage,
} from "@/lib/api";

export default function MailCodePage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);

  if (isCheckingAuth || !session || session.role !== "admin") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <MailCodeContent />;
}

function MailCodeContent() {
  const [address, setAddress] = useState("");
  const [isPolling, setIsPolling] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [message, setMessage] = useState<MailCodeMessage | null>(null);
  const [info, setInfo] = useState("");
  const [error, setError] = useState("");
  const [history, setHistory] = useState<Array<{ time: string; address: string; code: string }>>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setIsPolling(false);
    pollCountRef.current = 0;
  }, []);

  const doFetch = useCallback(async (addr: string) => {
    if (!addr.trim() || !addr.includes("@")) return;
    setIsFetching(true);
    setError("");
    try {
      const result = await fetchMailCode(addr.trim());
      if (!result.ok) {
        setError(result.error || "查询失败");
        setCode(null);
        setMessage(null);
        setInfo("");
      } else {
        setCode(result.code || null);
        setMessage(result.message || null);
        setInfo(result.info || "");
        if (result.code) {
          setHistory((prev) => {
            const item = {
              time: new Date().toLocaleTimeString(),
              address: addr,
              code: result.code!,
            };
            return [item, ...prev.slice(0, 19)];
          });
          // 拿到验证码后停止轮询
          stopPolling();
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "请求失败");
    } finally {
      setIsFetching(false);
    }
  }, [stopPolling]);

  const startPolling = useCallback(() => {
    if (!address.trim() || !address.includes("@")) {
      toast.error("请输入有效的邮箱地址");
      return;
    }
    setIsPolling(true);
    setCode(null);
    setMessage(null);
    setInfo("等待验证码...");
    setError("");
    pollCountRef.current = 0;

    // 立即查一次
    void doFetch(address);

    // 每 3 秒轮询
    pollRef.current = setInterval(() => {
      pollCountRef.current += 1;
      // 最多轮询 60 次 (3分钟)
      if (pollCountRef.current >= 60) {
        stopPolling();
        setInfo("轮询超时，未收到验证码");
        return;
      }
      void doFetch(address);
    }, 3000);
  }, [address, doFetch, stopPolling]);

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleCreateMailbox = async () => {
    setIsCreating(true);
    setError("");
    try {
      const result = await createTempMailbox();
      if (!result.ok) {
        setError(result.error || "创建失败");
      } else if (result.address) {
        setAddress(result.address);
        setCode(null);
        setMessage(null);
        setInfo(`已创建邮箱: ${result.address}`);
        toast.success(`邮箱已创建: ${result.address}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setIsCreating(false);
    }
  };

  const handleCopy = (text: string) => {
    void navigator.clipboard.writeText(text);
    toast.success("已复制到剪贴板");
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isPolling) {
      stopPolling();
    } else {
      startPolling();
    }
  };

  return (
    <>
      <section className="mt-4 mb-2 flex flex-col gap-1 sm:mt-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-kiro-gradient shadow-lg shadow-violet-500/30">
            <Mail className="size-5 text-white" />
          </div>
          <div>
            <h1 className="text-[20px] font-semibold tracking-tight text-foreground">
              接码
            </h1>
            <p className="text-[13px] text-muted-foreground">
              输入邮箱地址，自动从邮件 Provider 拉取验证码
            </p>
          </div>
        </div>
      </section>

      <section className="mt-4 space-y-4">
        {/* 输入区域 */}
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="border-b border-border bg-gradient-to-br from-card to-secondary/40 p-5">
            <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1.5">
                <label className="font-data text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
                  邮箱地址
                </label>
                <Input
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="输入邮箱地址，如 xxx@mymail2026.xyz"
                  className="h-11 rounded-lg border-border bg-background font-mono text-[14px]"
                  disabled={isPolling}
                />
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="submit"
                  className={cn(
                    "h-11 cursor-pointer rounded-lg px-5 text-[13px] font-medium transition",
                    isPolling
                      ? "bg-rose-500 text-white shadow-sm shadow-rose-500/30 hover:bg-rose-600"
                      : "bg-violet-500 text-white shadow-sm shadow-violet-500/30 hover:bg-violet-600",
                  )}
                  disabled={!address.trim() || !address.includes("@")}
                >
                  {isPolling ? (
                    <>
                      <LoaderCircle className="size-4 animate-spin" />
                      停止
                    </>
                  ) : isFetching ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <>
                      <Search className="size-4" />
                      开始接码
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 cursor-pointer rounded-lg border-border bg-background px-3"
                  onClick={() => void doFetch(address)}
                  disabled={isPolling || !address.trim() || !address.includes("@")}
                  title="手动刷新一次"
                >
                  <RefreshCw className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 cursor-pointer rounded-lg border-border bg-background px-3 gap-1.5"
                  onClick={() => void handleCreateMailbox()}
                  disabled={isCreating || isPolling}
                  title="创建临时邮箱"
                >
                  {isCreating ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <MailPlus className="size-4" />
                  )}
                  <span className="hidden sm:inline">新建邮箱</span>
                </Button>
              </div>
            </form>
          </div>

          {/* 结果展示 */}
          <div className="p-5">
            {error && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700">
                {error}
              </div>
            )}

            {code && (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50/50 p-6">
                <ShieldCheck className="size-8 text-emerald-600" />
                <div className="text-[11px] font-medium uppercase tracking-wider text-emerald-600">
                  验证码
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[36px] font-bold tracking-[0.2em] text-emerald-700">
                    {code}
                  </span>
                  <button
                    type="button"
                    className="cursor-pointer rounded-lg p-2 text-emerald-600 transition hover:bg-emerald-100"
                    onClick={() => handleCopy(code)}
                    title="复制验证码"
                  >
                    <Copy className="size-5" />
                  </button>
                </div>
                {message?.received_at && (
                  <div className="text-[12px] text-muted-foreground">
                    收到时间: {message.received_at}
                  </div>
                )}
              </div>
            )}

            {!code && !error && info && (
              <div className="flex items-center gap-3 rounded-lg border border-border bg-secondary/30 px-4 py-3">
                {isPolling && (
                  <LoaderCircle className="size-4 shrink-0 animate-spin text-violet-500" />
                )}
                <span className="text-[13px] text-muted-foreground">{info}</span>
              </div>
            )}

            {!code && !error && !info && (
              <div className="flex flex-col items-center gap-2 py-8 text-center text-muted-foreground">
                <Mail className="size-8 opacity-40" />
                <p className="text-[13px]">
                  输入邮箱地址后点击"开始接码"，将自动轮询邮件验证码
                </p>
                <p className="text-[11px] opacity-70">
                  也可以点击"新建邮箱"自动创建一个临时邮箱
                </p>
              </div>
            )}

            {message && !code && message.text_content && (
              <div className="mt-3 rounded-lg border border-border bg-secondary/20 p-4">
                <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  邮件内容
                </div>
                <div className="text-[12px] text-foreground/80 whitespace-pre-wrap">
                  {message.text_content}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 历史记录 */}
        {history.length > 0 && (
          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            <div className="flex items-center justify-between border-b border-border bg-secondary/30 px-4 py-2.5">
              <span className="font-data text-[10px] font-bold tracking-[0.22em] text-foreground/70 uppercase">
                接码历史
              </span>
              <span className="font-data text-[10px] tabular-nums text-muted-foreground">
                {history.length} 条
              </span>
            </div>
            <div className="max-h-[300px] overflow-y-auto scrollbar-fancy">
              {history.map((item, index) => (
                <div
                  key={`${item.time}-${index}`}
                  className="flex items-center gap-4 border-b border-border/50 px-4 py-2.5 last:border-0 hover:bg-secondary/20"
                >
                  <span className="shrink-0 font-data text-[11px] tabular-nums text-muted-foreground">
                    {item.time}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground/70">
                    {item.address}
                  </span>
                  <span className="shrink-0 font-mono text-[14px] font-bold tracking-wider text-emerald-600">
                    {item.code}
                  </span>
                  <button
                    type="button"
                    className="cursor-pointer rounded p-1 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                    onClick={() => handleCopy(item.code)}
                    title="复制"
                  >
                    <Copy className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
