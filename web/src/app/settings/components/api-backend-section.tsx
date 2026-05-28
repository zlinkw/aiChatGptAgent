"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";
import { toast } from "sonner";

import { httpRequest } from "@/lib/request";

type APIConfig = {
  enabled: boolean;
  base_url: string;
  api_key_masked: string;
  default_model: string;
};

type Model = {
  id: string;
  name: string;
};

export function APIBackendSection() {
  const [config, setConfig] = useState<APIConfig | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"success" | "fail" | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);

  const loadConfig = useCallback(async () => {
    try {
      const data = await httpRequest<{ enabled: boolean; base_url: string; api_key_masked: string; default_model: string }>("/api-backend");
      setConfig(data);
      setBaseUrl(data.base_url);
      setDefaultModel(data.default_model);
    } catch {}
  }, []);

  useEffect(() => { void loadConfig(); }, [loadConfig]);

  const handleSave = async () => {
    if (!baseUrl.trim() || !apiKey.trim()) {
      toast.error("请填写 Base URL 和 API Key");
      return;
    }
    setSaving(true);
    try {
      await httpRequest("/api-backend", {
        method: "PUT",
        body: { base_url: baseUrl, api_key: apiKey, default_model: defaultModel },
      });
      toast.success("中转 API 配置已保存");
      await loadConfig();
      setApiKey("");
    } catch (err: any) {
      toast.error(err?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await httpRequest<{ ok: boolean }>("/api-backend/test", {
        method: "POST",
        body: { model: defaultModel },
      });
      setTestResult("success");
      toast.success("连接成功");
    } catch (err: any) {
      setTestResult("fail");
      toast.error(err?.message || "连接失败");
    } finally {
      setTesting(false);
    }
  };

  const handleLoadModels = async () => {
    setLoadingModels(true);
    try {
      const data = await httpRequest<{ models: Model[] }>("/api-backend/models");
      setModels(data.models);
      toast.success(`发现 ${data.models.length} 个模型`);
    } catch (err: any) {
      toast.error(err?.message || "获取模型失败");
    } finally {
      setLoadingModels(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* 状态指示 */}
      <div className="flex items-center gap-2">
        <div className={`size-2 rounded-full ${config?.enabled ? "bg-emerald-500" : "bg-gray-300"}`} />
        <span className="text-[13px] text-gray-600">
          {config?.enabled ? "已启用" : "未配置"}
          {config?.enabled && config.base_url && <span className="text-gray-400 ml-2">({config.base_url})</span>}
        </span>
      </div>

      {/* 配置表单 */}
      <div className="space-y-3">
        <div>
          <label className="text-[12px] font-medium text-gray-600 mb-1 block">Base URL</label>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com 或中转地址"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-[13px] outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
          />
        </div>
        <div>
          <label className="text-[12px] font-medium text-gray-600 mb-1 block">API Key</label>
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={config?.api_key_masked || "sk-..."}
            type="password"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-[13px] outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
          />
          {config?.api_key_masked && !apiKey && (
            <p className="text-[11px] text-gray-400 mt-1">当前: {config.api_key_masked}（留空则不修改）</p>
          )}
        </div>
        <div>
          <label className="text-[12px] font-medium text-gray-600 mb-1 block">默认模型</label>
          <input
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
            placeholder="gpt-4o"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-[13px] outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
          />
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-lg bg-violet-600 px-4 py-2 text-[12px] font-medium text-white hover:bg-violet-700 disabled:opacity-50 flex items-center gap-1.5"
        >
          {saving && <Loader2 className="size-3 animate-spin" />}
          保存配置
        </button>
        <button
          onClick={handleTest}
          disabled={testing || !config?.enabled}
          className="rounded-lg border border-gray-200 px-4 py-2 text-[12px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1.5"
        >
          {testing ? <Loader2 className="size-3 animate-spin" /> : testResult === "success" ? <CheckCircle2 className="size-3 text-emerald-500" /> : testResult === "fail" ? <XCircle className="size-3 text-red-500" /> : null}
          测试连接
        </button>
        <button
          onClick={handleLoadModels}
          disabled={loadingModels || !config?.enabled}
          className="rounded-lg border border-gray-200 px-4 py-2 text-[12px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1.5"
        >
          {loadingModels ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          获取模型
        </button>
      </div>

      {/* 模型列表 */}
      {models.length > 0 && (
        <div className="rounded-lg border border-gray-200 p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[12px] font-medium text-gray-600">可用模型 ({models.length})</div>
            <button
              onClick={() => setDefaultModel(models[0]?.id || "")}
              className="text-[11px] text-violet-600 hover:text-violet-700"
            >
              选第一个
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5 max-h-[200px] overflow-y-auto">
            {models.map((m) => (
              <button
                key={m.id}
                onClick={() => setDefaultModel(m.id)}
                className={`rounded-md px-2.5 py-1 text-[11px] border transition ${
                  defaultModel === m.id
                    ? "bg-violet-50 border-violet-300 text-violet-700"
                    : "bg-gray-50 border-gray-200 text-gray-600 hover:border-gray-300"
                }`}
              >
                {m.id}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-gray-400 mt-2">点击模型设为默认。所有功能（聊天、画图、设计工具）都会使用中转 API 的模型。</p>
        </div>
      )}
    </div>
  );
}
