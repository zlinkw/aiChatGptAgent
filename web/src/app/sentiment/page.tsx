"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle, Globe, Loader2, Search, Shield, ShieldAlert,
  ShieldCheck, TrendingDown, ExternalLink, Zap, Microscope, BarChart3, Bot,
  History, X, Clock,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { httpRequest } from "@/lib/request";
import { cn } from "@/lib/utils";
import { getStoredAuthKey } from "@/store/auth";
import webConfig from "@/constants/common-env";

type SearchScope = "domestic" | "overseas" | "global";
type SearchDepth = "quick" | "deep";

interface SentimentResult {
  title: string; url: string; snippet: string; source: string;
  sentiment: "positive" | "neutral" | "negative";
  sentiment_score: number; category: string; has_content: boolean;
}
interface SentimentStats {
  total: number; negative: number; positive: number; neutral: number;
  risk_level: "low" | "medium" | "high" | "unknown"; negative_ratio: number;
}
interface KeyFinding { title: string; source: string; category: string; severity: number; }
interface CategoryStat { total: number; negative: number; positive: number; neutral: number; }
interface SentimentResponse {
  company: string; scope: SearchScope; results: SentimentResult[];
  stats: SentimentStats; source_stats: Record<string, number>;
  category_stats: Record<string, CategoryStat>; key_findings: KeyFinding[];
}

const MODELS = [
  { value: "", label: "不使用 AI 分析" },
  { value: "gpt-4o", label: "GPT-4o" },
  { value: "gpt-4o-mini", label: "GPT-4o Mini" },
  { value: "o3-mini", label: "o3-mini" },
  { value: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
  { value: "deepseek-chat", label: "DeepSeek" },
];

const scopeOptions = [
  { value: "domestic" as SearchScope, label: "国内", icon: "🇨🇳", desc: "百度、小红书、微博、知乎、天眼查" },
  { value: "overseas" as SearchScope, label: "国外", icon: "🌍", desc: "DuckDuckGo、Reddit、Twitter、Bloomberg" },
  { value: "global" as SearchScope, label: "全球", icon: "🌐", desc: "全部来源综合搜索" },
];
const depthOptions = [
  { value: "quick" as SearchDepth, label: "快速", Icon: Zap, desc: "秒级响应" },
  { value: "deep" as SearchDepth, label: "深度", Icon: Microscope, desc: "多引擎+正文分析" },
];
const timeOptions = [
  { value: "", label: "不限" },
  { value: "qdr:d", label: "24小时" },
  { value: "qdr:w", label: "一周" },
  { value: "qdr:m", label: "一个月" },
  { value: "qdr:y", label: "一年" },
];
const riskCfg = {
  low: { color: "text-green-600", bg: "bg-green-50", border: "border-green-200", Icon: ShieldCheck, label: "低风险" },
  medium: { color: "text-yellow-600", bg: "bg-yellow-50", border: "border-yellow-200", Icon: Shield, label: "中风险" },
  high: { color: "text-red-600", bg: "bg-red-50", border: "border-red-200", Icon: ShieldAlert, label: "高风险" },
  unknown: { color: "text-gray-500", bg: "bg-gray-50", border: "border-gray-200", Icon: Shield, label: "未知" },
};
const sentColors = { negative: "bg-red-100 text-red-700 border-red-200", neutral: "bg-gray-100 text-gray-700 border-gray-200", positive: "bg-green-100 text-green-700 border-green-200" };
const sentLabels = { negative: "负面", neutral: "中性", positive: "正面" };

interface HistoryItem {
  company: string;
  scope: SearchScope;
  depth: SearchDepth;
  time: number;
  total: number;
  negative: number;
  risk_level: string;
  response: SentimentResponse;
}

const HISTORY_KEY = "sentiment_search_history";
const MAX_HISTORY = 10;

function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveHistory(items: HistoryItem[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, MAX_HISTORY)));
  } catch {
    // localStorage 满了，删掉最旧的再试
    items.pop();
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(items)); } catch {}
  }
}

