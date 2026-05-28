"use client";

import { useState } from "react";
import {
  Code2,
  Copy,
  Download,
  FileCode,
  Image as ImageIcon,
  Loader2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { httpRequest } from "@/lib/request";

type Props = {
  html: string;
  projectId: string;
  pageId: string;
  pageName: string;
  onClose: () => void;
};

export function ExportPanel({ html, projectId, pageId, pageName, onClose }: Props) {
  const [converting, setConverting] = useState(false);
  const [convertedCode, setConvertedCode] = useState("");
  const [convertTarget, setConvertTarget] = useState("");

  // HTML 导出
  const handleExportHtml = () => {
    const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pageName}</title>
  <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;}</style>
</head>
<body>
${html}
</body>
</html>`;
    const blob = new Blob([fullHtml], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${pageName}.html`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("HTML 已导出");
  };

  // Vue/React 转换
  const handleConvert = async (target: "vue" | "react") => {
    setConverting(true);
    setConvertTarget(target);
    setConvertedCode("");
    try {
      const data = await httpRequest<{ code: string }>("/api/design/export/convert", {
        method: "POST",
        body: { html, target },
      });
      setConvertedCode(data.code);
    } catch (err: any) {
      toast.error(err?.message || "转换失败");
    } finally {
      setConverting(false);
    }
  };

  // 复制代码
  const handleCopy = () => {
    navigator.clipboard.writeText(convertedCode);
    toast.success("已复制到剪贴板");
  };

  // 下载转换后的代码
  const handleDownloadCode = () => {
    const ext = convertTarget === "vue" ? "vue" : "jsx";
    const blob = new Blob([convertedCode], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${pageName}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`${ext.toUpperCase()} 文件已导出`);
  };

  // PNG 截图
  const handleScreenshot = async () => {
    try {
      const iframe = document.querySelector("#preview-container iframe") as HTMLIFrameElement;
      if (!iframe?.contentDocument?.body) {
        toast.error("无法截图，请确保预览已加载");
        return;
      }
      // 动态加载 html2canvas
      const { default: html2canvas } = await import("html2canvas");
      const canvas = await html2canvas(iframe.contentDocument.body, {
        width: 375,
        height: 812,
        scale: 2,
        useCORS: true,
        allowTaint: true,
      });
      const url = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = `${pageName}.png`;
      a.click();
      toast.success("截图已导出");
    } catch (err: any) {
      toast.error("截图失败：" + (err?.message || "未知错误"));
    }
  };

  // Figma 预览链接
  const handleFigmaLink = () => {
    const previewUrl = `${window.location.origin}/api/design/preview/${projectId}/${pageId}`;
    navigator.clipboard.writeText(previewUrl);
    toast.success("预览链接已复制，请在 Figma 的 html.to.design 插件中粘贴");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div className="w-[480px] rounded-2xl bg-white border border-gray-200 shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-[15px] font-semibold text-gray-800">导出设计</h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100">
            <X className="size-4" />
          </button>
        </div>

        {/* 转换结果 */}
        {convertedCode ? (
          <div className="p-5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-medium text-gray-700">
                {convertTarget === "vue" ? "Vue 3 组件" : "React 组件"}
              </span>
              <div className="flex items-center gap-2">
                <button onClick={handleCopy} className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 transition">
                  <Copy className="size-3" /> 复制
                </button>
                <button onClick={handleDownloadCode} className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium text-white bg-violet-600 hover:bg-violet-700 transition">
                  <Download className="size-3" /> 下载
                </button>
              </div>
            </div>
            <pre className="rounded-xl bg-gray-900 p-4 text-[11px] text-green-300 font-mono leading-relaxed max-h-[300px] overflow-auto whitespace-pre-wrap">
              {convertedCode}
            </pre>
            <button onClick={() => setConvertedCode("")} className="text-[12px] text-gray-400 hover:text-gray-600">
              ← 返回导出选项
            </button>
          </div>
        ) : (
          /* 导出选项列表 */
          <div className="p-4 space-y-1.5">
            {/* HTML */}
            <button onClick={handleExportHtml} className="w-full flex items-center gap-3 rounded-xl px-4 py-3 text-left hover:bg-gray-50 transition group">
              <div className="size-9 rounded-lg bg-orange-100 flex items-center justify-center">
                <FileCode className="size-4 text-orange-600" />
              </div>
              <div>
                <div className="text-[13px] font-medium text-gray-800">HTML 文件</div>
                <div className="text-[11px] text-gray-400">完整的 HTML 页面，可直接在浏览器打开</div>
              </div>
            </button>

            {/* Vue */}
            <button onClick={() => handleConvert("vue")} disabled={converting} className="w-full flex items-center gap-3 rounded-xl px-4 py-3 text-left hover:bg-gray-50 transition group disabled:opacity-50">
              <div className="size-9 rounded-lg bg-green-100 flex items-center justify-center">
                {converting && convertTarget === "vue" ? <Loader2 className="size-4 text-green-600 animate-spin" /> : <Code2 className="size-4 text-green-600" />}
              </div>
              <div>
                <div className="text-[13px] font-medium text-gray-800">Vue 3 组件</div>
                <div className="text-[11px] text-gray-400">转换为 .vue 单文件组件（SFC）</div>
              </div>
            </button>

            {/* React */}
            <button onClick={() => handleConvert("react")} disabled={converting} className="w-full flex items-center gap-3 rounded-xl px-4 py-3 text-left hover:bg-gray-50 transition group disabled:opacity-50">
              <div className="size-9 rounded-lg bg-blue-100 flex items-center justify-center">
                {converting && convertTarget === "react" ? <Loader2 className="size-4 text-blue-600 animate-spin" /> : <Code2 className="size-4 text-blue-600" />}
              </div>
              <div>
                <div className="text-[13px] font-medium text-gray-800">React 组件</div>
                <div className="text-[11px] text-gray-400">转换为 .jsx 函数组件</div>
              </div>
            </button>

            {/* PNG */}
            <button onClick={handleScreenshot} className="w-full flex items-center gap-3 rounded-xl px-4 py-3 text-left hover:bg-gray-50 transition group">
              <div className="size-9 rounded-lg bg-purple-100 flex items-center justify-center">
                <ImageIcon className="size-4 text-purple-600" />
              </div>
              <div>
                <div className="text-[13px] font-medium text-gray-800">PNG 截图</div>
                <div className="text-[11px] text-gray-400">高清截图，可直接分享或导入设计工具</div>
              </div>
            </button>

            {/* Figma */}
            <button onClick={handleFigmaLink} className="w-full flex items-center gap-3 rounded-xl px-4 py-3 text-left hover:bg-gray-50 transition group">
              <div className="size-9 rounded-lg bg-pink-100 flex items-center justify-center">
                <svg className="size-4 text-pink-600" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M5 5.5A3.5 3.5 0 018.5 2H12v7H8.5A3.5 3.5 0 015 5.5zM12 2h3.5a3.5 3.5 0 110 7H12V2zm0 12.5a3.5 3.5 0 11-7 0 3.5 3.5 0 017 0zm1-5a3.5 3.5 0 107 0 3.5 3.5 0 00-7 0zM5 19a3.5 3.5 0 013.5-3.5H12V19a3.5 3.5 0 11-7 0z"/>
                </svg>
              </div>
              <div>
                <div className="text-[13px] font-medium text-gray-800">Figma 导入</div>
                <div className="text-[11px] text-gray-400">复制预览链接，在 Figma 的 html.to.design 插件中粘贴</div>
              </div>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
