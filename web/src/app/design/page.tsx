"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Brain,
  ChevronDown,
  ChevronRight,
  Code2,
  Loader2,
  Monitor,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Send,
  Smartphone,
  Tablet,
  X,
  Zap,
  Share2,
  Download,
  FileCode,
  FolderOpen,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";

import { httpRequest } from "@/lib/request";
import { AgentPanel } from "./agent-panel";
import { PagesCanvas, type DesignPage } from "./pages-canvas";
import { ExportPanel } from "./export-panel";
import { ProjectSetup, type ProjectConfig } from "./project-setup";

type Message = {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  code?: string;
  files?: string[];
  skills_used?: string[];
};

type Project = {
  id: string;
  name: string;
  html: string;
  conversation: Message[];
  versions: { html: string; prompt: string; timestamp: number }[];
  pages?: DesignPage[];
  created_at: number;
  updated_at: number;
};

type DeviceSize = { name: string; width: number; height: number; group?: string };

const DEVICES: DeviceSize[] = [
  // iPhone
  { name: "iPhone 16 Pro Max", width: 440, height: 956, group: "iPhone" },
  { name: "iPhone 16 Pro", width: 402, height: 874, group: "iPhone" },
  { name: "iPhone 16", width: 393, height: 852, group: "iPhone" },
  { name: "iPhone 15", width: 393, height: 852, group: "iPhone" },
  { name: "iPhone 14", width: 390, height: 844, group: "iPhone" },
  { name: "iPhone SE", width: 375, height: 667, group: "iPhone" },
  // Android
  { name: "Pixel 8", width: 412, height: 915, group: "Android" },
  { name: "Samsung S24", width: 412, height: 915, group: "Android" },
  // Tablet
  { name: "iPad Pro 12.9\"", width: 1024, height: 1366, group: "Tablet" },
  { name: "iPad Air", width: 820, height: 1180, group: "Tablet" },
  { name: "iPad Mini", width: 744, height: 1133, group: "Tablet" },
  // Desktop
  { name: "Desktop 1440", width: 1440, height: 900, group: "Desktop" },
  { name: "Desktop 1920", width: 1920, height: 1080, group: "Desktop" },
  { name: "MacBook Pro", width: 1512, height: 982, group: "Desktop" },
];

