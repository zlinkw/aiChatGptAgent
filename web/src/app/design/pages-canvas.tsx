"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Eye,
  FolderOpen,
  Loader2,
  Maximize2,
  Minus,
  Monitor,
  Plus,
  Send,
  Smartphone,
  Tablet,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { httpRequest } from "@/lib/request";

export type DesignPage = {
  id: string;
  name: string;
  html: string;
  conversation: { role: string; content: string }[];
  versions: { html: string; prompt: string; timestamp: number }[];
  device: string;
  sort_order: number;
  created_at: number;
};

type Props = {
  projectId: string;
  projectName: string;
  theme: "dark" | "light";
  onEditPage: (page: DesignPage) => void;
  onBack: () => void;
};

const DEVICE_SIZES: Record<string, { w: number; h: number }> = {
  mobile: { w: 375, h: 812 },
  tablet: { w: 768, h: 1024 },
  desktop: { w: 1440, h: 900 },
};

export function PagesCanvas({ projectId, projectName, theme, onEditPage, onBack }: Props) {
  const [pages, setPages] = useState<DesignPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewPage, setShowNewPage] = useState(false);
  const [newPageName, setNewPageName] = useState("");
  const [newPageDevice, setNewPageDevice] = useState("mobile");
  const [previewMode, setPreviewMode] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [zoom, setZoom] = useState(55);
  const [showLeftPanel, setShowLeftPanel] = useState(true);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [quickInput, setQuickInput] = useState("");
  const [quickLoading, setQuickLoading] = useState(false);

  const loadPages = useCallback(async () => {
    try {
      const data = await httpRequest<{ pages: DesignPage[] }>(
        `/api/design/projects/${projectId}/pages`
      );
      setPages(data.pages.sort((a, b) => a.sort_order - b.sort_order));
    } catch (err: any) {
      toast.error(err?.message || "加载页面失败");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadPages();
  }, [loadPages]);

  const handleCreatePage = async () => {
    const name = newPageName.trim() || `页面 ${pages.length + 1}`;
    try {
      await httpRequest(`/api/design/projects/${projectId}/pages`, {
        method: "POST",
        body: { name, device: newPageDevice },
      });
      setNewPageName("");
      setShowNewPage(false);
      await loadPages();
      toast.success(`已创建「${name}」`);
    } catch (err: any) {
      toast.error(err?.message || "创建失败");
    }
  };

  const handleDeletePage = async (pageId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (pages.length <= 1) {
      toast.error("至少保留一个页面");
      return;
    }
    try {
      await httpRequest(`/api/design/projects/${projectId}/pages/${pageId}`, {
        method: "DELETE",
      });
      await loadPages();
      toast.success("已删除");
    } catch (err: any) {
      toast.error(err?.message || "删除失败");
    }
  };

  const handleZoomIn = () => setZoom((z) => Math.min(z + 10, 100));
  const handleZoomOut = () => setZoom((z) => Math.max(z - 10, 20));
  const handleZoomFit = () => setZoom(55);

  // 快捷对话修改 — 在画布里直接输入修改选中的页面
  const handleQuickGenerate = async () => {
    const prompt = quickInput.trim();
    if (!prompt || quickLoading) return;

    // 如果没选中页面，选第一个
    const targetId = selectedPageId || pages[0]?.id;
    if (!targetId) {
      toast.error("请先创建一个页面");
      return;
    }
    const targetPage = pages.find((p) => p.id === targetId);
    if (!targetPage) return;

    setQuickLoading(true);
    setQuickInput("");

    try {
      const { getStoredAuthKey } = await import("@/store/auth");
      const authKey = await getStoredAuthKey();
      const response = await fetch("/api/design/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authKey ? { Authorization: `Bearer ${authKey}` } : {}),
        },
        body: JSON.stringify({
          prompt,
          current_html: targetPage.html || "",
          conversation: [],
          project_id: projectId,
          page_id: targetId,
          model: "auto",
          stream: true,
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData?.detail || "生成失败");
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("无法读取流");

      const decoder = new TextDecoder();
      let fullHtml = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6).trim());
            if (event.type === "delta") fullHtml += event.delta;
            else if (event.type === "done") fullHtml = event.html || fullHtml;
          } catch {}
        }
      }

      // 更新页面数据
      setPages((prev) => prev.map((p) => p.id === targetId ? { ...p, html: fullHtml } : p));
      toast.success("已更新设计");
    } catch (err: any) {
      toast.error(err?.message || "生成失败");
    } finally {
      setQuickLoading(false);
    }
  };

  // 预览模式
  if (previewMode) {
    const currentPage = pages[previewIndex];
    if (!currentPage) { setPreviewMode(false); return null; }
    const size = DEVICE_SIZES[currentPage.device] || DEVICE_SIZES.mobile;
    return (
      <div className="fixed inset-0 z-[100] flex flex-col bg-black">
        <div className="flex items-center justify-between px-4 py-2.5 bg-black/90 border-b border-white/10">
          <div className="flex items-center gap-3">
            <button onClick={() => setPreviewMode(false)} className="rounded-lg p-2 text-white/60 hover:text-white hover:bg-white/10">
              <X className="size-4" />
            </button>
            <span className="text-[13px] text-white/80 font-medium">{projectName} — {currentPage.name}</span>
          </div>
          <div className="flex items-center gap-1">
            {pages.map((p, i) => (
              <button key={p.id} onClick={() => setPreviewIndex(i)}
                className={`rounded-md px-3 py-1.5 text-[11px] font-medium transition ${i === previewIndex ? "bg-violet-600 text-white" : "text-white/40 hover:text-white/70 hover:bg-white/10"}`}
              >{p.name}</button>
            ))}
          </div>
          <span className="text-[11px] text-white/30">{previewIndex + 1} / {pages.length}</span>
        </div>
        <div className="flex-1 flex items-center justify-center overflow-auto p-8">
          <div className="bg-white rounded-2xl shadow-2xl overflow-hidden" style={{ width: size.w, height: size.h, maxWidth: "90vw", maxHeight: "85vh" }}>
            <iframe
              srcDoc={`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;}</style></head><body>${currentPage.html || ""}</body></html>`}
              className="w-full h-full border-0" sandbox="allow-scripts allow-same-origin" title="Preview"
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#f0f1f3] relative">
      {/* 顶部导航栏 — 蓝湖风格 */}
      <div className="flex items-center justify-between h-12 px-4 bg-white border-b border-gray-200 shrink-0 z-20">
        {/* 左侧 */}
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="rounded-lg p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition">
            <ArrowLeft className="size-4" />
          </button>
          <span className="text-[14px] font-semibold text-gray-800">{projectName}</span>
          <ChevronDown className="size-3.5 text-gray-400" />
        </div>
        {/* 中间 Tab */}
        <div className="flex items-center gap-1">
          <button className="px-4 py-1.5 text-[13px] font-medium text-violet-600 border-b-2 border-violet-600">设计</button>
        </div>
        {/* 右侧 */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPreviewMode(true)}
            disabled={!pages.some((p) => p.html)}
            className="flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[12px] font-medium bg-violet-600 text-white hover:bg-violet-700 transition disabled:opacity-40"
          >
            <Eye className="size-3.5" />
            预览
          </button>
        </div>
      </div>

      {/* 主体区域 */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* 左侧面板 */}
        {showLeftPanel && (
          <div className="w-[200px] bg-white border-r border-gray-200 flex flex-col shrink-0 z-10">
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-gray-100">
              <span className="text-[12px] font-semibold text-gray-700">全部</span>
              <button onClick={() => setShowNewPage(true)} className="rounded p-1 text-gray-400 hover:text-violet-600 hover:bg-violet-50 transition">
                <Plus className="size-3.5" />
              </button>
            </div>
            {/* 页面列表 */}
            <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
              {pages.map((page) => (
                <button
                  key={page.id}
                  onClick={() => onEditPage(page)}
                  className="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] text-gray-600 hover:bg-violet-50 hover:text-violet-700 transition group"
                >
                  <FolderOpen className="size-3.5 text-gray-400 group-hover:text-violet-500 shrink-0" />
                  <span className="truncate flex-1">{page.name}</span>
                  <button
                    onClick={(e) => handleDeletePage(page.id, e)}
                    className="opacity-0 group-hover:opacity-100 rounded p-0.5 text-gray-300 hover:text-rose-500 transition"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </button>
              ))}
            </div>
            {/* 新建页面表单 */}
            {showNewPage && (
              <div className="border-t border-gray-100 p-3 space-y-2">
                <input
                  value={newPageName}
                  onChange={(e) => setNewPageName(e.target.value)}
                  placeholder="页面名称"
                  className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-[12px] outline-none focus:border-violet-400"
                  onKeyDown={(e) => e.key === "Enter" && handleCreatePage()}
                  autoFocus
                />
                <div className="flex items-center gap-1">
                  {(["mobile", "tablet", "desktop"] as const).map((d) => (
                    <button key={d} onClick={() => setNewPageDevice(d)}
                      className={`rounded-md p-1.5 transition ${newPageDevice === d ? "bg-violet-100 text-violet-600" : "text-gray-400 hover:text-gray-600 hover:bg-gray-100"}`}
                    >
                      {d === "mobile" ? <Smartphone className="size-3.5" /> : d === "tablet" ? <Tablet className="size-3.5" /> : <Monitor className="size-3.5" />}
                    </button>
                  ))}
                  <button onClick={handleCreatePage} className="ml-auto rounded-md bg-violet-600 px-3 py-1 text-[11px] text-white font-medium hover:bg-violet-700">
                    创建
                  </button>
                  <button onClick={() => setShowNewPage(false)} className="rounded-md p-1 text-gray-400 hover:text-gray-600">
                    <X className="size-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 画布区域 — 蓝湖风格 */}
        <div className="flex-1 overflow-auto relative" style={{ background: "#f0f1f3" }}>
          {/* 点阵背景 */}
          <div className="absolute inset-0 pointer-events-none" style={{
            backgroundImage: "radial-gradient(circle, rgba(0,0,0,0.07) 1px, transparent 1px)",
            backgroundSize: "20px 20px",
          }} />

          {/* 页面卡片 — 横向排列 */}
          <div className="relative z-10 flex items-start gap-8 p-10 min-h-full" style={{ paddingTop: "60px" }}>
            {loading ? (
              <div className="flex items-center justify-center w-full h-full">
                <span className="text-[13px] text-gray-400">加载中...</span>
              </div>
            ) : pages.length === 0 ? (
              <div className="flex flex-col items-center justify-center w-full h-[400px] gap-3">
                <p className="text-[13px] text-gray-400">还没有页面</p>
                <button onClick={() => setShowNewPage(true)} className="rounded-lg bg-violet-600 px-4 py-2 text-[12px] text-white font-medium hover:bg-violet-700">
                  新建页面
                </button>
              </div>
            ) : (
              pages.map((page) => {
                const size = DEVICE_SIZES[page.device] || DEVICE_SIZES.mobile;
                const scale = (zoom / 100) * (280 / size.w);
                const cardW = size.w * scale;
                const cardH = size.h * scale;
                return (
                  <div key={page.id} className="flex flex-col items-center shrink-0">
                    {/* 页面名称标注 */}
                    <div className="flex items-center gap-2 mb-3 self-start">
                      <span className="text-[12px] font-medium text-gray-500">{page.name}</span>
                    </div>
                    {/* 页面卡片 */}
                    <div
                      onClick={() => setSelectedPageId(page.id)}
                      onDoubleClick={() => onEditPage(page)}
                      className={`cursor-pointer rounded-lg overflow-hidden bg-white border shadow-sm hover:shadow-lg transition-all duration-200 group relative ${
                        selectedPageId === page.id ? "border-violet-400 ring-2 ring-violet-400/30 shadow-lg" : "border-gray-200 hover:border-violet-300"
                      }`}
                      style={{ width: cardW, height: cardH }}
                    >
                      {page.html ? (
                        <div className="origin-top-left pointer-events-none" style={{ width: size.w, height: size.h, transform: `scale(${scale})` }}>
                          <iframe
                            srcDoc={`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;}</style></head><body>${page.html}</body></html>`}
                            className="w-full h-full border-0" sandbox="allow-same-origin" title={page.name} tabIndex={-1}
                          />
                        </div>
                      ) : (
                        <div className="flex items-center justify-center h-full text-[12px] text-gray-300">空页面</div>
                      )}
                      {/* hover 遮罩 */}
                      <div className="absolute inset-0 bg-violet-600/0 group-hover:bg-violet-600/5 transition-colors" />
                      {/* 设备标识 */}
                      <div className="absolute bottom-2 left-2 flex items-center gap-1 rounded-md bg-white/90 border border-gray-200 px-2 py-0.5 text-[9px] text-gray-500 shadow-sm">
                        {page.device === "mobile" ? <Smartphone className="size-3" /> : page.device === "tablet" ? <Tablet className="size-3" /> : <Monitor className="size-3" />}
                        {page.device}
                      </div>
                    </div>
                  </div>
                );
              }).concat([
                /* 新建页面卡片 */
                <div key="__new_page" className="flex flex-col items-center shrink-0">
                  <div className="flex items-center gap-2 mb-3 self-start">
                    <span className="text-[12px] font-medium text-gray-400">新页面</span>
                  </div>
                  <button
                    onClick={() => setShowNewPage(true)}
                    className="rounded-lg border-2 border-dashed border-gray-300 hover:border-violet-400 hover:bg-violet-50 transition-all duration-200 flex flex-col items-center justify-center gap-2"
                    style={{ width: 200, height: 360 }}
                  >
                    <Plus className="size-8 text-gray-300" />
                    <span className="text-[12px] text-gray-400">添加页面</span>
                  </button>
                </div>
              ])
            )}
          </div>
        </div>
      </div>

      {/* 底部快捷输入框 */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-[500px] max-w-[calc(100%-240px)] z-20">
        <div className="rounded-xl bg-white border border-gray-200 shadow-lg flex items-center gap-2 px-4 py-2.5">
          {selectedPageId && (
            <span className="text-[11px] text-violet-600 bg-violet-50 rounded-md px-2 py-0.5 shrink-0 font-medium">
              {pages.find((p) => p.id === selectedPageId)?.name || "页面"}
            </span>
          )}
          <input
            value={quickInput}
            onChange={(e) => setQuickInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleQuickGenerate()}
            placeholder={selectedPageId ? "描述修改内容，回车生成..." : "选中一个页面后输入修改指令"}
            className="flex-1 text-[13px] text-gray-800 placeholder-gray-400 outline-none bg-transparent"
            disabled={quickLoading}
          />
          <button
            onClick={handleQuickGenerate}
            disabled={quickLoading || !quickInput.trim()}
            className="rounded-lg p-2 bg-violet-600 text-white hover:bg-violet-700 transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          >
            {quickLoading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </button>
        </div>
        <p className="text-center text-[10px] text-gray-400 mt-1.5">
          单击选中页面 · 双击进入编辑 · 输入指令直接修改
        </p>
      </div>

      {/* 底部缩放控制栏 — 蓝湖风格 */}
      <div className="absolute bottom-4 right-4 flex items-center gap-1 rounded-xl bg-white border border-gray-200 shadow-lg px-2 py-1.5 z-20">
        <button onClick={() => setShowLeftPanel(!showLeftPanel)} className="rounded-md p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition" title="切换面板">
          <FolderOpen className="size-3.5" />
        </button>
        <div className="w-px h-4 bg-gray-200 mx-1" />
        <button onClick={handleZoomOut} className="rounded-md p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition">
          <Minus className="size-3.5" />
        </button>
        <span className="text-[11px] font-medium text-gray-600 w-10 text-center">{zoom}%</span>
        <button onClick={handleZoomIn} className="rounded-md p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition">
          <Plus className="size-3.5" />
        </button>
        <button onClick={handleZoomFit} className="rounded-md p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition" title="适应屏幕">
          <Maximize2 className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
