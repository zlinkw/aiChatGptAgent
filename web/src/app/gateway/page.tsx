"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Copy, Key, LoaderCircle, Plus, Power, RefreshCw, Shield, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";
import { httpRequest } from "@/lib/request";

interface GatewayStatus { running: boolean; started_at: string; total_requests: number; success_requests: number; error_requests: number; success_rate: number; error_rate: number; last_error: string; last_error_at: string; last_sync: string; }
interface ClientKey { key: string; enabled: boolean; created_at: string; }
interface GatewayConfig { enabled: boolean; port: number; route_strategy: string; account_source: string; allow_remote: boolean; localhost_only: boolean; ip_whitelist: string[]; switch_threshold: number; log_level: string; auto_start: boolean; client_keys: ClientKey[]; last_sync: string; }

function GatewayContent() {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const didLoad = useRef(false);

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([
        httpRequest<{ status: GatewayStatus }>("/api/gateway/status"),
        httpRequest<{ config: GatewayConfig }>("/api/gateway/config"),
      ]);
      setStatus(s.status);
      setConfig(c.config);
    } catch (e) { toast.error("加载网关状态失败"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (didLoad.current) return; didLoad.current = true; void load(); }, [load]);

  const saveConfig = async (updates: Partial<GatewayConfig>) => {
    setSaving(true);
    try {
      const res = await httpRequest<{ config: GatewayConfig }>("/api/gateway/config", { method: "POST", body: updates });
      setConfig(res.config); toast.success("配置已保存");
    } catch (e) { toast.error("保存失败"); }
    finally { setSaving(false); }
  };

  const addKey = async () => {
    try {
      const res = await httpRequest<{ config: GatewayConfig; key: string }>("/api/gateway/keys/add", { method: "POST", body: {} });
      setConfig(res.config); toast.success(`已生成 Key: ${res.key.slice(0, 20)}...`);
    } catch { toast.error("生成失败"); }
  };

  const removeKey = async (key: string) => {
    try {
      const res = await httpRequest<{ config: GatewayConfig }>("/api/gateway/keys/remove", { method: "POST", body: { key } });
      setConfig(res.config); toast.success("已删除");
    } catch { toast.error("删除失败"); }
  };

  const toggleKey = async (key: string) => {
    try {
      const res = await httpRequest<{ config: GatewayConfig }>("/api/gateway/keys/toggle", { method: "POST", body: { key } });
      setConfig(res.config);
    } catch { toast.error("操作失败"); }
  };

  const resetStats = async () => {
    try {
      const res = await httpRequest<{ status: GatewayStatus }>("/api/gateway/reset-stats", { method: "POST", body: {} });
      setStatus(res.status); toast.success("统计已重置");
    } catch { toast.error("重置失败"); }
  };

  if (loading || !status || !config) return <div className="flex min-h-[40vh] items-center justify-center"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></div>;

  const entryUrl = `http://localhost:${config.port}`;
  const keyCount = config.client_keys.filter(k => k.enabled).length;

  return (
    <div className="space-y-4 mt-4">
      {/* 页头 */}
      <div className="flex items-center gap-3">
        <div className="grid size-10 place-items-center rounded-xl bg-kiro-gradient shadow-lg shadow-violet-500/30"><Zap className="size-5 text-white" /></div>
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight text-foreground">API 反代</h1>
          <p className="text-[13px] text-muted-foreground">把入口状态、客户端接入、安全边界和观测线索压到一屏里</p>
        </div>
      </div>

      {/* 状态卡片网格 */}
      <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-6">
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="text-[11px] text-muted-foreground mb-1">当前入口</div>
          <div className="text-[14px] font-semibold font-data text-foreground">{entryUrl}</div>
          <div className="text-[11px] text-muted-foreground mt-1">{config.allow_remote ? "允许远程访问" : "仅本机"} · {status.running ? "运行中" : "已停止"}</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="text-[11px] text-muted-foreground mb-1">客户端 Key</div>
          <div className="text-[14px] font-semibold text-foreground">已配置 {keyCount} 个</div>
          <div className="text-[11px] text-muted-foreground mt-1">Bearer {config.client_keys[0]?.key.slice(0, 8) || "—"}...</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="text-[11px] text-muted-foreground mb-1">路由模式</div>
          <div className="text-[14px] font-semibold text-foreground">{config.account_source === "pool" ? "账号管理池" : "自定义"}</div>
          <div className="text-[11px] text-muted-foreground mt-1">路由范围：所有可用账号</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="text-[11px] text-muted-foreground mb-1">最近风险</div>
          <div className={cn("text-[14px] font-semibold", status.last_error ? "text-rose-500" : "text-emerald-600")}>{status.last_error ? "有错误" : "状态平稳"}</div>
          <div className="text-[11px] text-muted-foreground mt-1">最后同步 {config.last_sync?.slice(0, 16) || "—"}</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="text-[11px] text-muted-foreground mb-1">观测样本</div>
          <div className="text-[14px] font-semibold text-foreground">{status.total_requests} 条请求</div>
          <div className="text-[11px] text-muted-foreground mt-1">成功率 {status.success_rate}% · 错误率 {status.error_rate}%</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="text-[11px] text-muted-foreground mb-1">运行差异</div>
          <div className="text-[14px] font-semibold text-emerald-600">运行态已对齐</div>
          <div className="text-[11px] text-muted-foreground mt-1">配置已保存</div>
        </div>
      </div>

      {/* 运行状态条 */}
      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold", status.running ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700")}>
            <span className={cn("size-1.5 rounded-full", status.running ? "bg-emerald-500" : "bg-rose-500")} />
            {status.running ? "反代运行中" : "已停止"}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-50 px-2.5 py-1 text-[11px] font-semibold text-violet-700">允许远程访问</span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">配置已保存</span>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[14px] font-semibold text-foreground">当前入口 {entryUrl}</div>
            <div className="text-[12px] text-muted-foreground">账号管理池 · 所有可用账号 · 已配置 {keyCount} 个客户端 Key</div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" className="h-9 rounded-lg" onClick={() => void load()} disabled={saving}><RefreshCw className="size-4" />刷新</Button>
            <Button variant="outline" className="h-9 rounded-lg" onClick={() => void resetStats()} disabled={saving}><Activity className="size-4" />重置统计</Button>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-border bg-secondary/30 p-3">
            <div className="text-[10px] text-muted-foreground uppercase font-data tracking-wider">运行快照</div>
            <div className="text-[13px] font-semibold text-foreground mt-1">{entryUrl}</div>
            <div className="text-[11px] text-muted-foreground">pool / {config.route_strategy}</div>
          </div>
          <div className="rounded-lg border border-border bg-secondary/30 p-3">
            <div className="text-[10px] text-muted-foreground uppercase font-data tracking-wider">接入与鉴权</div>
            <div className="text-[13px] font-semibold text-foreground mt-1">{entryUrl}</div>
            <div className="text-[11px] text-muted-foreground">Bearer {config.client_keys[0]?.key.slice(0, 8) || "—"}...</div>
          </div>
          <div className="rounded-lg border border-border bg-secondary/30 p-3">
            <div className="text-[10px] text-muted-foreground uppercase font-data tracking-wider">最新风险</div>
            <div className={cn("text-[13px] font-semibold mt-1", status.last_error ? "text-rose-500" : "text-foreground")}>{status.last_error || "最近未发现错误"}</div>
            <div className="text-[11px] text-muted-foreground">{status.last_error_at?.slice(0, 19) || "—"}</div>
          </div>
        </div>
      </div>

      {/* 接入指南 */}
      <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-3"><Zap className="size-4 text-primary" /><span className="text-[14px] font-semibold text-foreground">接入指南</span></div>
        <p className="text-[12px] text-muted-foreground mb-3">在你的 AI 客户端（Cherry Studio、ChatBox、New API、NextChat 等）里填以下配置即可使用：</p>
        <div className="space-y-2">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2.5">
            <span className="text-[11px] text-muted-foreground w-24 shrink-0">API Base URL</span>
            <code className="flex-1 truncate font-data text-[12px] text-foreground">{typeof window !== "undefined" ? `${window.location.origin}/v1` : `${entryUrl}/v1`}</code>
            <button type="button" className="cursor-pointer rounded p-1 text-muted-foreground hover:text-foreground" onClick={() => { const url = typeof window !== "undefined" ? `${window.location.origin}/v1` : `${entryUrl}/v1`; void navigator.clipboard.writeText(url); toast.success("已复制 Base URL"); }}><Copy className="size-3.5" /></button>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2.5">
            <span className="text-[11px] text-muted-foreground w-24 shrink-0">API Key</span>
            <code className="flex-1 truncate font-data text-[12px] text-foreground">{config.client_keys.find(k => k.enabled)?.key || "（请先生成一个 Key）"}</code>
            <button type="button" className="cursor-pointer rounded p-1 text-muted-foreground hover:text-foreground" onClick={() => { const key = config.client_keys.find(k => k.enabled)?.key; if (key) { void navigator.clipboard.writeText(key); toast.success("已复制 Key"); } else { toast.error("没有可用的 Key"); } }}><Copy className="size-3.5" /></button>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2.5">
            <span className="text-[11px] text-muted-foreground w-24 shrink-0">可用模型</span>
            <code className="flex-1 font-data text-[12px] text-foreground">gpt-image-2（画图）· auto / gpt-5（文本）· claude-* / gemini-*（中转）</code>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground mt-3">请求示例：<code className="text-[11px]">curl {typeof window !== "undefined" ? window.location.origin : entryUrl}/v1/models -H &quot;Authorization: Bearer 你的Key&quot;</code></p>
      </section>

      {/* 配置区 */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* 客户端 API Keys */}
        <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2"><Key className="size-4 text-primary" /><span className="text-[14px] font-semibold text-foreground">客户端 API Keys</span></div>
            <Button variant="outline" className="h-8 rounded-lg text-[12px]" onClick={() => void addKey()}><Plus className="size-3.5" />生成</Button>
          </div>
          {config.client_keys.length === 0 ? (
            <div className="flex h-20 items-center justify-center rounded-lg border border-dashed border-border text-[12px] text-muted-foreground">还没有 Key，点右上角"生成"</div>
          ) : (
            <div className="space-y-2">
              {config.client_keys.map((k, i) => (
                <div key={k.key} className="flex items-center gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2.5">
                  <span className="text-[12px] text-muted-foreground font-data w-6">{i + 1}</span>
                  <span className="flex-1 truncate font-data text-[12px] text-foreground">{k.key}</span>
                  <button type="button" className={cn("rounded px-2 py-0.5 text-[11px] font-semibold cursor-pointer transition", k.enabled ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700")} onClick={() => void toggleKey(k.key)}>{k.enabled ? "启用" : "禁用"}</button>
                  <button type="button" className="cursor-pointer rounded p-1 text-muted-foreground hover:text-foreground" onClick={() => { void navigator.clipboard.writeText(k.key); toast.success("已复制"); }}><Copy className="size-3.5" /></button>
                  <button type="button" className="cursor-pointer rounded p-1 text-muted-foreground hover:text-rose-500" onClick={() => void removeKey(k.key)}><Trash2 className="size-3.5" /></button>
                </div>
              ))}
              <p className="text-[11px] text-muted-foreground mt-2">客户端可使用任意已启用的 Key 进行认证，禁用的 Key 不会被使用</p>
            </div>
          )}
        </section>

        {/* 网关配置 */}
        <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4"><Shield className="size-4 text-primary" /><span className="text-[14px] font-semibold text-foreground">网关配置</span></div>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="font-data text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">账号来源</label>
              <Select value={config.account_source} onValueChange={v => void saveConfig({ account_source: v })}>
                <SelectTrigger className="h-10 rounded-lg border-border bg-background"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pool">账号管理池（推荐）</SelectItem>
                  <SelectItem value="custom">自定义</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">使用所有可用账号，最大化资源利用</p>
            </div>
            <div className="space-y-1.5">
              <label className="font-data text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">路由策略</label>
              <Select value={config.route_strategy} onValueChange={v => void saveConfig({ route_strategy: v })}>
                <SelectTrigger className="h-10 rounded-lg border-border bg-background"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="round_robin">轮询 (Round Robin)</SelectItem>
                  <SelectItem value="least_connections">最少连接</SelectItem>
                  <SelectItem value="random">随机</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">优先使用活跃连接最少的账号</p>
            </div>
            <div className="space-y-1.5">
              <label className="font-data text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">切换阈值 (%)</label>
              <Input type="number" value={config.switch_threshold} onChange={e => void saveConfig({ switch_threshold: Number(e.target.value) || 90 })} className="h-10 rounded-lg border-border bg-background font-data tabular-nums" />
              <p className="text-[11px] text-muted-foreground">账号使用率达到该值时切换</p>
            </div>
            <div className="space-y-1.5">
              <label className="font-data text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">日志级别</label>
              <Select value={config.log_level} onValueChange={v => void saveConfig({ log_level: v })}>
                <SelectTrigger className="h-10 rounded-lg border-border bg-background"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="debug">debug</SelectItem>
                  <SelectItem value="info">info</SelectItem>
                  <SelectItem value="warning">warning</SelectItem>
                  <SelectItem value="error">error</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="font-data text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">IP 白名单（允许远程访问）</label>
              <Input value={(config.ip_whitelist || []).join(", ")} onChange={e => void saveConfig({ ip_whitelist: e.target.value.split(/[,\n]/).map(s => s.trim()).filter(Boolean) })} placeholder="192.168.1.0/24, 172.17.0.0/16" className="h-10 rounded-lg border-border bg-background font-data text-[12px]" />
              <p className="text-[11px] text-muted-foreground">允许局域网其他设备访问，支持单个 IP 或 CIDR，每行或逗号分隔</p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export default function GatewayPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);
  if (isCheckingAuth || !session || session.role !== "admin") return <div className="flex min-h-[40vh] items-center justify-center"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></div>;
  return <GatewayContent />;
}