export default function DesignPage() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [currentHtml, setCurrentHtml] = useState("");
  const [device, setDevice] = useState<DeviceSize>(DEVICES[2]); // 默认 iPhone 16
  const [customSize, setCustomSize] = useState(false);
  const [customW, setCustomW] = useState(375);
  const [customH, setCustomH] = useState(852);
  const [showCode, setShowCode] = useState(false);
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [showProjects, setShowProjects] = useState(false);
  const [versionLabel, setVersionLabel] = useState("Version 1");
  const [versions, setVersions] = useState<{ html: string; prompt: string; timestamp: number }[]>([]);
  const [streamingCode, setStreamingCode] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [showReasoning, setShowReasoning] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("light");
  const abortRef = useRef<AbortController | null>(null);
  const [selectedModel, setSelectedModel] = useState("auto");
  const [availableModels, setAvailableModels] = useState<{ id: string; name: string; desc: string }[]>([
    { id: "auto", name: "Auto", desc: "自动选择" },
  ]);

  // 动态加载模型列表
  useEffect(() => {
    const loadModels = async () => {
      try {
        // 先尝试从中转 API 获取
        const data = await httpRequest<{ models: { id: string }[] }>("/api-backend/models");
        if (data.models?.length) {
          const models = [
            { id: "auto", name: "Auto", desc: "自动选择" },
            ...data.models.slice(0, 20).map((m) => ({ id: m.id, name: m.id, desc: "" })),
          ];
          setAvailableModels(models);
          return;
        }
      } catch {}
      // 中转不可用，从 /v1/models 获取
      try {
        const data = await httpRequest<{ data?: { id: string }[]; models?: { id: string }[] }>("/v1/models");
        const models = data.data || data.models || [];
        if (models.length) {
          setAvailableModels([
            { id: "auto", name: "Auto", desc: "自动选择" },
            ...models.slice(0, 20).map((m) => ({ id: m.id, name: m.id, desc: "" })),
          ]);
        }
      } catch {}
    };
    void loadModels();
  }, []);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showDevicePicker, setShowDevicePicker] = useState(false);
  const [leftTab, setLeftTab] = useState<"chat" | "agent">("agent");
  const [viewMode, setViewMode] = useState<"editor" | "canvas">("editor");
  const [editingPage, setEditingPage] = useState<DesignPage | null>(null);
  const [canvasKey, setCanvasKey] = useState(0);
  const [designTarget, setDesignTarget] = useState<"app" | "web">("app");
  const [showExport, setShowExport] = useState(false);
  const [multiAgentEnabled, setMultiAgentEnabled] = useState(false);
  const [showProjectSetup, setShowProjectSetup] = useState(false);

  // 隐藏侧边栏，全屏显示设计工具
  useEffect(() => {
    document.body.classList.add("design-fullscreen");
    return () => {
      document.body.classList.remove("design-fullscreen");
    };
  }, []);

  // 元素选中状态（支持多选）
  const [selectedElement, setSelectedElement] = useState<{
    selector: string;
    html: string;
    text: string;
    tagName: string;
  } | null>(null);
  const [multiSelected, setMultiSelected] = useState<{
    selector: string;
    html: string;
    text: string;
    tagName: string;
  }[]>([]);

  // 监听 iframe 传来的选中事件
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === "element-selected") {
        const el = {
          selector: e.data.selector,
          html: e.data.html,
          text: e.data.text,
          tagName: e.data.tagName,
          styles: e.data.styles,
        };
        if (e.data.shiftKey) {
          // Shift+点击：批量选中
          setMultiSelected((prev) => {
            const exists = prev.some((p) => p.selector === el.selector);
            if (exists) return prev.filter((p) => p.selector !== el.selector);
            return [...prev, el];
          });
          setSelectedElement(el);
        } else {
          // 普通点击：单选
          setSelectedElement(el);
          setMultiSelected([el]);
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // 更新 iframe 预览（注入交互脚本）
  const updatePreview = useCallback((html: string) => {
    if (!iframeRef.current) return;
    const interactionScript = `<script>
(function(){
  var selected=null;
  function getCssPath(el){
    if(!el||el===document.body)return'body';
    var path=[];
    while(el&&el!==document.body){
      var tag=el.tagName.toLowerCase();
      var parent=el.parentElement;
      if(parent){
        var siblings=Array.from(parent.children).filter(function(c){return c.tagName===el.tagName});
        if(siblings.length>1){
          tag+=':nth-child('+(Array.from(parent.children).indexOf(el)+1)+')';
        }
      }
      path.unshift(tag);
      el=parent;
    }
    return'body > '+path.join(' > ');
  }
  document.addEventListener('mouseover',function(e){
    if(e.target===document.body||e.target===document.documentElement)return;
    if(selected&&e.target===selected)return;
    e.target.classList.add('__hover_highlight');
  });
  document.addEventListener('mouseout',function(e){
    e.target.classList.remove('__hover_highlight');
  });
  document.addEventListener('click',function(e){
    e.preventDefault();
    e.stopPropagation();
    if(e.target===document.body||e.target===document.documentElement)return;
    if(selected)selected.classList.remove('__selected_highlight');
    selected=e.target;
    selected.classList.add('__selected_highlight');
    selected.classList.remove('__hover_highlight');
    window.parent.postMessage({
      type:'element-selected',
      selector:getCssPath(e.target),
      html:e.target.outerHTML.slice(0,500),
      text:(e.target.textContent||'').slice(0,100),
      tagName:e.target.tagName.toLowerCase(),
      shiftKey:e.shiftKey,
      styles:(function(){
        var cs=window.getComputedStyle(e.target);
        return{
          width:cs.width,height:cs.height,
          color:cs.color,backgroundColor:cs.backgroundColor,
          fontSize:cs.fontSize,fontWeight:cs.fontWeight,
          borderRadius:cs.borderRadius,
          padding:cs.padding,margin:cs.margin,
          border:cs.border,opacity:cs.opacity
        };
      })()
    },'*');
  },true);
})();
<\/script>`;
    const styles = `<style>*{box-sizing:border-box}body{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;padding:0;}.__hover_highlight{outline:2px dashed #3B82F6!important;outline-offset:2px;}.__selected_highlight{outline:2px solid #3B82F6!important;outline-offset:2px;background:rgba(59,130,246,0.05)!important;}</style>`;

    // 判断 AI 生成的 HTML 是否是完整文档
    const isFullDoc = html.trim().toLowerCase().startsWith('<!doctype') || html.trim().toLowerCase().startsWith('<html');
    let fullDoc: string;
    if (isFullDoc) {
      // 完整文档：在 </html> 前注入样式和脚本
      if (html.includes('</body>')) {
        fullDoc = html.replace('</head>', `${styles}</head>`).replace('</body>', `${interactionScript}</body>`);
      } else if (html.includes('</html>')) {
        fullDoc = html.replace('</html>', `${styles}${interactionScript}</html>`);
      } else {
        fullDoc = html + styles + interactionScript;
      }
      if (!fullDoc.toLowerCase().includes('charset')) {
        fullDoc = fullDoc.replace(/<head>/i, '<head><meta charset="UTF-8">');
      }
    } else {
      // 片段：包裹完整文档
      fullDoc = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">${styles}</head><body>${html}${interactionScript}</body></html>`;
    }
    iframeRef.current.srcdoc = fullDoc;
  }, []);

  useEffect(() => {
    if (currentHtml) updatePreview(currentHtml);
  }, [currentHtml, updatePreview]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, reasoning, streamingCode]);

  // Load projects
  const loadProjects = useCallback(async () => {
    try {
      const data = await httpRequest<{ projects: Project[] }>("/api/design/projects");
      setProjects(data.projects);
    } catch {}
  }, []);

  useEffect(() => { void loadProjects(); }, [loadProjects]);

  const handleStop = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setLoading(false);
    setStreamingCode("");
    setMessages((prev) => [...prev, { role: "assistant", content: "⏹ 已停止生成" }]);
  };

  const handleGenerate = async () => {
    const prompt = input.trim();
    if (!prompt || loading) return;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: prompt }]);
    setLoading(true);
    setReasoning("");
    setStreamingCode("");
    setShowReasoning(true);

    const controller = new AbortController();
    abortRef.current = controller;

    // 模拟 reasoning 阶段
    const reasoningSteps = [
      `我来帮你${currentHtml ? "修改" : "创建"}这个设计。`,
      `首先让我检查一下项目的当前状态和可用的设计系统。`,
    ];
    setReasoning(reasoningSteps.join("\n"));

    try {
      const conversation = messages
        .filter((m) => m.role === "user")
        .slice(-5)
        .map((m) => ({ role: m.role, content: m.content }));

      // 流式请求
      const { getStoredAuthKey } = await import("@/store/auth");
      const authKey = await getStoredAuthKey();
      const response = await fetch("/api/design/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authKey ? { Authorization: `Bearer ${authKey}` } : {}),
        },
        body: JSON.stringify({
          prompt: selectedElement
            ? multiSelected.length > 1
              ? `用户选中了页面中的 ${multiSelected.length} 个元素：\n${multiSelected.map((el, i) => `${i + 1}. <${el.tagName}> "${el.text.slice(0, 30)}" (${el.selector})`).join('\n')}\n\n修改指令：${prompt}`
              : `用户选中了页面中的元素：\n选择器：${selectedElement.selector}\n元素HTML：${selectedElement.html}\n元素文字：${selectedElement.text}\n\n修改指令：${prompt}`
            : prompt,
          current_html: currentHtml,
          conversation,
          project_id: currentProject?.id || "",
          page_id: editingPage?.id || "",
          model: selectedModel,
          stream: true,
          multi_agent: multiAgentEnabled,
          device_width: previewWidth,
          device_height: previewHeight,
          device_name: device.name,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData?.detail || `生成失败 (${response.status})`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("无法读取流");

      const decoder = new TextDecoder();
      let fullHtml = "";
      let skillsUsed: string[] = [];
      let suggestions: any[] = [];
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;

          try {
            const event = JSON.parse(jsonStr);

            if (event.type === "meta") {
              skillsUsed = event.skills_used || [];
              suggestions = event.suggestions || [];
              if (skillsUsed.length) {
                setReasoning((prev) => prev + `\n使用了 Skills: ${skillsUsed.join(", ")}`);
              }
            } else if (event.type === "stage") {
              // Multi-Agent 阶段开始
              setReasoning((prev) => prev + `\n${event.label}`);
            } else if (event.type === "stage_done") {
              // 阶段完成，显示完整结果
              if (event.result) {
                setReasoning((prev) => prev + `\n${event.result}\n`);
              }
            } else if (event.type === "delta") {
              fullHtml += event.delta;
              setStreamingCode(fullHtml);
              // 实时更新预览 — 每积累一定量就刷新
              if (fullHtml.length % 200 < event.delta.length) {
                setCurrentHtml(fullHtml);
              }
            } else if (event.type === "done") {
              fullHtml = event.html || fullHtml;
              setCurrentHtml(fullHtml);
              setStreamingCode(fullHtml);
            }
          } catch {}
        }
      }

      // 完成
      setCurrentHtml(fullHtml);
      setLoading(false);
      setSelectedElement(null);
      // 强制刷新预览
      setTimeout(() => {
        if (iframeRef.current) {
          updatePreview(fullHtml);
        }
      }, 100);

      // 更新版本
      setVersions((prev) => [...prev, { html: fullHtml, prompt, timestamp: Date.now() / 1000 }]);
      setVersionLabel(`Version ${versions.length + 2}`);

      const finalReasoning = [
        ...reasoningSteps,
        skillsUsed.length ? `使用了 Skills: ${skillsUsed.join(", ")}` : "",
        `已完成${currentHtml ? "修改" : "创建"}设计。`,
      ].filter(Boolean).join("\n");
      setReasoning(finalReasoning);

      let assistantContent = `已为你${currentHtml ? "修改" : "创建"}完成设计！\n`;
      if (skillsUsed.length) {
        assistantContent += `使用了 Skills: ${skillsUsed.join(", ")}\n`;
      }
      if (suggestions.length) {
        assistantContent += `建议安装: ${suggestions.map((s: any) => s.name).join(", ")}`;
      }

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: assistantContent,
          reasoning: finalReasoning,
          code: fullHtml.slice(0, 200) + "...",
          skills_used: skillsUsed,
        },
      ]);
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      const msg = err?.message || "生成失败";
      toast.error(msg);
      setMessages((prev) => [...prev, { role: "assistant", content: `❌ ${msg}` }]);
      setLoading(false);
    }
  };

  const handleCreateProject = async (name?: string) => {
    if (name) {
      // 直接创建（从 quickStart 调用）
      await doCreateProject(name, "", {}, "", "mobile");
    } else {
      // 打开配置面板
      setShowProjectSetup(true);
    }
  };

  const handleProjectSetupComplete = async (config: ProjectConfig) => {
    setShowProjectSetup(false);
    await doCreateProject(config.name, config.role_id, config.brand_colors, config.preset_id, config.device);
  };

  const doCreateProject = async (projectName: string, roleId: string, brandColors: Record<string, string>, presetId: string, deviceType: string) => {
    try {
      const data = await httpRequest<{ project: Project }>("/api/design/projects", {
        method: "POST",
        body: { name: projectName },
      });
      // 保存 Agent 配置
      await httpRequest("/api/design/agent/persona", {
        method: "PUT",
        body: { role_id: roleId, brand_colors: brandColors, active_preset: presetId },
      });
      // 激活预设
      if (presetId) {
        await httpRequest("/api/design/agent/presets/activate", {
          method: "POST",
          body: { preset_id: presetId },
        }).catch(() => {});
      }
      // 创建第一个页面
      const pageData = await httpRequest<{ page: DesignPage }>(
        `/api/design/projects/${data.project.id}/pages`,
        { method: "POST", body: { name: "首页", device: deviceType } }
      );
      setCurrentProject(data.project);
      setEditingPage(pageData.page);
      setMessages([]);
      setCurrentHtml("");
      setVersions([]);
      setVersionLabel("Version 1");
      await loadProjects();
      setShowProjects(false);
      setViewMode("editor");
      setLeftTab("chat");
      toast.success(`项目「${projectName}」已创建`);
    } catch (err: any) {
      toast.error(err?.message || "创建失败");
    }
  };

  const handleOpenProject = async (id: string) => {
    try {
      const data = await httpRequest<{ project: Project }>(`/api/design/projects/${id}`);
      setCurrentProject(data.project);
      setShowProjects(false);
      setEditingPage(null);
      // 所有项目都进入画布模式（画布会自动兼容旧项目）
      setViewMode("canvas");
      toast.success(`已打开「${data.project.name}」`);
    } catch (err: any) {
      toast.error(err?.message || "打开失败");
    }
  };

  const handleEditPage = (page: DesignPage) => {
    setEditingPage(page);
    setCurrentHtml(page.html || "");
    setMessages(page.conversation || []);
    setVersions(page.versions || []);
    setVersionLabel(`Version ${(page.versions?.length || 0) + 1}`);
    setViewMode("editor");
    setLeftTab("chat");
  };

  const handleBackToCanvas = () => {
    setViewMode("canvas");
    setEditingPage(null);
    setCanvasKey((k) => k + 1);
  };

  const handleQuickStart = async (prompt: string) => {
    if (!prompt.trim()) return;
    const projectName = prompt.slice(0, 20) + (prompt.length > 20 ? "..." : "");
    try {
      const data = await httpRequest<{ project: Project }>("/api/design/projects", {
        method: "POST",
        body: { name: projectName },
      });
      const deviceType = designTarget === "app" ? "mobile" : "desktop";
      const pageData = await httpRequest<{ page: DesignPage }>(
        `/api/design/projects/${data.project.id}/pages`,
        { method: "POST", body: { name: "首页", device: deviceType } }
      );
      setCurrentProject(data.project);
      setEditingPage(pageData.page);
      setMessages([]);
      setCurrentHtml("");
      setVersions([]);
      setVersionLabel("Version 1");
      setViewMode("editor");
      setLeftTab("chat");
      // 设置设备尺寸
      if (designTarget === "app") {
        setDevice(DEVICES[2]); // Mobile
      } else {
        setDevice(DEVICES[0]); // Desktop
      }
      setCustomSize(false);
      await loadProjects();
      // 自动触发生成
      setInput(prompt);
      setTimeout(() => {
        const btn = document.querySelector("[data-generate-btn]") as HTMLButtonElement;
        if (btn) btn.click();
      }, 100);
    } catch (err: any) {
      toast.error(err?.message || "创建失败");
    }
  };

  const handleExport = () => {
    if (!currentHtml) return;
    setShowExport(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleGenerate();
    }
  };

  const previewWidth = customSize ? customW : device.width;
  const previewHeight = customSize ? customH : device.height;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-white text-gray-900">
      {/* Canvas Mode */}
      {viewMode === "canvas" && currentProject && (
        <PagesCanvas
          key={currentProject.id + "_" + canvasKey}
          projectId={currentProject.id}
          projectName={currentProject.name}
          theme={theme}
          onEditPage={handleEditPage}
          onBack={() => { setCurrentProject(null); setEditingPage(null); setViewMode("editor"); }}
        />
      )}

      {/* Editor Mode */}
      {viewMode === "editor" && (<>

      {/* Landing Page — 没有打开项目时显示 */}
      {!currentProject && !editingPage && (
        <div className="flex-1 flex flex-col items-center justify-center relative overflow-hidden bg-black">
          {/* 流体光效背景 */}
          <div className="absolute inset-0 overflow-hidden">
            {/* 主光效 — 紫色/青色流体 */}
            <div className="absolute top-[30%] left-[10%] w-[800px] h-[500px] rounded-full opacity-40"
              style={{
                background: "radial-gradient(ellipse at center, rgba(139,92,246,0.4) 0%, rgba(6,182,212,0.3) 40%, transparent 70%)",
                filter: "blur(60px)",
                animation: "fluid-drift-1 12s ease-in-out infinite",
              }}
            />
            <div className="absolute top-[40%] right-[5%] w-[600px] h-[400px] rounded-full opacity-30"
              style={{
                background: "radial-gradient(ellipse at center, rgba(6,182,212,0.5) 0%, rgba(59,130,246,0.3) 40%, transparent 70%)",
                filter: "blur(80px)",
                animation: "fluid-drift-2 15s ease-in-out infinite",
              }}
            />
            <div className="absolute bottom-[10%] left-[30%] w-[700px] h-[350px] rounded-full opacity-25"
              style={{
                background: "radial-gradient(ellipse at center, rgba(168,85,247,0.4) 0%, rgba(236,72,153,0.2) 50%, transparent 70%)",
                filter: "blur(70px)",
                animation: "fluid-drift-3 18s ease-in-out infinite",
              }}
            />
            {/* 粒子效果 */}
            <div className="absolute inset-0" style={{
              backgroundImage: `radial-gradient(1px 1px at 20px 30px, rgba(255,255,255,0.15) 0%, transparent 100%),
                radial-gradient(1px 1px at 40px 70px, rgba(255,255,255,0.1) 0%, transparent 100%),
                radial-gradient(1px 1px at 50px 160px, rgba(255,255,255,0.12) 0%, transparent 100%),
                radial-gradient(1px 1px at 90px 40px, rgba(255,255,255,0.08) 0%, transparent 100%),
                radial-gradient(1.5px 1.5px at 130px 80px, rgba(139,92,246,0.3) 0%, transparent 100%),
                radial-gradient(1px 1px at 160px 120px, rgba(255,255,255,0.1) 0%, transparent 100%)`,
              backgroundSize: "200px 200px",
              animation: "particle-float 20s linear infinite",
            }} />
            {/* 水波纹理 */}
            <div className="absolute inset-0 opacity-[0.03]" style={{
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='400'%3E%3Cfilter id='a'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.015' numOctaves='3' seed='2'/%3E%3CfeDisplacementMap in='SourceGraphic' scale='30'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23a)' fill='white'/%3E%3C/svg%3E")`,
              animation: "wave-shift 25s linear infinite",
            }} />
          </div>

          {/* 顶部导航 */}
          <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-6 py-4 z-20">
            <div className="flex items-center gap-2">
              <span className="text-[18px] font-bold text-white tracking-tight">Design Studio</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full border border-white/20 text-white/50 font-medium">BETA</span>
            </div>
            <button
              onClick={() => { setShowProjects(true); loadProjects(); }}
              className="rounded-full bg-white px-5 py-2 text-[13px] font-semibold text-black hover:bg-white/90 transition shadow-lg shadow-white/10"
            >
              开始使用
            </button>
            <button
              onClick={() => handleCreateProject()}
              className="rounded-full bg-violet-600 px-5 py-2 text-[13px] font-semibold text-white hover:bg-violet-700 transition shadow-lg shadow-violet-500/20"
            >
              新建项目
            </button>
          </div>

          {/* 主内容 */}
          <div className="relative z-10 flex flex-col items-center text-center px-6 max-w-3xl mt-[-40px]">
            {/* 大标题 */}
            <h1 className="text-[64px] font-bold text-white leading-[1.1] tracking-tight mb-5" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
              Design at the<br />speed of AI
            </h1>
            <p className="text-[17px] text-white/50 mb-14 font-light">
              Transform ideas into UI designs for mobile and web applications
            </p>

            {/* 输入框 — 毛玻璃效果 */}
            <div className="w-full max-w-[580px]">
              <div className="rounded-2xl border border-white/[0.1] bg-white/[0.04] backdrop-blur-2xl p-5 shadow-[0_8px_60px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.05)]">
                <textarea
                  placeholder="我们要设计什么样的原生移动应用？"
                  className="w-full resize-none bg-transparent text-[15px] text-white/90 placeholder-white/30 outline-none leading-relaxed"
                  rows={3}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleQuickStart((e.target as HTMLTextAreaElement).value);
                    }
                  }}
                />
                {/* 底部工具栏 */}
                <div className="flex items-center justify-between mt-4 pt-3 border-t border-white/[0.06]">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleCreateProject()}
                      className="rounded-lg p-2 text-white/25 hover:text-white/50 hover:bg-white/5 transition"
                    >
                      <Plus className="size-4" />
                    </button>
                    <div className="flex items-center gap-0.5 rounded-xl bg-white/[0.06] p-1">
                      <button
                        onClick={() => setDesignTarget("app")}
                        className={`flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[12px] font-medium transition ${
                          designTarget === "app"
                            ? "bg-white/[0.12] text-white shadow-sm"
                            : "text-white/35 hover:text-white/55"
                        }`}
                      >
                        <Smartphone className="size-3.5" />
                        应用
                      </button>
                      <button
                        onClick={() => setDesignTarget("web")}
                        className={`flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[12px] font-medium transition ${
                          designTarget === "web"
                            ? "bg-white/[0.12] text-white shadow-sm"
                            : "text-white/35 hover:text-white/55"
                        }`}
                      >
                        <Monitor className="size-3.5" />
                        Web
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button className="rounded-lg p-2 text-white/25 hover:text-white/50 hover:bg-white/5 transition">
                      <Brain className="size-4" />
                    </button>
                    <button
                      onClick={(e) => {
                        const textarea = (e.target as HTMLElement).closest(".rounded-2xl")?.querySelector("textarea");
                        if (textarea?.value.trim()) handleQuickStart(textarea.value);
                      }}
                      className="rounded-xl bg-white/[0.1] border border-white/[0.08] p-2.5 text-white/70 hover:bg-white/[0.15] hover:text-white transition"
                    >
                      <Send className="size-4" />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* 已有项目快捷入口 */}
            {projects.length > 0 && (
              <div className="mt-10 flex items-center gap-2 flex-wrap justify-center">
                <span className="text-[11px] text-white/20 mr-1">最近：</span>
                {projects.slice(0, 4).map((p) => (
                  <button
                    key={p.id}
                    onClick={() => handleOpenProject(p.id)}
                    className="rounded-full px-4 py-1.5 text-[11px] text-white/35 border border-white/[0.06] hover:bg-white/[0.05] hover:text-white/55 hover:border-white/[0.12] transition"
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 有项目时显示编辑器 */}
      {(currentProject || editingPage) && (<>
      {/* Top Bar */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4">
        {/* Left: Project name + nav */}
        <div className="flex items-center gap-2">
          {editingPage ? (
            <button onClick={handleBackToCanvas} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700" title="返回画布">
              <FolderOpen className="size-4" />
            </button>
          ) : (
            <Link href="/" className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
              <FolderOpen className="size-4" />
            </Link>
          )}
          <button
            onClick={() => { setShowProjects(!showProjects); loadProjects(); }}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-semibold text-gray-800 hover:bg-gray-100"
          >
            {editingPage ? `${currentProject?.name} / ${editingPage.name}` : (currentProject?.name || "新设计")}
            <ChevronDown className="size-3 text-gray-400" />
          </button>
          <span className="text-[11px] text-gray-400 ml-2">{versionLabel}</span>
        </div>

        {/* Center: Device + Preview controls */}
        <div className="flex items-center gap-2">
          {/* 设备选择下拉 */}
          <div className="relative">
            <button
              onClick={() => setShowDevicePicker(!showDevicePicker)}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium bg-gray-100 text-gray-700 hover:bg-gray-200 transition"
            >
              {(device.group === "iPhone" || device.group === "Android") ? <Smartphone className="size-3.5" /> : device.group === "Tablet" ? <Tablet className="size-3.5" /> : <Monitor className="size-3.5" />}
              {customSize ? "自定义" : device.name}
              <ChevronDown className="size-3 opacity-50" />
            </button>
            {showDevicePicker && (
              <div className="absolute top-9 left-1/2 -translate-x-1/2 w-56 rounded-xl border border-gray-200 bg-white shadow-2xl overflow-hidden z-50 max-h-[400px] overflow-y-auto">
                {["iPhone", "Android", "Tablet", "Desktop"].map((group) => (
                  <div key={group}>
                    <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400 bg-gray-50">
                      {group}
                    </div>
                    {DEVICES.filter((d) => d.group === group).map((d) => (
                      <button
                        key={d.name}
                        onClick={() => { setDevice(d); setCustomSize(false); setShowDevicePicker(false); }}
                        className={`w-full text-left px-3 py-2 text-[12px] transition flex items-center justify-between ${
                          !customSize && device.name === d.name
                            ? "bg-violet-50 text-violet-700"
                            : "text-gray-700 hover:bg-gray-50"
                        }`}
                      >
                        <span>{d.name}</span>
                        <span className="text-[10px] font-mono text-gray-400">{d.width}×{d.height}</span>
                      </button>
                    ))}
                  </div>
                ))}
                <div className="border-t border-gray-100">
                  <button
                    onClick={() => { setCustomSize(true); setShowDevicePicker(false); }}
                    className={`w-full text-left px-3 py-2 text-[12px] transition ${
                      customSize ? "bg-violet-50 text-violet-700" : "text-gray-700 hover:bg-gray-50"
                    }`}
                  >
                    自定义尺寸
                  </button>
                </div>
              </div>
            )}
          </div>
          {/* 自定义尺寸输入 */}
          {customSize ? (
            <div className="flex items-center gap-1">
              <input type="number" value={customW} onChange={(e) => setCustomW(Number(e.target.value) || 375)}
                className="w-14 rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] font-mono text-center text-gray-700 outline-none focus:border-violet-400" />
              <span className="text-[11px] text-gray-400">×</span>
              <input type="number" value={customH} onChange={(e) => setCustomH(Number(e.target.value) || 812)}
                className="w-14 rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] font-mono text-center text-gray-700 outline-none focus:border-violet-400" />
            </div>
          ) : (
            <span className="text-[11px] font-mono text-gray-400">{previewWidth} × {previewHeight}</span>
          )}
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-1.5">
          <button onClick={() => setShowCode(!showCode)} className={`rounded-lg p-1.5 transition ${showCode ? "bg-violet-100 text-violet-600" : "text-gray-400 hover:text-gray-700 hover:bg-gray-100"}`} title="查看代码">
            <Code2 className="size-4" />
          </button>
          <button onClick={handleExport} disabled={!currentHtml} className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium bg-violet-600 text-white hover:bg-violet-700 transition disabled:opacity-40 disabled:cursor-not-allowed">
            <Download className="size-3.5" />
            导出
          </button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Chat + Code */}
        <div className="flex w-[380px] flex-col border-r border-gray-200 bg-white">
          {/* Left panel tab switcher */}
          <div className="flex items-center gap-1 px-3 pt-2 pb-1 border-b border-gray-100">
            <button
              onClick={() => setLeftTab("chat")}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition ${
                leftTab === "chat" ? "bg-violet-50 text-violet-700" : "text-gray-400 hover:text-gray-600 hover:bg-gray-50"
              }`}
            >
              <Send className="size-3" />
              对话
            </button>
            <button
              onClick={() => setLeftTab("agent")}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition ${
                leftTab === "agent" ? "bg-violet-50 text-violet-700" : "text-gray-400 hover:text-gray-600 hover:bg-gray-50"
              }`}
            >
              <Brain className="size-3" />
              Agent
            </button>
          </div>

          {/* Agent Panel */}
          {leftTab === "agent" && (
            <AgentPanel theme={theme} />
          )}

          {/* Chat Panel */}
          {leftTab === "chat" && (<>
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
            {messages.length === 0 && !loading && (
              <div className="flex flex-col items-center justify-center h-full text-center px-6">
                <div className="size-12 rounded-2xl bg-gradient-to-br from-violet-500/20 to-purple-500/20 flex items-center justify-center mb-4">
                  <Zap className="size-6 text-violet-400" />
                </div>
                <p className="text-sm font-medium text-gray-700 mb-1">AI Design Agent</p>
                <p className="text-xs text-gray-400 leading-relaxed">
                  描述你想要的页面或应用，Agent 会自动选择合适的 Skills 来生成专业设计。
                </p>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className="space-y-2">
                {msg.role === "user" ? (
                  <div className="flex items-start gap-2">
                    <div className="size-6 rounded-full bg-violet-600 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-[10px] font-bold">U</span>
                    </div>
                    <div className="rounded-xl bg-violet-600/10 border border-violet-500/20 px-3 py-2 text-[13px] text-gray-800 leading-relaxed">
                      {msg.content}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {/* Reasoning */}
                    {msg.reasoning && (
                      <button
                        onClick={() => setShowReasoning(!showReasoning)}
                        className="flex items-center gap-1.5 text-[11px] text-gray-400 hover:text-gray-500"
                      >
                        <ChevronRight className={`size-3 transition ${showReasoning ? "rotate-90" : ""}`} />
                        Reasoning
                      </button>
                    )}
                    {msg.reasoning && showReasoning && (
                      <div className="ml-4 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-[11px] text-gray-500 leading-relaxed whitespace-pre-wrap">
                        {msg.reasoning}
                      </div>
                    )}
                    {/* Skills used */}
                    {msg.skills_used && msg.skills_used.length > 0 && (
                      <div className="flex items-center gap-1.5 ml-4">
                        <Brain className="size-3 text-emerald-400" />
                        <span className="text-[10px] text-emerald-400/80">
                          Skills: {msg.skills_used.join(", ")}
                        </span>
                      </div>
                    )}
                    {/* Content */}
                    <div className="ml-4 text-[13px] text-gray-600 leading-relaxed whitespace-pre-wrap">
                      {msg.content}
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Loading state: agent stages + streaming code */}
            {loading && (
              <div className="space-y-3">
                {/* Agent 阶段进度 — 直接显示 */}
                {reasoning && (
                  <div className="rounded-lg bg-violet-50 border border-violet-200 px-3 py-2.5 text-[12px] text-violet-700 leading-relaxed whitespace-pre-wrap max-h-[300px] overflow-y-auto">
                    {reasoning}
                  </div>
                )}
                {streamingCode ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-[12px] text-gray-500">
                      <Loader2 className="size-3.5 animate-spin text-violet-500" />
                      <span>正在生成设计...</span>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-[12px] text-gray-500">
                    <Loader2 className="size-3.5 animate-spin text-violet-500" />
                    <span>思考中...</span>
                  </div>
                )}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Version indicator */}
          {currentProject && versions.length > 0 && (
            <div className="border-t border-gray-200 px-4 py-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="size-2 rounded-full bg-emerald-500" />
                <span className="text-[11px] font-medium text-gray-500">{currentProject.name}</span>
              </div>
              <button className="text-[11px] text-gray-400 hover:text-gray-500 flex items-center gap-1">
                <MoreHorizontal className="size-3" />
              </button>
            </div>
          )}

          {/* Input */}
          <div className="border-t border-gray-200 p-3">
            {/* 选中元素提示 + 操作 */}
            {selectedElement && (
              <div className="mb-2 rounded-lg bg-blue-50 border border-blue-200 px-3 py-2 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[11px] text-blue-600 font-medium shrink-0">
                      📌 {multiSelected.length > 1 ? `已选中 ${multiSelected.length} 个元素` : "已选中"}
                    </span>
                    {multiSelected.length <= 1 && (
                      <span className="text-[11px] text-blue-800 font-mono truncate">
                        &lt;{selectedElement.tagName}&gt; {selectedElement.text ? `"${selectedElement.text.slice(0, 20)}"` : ""}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => { setSelectedElement(null); setMultiSelected([]); }}
                    className="text-blue-400 hover:text-blue-600 shrink-0 ml-2"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
                {/* 多选列表 */}
                {multiSelected.length > 1 && (
                  <div className="flex flex-wrap gap-1">
                    {multiSelected.map((el, i) => (
                      <span key={i} className="text-[9px] text-blue-700 bg-blue-100 rounded px-1.5 py-0.5">
                        &lt;{el.tagName}&gt; {el.text.slice(0, 10)}
                      </span>
                    ))}
                  </div>
                )}
                {/* 快捷操作按钮 */}
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => { setInput(multiSelected.length > 1 ? "删除这些元素" : "删除这个元素"); }}
                    className="rounded-md px-2 py-1 text-[10px] font-medium text-rose-600 bg-rose-50 border border-rose-200 hover:bg-rose-100 transition"
                  >
                    删除
                  </button>
                  <button
                    onClick={() => { setInput(multiSelected.length > 1 ? "隐藏这些元素" : "隐藏这个元素"); }}
                    className="rounded-md px-2 py-1 text-[10px] font-medium text-gray-600 bg-gray-100 border border-gray-200 hover:bg-gray-200 transition"
                  >
                    隐藏
                  </button>
                  <button
                    onClick={() => { setInput("复制这个元素到下方"); }}
                    className="rounded-md px-2 py-1 text-[10px] font-medium text-gray-600 bg-gray-100 border border-gray-200 hover:bg-gray-200 transition"
                  >
                    复制
                  </button>
                  <button
                    onClick={() => { setInput("修改这个元素的样式："); }}
                    className="rounded-md px-2 py-1 text-[10px] font-medium text-violet-600 bg-violet-50 border border-violet-200 hover:bg-violet-100 transition"
                  >
                    改样式
                  </button>
                  <span className="text-[9px] text-gray-400 ml-auto">Shift+点击多选</span>
                </div>
              </div>
            )}
            <div className="relative">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="描述你想要的设计或修改..."
                className="w-full resize-none rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 pr-12 text-[13px] text-gray-800 placeholder-gray-400 outline-none focus:border-violet-500/30 focus:bg-gray-50 transition"
                rows={1}
                disabled={loading}
              />
              <button
                onClick={loading ? handleStop : handleGenerate}
                disabled={!loading && !input.trim()}
                data-generate-btn
                className={`absolute right-2 bottom-2 rounded-lg p-1.5 text-gray-800 transition disabled:opacity-30 disabled:cursor-not-allowed ${loading ? "bg-rose-600 hover:bg-rose-700" : "bg-violet-600 hover:bg-violet-700"}`}
              >
                {loading ? <X className="size-4" /> : <Send className="size-4" />}
              </button>
            </div>
            <div className="flex items-center justify-between mt-2 px-1">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleCreateProject()}
                  className="text-[11px] flex items-center gap-1 text-gray-400 hover:text-gray-600"
                >
                  <Plus className="size-3" />
                </button>
                {/* Multi-Agent 开关 */}
                <button
                  onClick={() => setMultiAgentEnabled(!multiAgentEnabled)}
                  className={`text-[10px] px-2 py-1 rounded-md flex items-center gap-1.5 transition border ${
                    multiAgentEnabled
                      ? "bg-violet-50 text-violet-700 border-violet-200"
                      : "bg-gray-50 text-gray-400 border-gray-200"
                  }`}
                  title={multiAgentEnabled ? "Multi-Agent 已开启（4步流水线）" : "Multi-Agent 已关闭（单Agent）"}
                >
                  <span className={`size-2 rounded-full ${multiAgentEnabled ? "bg-violet-500" : "bg-gray-300"}`} />
                  {multiAgentEnabled ? "多Agent" : "单Agent"}
                </button>
              </div>
              <div className="relative">
                <button
                  onClick={() => setShowModelPicker(!showModelPicker)}
                  className={`text-[11px] px-2 py-1 rounded-md flex items-center gap-1 transition ${theme === "dark" ? "text-gray-500 hover:text-gray-700 hover:bg-gray-100" : "text-gray-500 hover:text-gray-800 hover:bg-gray-100"}`}
                >
                  <Brain className="size-3" />
                  {availableModels.find((m) => m.id === selectedModel)?.name || "Auto"}
                  <ChevronDown className="size-3" />
                </button>
                {showModelPicker && (
                  <div className="absolute bottom-8 right-0 w-56 rounded-xl border border-gray-200 bg-white shadow-2xl overflow-hidden z-50">
                    <div className="max-h-[240px] overflow-y-auto">
                      {availableModels.map((m) => (
                        <button
                          key={m.id}
                          onClick={() => { setSelectedModel(m.id); setShowModelPicker(false); }}
                          className={`w-full text-left px-3 py-1.5 transition text-[11px] ${
                            selectedModel === m.id
                              ? "bg-violet-50 text-violet-700 font-medium"
                              : "text-gray-600 hover:bg-gray-50"
                          }`}
                        >
                          {m.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
            {/* Multi-Agent 角色说明 */}
            {multiAgentEnabled && (
              <div className="mt-2 px-1 flex items-center gap-1.5 flex-wrap">
                <span className="text-[9px] text-gray-400">流水线：</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600">🧠 产品经理</span>
                <span className="text-[9px] text-gray-300">→</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-green-50 text-green-600">🎨 设计师</span>
                <span className="text-[9px] text-gray-300">→</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-orange-50 text-orange-600">💻 开发者</span>
                <span className="text-[9px] text-gray-300">→</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-600">✨ 优化师</span>
              </div>
            )}
          </div>
        </>)}
        </div>

        {/* Right: Preview */}
        <div className="flex-1 flex flex-col overflow-hidden bg-[#f5f6f8]">
          {/* Preview area — 点阵画布 */}
          <div className="flex-1 flex items-center justify-center overflow-auto relative">
            {/* 点阵背景 */}
            <div className="absolute inset-0 pointer-events-none" style={{
              backgroundImage: "radial-gradient(circle, rgba(0,0,0,0.05) 1px, transparent 1px)",
              backgroundSize: "20px 20px",
            }} />

            {currentHtml ? (
              <div className="relative z-10 flex flex-col items-center">
                {/* 页面名称标注 */}
                {editingPage && (
                  <div className="mb-4 text-[13px] font-medium text-gray-500">{editingPage.name}</div>
                )}
                {/* iPhone 外壳 */}
                <div
                  className="relative bg-[#1a1a1a] rounded-[3rem] shadow-[0_20px_60px_rgba(0,0,0,0.15)] p-[10px] overflow-hidden"
                  style={{ width: 340, height: 700 }}
                >
                  {/* 内屏 */}
                  <div className="relative w-full h-full rounded-[2.2rem] overflow-hidden bg-white">
                    {/* 状态栏 */}
                    <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 pt-3 pb-1 bg-white/80 backdrop-blur-sm">
                      {/* 左：时间 */}
                      <span className="text-[12px] font-semibold text-black">9:41</span>
                      {/* 中：灵动岛 */}
                      <div className="absolute left-1/2 -translate-x-1/2 top-2.5 w-[90px] h-[24px] bg-black rounded-full" />
                      {/* 右：信号+WiFi+电池 */}
                      <div className="flex items-center gap-1">
                        {/* 信号 */}
                        <svg width="16" height="12" viewBox="0 0 16 12" fill="none" className="text-black">
                          <rect x="0" y="8" width="3" height="4" rx="0.5" fill="currentColor"/>
                          <rect x="4.5" y="5" width="3" height="7" rx="0.5" fill="currentColor"/>
                          <rect x="9" y="2" width="3" height="10" rx="0.5" fill="currentColor"/>
                          <rect x="13.5" y="0" width="2.5" height="12" rx="0.5" fill="currentColor" opacity="0.3"/>
                        </svg>
                        {/* WiFi */}
                        <svg width="14" height="12" viewBox="0 0 14 12" fill="none" className="text-black">
                          <path d="M7 10.5a1 1 0 100-2 1 1 0 000 2z" fill="currentColor"/>
                          <path d="M4.5 7.5a3.5 3.5 0 015 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                          <path d="M2.5 5.2a6.5 6.5 0 019 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                          <path d="M0.5 3a9.5 9.5 0 0113 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                        </svg>
                        {/* 电池 */}
                        <svg width="22" height="11" viewBox="0 0 22 11" fill="none" className="text-black">
                          <rect x="0.5" y="0.5" width="19" height="10" rx="2" stroke="currentColor" strokeWidth="1"/>
                          <rect x="20" y="3" width="1.5" height="5" rx="0.5" fill="currentColor" opacity="0.4"/>
                          <rect x="1.5" y="1.5" width="14" height="8" rx="1" fill="currentColor"/>
                        </svg>
                      </div>
                    </div>
                    {/* 页面内容 */}
                    <iframe
                      ref={iframeRef}
                      className="w-full h-full border-0"
                      sandbox="allow-scripts allow-same-origin"
                      title="Preview"
                    />
                    {/* 底部 Home Indicator */}
                    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 w-[120px] h-[4px] bg-black/20 rounded-full" />
                  </div>
                </div>
                {/* 设备标识 */}
                <div className="mt-3 flex items-center gap-2">
                  <span className="text-[10px] text-gray-400 bg-white rounded-md px-2 py-0.5 border border-gray-200">
                    {device.name} · {previewWidth}×{previewHeight}
                  </span>
                </div>
              </div>
            ) : loading ? (
              <div className="relative z-10 flex flex-col items-center">
                <div
                  className="bg-white rounded-[3rem] border-[3px] border-gray-200 overflow-hidden shadow-lg animate-pulse"
                  style={{ width: 320, height: 680 }}
                >
                  <div className="p-5 space-y-4">
                    <div className="h-4 bg-gray-200 rounded-full w-3/4" />
                    <div className="h-3 bg-gray-100 rounded-full w-1/2" />
                    <div className="h-40 bg-gray-100 rounded-2xl mt-6" />
                    <div className="grid grid-cols-3 gap-3 mt-4">
                      <div className="h-16 bg-gray-100 rounded-xl" />
                      <div className="h-16 bg-gray-100 rounded-xl" />
                      <div className="h-16 bg-gray-100 rounded-xl" />
                    </div>
                  </div>
                </div>
                <div className="mt-4 flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin text-violet-500" />
                  <span className="text-[12px] text-gray-500">正在生成设计...</span>
                </div>
              </div>
            ) : (
              <div className="relative z-10 text-center">
                <div className="size-16 rounded-2xl bg-gradient-to-br from-violet-100 to-purple-100 flex items-center justify-center mx-auto mb-4">
                  <Zap className="size-7 text-violet-500" />
                </div>
                <p className="text-[14px] font-medium text-gray-600">在左侧描述你的设计需求</p>
                <p className="text-[12px] text-gray-400 mt-1">Agent 会自动生成并实时预览</p>
              </div>
            )}
          </div>
        </div>

        {/* Properties Panel — 选中元素时显示 */}
        {selectedElement && selectedElement.styles && !showCode && (
          <div className="w-[240px] border-l border-gray-200 bg-white flex flex-col shrink-0 overflow-y-auto">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
              <span className="text-[12px] font-semibold text-gray-700">属性</span>
              <button onClick={() => { setSelectedElement(null); setMultiSelected([]); }} className="rounded-md p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100">
                <X className="size-3.5" />
              </button>
            </div>
            <div className="p-3 space-y-3">
              {/* 元素信息 */}
              <div className="text-[11px] text-gray-500 font-mono bg-gray-50 rounded-md px-2 py-1.5">
                &lt;{selectedElement.tagName}&gt;
              </div>
              {/* 文字内容 */}
              {selectedElement.text && (
                <div>
                  <label className="text-[10px] font-medium text-gray-500 mb-1 block">文字</label>
                  <div className="text-[11px] text-gray-700 bg-gray-50 rounded-md px-2 py-1.5 truncate">{selectedElement.text}</div>
                </div>
              )}
              {/* 尺寸 */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-medium text-gray-500 mb-1 block">宽度</label>
                  <div className="text-[11px] font-mono text-gray-700 bg-gray-50 rounded-md px-2 py-1.5">{selectedElement.styles.width}</div>
                </div>
                <div>
                  <label className="text-[10px] font-medium text-gray-500 mb-1 block">高度</label>
                  <div className="text-[11px] font-mono text-gray-700 bg-gray-50 rounded-md px-2 py-1.5">{selectedElement.styles.height}</div>
                </div>
              </div>
              {/* 圆角 */}
              <div>
                <label className="text-[10px] font-medium text-gray-500 mb-1 block">圆角</label>
                <div className="text-[11px] font-mono text-gray-700 bg-gray-50 rounded-md px-2 py-1.5">{selectedElement.styles.borderRadius}</div>
              </div>
              {/* 间距 */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-medium text-gray-500 mb-1 block">内边距</label>
                  <div className="text-[11px] font-mono text-gray-700 bg-gray-50 rounded-md px-2 py-1.5">{selectedElement.styles.padding}</div>
                </div>
                <div>
                  <label className="text-[10px] font-medium text-gray-500 mb-1 block">外边距</label>
                  <div className="text-[11px] font-mono text-gray-700 bg-gray-50 rounded-md px-2 py-1.5">{selectedElement.styles.margin}</div>
                </div>
              </div>
              {/* 颜色 */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-medium text-gray-500 mb-1 block">文字色</label>
                  <div className="flex items-center gap-1.5">
                    <div className="size-4 rounded border border-gray-200" style={{ backgroundColor: selectedElement.styles.color }} />
                    <span className="text-[10px] font-mono text-gray-600">{selectedElement.styles.color}</span>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-medium text-gray-500 mb-1 block">背景色</label>
                  <div className="flex items-center gap-1.5">
                    <div className="size-4 rounded border border-gray-200" style={{ backgroundColor: selectedElement.styles.backgroundColor }} />
                    <span className="text-[10px] font-mono text-gray-600">{selectedElement.styles.backgroundColor?.slice(0, 20)}</span>
                  </div>
                </div>
              </div>
              {/* 字体 */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-medium text-gray-500 mb-1 block">字号</label>
                  <div className="text-[11px] font-mono text-gray-700 bg-gray-50 rounded-md px-2 py-1.5">{selectedElement.styles.fontSize}</div>
                </div>
                <div>
                  <label className="text-[10px] font-medium text-gray-500 mb-1 block">字重</label>
                  <div className="text-[11px] font-mono text-gray-700 bg-gray-50 rounded-md px-2 py-1.5">{selectedElement.styles.fontWeight}</div>
                </div>
              </div>
              {/* 快捷修改 */}
              <div className="pt-2 border-t border-gray-100 space-y-1.5">
                <button onClick={() => setInput(`把这个元素的圆角改为 `)} className="w-full text-left rounded-md px-2 py-1.5 text-[11px] text-gray-600 hover:bg-violet-50 hover:text-violet-700 transition">修改圆角</button>
                <button onClick={() => setInput(`把这个元素的颜色改为 `)} className="w-full text-left rounded-md px-2 py-1.5 text-[11px] text-gray-600 hover:bg-violet-50 hover:text-violet-700 transition">修改颜色</button>
                <button onClick={() => setInput(`把这个元素的间距改为 `)} className="w-full text-left rounded-md px-2 py-1.5 text-[11px] text-gray-600 hover:bg-violet-50 hover:text-violet-700 transition">修改间距</button>
                <button onClick={() => setInput(`修改这个元素的文字为 `)} className="w-full text-left rounded-md px-2 py-1.5 text-[11px] text-gray-600 hover:bg-violet-50 hover:text-violet-700 transition">修改文字</button>
              </div>
            </div>
          </div>
        )}

        {/* Code Panel (slide from right) */}
        {showCode && currentHtml && (
          <div className={`w-[400px] border-l flex flex-col transition-colors ${theme === "dark" ? "border-gray-200 bg-white" : "border-gray-200 bg-white"}`}>
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200">
              <span className="text-[11px] font-medium text-gray-500">Source Code</span>
              <button onClick={() => setShowCode(false)} className="rounded p-1 text-gray-400 hover:text-gray-500">
                <X className="size-3.5" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              <pre className="text-[11px] font-mono text-emerald-300/60 leading-relaxed whitespace-pre-wrap break-all">
                {currentHtml}
              </pre>
            </div>
          </div>
        )}
      </div>

      {/* Projects Dropdown */}
      {showProjects && (
        <div className="absolute top-11 left-3 z-50 w-64 rounded-xl bg-gray-100 border border-gray-200 shadow-2xl shadow-black/60 overflow-hidden">
          <div className="p-2 border-b border-gray-200">
            <button
              onClick={() => handleCreateProject()}
              className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-[12px] text-gray-500 hover:bg-gray-100 hover:text-gray-700"
            >
              <Plus className="size-3.5" />新建项目
            </button>
          </div>
          <div className="max-h-[300px] overflow-y-auto p-1">
            {projects.map((p) => (
              <button
                key={p.id}
                onClick={() => handleOpenProject(p.id)}
                className={`w-full flex items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] transition ${
                  currentProject?.id === p.id
                    ? "bg-violet-500/10 text-violet-300"
                    : "text-gray-500 hover:bg-gray-100 hover:text-gray-700"
                }`}
              >
                <FileCode className="size-3.5 shrink-0" />
                <span className="truncate">{p.name}</span>
              </button>
            ))}
            {projects.length === 0 && (
              <p className="text-center text-[11px] text-gray-300 py-4">暂无项目</p>
            )}
          </div>
        </div>
      )}

      {/* 导出面板 */}
      {showExport && currentHtml && (
        <ExportPanel
          html={currentHtml}
          projectId={currentProject?.id || ""}
          pageId={editingPage?.id || ""}
          pageName={editingPage?.name || currentProject?.name || "design"}
          onClose={() => setShowExport(false)}
        />
      )}

      {/* 项目配置面板 */}
      </>)}
      </>)}

      {/* 项目配置面板 — 放在最外层 */}
      {showProjectSetup && (
        <ProjectSetup
          onComplete={handleProjectSetupComplete}
          onCancel={() => setShowProjectSetup(false)}
        />
      )}
    </div>
  );
}
