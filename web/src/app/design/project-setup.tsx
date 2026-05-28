"use client";

import { useState } from "react";
import {
  Brain,
  Loader2,
  Monitor,
  Palette,
  Smartphone,
  Sparkles,
  Tablet,
  X,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { httpRequest } from "@/lib/request";

type Props = {
  onComplete: (config: ProjectConfig) => void;
  onCancel: () => void;
};

export type ProjectConfig = {
  name: string;
  role_id: string;
  brand_colors: Record<string, string>;
  preset_id: string;
  device: string;
};

const ROLES = [
  { id: "", name: "默认", icon: "🤖", desc: "通用设计" },
  { id: "designer", name: "创意设计师", icon: "🎨", desc: "大胆配色、动效丰富" },
  { id: "engineer", name: "严谨工程师", icon: "📐", desc: "规范优先、组件化" },
  { id: "growth", name: "增长黑客", icon: "🚀", desc: "转化率优先" },
  { id: "mobile", name: "移动端专家", icon: "📱", desc: "触摸优化、原生感" },
  { id: "minimalist", name: "极简主义", icon: "⬜", desc: "留白、克制" },
];

const PRESETS = [
  { id: "", name: "不选预设", icon: "⚡", desc: "AI 自动匹配" },
  { id: "saas-full", name: "SaaS 产品", icon: "🚀", desc: "落地页+后台" },
  { id: "mobile-app", name: "移动端 App", icon: "📱", desc: "手机应用" },
  { id: "ecommerce", name: "电商设计", icon: "🛒", desc: "商品+购物" },
  { id: "dashboard", name: "管理后台", icon: "📊", desc: "数据面板" },
  { id: "dark-theme", name: "暗色主题", icon: "🌙", desc: "深色风格" },
];

const DEVICES = [
  { id: "mobile", name: "iPhone 16", icon: <Smartphone className="size-5" />, size: "393×852" },
  { id: "tablet", name: "iPad Air", icon: <Tablet className="size-5" />, size: "820×1180" },
  { id: "desktop", name: "Desktop", icon: <Monitor className="size-5" />, size: "1440×900" },
];

export function ProjectSetup({ onComplete, onCancel }: Props) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState("");
  const [presetId, setPresetId] = useState("");
  const [device, setDevice] = useState("mobile");
  const [brandColors, setBrandColors] = useState<Record<string, string>>({});
  const [colorKeywords, setColorKeywords] = useState("");
  const [generatingColors, setGeneratingColors] = useState(false);

  const handleGenerateColors = async () => {
    if (!colorKeywords.trim()) return;
    setGeneratingColors(true);
    try {
      const data = await httpRequest<{ colors: Record<string, string> }>("/api/design/agent/generate-colors", {
        method: "POST",
        body: { keywords: colorKeywords },
      });
      setBrandColors(data.colors);
      toast.success("配色方案已生成");
    } catch (err: any) {
      toast.error(err?.message || "生成失败");
    } finally {
      setGeneratingColors(false);
    }
  };

  const handleComplete = () => {
    if (!name.trim()) {
      toast.error("请输入项目名称");
      return;
    }
    onComplete({
      name: name.trim(),
      role_id: roleId,
      brand_colors: brandColors,
      preset_id: presetId,
      device,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="w-[560px] max-h-[85vh] rounded-2xl bg-white border border-gray-200 shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-[16px] font-semibold text-gray-800">新建项目</h3>
            <p className="text-[12px] text-gray-400 mt-0.5">步骤 {step} / 3</p>
          </div>
          <button onClick={onCancel} className="rounded-lg p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100">
            <X className="size-4" />
          </button>
        </div>

        {/* Progress bar */}
        <div className="h-1 bg-gray-100">
          <div className="h-full bg-violet-500 transition-all duration-300" style={{ width: `${(step / 3) * 100}%` }} />
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Step 1: 名称 + 角色 */}
          {step === 1 && (
            <div className="space-y-6">
              <div>
                <label className="text-[13px] font-medium text-gray-700 mb-2 block">项目名称</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="如：我的电商App、SaaS官网..."
                  className="w-full rounded-xl border border-gray-200 px-4 py-3 text-[14px] outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                  autoFocus
                />
              </div>
              <div>
                <label className="text-[13px] font-medium text-gray-700 mb-2 block">选择 Agent 角色</label>
                <div className="grid grid-cols-3 gap-2">
                  {ROLES.map((role) => (
                    <button
                      key={role.id}
                      onClick={() => setRoleId(role.id)}
                      className={`rounded-xl border p-3 text-left transition ${
                        roleId === role.id
                          ? "border-violet-400 bg-violet-50 ring-2 ring-violet-100"
                          : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                      }`}
                    >
                      <div className="text-[18px] mb-1">{role.icon}</div>
                      <div className="text-[11px] font-medium text-gray-800">{role.name}</div>
                      <div className="text-[10px] text-gray-400">{role.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Step 2: 配色 + 预设 */}
          {step === 2 && (
            <div className="space-y-6">
              <div>
                <label className="text-[13px] font-medium text-gray-700 mb-2 block">
                  <Palette className="size-4 inline mr-1.5 text-violet-500" />
                  品牌配色
                </label>
                <div className="flex items-center gap-2 mb-3">
                  <input
                    value={colorKeywords}
                    onChange={(e) => setColorKeywords(e.target.value)}
                    placeholder="输入风格关键词，如：科技蓝、温暖橙、清新绿..."
                    className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-[13px] outline-none focus:border-violet-400"
                    onKeyDown={(e) => e.key === "Enter" && handleGenerateColors()}
                  />
                  <button
                    onClick={handleGenerateColors}
                    disabled={generatingColors || !colorKeywords.trim()}
                    className="rounded-lg bg-violet-600 px-4 py-2 text-[12px] font-medium text-white hover:bg-violet-700 disabled:opacity-40 flex items-center gap-1.5"
                  >
                    {generatingColors ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                    生成
                  </button>
                </div>
                {/* 配色预览 */}
                {Object.keys(brandColors).length > 0 && (
                  <div className="flex items-center gap-3 p-3 rounded-xl bg-gray-50 border border-gray-200">
                    {Object.entries(brandColors).map(([key, color]) => (
                      <div key={key} className="flex flex-col items-center gap-1">
                        <div className="size-10 rounded-lg border border-gray-200 shadow-sm" style={{ backgroundColor: color }} />
                        <span className="text-[9px] text-gray-500">{key === "primary" ? "主色" : key === "secondary" ? "辅色" : key === "accent" ? "强调" : "背景"}</span>
                        <span className="text-[9px] font-mono text-gray-400">{color}</span>
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-[11px] text-gray-400 mt-2">留空则由 AI 自动配色</p>
              </div>
              <div>
                <label className="text-[13px] font-medium text-gray-700 mb-2 block">
                  <Zap className="size-4 inline mr-1.5 text-violet-500" />
                  Skill 预设
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      onClick={() => setPresetId(preset.id)}
                      className={`rounded-xl border p-3 text-left transition ${
                        presetId === preset.id
                          ? "border-violet-400 bg-violet-50 ring-2 ring-violet-100"
                          : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                      }`}
                    >
                      <div className="text-[16px] mb-1">{preset.icon}</div>
                      <div className="text-[11px] font-medium text-gray-800">{preset.name}</div>
                      <div className="text-[10px] text-gray-400">{preset.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Step 3: 设备 */}
          {step === 3 && (
            <div className="space-y-6">
              <div>
                <label className="text-[13px] font-medium text-gray-700 mb-3 block">选择设备类型</label>
                <div className="grid grid-cols-3 gap-3">
                  {DEVICES.map((d) => (
                    <button
                      key={d.id}
                      onClick={() => setDevice(d.id)}
                      className={`rounded-xl border p-5 text-center transition ${
                        device === d.id
                          ? "border-violet-400 bg-violet-50 ring-2 ring-violet-100"
                          : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                      }`}
                    >
                      <div className={`mx-auto mb-2 ${device === d.id ? "text-violet-600" : "text-gray-400"}`}>{d.icon}</div>
                      <div className="text-[12px] font-medium text-gray-800">{d.name}</div>
                      <div className="text-[10px] text-gray-400 mt-0.5">{d.size}</div>
                    </button>
                  ))}
                </div>
              </div>
              {/* 配置摘要 */}
              <div className="rounded-xl bg-gray-50 border border-gray-200 p-4 space-y-2">
                <div className="text-[12px] font-medium text-gray-700 mb-2">配置摘要</div>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-gray-500">项目名称</span>
                  <span className="text-gray-800 font-medium">{name || "未填写"}</span>
                </div>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-gray-500">Agent 角色</span>
                  <span className="text-gray-800">{ROLES.find((r) => r.id === roleId)?.name || "默认"}</span>
                </div>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-gray-500">配色方案</span>
                  <span className="text-gray-800">{Object.keys(brandColors).length > 0 ? "已设置" : "AI 自动"}</span>
                </div>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-gray-500">Skill 预设</span>
                  <span className="text-gray-800">{PRESETS.find((p) => p.id === presetId)?.name || "自动匹配"}</span>
                </div>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-gray-500">设备</span>
                  <span className="text-gray-800">{DEVICES.find((d) => d.id === device)?.name}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100">
          <button
            onClick={() => step > 1 ? setStep(step - 1) : onCancel()}
            className="rounded-lg px-4 py-2 text-[13px] text-gray-600 hover:bg-gray-100 transition"
          >
            {step > 1 ? "上一步" : "取消"}
          </button>
          <button
            onClick={() => step < 3 ? setStep(step + 1) : handleComplete()}
            className="rounded-lg bg-violet-600 px-6 py-2 text-[13px] font-medium text-white hover:bg-violet-700 transition"
          >
            {step < 3 ? "下一步" : "创建项目"}
          </button>
        </div>
      </div>
    </div>
  );
}
