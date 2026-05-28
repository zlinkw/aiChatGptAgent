"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Brain,
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  Package,
  Palette,
  Plus,
  Search,
  Sparkles,
  Trash2,
  User,
  X,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { httpRequest } from "@/lib/request";

type Skill = {
  name: string;
  description: string;
  installed?: boolean;
  source_url?: string;
  body_preview?: string;
};

type SkillDetail = {
  name: string;
  description: string;
  body: string;
};

type Preset = {
  id: string;
  name: string;
  icon: string;
  description: string;
  skills: string[];
  skills_status: { name: string; installed: boolean }[];
};

type Role = {
  id: string;
  name: string;
  icon: string;
  prompt: string;
};

type Persona = {
  role_id: string;
  custom_prompt: string;
  style_keywords: string[];
  brand_colors: Record<string, string>;
  active_preset: string;
};

type AgentPanelTab = "skills" | "persona" | "presets";

export function AgentPanel({ theme }: { theme: "dark" | "light" }) {
  const [tab, setTab] = useState<AgentPanelTab>("skills");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [discoveredSkills, setDiscoveredSkills] = useState<Skill[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [persona, setPersona] = useState<Persona>({
    role_id: "",
    custom_prompt: "",
    style_keywords: [],
    brand_colors: {},
    active_preset: "",
  });
  const [loading, setLoading] = useState(false);
  const [showDiscover, setShowDiscover] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null>(null);
  const [customName, setCustomName] = useState("");
  const [customDesc, setCustomDesc] = useState("");
  const [customBody, setCustomBody] = useState("");
  const [newKeyword, setNewKeyword] = useState("");

  const isDark = theme === "dark";
  const bg = isDark ? "bg-[#141416]" : "bg-white";
  const border = isDark ? "border-white/[0.06]" : "border-gray-200";
  const textPrimary = isDark ? "text-white/90" : "text-gray-900";
  const textSecondary = isDark ? "text-white/50" : "text-gray-500";
  const textMuted = isDark ? "text-white/30" : "text-gray-400";
  const hoverBg = isDark ? "hover:bg-white/5" : "hover:bg-gray-50";
  const cardBg = isDark ? "bg-white/[0.03]" : "bg-gray-50";
  const cardBorder = isDark ? "border-white/[0.08]" : "border-gray-200";

  // Load data
  const loadSkills = useCallback(async () => {
    try {
      const data = await httpRequest<{ skills: Skill[] }>("/api/design/agent/skills");
      setSkills(data.skills);
    } catch {}
  }, []);

  const loadPresets = useCallback(async () => {
    try {
      const data = await httpRequest<{ presets: Preset[] }>("/api/design/agent/presets");
      setPresets(data.presets);
    } catch {}
  }, []);

  const loadRoles = useCallback(async () => {
    try {
      const data = await httpRequest<{ roles: Role[] }>("/api/design/agent/roles");
      setRoles(data.roles);
    } catch {}
  }, []);

  const loadPersona = useCallback(async () => {
    try {
      const data = await httpRequest<{ persona: Persona }>("/api/design/agent/persona");
      setPersona(data.persona);
    } catch {}
  }, []);

  useEffect(() => {
    void loadSkills();
    void loadPresets();
    void loadRoles();
    void loadPersona();
  }, [loadSkills, loadPresets, loadRoles, loadPersona]);

  // Skill actions
  const handleDiscover = async () => {
    setShowDiscover(true);
    setLoading(true);
    try {
      const data = await httpRequest<{ skills: Skill[] }>("/api/design/agent/skills/discover");
      setDiscoveredSkills(data.skills.filter((s) => !s.installed));
    } catch (err: any) {
      toast.error(err?.message || "发现失败");
    } finally {
      setLoading(false);
    }
  };

  const handleInstall = async (skill: Skill) => {
    try {
      await httpRequest("/api/design/agent/skills/install", {
        method: "POST",
        body: { name: skill.name, source_url: skill.source_url || "" },
      });
      toast.success(`已安装 ${skill.name}`);
      setDiscoveredSkills((prev) => prev.filter((s) => s.name !== skill.name));
      await loadSkills();
    } catch (err: any) {
      toast.error(err?.message || "安装失败");
    }
  };

  const handleUninstall = async (name: string) => {
    try {
      await httpRequest(`/api/design/agent/skills/${name}`, { method: "DELETE" });
      toast.success(`已卸载 ${name}`);
      await loadSkills();
    } catch (err: any) {
      toast.error(err?.message || "卸载失败");
    }
  };

  const handleViewDetail = async (name: string) => {
    if (expandedSkill === name) {
      setExpandedSkill(null);
      setSkillDetail(null);
      return;
    }
    setExpandedSkill(name);
    try {
      const data = await httpRequest<{ skill: SkillDetail }>(`/api/design/agent/skills/${name}/detail`);
      setSkillDetail(data.skill);
    } catch {
      setSkillDetail(null);
    }
  };

  const handleAddCustom = async () => {
    if (!customName.trim() || !customDesc.trim()) {
      toast.error("请填写名称和描述");
      return;
    }
    try {
      await httpRequest("/api/design/agent/skills/custom", {
        method: "POST",
        body: { name: customName, description: customDesc, body: customBody },
      });
      toast.success(`已添加自定义 Skill: ${customName}`);
      setCustomName("");
      setCustomDesc("");
      setCustomBody("");
      setShowCustom(false);
      await loadSkills();
    } catch (err: any) {
      toast.error(err?.message || "添加失败");
    }
  };

  // Persona actions
  const handleSavePersona = async (updates: Partial<Persona>) => {
    const newPersona = { ...persona, ...updates };
    setPersona(newPersona);
    try {
      await httpRequest("/api/design/agent/persona", {
        method: "PUT",
        body: newPersona,
      });
    } catch (err: any) {
      toast.error(err?.message || "保存失败");
    }
  };

  const handleAddKeyword = () => {
    const kw = newKeyword.trim();
    if (!kw) return;
    if (persona.style_keywords.includes(kw)) return;
    handleSavePersona({ style_keywords: [...persona.style_keywords, kw] });
    setNewKeyword("");
  };

  const handleRemoveKeyword = (kw: string) => {
    handleSavePersona({ style_keywords: persona.style_keywords.filter((k) => k !== kw) });
  };

  // Preset actions
  const handleActivatePreset = async (presetId: string) => {
    try {
      await httpRequest("/api/design/agent/presets/activate", {
        method: "POST",
        body: { preset_id: presetId },
      });
      handleSavePersona({ active_preset: presetId });
      toast.success("已激活预设");
      await loadSkills();
      await loadPresets();
    } catch (err: any) {
      toast.error(err?.message || "激活失败");
    }
  };

  const tabs: { id: AgentPanelTab; label: string; icon: typeof Brain }[] = [
    { id: "skills", label: "Skills", icon: Zap },
    { id: "persona", label: "人设", icon: User },
    { id: "presets", label: "预设", icon: Package },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className={`flex items-center gap-0.5 px-3 pt-3 pb-2`}>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium transition ${
              tab === t.id
                ? isDark
                  ? "bg-violet-500/15 text-violet-300"
                  : "bg-violet-50 text-violet-700"
                : `${textSecondary} ${hoverBg}`
            }`}
          >
            <t.icon className="size-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-3 pb-4">
        {/* ===== Skills Tab ===== */}
        {tab === "skills" && (
          <div className="space-y-3">
            {/* Installed skills */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className={`text-[11px] font-medium ${textSecondary}`}>
                  已安装 ({skills.length})
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setShowCustom(!showCustom)}
                    className={`rounded-md p-1 ${textMuted} ${hoverBg}`}
                    title="自定义 Skill"
                  >
                    <Plus className="size-3.5" />
                  </button>
                  <button
                    onClick={handleDiscover}
                    className={`rounded-md p-1 ${textMuted} ${hoverBg}`}
                    title="发现更多"
                  >
                    <Search className="size-3.5" />
                  </button>
                </div>
              </div>

              {skills.length === 0 && (
                <p className={`text-[11px] ${textMuted} text-center py-4`}>
                  暂无已安装的 Skill
                </p>
              )}

              {skills.map((skill) => (
                <div key={skill.name} className={`rounded-lg border ${cardBorder} ${cardBg} overflow-hidden`}>
                  <div className="flex items-center justify-between px-3 py-2">
                    <button
                      onClick={() => handleViewDetail(skill.name)}
                      className="flex items-center gap-2 flex-1 min-w-0 text-left"
                    >
                      <ChevronRight
                        className={`size-3 ${textMuted} transition shrink-0 ${
                          expandedSkill === skill.name ? "rotate-90" : ""
                        }`}
                      />
                      <div className="min-w-0">
                        <div className={`text-[12px] font-medium ${textPrimary} truncate`}>
                          {skill.name}
                        </div>
                        <div className={`text-[10px] ${textMuted} truncate`}>
                          {skill.description}
                        </div>
                      </div>
                    </button>
                    <button
                      onClick={() => handleUninstall(skill.name)}
                      className="rounded p-1 text-rose-400/60 hover:text-rose-400 hover:bg-rose-500/10 shrink-0"
                      title="卸载"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>

                  {/* Expanded detail */}
                  {expandedSkill === skill.name && skillDetail && (
                    <div className={`border-t ${cardBorder} px-3 py-2`}>
                      <pre className={`text-[10px] ${textMuted} leading-relaxed whitespace-pre-wrap max-h-[200px] overflow-y-auto`}>
                        {skillDetail.body}
                      </pre>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Custom skill form */}
            {showCustom && (
              <div className={`rounded-lg border ${cardBorder} ${cardBg} p-3 space-y-2`}>
                <div className="flex items-center justify-between">
                  <span className={`text-[11px] font-medium ${textPrimary}`}>自定义 Skill</span>
                  <button onClick={() => setShowCustom(false)} className={`${textMuted} ${hoverBg} rounded p-0.5`}>
                    <X className="size-3" />
                  </button>
                </div>
                <input
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="Skill 名称（英文，如 my-brand-style）"
                  className={`w-full rounded-md border ${cardBorder} ${cardBg} px-2.5 py-1.5 text-[11px] ${textPrimary} placeholder:${textMuted} outline-none focus:border-violet-500/30`}
                />
                <input
                  value={customDesc}
                  onChange={(e) => setCustomDesc(e.target.value)}
                  placeholder="描述（什么时候使用这个 Skill）"
                  className={`w-full rounded-md border ${cardBorder} ${cardBg} px-2.5 py-1.5 text-[11px] ${textPrimary} placeholder:${textMuted} outline-none focus:border-violet-500/30`}
                />
                <textarea
                  value={customBody}
                  onChange={(e) => setCustomBody(e.target.value)}
                  placeholder="Skill 内容（设计规范、代码模板等 Markdown 格式）"
                  rows={5}
                  className={`w-full rounded-md border ${cardBorder} ${cardBg} px-2.5 py-1.5 text-[11px] ${textPrimary} placeholder:${textMuted} outline-none focus:border-violet-500/30 resize-none`}
                />
                <button
                  onClick={handleAddCustom}
                  className="w-full rounded-md bg-violet-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-violet-700 transition"
                >
                  添加
                </button>
              </div>
            )}

            {/* Discover panel */}
            {showDiscover && (
              <div className={`rounded-lg border ${cardBorder} ${cardBg} p-3 space-y-2`}>
                <div className="flex items-center justify-between">
                  <span className={`text-[11px] font-medium ${textPrimary}`}>发现 Skills</span>
                  <button onClick={() => setShowDiscover(false)} className={`${textMuted} ${hoverBg} rounded p-0.5`}>
                    <X className="size-3" />
                  </button>
                </div>
                {loading ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className={`size-4 animate-spin ${textMuted}`} />
                  </div>
                ) : discoveredSkills.length === 0 ? (
                  <p className={`text-[11px] ${textMuted} text-center py-3`}>
                    没有发现新的 Skill
                  </p>
                ) : (
                  <div className="space-y-1.5 max-h-[250px] overflow-y-auto">
                    {discoveredSkills.map((skill) => (
                      <div
                        key={skill.name}
                        className={`flex items-center justify-between rounded-md border ${cardBorder} px-2.5 py-2`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className={`text-[11px] font-medium ${textPrimary} truncate`}>
                            {skill.name}
                          </div>
                          <div className={`text-[10px] ${textMuted} truncate`}>
                            {skill.description}
                          </div>
                        </div>
                        <button
                          onClick={() => handleInstall(skill)}
                          className="shrink-0 rounded-md bg-violet-600/20 px-2 py-1 text-[10px] font-medium text-violet-300 hover:bg-violet-600/30 transition"
                        >
                          <Download className="size-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ===== Persona Tab ===== */}
        {tab === "persona" && (
          <div className="space-y-4">
            {/* Agent Role */}
            <div className="space-y-2">
              <span className={`text-[11px] font-medium ${textSecondary}`}>Agent 角色</span>
              <div className="grid grid-cols-2 gap-1.5">
                {roles.map((role) => (
                  <button
                    key={role.id}
                    onClick={() => handleSavePersona({ role_id: role.id })}
                    className={`rounded-lg border px-2.5 py-2 text-left transition ${
                      persona.role_id === role.id
                        ? isDark
                          ? "border-violet-500/40 bg-violet-500/10"
                          : "border-violet-300 bg-violet-50"
                        : `${cardBorder} ${cardBg} ${hoverBg}`
                    }`}
                  >
                    <div className="text-[13px] mb-0.5">{role.icon}</div>
                    <div className={`text-[10px] font-medium ${persona.role_id === role.id ? (isDark ? "text-violet-300" : "text-violet-700") : textPrimary}`}>
                      {role.name}
                    </div>
                  </button>
                ))}
                {/* 清除选择 */}
                <button
                  onClick={() => handleSavePersona({ role_id: "" })}
                  className={`rounded-lg border px-2.5 py-2 text-left transition ${
                    !persona.role_id
                      ? isDark
                        ? "border-violet-500/40 bg-violet-500/10"
                        : "border-violet-300 bg-violet-50"
                      : `${cardBorder} ${cardBg} ${hoverBg}`
                  }`}
                >
                  <div className="text-[13px] mb-0.5">🤖</div>
                  <div className={`text-[10px] font-medium ${!persona.role_id ? (isDark ? "text-violet-300" : "text-violet-700") : textPrimary}`}>
                    默认
                  </div>
                </button>
              </div>
            </div>

            {/* Custom prompt */}
            <div className="space-y-2">
              <span className={`text-[11px] font-medium ${textSecondary}`}>自定义指令</span>
              <textarea
                value={persona.custom_prompt}
                onChange={(e) => setPersona({ ...persona, custom_prompt: e.target.value })}
                onBlur={() => handleSavePersona({ custom_prompt: persona.custom_prompt })}
                placeholder="告诉 Agent 你的额外要求，比如：&#10;• 所有设计使用圆角 16px&#10;• 偏好无衬线字体&#10;• 不要使用渐变"
                rows={4}
                className={`w-full rounded-lg border ${cardBorder} ${cardBg} px-3 py-2 text-[11px] ${textPrimary} placeholder:${textMuted} outline-none focus:border-violet-500/30 resize-none leading-relaxed`}
              />
            </div>

            {/* Style keywords */}
            <div className="space-y-2">
              <span className={`text-[11px] font-medium ${textSecondary}`}>风格关键词</span>
              <div className="flex flex-wrap gap-1.5">
                {persona.style_keywords.map((kw) => (
                  <span
                    key={kw}
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${
                      isDark ? "bg-violet-500/15 text-violet-300" : "bg-violet-50 text-violet-700"
                    }`}
                  >
                    {kw}
                    <button onClick={() => handleRemoveKeyword(kw)} className="hover:text-rose-400">
                      <X className="size-2.5" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  value={newKeyword}
                  onChange={(e) => setNewKeyword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddKeyword()}
                  placeholder="添加关键词（回车确认）"
                  className={`flex-1 rounded-md border ${cardBorder} ${cardBg} px-2.5 py-1.5 text-[11px] ${textPrimary} placeholder:${textMuted} outline-none focus:border-violet-500/30`}
                />
                <button
                  onClick={handleAddKeyword}
                  className={`rounded-md p-1.5 ${textMuted} ${hoverBg}`}
                >
                  <Plus className="size-3.5" />
                </button>
              </div>
            </div>

            {/* Brand colors */}
            <div className="space-y-2">
              <span className={`text-[11px] font-medium ${textSecondary}`}>品牌配色</span>
              <div className="space-y-1.5">
                {["primary", "secondary", "accent", "background"].map((key) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className={`text-[10px] ${textMuted} w-16`}>
                      {key === "primary" ? "主色" : key === "secondary" ? "辅色" : key === "accent" ? "强调色" : "背景色"}
                    </span>
                    <input
                      type="color"
                      value={persona.brand_colors[key] || "#8b5cf6"}
                      onChange={(e) => {
                        const newColors = { ...persona.brand_colors, [key]: e.target.value };
                        setPersona({ ...persona, brand_colors: newColors });
                      }}
                      onBlur={() => handleSavePersona({ brand_colors: persona.brand_colors })}
                      className="size-6 rounded border-0 cursor-pointer"
                    />
                    <input
                      value={persona.brand_colors[key] || ""}
                      onChange={(e) => {
                        const newColors = { ...persona.brand_colors, [key]: e.target.value };
                        setPersona({ ...persona, brand_colors: newColors });
                      }}
                      onBlur={() => handleSavePersona({ brand_colors: persona.brand_colors })}
                      placeholder="#hex"
                      className={`flex-1 rounded-md border ${cardBorder} ${cardBg} px-2 py-1 text-[10px] font-mono ${textPrimary} placeholder:${textMuted} outline-none focus:border-violet-500/30`}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ===== Presets Tab ===== */}
        {tab === "presets" && (
          <div className="space-y-2">
            <p className={`text-[11px] ${textMuted} mb-3`}>
              一键激活 Skill 组合，快速切换设计模式
            </p>
            {presets.map((preset) => (
              <div
                key={preset.id}
                className={`rounded-lg border p-3 transition ${
                  persona.active_preset === preset.id
                    ? isDark
                      ? "border-violet-500/40 bg-violet-500/5"
                      : "border-violet-300 bg-violet-50/50"
                    : `${cardBorder} ${cardBg} ${hoverBg}`
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px]">{preset.icon}</span>
                    <span className={`text-[12px] font-medium ${textPrimary}`}>{preset.name}</span>
                  </div>
                  <button
                    onClick={() => handleActivatePreset(preset.id)}
                    className={`rounded-md px-2.5 py-1 text-[10px] font-medium transition ${
                      persona.active_preset === preset.id
                        ? isDark
                          ? "bg-violet-600 text-white"
                          : "bg-violet-600 text-white"
                        : isDark
                          ? "bg-white/10 text-white/60 hover:bg-white/15"
                          : "bg-gray-200 text-gray-600 hover:bg-gray-300"
                    }`}
                  >
                    {persona.active_preset === preset.id ? "已激活" : "激活"}
                  </button>
                </div>
                <p className={`text-[10px] ${textMuted} mb-2`}>{preset.description}</p>
                <div className="flex flex-wrap gap-1">
                  {preset.skills_status.map((s) => (
                    <span
                      key={s.name}
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] ${
                        s.installed
                          ? isDark
                            ? "bg-emerald-500/15 text-emerald-300"
                            : "bg-emerald-50 text-emerald-700"
                          : isDark
                            ? "bg-white/5 text-white/30"
                            : "bg-gray-100 text-gray-400"
                      }`}
                    >
                      <span className={`size-1.5 rounded-full ${s.installed ? "bg-emerald-400" : isDark ? "bg-white/20" : "bg-gray-300"}`} />
                      {s.name}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
