"use client";

import Link from "next/link";
import {
  LoaderCircle,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Square,
  Terminal,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { useSettingsStore } from "../../settings/store";

export function RegisterCard() {
  const config = useSettingsStore((state) => state.registerConfig);
  const isLoading = useSettingsStore((state) => state.isLoadingRegister);
  const isSaving = useSettingsStore((state) => state.isSavingRegister);
  const setTotal = useSettingsStore((state) => state.setRegisterTotal);
  const toggle = useSettingsStore((state) => state.toggleRegister);
  const reset = useSettingsStore((state) => state.resetRegister);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-border bg-card p-10">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!config) return null;

  const stats = config.stats || { success: 0, fail: 0, done: 0, running: 0, threads: config.threads };
  const logs = config.logs || [];

  const targetTotal =
    config.mode === "quota"
      ? Number(config.target_quota || 0)
      : config.mode === "available"
        ? Number(config.target_available || 0)
        : Number(config.total || 0);
  const currentValue =
    config.mode === "quota"
      ? Number(stats.current_quota || 0)
      : config.mode === "available"
        ? Number(stats.current_available || 0)
        : Number(stats.success || 0);
  const progress = targetTotal > 0 ? Math.min(100, Math.round((currentValue / targetTotal) * 100)) : 0;
  const modeLabel = config.mode === "quota" ? "额度" : config.mode === "available" ? "可用账号" : "已注册";

  const kpis: { label: string; value: string | number; tone?: "ok" | "warn" | "error" | "muted" }[] = [
    { label: "成功", value: stats.success, tone: "ok" },
    { label: "失败", value: stats.fail, tone: stats.fail > 0 ? "error" : "muted" },
    { label: "完成", value: stats.done },
    { label: "线程", value: `${stats.running}/${stats.threads}` },
    { label: "平均", value: `${stats.avg_seconds || 0}s` },
    { label: "已运行", value: `${stats.elapsed_seconds || 0}s` },
    { label: "成功率", value: `${stats.success_rate || 0}%`, tone: (stats.success_rate || 0) >= 80 ? "ok" : "warn" },
    { label: "额度", value: stats.current_quota || 0, tone: "muted" },
  ];

  return (
    <div className="space-y-4">
      {/* === 顶部状态卡片 === */}
      <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex flex-col gap-4 border-b border-border bg-gradient-to-br from-card to-secondary/40 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "relative grid size-10 place-items-center rounded-lg border",
                config.enabled
                  ? "border-violet-200 bg-violet-50 text-violet-600"
                  : "border-border bg-secondary text-muted-foreground",
              )}
            >
              {config.enabled ? (
                <>
                  <span className="absolute inset-0 animate-ping rounded-lg bg-violet-400/20" />
                  <span className="relative size-2 rounded-full bg-violet-500" />
                </>
              ) : (
                <span className="size-2 rounded-full bg-muted-foreground/50" />
              )}
            </span>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "font-data text-[10px] font-bold tracking-[0.22em] uppercase",
                    config.enabled ? "text-violet-600" : "text-muted-foreground",
                  )}
                >
                  {config.enabled ? "运行中" : "空闲"}
                </span>
                <span className="h-px w-6 bg-border" />
                <span className="font-data text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                  模式 · {config.mode === "total" ? "总数" : config.mode === "quota" ? "额度" : "可用"}
                </span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="font-data tabular-nums text-[28px] font-semibold leading-none tracking-tight text-foreground">
                  {currentValue}
                </span>
                <span className="font-data tabular-nums text-[16px] font-medium text-muted-foreground">
                  / {targetTotal || "∞"}
                </span>
                <span className="ml-1 font-data text-[11px] font-medium text-muted-foreground">{modeLabel}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <label className="font-data text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase whitespace-nowrap">
                数量
              </label>
              <Input
                value={String(config.total)}
                onChange={(event) => setTotal(event.target.value)}
                className="h-10 w-20 rounded-lg border-border bg-background font-data tabular-nums text-center"
                disabled={config.enabled}
              />
            </div>
            <Button
              className={cn(
                "h-10 cursor-pointer rounded-lg px-5 text-[13px] font-medium transition",
                config.enabled
                  ? "bg-rose-500 text-white shadow-sm shadow-rose-500/30 hover:bg-rose-600"
                  : "bg-violet-500 text-white shadow-sm shadow-violet-500/30 hover:bg-violet-600",
              )}
              onClick={() => void toggle()}
              disabled={isSaving}
            >
              {isSaving ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : config.enabled ? (
                <Square className="size-4 fill-current" />
              ) : (
                <Play className="size-4 fill-current" />
              )}
              {config.enabled ? "停止" : "启动"}
            </Button>
            <Button
              variant="outline"
              className="h-10 cursor-pointer rounded-lg border-border bg-background px-3 text-foreground"
              onClick={() => void reset()}
              disabled={isSaving || config.enabled}
              title="重置"
            >
              <RotateCcw className="size-4" />
            </Button>
            <Link
              href="/register-settings"
              className="inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-[13px] font-medium text-foreground transition hover:bg-secondary/60"
              title="打开注册配置"
            >
              <SlidersHorizontal className="size-4" />
              配置
            </Link>
          </div>
        </div>

        <div className="px-5 pt-4">
          <div className="relative h-1.5 overflow-hidden rounded-full bg-secondary">
            <div
              className={cn(
                "absolute inset-y-0 left-0 rounded-full transition-all duration-500",
                config.enabled
                  ? "bg-gradient-to-r from-violet-400 to-violet-600"
                  : "bg-gradient-to-r from-muted-foreground/40 to-muted-foreground/60",
              )}
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between font-data text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
            <span>进度</span>
            <span className="tabular-nums">{progress}%</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-px overflow-hidden bg-border md:grid-cols-4 lg:grid-cols-8">
          {kpis.map((kpi) => (
            <div key={kpi.label} className="flex flex-col gap-1 bg-card px-4 py-3">
              <span className="font-data text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
                {kpi.label}
              </span>
              <span
                className={cn(
                  "font-data tabular-nums text-[18px] font-semibold leading-tight",
                  kpi.tone === "ok" && "text-emerald-600",
                  kpi.tone === "error" && "text-rose-500",
                  kpi.tone === "warn" && "text-amber-600",
                  kpi.tone === "muted" && "text-muted-foreground",
                  !kpi.tone && "text-foreground",
                )}
              >
                {kpi.value}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* === 实时日志 === */}
      <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b border-border bg-secondary/30 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Terminal className="size-3.5 text-primary" />
            <span className="font-data text-[10px] font-bold tracking-[0.22em] text-foreground/70 uppercase">
              实时日志
            </span>
            <span className="ml-1 font-data text-[10px] tabular-nums text-muted-foreground">
              {logs.length} 条
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-rose-400" />
            <span className="size-2 rounded-full bg-amber-400" />
            <span className="size-2 rounded-full bg-emerald-400" />
          </div>
        </div>
        <div className="h-[calc(100vh-380px)] min-h-[400px] overflow-y-auto bg-[#fafbff] px-4 py-3 font-data text-[12px] leading-[1.7] scrollbar-fancy">
          {logs.length === 0 ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <span>暂无日志，启动后将实时显示</span>
            </div>
          ) : (
            logs
              .slice()
              .reverse()
              .map((item, index) => (
                <div
                  key={`${item.time}-${index}`}
                  className={cn(
                    "flex gap-3 rounded-sm py-[2px] transition hover:bg-secondary/40",
                    item.level === "red" && "text-rose-600",
                    item.level === "green" && "text-emerald-600",
                    item.level === "yellow" && "text-amber-600",
                    !item.level || item.level === "info" ? "text-foreground/80" : "",
                  )}
                >
                  <span className="shrink-0 select-none text-muted-foreground">
                    {new Date(item.time).toLocaleTimeString()}
                  </span>
                  <span className="min-w-0 break-words">{item.text}</span>
                </div>
              ))
          )}
        </div>
      </section>
    </div>
  );
}
