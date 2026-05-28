"use client";

import { useState } from "react";

import {
  AlertTriangle,
  Globe,
  LoaderCircle,
  Mail,
  Plus,
  Save,
  Send,
  Settings2,
  Trash2,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { testProxyPool } from "@/lib/api";

import { useSettingsStore } from "../../settings/store";

export function RegisterSettingsCard() {
  const [proxyTestResult, setProxyTestResult] = useState<string | null>(null);
  const [isTestingProxy, setIsTestingProxy] = useState(false);

  const config = useSettingsStore((state) => state.registerConfig);
  const isLoading = useSettingsStore((state) => state.isLoadingRegister);
  const isSaving = useSettingsStore((state) => state.isSavingRegister);
  const setProxy = useSettingsStore((state) => state.setRegisterProxy);
  const setProxyPool = useSettingsStore((state) => state.setRegisterProxyPool);
  const setTotal = useSettingsStore((state) => state.setRegisterTotal);
  const setThreads = useSettingsStore((state) => state.setRegisterThreads);
  const setMode = useSettingsStore((state) => state.setRegisterMode);
  const setTargetQuota = useSettingsStore((state) => state.setRegisterTargetQuota);
  const setTargetAvailable = useSettingsStore((state) => state.setRegisterTargetAvailable);
  const setCheckInterval = useSettingsStore((state) => state.setRegisterCheckInterval);
  const setCpaExport = useSettingsStore((state) => state.setRegisterCpaExport);
  const setSmsCodes = useSettingsStore((state) => state.setRegisterSmsCodes);
  const setSmsBaseUrl = useSettingsStore((state) => state.setRegisterSmsBaseUrl);
  const setMailField = useSettingsStore((state) => state.setRegisterMailField);
  const addProvider = useSettingsStore((state) => state.addRegisterProvider);
  const updateProvider = useSettingsStore((state) => state.updateRegisterProvider);
  const deleteProvider = useSettingsStore((state) => state.deleteRegisterProvider);
  const save = useSettingsStore((state) => state.saveRegister);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-border bg-card p-10">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!config) return null;

  const providers = config.mail.providers || [];

  const updateProviderType = (index: number, type: string) => {
    updateProvider(index, {
      type,
      enable: true,
      ...(type === "cloudflare_temp_email" ? { api_base: "", admin_password: "", domain: [] } : {}),
      ...(type === "tempmail_lol" ? { api_key: "", domain: [] } : {}),
      ...(type === "moemail" ? { api_base: "", api_key: "", domain: [] } : {}),
      ...(type === "inbucket" ? { api_base: "", domain: [], random_subdomain: true } : {}),
      ...(type === "duckmail" ? { api_key: "", default_domain: "duckmail.sbs" } : {}),
      ...(type === "gptmail" ? { api_key: "", default_domain: "" } : {}),
      ...(type === "yyds_mail" ? { api_base: "https://maliapi.215.im/v1", api_key: "", domain: [], subdomain: "", wildcard: false } : {}),
    });
  };

  const labelClass = "font-data text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase";
  const inputClass = "h-10 rounded-lg border-border bg-background font-data text-[13px]";

  return (
    <div className="space-y-4">
      {!config.enabled ? null : (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12.5px] text-amber-800">
          <AlertTriangle className="size-4 shrink-0" />
          <span>注册任务运行中，配置已锁定。停止任务后即可编辑。</span>
        </div>
      )}

      {/* 三块卡片栅格：基础参数 / 邮箱配置 / 推送 & 接码 */}
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {/* === 基础参数 === */}
        <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-lg bg-violet-50 text-violet-600">
              <Settings2 className="size-4" />
            </span>
            <div>
              <div className="text-[14px] font-semibold text-foreground">基础参数</div>
              <div className="text-[11px] text-muted-foreground">注册数量、并发、代理等</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <label className={labelClass}>注册模式</label>
              <Select
                value={config.mode || "total"}
                onValueChange={(value) => setMode(value as "total" | "quota" | "available")}
                disabled={config.enabled}
              >
                <SelectTrigger className={inputClass}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="total">注册总数</SelectItem>
                  <SelectItem value="quota">号池剩余额度</SelectItem>
                  <SelectItem value="available">可用账号数量</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className={labelClass}>注册总数</label>
              <Input
                value={String(config.total)}
                onChange={(event) => setTotal(event.target.value)}
                className={cn(inputClass, "tabular-nums")}
                disabled={config.enabled || config.mode !== "total"}
              />
            </div>
            <div className="space-y-1.5">
              <label className={labelClass}>线程数</label>
              <Input
                value={String(config.threads)}
                onChange={(event) => setThreads(event.target.value)}
                className={cn(inputClass, "tabular-nums")}
                disabled={config.enabled}
              />
            </div>
            <div className="space-y-1.5">
              <label className={labelClass}>目标剩余额度</label>
              <Input
                value={String(config.target_quota || "")}
                onChange={(event) => setTargetQuota(event.target.value)}
                className={cn(inputClass, "tabular-nums")}
                disabled={config.enabled || config.mode !== "quota"}
              />
            </div>
            <div className="space-y-1.5">
              <label className={labelClass}>目标可用账号</label>
              <Input
                value={String(config.target_available || "")}
                onChange={(event) => setTargetAvailable(event.target.value)}
                className={cn(inputClass, "tabular-nums")}
                disabled={config.enabled || config.mode !== "available"}
              />
            </div>
            <div className="space-y-1.5">
              <label className={labelClass}>检查间隔（秒）</label>
              <Input
                value={String(config.check_interval || "")}
                onChange={(event) => setCheckInterval(event.target.value)}
                className={cn(inputClass, "tabular-nums")}
                disabled={config.enabled || config.mode === "total"}
              />
            </div>
            <div className="space-y-1.5">
              <label className={labelClass}>请求超时</label>
              <Input
                value={String(config.mail.request_timeout || "")}
                onChange={(event) => setMailField("request_timeout", event.target.value)}
                className={cn(inputClass, "tabular-nums")}
                disabled={config.enabled}
              />
            </div>
            <div className="col-span-2 space-y-1.5">
              <label className={labelClass}>注册代理</label>
              <Input
                value={config.proxy}
                onChange={(event) => setProxy(event.target.value)}
                placeholder="http://127.0.0.1:7890"
                className={inputClass}
                disabled={config.enabled}
              />
            </div>
            <div className="space-y-1.5">
              <label className={labelClass}>等待验证码超时</label>
              <Input
                value={String(config.mail.wait_timeout || "")}
                onChange={(event) => setMailField("wait_timeout", event.target.value)}
                className={cn(inputClass, "tabular-nums")}
                disabled={config.enabled}
              />
            </div>
            <div className="space-y-1.5">
              <label className={labelClass}>轮询间隔</label>
              <Input
                value={String(config.mail.wait_interval || "")}
                onChange={(event) => setMailField("wait_interval", event.target.value)}
                className={cn(inputClass, "tabular-nums")}
                disabled={config.enabled}
              />
            </div>
          </div>
        </section>

        {/* === CPA 导出 + SMS 接码 === */}
        <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-lg bg-violet-50 text-violet-600">
              <Send className="size-4" />
            </span>
            <div>
              <div className="text-[14px] font-semibold text-foreground">推送 &amp; 接码</div>
              <div className="text-[11px] text-muted-foreground">CPA 自动推送、手机验证接码</div>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <div className="mb-2 text-[12px] font-semibold text-foreground">CPA 导出</div>
              <p className="mb-2.5 text-[11px] text-muted-foreground">
                注册成功后自动推送到 CPA 服务器（留空不推送）
              </p>
              <div className="space-y-2.5">
                <div className="space-y-1.5">
                  <label className={labelClass}>Base URL</label>
                  <Input
                    value={String(config.cpa_export?.base_url || "")}
                    onChange={(event) => setCpaExport("base_url", event.target.value)}
                    placeholder="http://localhost:8317"
                    className={inputClass}
                    disabled={config.enabled}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className={labelClass}>Secret Key</label>
                  <Input
                    value={String(config.cpa_export?.secret_key || "")}
                    onChange={(event) => setCpaExport("secret_key", event.target.value)}
                    placeholder="management secret"
                    className={inputClass}
                    disabled={config.enabled}
                  />
                </div>
              </div>
            </div>

            <div className="border-t border-border pt-4">
              <div className="mb-2 text-[12px] font-semibold text-foreground">SMS 接码</div>
              <p className="mb-2.5 text-[11px] text-muted-foreground">
                需要手机验证时自动接码。兼容 SMSPro 风格的 API（GET /activate/{`{code}`}、/status/{`{code}`} 等）。
              </p>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className={labelClass}>API Base URL</label>
                  <Input
                    value={config.sms?.base_url || ""}
                    onChange={(event) => setSmsBaseUrl(event.target.value)}
                    placeholder="https://your-sms-provider.example.com/api/v1"
                    className={inputClass}
                    disabled={config.enabled}
                  />
                  <p className="text-[11px] text-muted-foreground">留空表示不启用接码。也可通过环境变量 SMS_PROVIDER_BASE_URL 配置。</p>
                </div>
                <div className="space-y-1.5">
                  <label className={labelClass}>兑换码列表</label>
                  <Textarea
                    value={(config.sms?.codes || []).join("\n")}
                    onChange={(event) => setSmsCodes(event.target.value)}
                    placeholder="32位hex 兑换码，每行一个"
                    className="min-h-[120px] rounded-lg border-border bg-background font-data text-[12px]"
                    disabled={config.enabled}
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* === IP 代理池 === */}
        <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-lg bg-emerald-50 text-emerald-600">
              <Globe className="size-4" />
            </span>
            <div>
              <div className="text-[14px] font-semibold text-foreground">IP 代理池</div>
              <div className="text-[11px] text-muted-foreground">隧道代理配置，每个任务自动分配不同 IP</div>
            </div>
          </div>

          <div className="space-y-3">
            <label className="flex items-center gap-2 text-[13px] text-foreground">
              <Checkbox
                checked={Boolean(config.proxy_pool?.enabled)}
                onCheckedChange={(checked) => setProxyPool("enabled", Boolean(checked))}
                disabled={config.enabled}
              />
              <span>启用 IP 代理池</span>
            </label>
            <p className="text-[11px] text-muted-foreground">
              启用后将忽略上方的"注册代理"字段，每个注册任务自动获取独立 IP
            </p>

            <div className="space-y-1.5">
              <label className={labelClass}>代理模式</label>
              <Select
                value={config.proxy_pool?.mode || "userpass"}
                onValueChange={(value) => setProxyPool("mode", value)}
                disabled={config.enabled || !config.proxy_pool?.enabled}
              >
                <SelectTrigger className={inputClass}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="userpass">用户名/密码（Session 轮换）</SelectItem>
                  <SelectItem value="api">API URL（提取 IP 列表）</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* === 用户名/密码模式 === */}
            {(config.proxy_pool?.mode || "userpass") === "userpass" && (
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2 space-y-1.5">
                  <label className={labelClass}>代理主机</label>
                  <Input
                    value={String(config.proxy_pool?.host || "")}
                    onChange={(event) => setProxyPool("host", event.target.value)}
                    placeholder="proxy.711proxy.com"
                    className={inputClass}
                    disabled={config.enabled || !config.proxy_pool?.enabled}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className={labelClass}>端口</label>
                  <Input
                    value={String(config.proxy_pool?.port || "")}
                    onChange={(event) => setProxyPool("port", event.target.value)}
                    placeholder="1000"
                    className={cn(inputClass, "tabular-nums")}
                    disabled={config.enabled || !config.proxy_pool?.enabled}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className={labelClass}>协议</label>
                  <Select
                    value={config.proxy_pool?.protocol || "http"}
                    onValueChange={(value) => setProxyPool("protocol", value)}
                    disabled={config.enabled || !config.proxy_pool?.enabled}
                  >
                    <SelectTrigger className={inputClass}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="http">HTTP</SelectItem>
                      <SelectItem value="socks5">SOCKS5</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label className={labelClass}>用户名</label>
                  <Input
                    value={String(config.proxy_pool?.username || "")}
                    onChange={(event) => setProxyPool("username", event.target.value)}
                    placeholder="子用户名"
                    className={inputClass}
                    disabled={config.enabled || !config.proxy_pool?.enabled}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className={labelClass}>密码</label>
                  <Input
                    value={String(config.proxy_pool?.password || "")}
                    onChange={(event) => setProxyPool("password", event.target.value)}
                    placeholder="密码"
                    type="password"
                    className={inputClass}
                    disabled={config.enabled || !config.proxy_pool?.enabled}
                  />
                </div>
                <div className="col-span-2 space-y-1.5">
                  <label className={labelClass}>附加参数</label>
                  <Input
                    value={String(config.proxy_pool?.extra_params || "")}
                    onChange={(event) => setProxyPool("extra_params", event.target.value)}
                    placeholder="-zone-custom-region-US（可选，附加到用户名后）"
                    className={inputClass}
                    disabled={config.enabled || !config.proxy_pool?.enabled}
                  />
                </div>
                <div className="col-span-2 space-y-1.5">
                  <label className={labelClass}>Session 前缀</label>
                  <Input
                    value={String(config.proxy_pool?.session_prefix || "session-")}
                    onChange={(event) => setProxyPool("session_prefix", event.target.value)}
                    placeholder="session-"
                    className={inputClass}
                    disabled={config.enabled || !config.proxy_pool?.enabled}
                  />
                </div>
              </div>
            )}

            {/* === API URL 模式 === */}
            {config.proxy_pool?.mode === "api" && (
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2 space-y-1.5">
                  <label className={labelClass}>API 提取 URL</label>
                  <Input
                    value={String(config.proxy_pool?.api_url || "")}
                    onChange={(event) => setProxyPool("api_url", event.target.value)}
                    placeholder="https://api.711proxy.com/get?..."
                    className={inputClass}
                    disabled={config.enabled || !config.proxy_pool?.enabled}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    从 711Proxy 后台「API」标签页点「生成URL」获取
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label className={labelClass}>连接协议</label>
                  <Select
                    value={config.proxy_pool?.api_protocol || "http"}
                    onValueChange={(value) => setProxyPool("api_protocol", value)}
                    disabled={config.enabled || !config.proxy_pool?.enabled}
                  >
                    <SelectTrigger className={inputClass}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="http">HTTP</SelectItem>
                      <SelectItem value="socks5">SOCKS5</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label className={labelClass}>刷新间隔（秒）</label>
                  <Input
                    value={String(config.proxy_pool?.api_refresh_seconds || 300)}
                    onChange={(event) => setProxyPool("api_refresh_seconds", Number(event.target.value) || 300)}
                    placeholder="300"
                    className={cn(inputClass, "tabular-nums")}
                    disabled={config.enabled || !config.proxy_pool?.enabled}
                  />
                </div>
              </div>
            )}

            <div className="rounded-lg border border-dashed border-border bg-secondary/30 p-3">
              <div className="text-[11px] text-muted-foreground">
                <span className="font-semibold text-foreground">模式说明：</span>
                <br />
                {(config.proxy_pool?.mode || "userpass") === "userpass" ? (
                  <span>用户名/密码模式：通过 session ID 自动轮换 IP，适合隧道代理（推荐）</span>
                ) : (
                  <span>API URL 模式：定期调接口提取 IP 列表轮询使用，适合白名单认证</span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-8 cursor-pointer rounded-lg border-border bg-background px-3 text-[12px]"
                onClick={async () => {
                  setIsTestingProxy(true);
                  setProxyTestResult(null);
                  try {
                    const data = await testProxyPool();
                    setProxyTestResult(data.message);
                  } catch (error) {
                    setProxyTestResult(error instanceof Error ? error.message : "测试失败");
                  } finally {
                    setIsTestingProxy(false);
                  }
                }}
                disabled={!config.proxy_pool?.enabled || isTestingProxy}
              >
                {isTestingProxy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
                测试代理
              </Button>
              {proxyTestResult && (
                <span className={cn("text-[11px]", proxyTestResult.includes("连通") || proxyTestResult.includes("出口") ? "text-emerald-600" : "text-rose-500")}>
                  {proxyTestResult}
                </span>
              )}
            </div>
          </div>
        </section>

        {/* === 邮箱 Providers === */}
        <section className="rounded-xl border border-border bg-card p-5 shadow-sm xl:col-span-1 lg:col-span-2">
          <div className="mb-4 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span className="grid size-8 place-items-center rounded-lg bg-violet-50 text-violet-600">
                <Mail className="size-4" />
              </span>
              <div>
                <div className="text-[14px] font-semibold text-foreground">邮箱 Providers</div>
                <div className="text-[11px] text-muted-foreground">{providers.length} 个 provider</div>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              className="h-8 cursor-pointer rounded-lg border-border bg-background px-2.5 text-[12px]"
              onClick={addProvider}
              disabled={config.enabled}
            >
              <Plus className="size-3.5" />
              添加
            </Button>
          </div>

          <div className="space-y-3 max-h-[600px] overflow-y-auto pr-1 scrollbar-fancy">
            {providers.length === 0 ? (
              <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-border text-[12px] text-muted-foreground">
                还没有邮箱 provider，点右上角"添加"
              </div>
            ) : null}
            {providers.map((provider, index) => {
              const type = String(provider.type || "tempmail_lol");
              const domains = Array.isArray(provider.domain) ? provider.domain.map(String).join("\n") : "";
              return (
                <div key={index} className="space-y-2.5 rounded-lg border border-border bg-secondary/30 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <label className="flex items-center gap-2 text-[13px] text-foreground">
                      <Checkbox
                        checked={Boolean(provider.enable)}
                        onCheckedChange={(checked) => updateProvider(index, { enable: Boolean(checked) })}
                        disabled={config.enabled}
                      />
                      <span>启用</span>
                    </label>
                    <button
                      type="button"
                      className="cursor-pointer rounded-md p-1.5 text-muted-foreground transition hover:bg-rose-50 hover:text-rose-500 disabled:opacity-50"
                      onClick={() => deleteProvider(index)}
                      disabled={config.enabled || providers.length <= 1}
                      title="删除"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>

                  <div className="space-y-1.5">
                    <label className={labelClass}>类型</label>
                    <Select
                      value={type}
                      onValueChange={(value) => updateProviderType(index, value)}
                      disabled={config.enabled}
                    >
                      <SelectTrigger className={inputClass}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cloudflare_temp_email">cloudflare_temp_email</SelectItem>
                        <SelectItem value="tempmail_lol">tempmail_lol</SelectItem>
                        <SelectItem value="moemail">moemail</SelectItem>
                        <SelectItem value="inbucket">inbucket_mail</SelectItem>
                        <SelectItem value="duckmail">duckmail</SelectItem>
                        <SelectItem value="gptmail">gptmail(未测试)</SelectItem>
                        <SelectItem value="yyds_mail">yyds_mail</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {(type === "cloudflare_temp_email" ||
                    type === "moemail" ||
                    type === "inbucket" ||
                    type === "yyds_mail") && (
                    <div className="space-y-1.5">
                      <label className={labelClass}>API Base</label>
                      <Input
                        value={String(provider.api_base || "")}
                        onChange={(event) => updateProvider(index, { api_base: event.target.value })}
                        className={inputClass}
                        disabled={config.enabled}
                      />
                    </div>
                  )}
                  {type === "cloudflare_temp_email" && (
                    <div className="space-y-1.5">
                      <label className={labelClass}>Admin Password</label>
                      <Input
                        value={String(provider.admin_password || "")}
                        onChange={(event) =>
                          updateProvider(index, { admin_password: event.target.value })
                        }
                        className={inputClass}
                        disabled={config.enabled}
                      />
                    </div>
                  )}
                  {type === "cloudflare_temp_email" && (
                    <label className="flex items-center gap-2 text-[13px] text-foreground">
                      <Checkbox
                        checked={Boolean(provider.random_subdomain)}
                        onCheckedChange={(checked) =>
                          updateProvider(index, { random_subdomain: Boolean(checked) })
                        }
                        disabled={config.enabled}
                      />
                      <span>启用随机用户名（edu.随机.xyz@域名）</span>
                    </label>
                  )}
                  {type === "inbucket" && (
                    <label className="flex items-center gap-2 text-[13px] text-foreground">
                      <Checkbox
                        checked={Boolean(provider.random_subdomain ?? true)}
                        onCheckedChange={(checked) =>
                          updateProvider(index, { random_subdomain: Boolean(checked) })
                        }
                        disabled={config.enabled}
                      />
                      <span>启用随机子域名</span>
                    </label>
                  )}
                  {(type === "tempmail_lol" ||
                    type === "moemail" ||
                    type === "duckmail" ||
                    type === "gptmail" ||
                    type === "yyds_mail") && (
                    <div className="space-y-1.5">
                      <label className={labelClass}>API Key</label>
                      <Input
                        value={String(provider.api_key || "")}
                        onChange={(event) => updateProvider(index, { api_key: event.target.value })}
                        className={inputClass}
                        disabled={config.enabled}
                      />
                    </div>
                  )}
                  {(type === "duckmail" || type === "gptmail") && (
                    <div className="space-y-1.5">
                      <label className={labelClass}>Default Domain</label>
                      <Input
                        value={String(provider.default_domain || "")}
                        onChange={(event) =>
                          updateProvider(index, { default_domain: event.target.value })
                        }
                        placeholder={type === "duckmail" ? "duckmail.sbs" : ""}
                        className={inputClass}
                        disabled={config.enabled}
                      />
                    </div>
                  )}
                  {type === "yyds_mail" && (
                    <>
                      <div className="space-y-1.5">
                        <label className={labelClass}>Subdomain</label>
                        <Input
                          value={String(provider.subdomain || "")}
                          onChange={(event) => updateProvider(index, { subdomain: event.target.value })}
                          className={inputClass}
                          disabled={config.enabled}
                        />
                      </div>
                      <label className="flex items-center gap-2 text-[13px] text-foreground">
                        <Checkbox
                          checked={Boolean(provider.wildcard)}
                          onCheckedChange={(checked) =>
                            updateProvider(index, { wildcard: Boolean(checked) })
                          }
                          disabled={config.enabled}
                        />
                        <span>Wildcard</span>
                      </label>
                    </>
                  )}

                  {(type === "tempmail_lol" ||
                    type === "cloudflare_temp_email" ||
                    type === "moemail" ||
                    type === "inbucket" ||
                    type === "yyds_mail") && (
                    <div className="space-y-1.5">
                      <label className={labelClass}>
                        {type === "inbucket" ? "基础域名列表" : "Domain"}
                      </label>
                      <Textarea
                        value={domains}
                        onChange={(event) =>
                          updateProvider(index, {
                            domain: event.target.value
                              .split(/[\n,]/)
                              .map((item) => item.trim())
                              .filter(Boolean),
                          })
                        }
                        placeholder={
                          type === "inbucket"
                            ? "每行一个基础域名"
                            : type === "moemail"
                              ? "每行一个域名"
                              : "每行一个域名"
                        }
                        className="min-h-[80px] rounded-lg border-border bg-background font-data text-[12px]"
                        disabled={config.enabled}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {/* 底部保存条 */}
      <div className="sticky bottom-2 flex items-center justify-end gap-2 rounded-xl border border-border bg-card/95 p-3 shadow-md backdrop-blur">
        <span className="mr-auto text-[12px] text-muted-foreground">
          修改后请点保存。运行中无法编辑配置。
        </span>
        <Button
          className="h-10 cursor-pointer rounded-lg bg-violet-500 px-5 text-[13px] font-medium text-white shadow-sm shadow-violet-500/30 hover:bg-violet-600"
          onClick={() => void save()}
          disabled={isSaving || config.enabled}
        >
          {isSaving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
          保存配置
        </Button>
      </div>
    </div>
  );
}