function addHistory(item: HistoryItem) {
  const list = loadHistory().filter(h => h.company !== item.company);
  list.unshift(item);
  saveHistory(list);
}

function SentimentContent() {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>("global");
  const [depth, setDepth] = useState<SearchDepth>("quick");
  const [timeRange, setTimeRange] = useState("");
  const [model, setModel] = useState("none");
  const [models, setModels] = useState<{ value: string; label: string }[]>([{ value: "none", label: "不使用 AI 分析" }]);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<SentimentResponse | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [streamResults, setStreamResults] = useState<SentimentResult[]>([]);
  const [streamProgress, setStreamProgress] = useState("");
  const [streamCount, setStreamCount] = useState(0);
  const [aiSummary, setAiSummary] = useState("");
  const [summarizing, setSummarizing] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const searchRef = useRef<string>("");

  // 加载历史记录
  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  // 加载可用模型列表
  useEffect(() => {
    httpRequest<{ data: { id: string }[] }>("/v1/models").then((res) => {
      const list: { value: string; label: string }[] = [{ value: "none", label: "不使用 AI 分析" }];
      if (res?.data) {
        for (const m of res.data) {
          list.push({ value: m.id, label: m.id });
        }
      }
      setModels(list);
    }).catch(() => {});
  }, []);

  const handleSearch = useCallback(async () => {
    const q = (searchRef.current || query).trim();
    searchRef.current = "";
    if (!q) { toast.error("请输入公司名称"); inputRef.current?.focus(); return; }

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setData(null);
    setActiveCategory(null);
    setStreamResults([]);
    setStreamProgress("正在搜索...");
    setStreamCount(0);
    setAiSummary("");

    try {
      const authKey = await getStoredAuthKey();
      const baseUrl = webConfig.apiUrl.replace(/\/$/, "");
      const params = new URLSearchParams({ company: q, scope, depth, model: model === "none" ? "" : model, time_range: timeRange });
      const url = `${baseUrl}/api/sentiment/search/stream?${params}`;

      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${authKey}` },
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new Error(`搜索失败 (${resp.status})`);
      }

      const reader = resp.body?.getReader();
      if (!reader) throw new Error("无法读取响应流");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;

          try {
            const event = JSON.parse(payload);
            if (event.type === "result") {
              setStreamResults((prev) => [...prev, event.item]);
              setStreamCount((prev) => prev + 1);
            } else if (event.type === "progress") {
              setStreamProgress(`正在搜索: ${event.dimension} (${event.dimension_index}/${event.dimension_total})`);
            } else if (event.type === "stats") {
              setData(event as unknown as SentimentResponse);
              // 保存到历史记录
              const resp = event as unknown as SentimentResponse;
              const stats = resp.stats;
              const item: HistoryItem = { company: q, scope, depth, time: Date.now(), total: stats.total, negative: stats.negative, risk_level: stats.risk_level, response: resp };
              addHistory(item);
              setHistory(loadHistory());
            } else if (event.type === "ai_summary") {
              setAiSummary(event.summary);
            }
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (e: unknown) {
      if ((e as Error).name !== "AbortError") {
        toast.error(e instanceof Error ? e.message : "搜索失败");
      }
    } finally {
      setLoading(false);
      setStreamProgress("");
    }
  }, [query, scope, depth, model, timeRange]);

  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === "Enter" && !loading) handleSearch(); };

  const handleSummarize = useCallback(async () => {
    if (!data || model === "none" || !model) return;
    setSummarizing(true);
    try {
      const res = await httpRequest<{ summary: string }>("/api/sentiment/summarize", {
        method: "POST",
        body: { company: query.trim(), model, results: data.results },
      });
      setAiSummary(res.summary);
      toast.success("AI 分析完成");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "AI 分析失败");
    } finally {
      setSummarizing(false);
    }
  }, [data, model, query]);

  // 使用最终数据或流式数据
  const displayResults = data?.results ?? streamResults;
  const filteredResults = displayResults.filter((r) => !activeCategory || r.category === activeCategory);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">舆情搜索</h1>
        <p className="mt-1 text-sm text-gray-500">深度搜索公司舆情：负面新闻、投诉曝光、法律诉讼、监管处罚、社交媒体口碑</p>
      </div>

      {/* 搜索区域 */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        {/* 范围 + 深度 */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-gray-500 mr-1">范围:</span>
          {scopeOptions.map((opt) => (
            <button key={opt.value} onClick={() => setScope(opt.value)} className={cn("flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-all", scope === opt.value ? "border-blue-300 bg-blue-50 text-blue-700 shadow-sm" : "border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50")}>
              <span>{opt.icon}</span><span>{opt.label}</span>
            </button>
          ))}
          <span className="mx-2 h-5 w-px bg-gray-200" />
          <span className="text-xs font-medium text-gray-500 mr-1">深度:</span>
          {depthOptions.map((opt) => (
            <button key={opt.value} onClick={() => setDepth(opt.value)} className={cn("flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-all", depth === opt.value ? "border-purple-300 bg-purple-50 text-purple-700 shadow-sm" : "border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50")}>
              <opt.Icon className="h-3.5 w-3.5" /><span>{opt.label}</span>
            </button>
          ))}
          <span className="mx-2 h-5 w-px bg-gray-200" />
          <span className="text-xs font-medium text-gray-500 mr-1">时间:</span>
          {timeOptions.map((opt) => (
            <button key={opt.value} onClick={() => setTimeRange(opt.value)} className={cn("rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-all", timeRange === opt.value ? "border-orange-300 bg-orange-50 text-orange-700 shadow-sm" : "border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50")}>
              {opt.label}
            </button>
          ))}
        </div>

        {/* 模型选择 */}
        <div className="mb-3 flex items-center gap-2">
          <span className="text-xs font-medium text-gray-500 mr-1">AI 分析:</span>
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger className="w-[200px] h-8 text-xs">
              <SelectValue placeholder="选择模型（可选）" />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.value} value={m.value} className="text-xs">{m.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {model && model !== "none" && <span className="text-[10px] text-purple-500">将使用 AI 对结果做总结分析</span>}
        </div>

        <p className="mb-3 text-xs text-gray-400">{scopeOptions.find((o) => o.value === scope)?.desc} · {depthOptions.find((o) => o.value === depth)?.desc}</p>

        {/* 搜索框 */}
        <div className="flex gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <Input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={handleKeyDown} placeholder="输入公司名称，如：大吉公社、恒大、瑞幸咖啡、FTX..." className="pl-9" disabled={loading} />
          </div>
          <Button onClick={handleSearch} disabled={loading || !query.trim()} className="min-w-[100px]">
            {loading ? (<><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />{depth === "deep" ? "深度搜索中" : "搜索中"}</>) : (<><Search className="mr-1.5 h-4 w-4" />{depth === "deep" ? "深度搜索" : "搜索"}</>)}
          </Button>
        </div>
      </div>

      {/* 实时搜索进度 */}
      {loading && (
        <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-4">
          <div className="flex items-center gap-3">
            <div className="relative">
              <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-blue-700">{streamProgress || "正在搜索..."}</span>
                <span className="text-lg font-bold text-blue-600 tabular-nums">{streamCount} <span className="text-xs font-normal">条结果</span></span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-blue-100">
                <div className="h-full animate-pulse rounded-full bg-blue-400 transition-all" style={{ width: `${Math.min(95, streamCount * 3)}%` }} />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 结果区域 */}
      {(data || streamResults.length > 0) && (
        <div className="space-y-4">
          {/* 统计卡片 — 只在最终数据到达后显示 */}
          {data && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className={cn("rounded-xl border p-4", riskCfg[data.stats.risk_level].bg, riskCfg[data.stats.risk_level].border)}>
                <div className="flex items-center gap-2">{(() => { const I = riskCfg[data.stats.risk_level].Icon; return <I className={cn("h-5 w-5", riskCfg[data.stats.risk_level].color)} />; })()}<span className={cn("text-sm font-medium", riskCfg[data.stats.risk_level].color)}>{riskCfg[data.stats.risk_level].label}</span></div>
                <p className="mt-1 text-xs text-gray-500">舆情风险等级</p>
              </div>
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="flex items-center gap-2"><Globe className="h-5 w-5 text-blue-500" /><span className="text-lg font-semibold text-gray-900">{data.stats.total}</span></div>
                <p className="mt-1 text-xs text-gray-500">相关结果</p>
              </div>
              <div className="rounded-xl border border-red-100 bg-red-50/50 p-4">
                <div className="flex items-center gap-2"><TrendingDown className="h-5 w-5 text-red-500" /><span className="text-lg font-semibold text-red-600">{data.stats.negative_ratio}%</span></div>
                <p className="mt-1 text-xs text-gray-500">负面占比</p>
              </div>
              <div className="rounded-xl border border-orange-100 bg-orange-50/50 p-4">
                <div className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-orange-500" /><span className="text-lg font-semibold text-orange-600">{data.stats.negative}</span></div>
                <p className="mt-1 text-xs text-gray-500">负面信息</p>
              </div>
            </div>
          )}

          {/* AI 总结 */}
          {aiSummary && (
            <div className="rounded-xl border border-purple-200 bg-purple-50/30 p-4">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-purple-700"><Bot className="h-4 w-4" />AI 舆情分析</h3>
              <p className="whitespace-pre-wrap text-sm text-gray-700 leading-relaxed">{aiSummary}</p>
            </div>
          )}

          {/* AI 总结按钮 — 搜索完成后可手动触发 */}
          {!aiSummary && data && data.stats.total > 0 && (
            <div className="flex items-center gap-3">
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger className="w-[180px] h-8 text-xs">
                  <SelectValue placeholder="选择模型" />
                </SelectTrigger>
                <SelectContent>
                  {models.filter(m => m.value !== "none").map((m) => (
                    <SelectItem key={m.value} value={m.value} className="text-xs">{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                disabled={model === "none" || !model || summarizing}
                onClick={handleSummarize}
                className="text-xs"
              >
                {summarizing ? <><Loader2 className="mr-1.5 h-3 w-3 animate-spin" />分析中...</> : <><Bot className="mr-1.5 h-3 w-3" />AI 总结分析</>}
              </Button>
            </div>
          )}

          {/* 关键发现 */}
          {data && data.key_findings.length > 0 && (
            <div className="rounded-xl border border-red-200 bg-red-50/30 p-4">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-red-700"><AlertTriangle className="h-4 w-4" />关键负面发现</h3>
              <div className="space-y-2">
                {data.key_findings.map((f, idx) => (
                  <div key={idx} className="flex items-start gap-2 text-xs">
                    <span className="mt-0.5 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-red-400" />
                    <span className="text-gray-700"><span className="font-medium text-red-600">[{f.category}]</span> {f.title}<span className="ml-1 text-gray-400">— {f.source}</span></span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 维度统计 */}
          {data && Object.keys(data.category_stats).length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-gray-700"><BarChart3 className="h-4 w-4" />搜索维度</h3>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => setActiveCategory(null)} className={cn("rounded-lg border px-2.5 py-1 text-xs font-medium transition-all", !activeCategory ? "border-blue-300 bg-blue-50 text-blue-700" : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50")}>全部 ({data.stats.total})</button>
                {Object.entries(data.category_stats).sort(([, a], [, b]) => b.negative - a.negative).map(([cat, stat]) => (
                  <button key={cat} onClick={() => setActiveCategory(activeCategory === cat ? null : cat)} className={cn("rounded-lg border px-2.5 py-1 text-xs font-medium transition-all", activeCategory === cat ? "border-blue-300 bg-blue-50 text-blue-700" : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50")}>
                    {cat} <span className="ml-1 text-[10px]">{stat.total}{stat.negative > 0 && <span className="text-red-500"> ({stat.negative}⚠)</span>}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 来源分布 */}
          {data && Object.keys(data.source_stats).length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <h3 className="mb-2 text-sm font-medium text-gray-700">来源分布</h3>
              <div className="flex flex-wrap gap-2">
                {Object.entries(data.source_stats).sort(([, a], [, b]) => b - a).map(([source, count]) => (
                  <span key={source} className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-600">{source}<span className="rounded-full bg-gray-200 px-1.5 text-[10px]">{count}</span></span>
                ))}
              </div>
            </div>
          )}

          {/* 结果列表 */}
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-gray-700">
              搜索结果 ({filteredResults.length})
              {activeCategory && <span className="ml-2 text-xs text-gray-400">筛选: {activeCategory}</span>}
              {loading && <span className="ml-2 inline-flex items-center text-xs text-blue-500"><Loader2 className="mr-1 h-3 w-3 animate-spin" />实时更新中</span>}
            </h3>
            {filteredResults.length === 0 && !loading ? (
              <div className="rounded-xl border border-gray-200 bg-white p-8 text-center"><p className="text-sm text-gray-500">未找到相关舆情信息</p></div>
            ) : (
              filteredResults.map((item, idx) => (
                <div key={`${item.url}-${idx}`} className={cn("group rounded-xl border border-gray-200 bg-white p-4 transition-all hover:shadow-md", loading && idx >= filteredResults.length - 3 && "animate-in fade-in slide-in-from-bottom-2 duration-300")}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="mb-1.5 flex flex-wrap items-center gap-2">
                        <span className={cn("inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium", sentColors[item.sentiment])}>{sentLabels[item.sentiment]}</span>
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">{item.category}</span>
                        <span className="text-xs text-gray-400">{item.source}</span>
                        {item.has_content && <span className="rounded bg-purple-50 px-1 py-0.5 text-[10px] text-purple-500">已分析正文</span>}
                      </div>
                      <a href={item.url} target="_blank" rel="noopener noreferrer" className="line-clamp-1 text-sm font-medium text-gray-900 group-hover:text-blue-600">{item.title}</a>
                      {item.snippet && <p className="mt-1 line-clamp-2 text-xs text-gray-500">{item.snippet}</p>}
                    </div>
                    <a href={item.url} target="_blank" rel="noopener noreferrer" className="flex-shrink-0 rounded-lg p-1.5 text-gray-400 opacity-0 transition-opacity hover:bg-gray-100 hover:text-gray-600 group-hover:opacity-100"><ExternalLink className="h-4 w-4" /></a>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* 历史记录 */}
      {!loading && history.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-medium text-gray-700"><History className="h-4 w-4" />搜索历史</h3>
            <button onClick={() => { localStorage.removeItem(HISTORY_KEY); setHistory([]); }} className="text-xs text-gray-400 hover:text-red-500">清空</button>
          </div>
          <div className="flex flex-wrap gap-2">
            {history.map((h, idx) => (
              <button
                key={idx}
                onClick={() => { setQuery(h.company); setScope(h.scope); setDepth(h.depth); setData(h.response); setStreamResults([]); setAiSummary(""); setActiveCategory(null); }}
                className="group inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs transition-all hover:border-blue-300 hover:bg-blue-50"
              >
                <span className={cn("inline-block h-2 w-2 rounded-full", h.risk_level === "high" ? "bg-red-400" : h.risk_level === "medium" ? "bg-yellow-400" : "bg-green-400")} />
                <span className="font-medium text-gray-700 group-hover:text-blue-700">{h.company}</span>
                <span className="text-gray-400">{h.total}条/{h.negative}负</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 空状态 */}
      {!data && !loading && streamResults.length === 0 && (
        <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50/50 p-12 text-center">
          <Search className="mx-auto h-10 w-10 text-gray-300" />
          <h3 className="mt-3 text-sm font-medium text-gray-600">输入公司名称开始搜索</h3>
          <p className="mt-1 text-xs text-gray-400">支持搜索国内外平台的舆情信息，包括百度、小红书、微博、知乎、Reddit、天眼查等</p>
          <p className="mt-2 text-xs text-gray-400">💡 选择 AI 模型可以对搜索结果做智能总结分析</p>
        </div>
      )}
    </div>
  );
}

export default function SentimentPage() {
  useAuthGuard(["admin"]);
  return <SentimentContent />;
}
