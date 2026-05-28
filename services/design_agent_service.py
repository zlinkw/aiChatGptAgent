"""Design Agent Service — 自主设计 Agent + Skill 系统

架构：
- Agent 接收用户设计需求
- 自动搜索/加载合适的 Skills（设计规范、组件库、最佳实践等）
- 用 Skills 增强 prompt，生成更专业的设计
- Skills 可以从 GitHub 仓库动态发现和安装
- Agent 会记住已学到的 Skills，不断进化

Skill 格式兼容 Vercel Agent Skills 标准：
- 每个 skill 是一个目录，包含 SKILL.md
- SKILL.md 有 YAML frontmatter（name, description）
- body 是 Markdown 指令
"""
from __future__ import annotations

import json
import re
import time
import threading
from pathlib import Path
from typing import Any

import requests

from services.config import DATA_DIR

# Skill 存储
SKILLS_DIR = DATA_DIR / "design_skills"
SKILLS_DIR.mkdir(parents=True, exist_ok=True)
SKILL_REGISTRY_FILE = SKILLS_DIR / "_registry.json"

# 用户 Agent 人设存储
PERSONA_DIR = DATA_DIR / "design_personas"
PERSONA_DIR.mkdir(parents=True, exist_ok=True)

# Skill 预设组合
SKILL_PRESETS = [
    {
        "id": "saas-full",
        "name": "SaaS 产品全套",
        "icon": "🚀",
        "description": "适合 SaaS 产品的完整设计规范",
        "skills": ["ui-design-principles", "modern-css-patterns", "responsive-design", "landing-page"],
    },
    {
        "id": "mobile-app",
        "name": "移动端 App",
        "icon": "📱",
        "description": "移动端优先的设计规范",
        "skills": ["responsive-design", "mobile-patterns", "ui-design-principles"],
    },
    {
        "id": "creative",
        "name": "创意设计",
        "icon": "🎨",
        "description": "大胆配色、实验性布局、动效丰富",
        "skills": ["modern-css-patterns", "animation-design"],
    },
    {
        "id": "minimal",
        "name": "极简风格",
        "icon": "⬜",
        "description": "大量留白、克制用色、内容优先",
        "skills": ["ui-design-principles"],
    },
    {
        "id": "ecommerce",
        "name": "电商设计",
        "icon": "🛒",
        "description": "转化率优先、商品展示、促销布局",
        "skills": ["ecommerce-layout", "ui-design-principles", "responsive-design"],
    },
    {
        "id": "dashboard",
        "name": "管理后台",
        "icon": "📊",
        "description": "数据面板、表格、图表、侧边栏导航",
        "skills": ["dashboard-design", "ui-design-principles", "form-design"],
    },
    {
        "id": "dark-theme",
        "name": "暗色主题",
        "icon": "🌙",
        "description": "深色背景、发光效果、科技感",
        "skills": ["dark-mode", "modern-css-patterns"],
    },
]

# Agent 角色预设
AGENT_ROLES = [
    {
        "id": "designer",
        "name": "创意设计师",
        "icon": "🎨",
        "prompt": "你是一个大胆创新的设计师，喜欢使用鲜艳的渐变色、不对称布局、丰富的动效和实验性的排版。你的设计总是让人眼前一亮。",
    },
    {
        "id": "engineer",
        "name": "严谨工程师",
        "icon": "📐",
        "prompt": "你是一个注重规范和可维护性的前端工程师。你的设计遵循 8px 网格系统，使用 CSS 变量管理主题，组件化程度高，代码整洁可复用。",
    },
    {
        "id": "growth",
        "name": "增长黑客",
        "icon": "🚀",
        "prompt": "你是一个专注转化率的增长设计师。你的设计 CTA 按钮醒目，信息层次清晰，善用社会证明和紧迫感，每个元素都服务于转化目标。",
    },
    {
        "id": "mobile",
        "name": "移动端专家",
        "icon": "📱",
        "prompt": "你是一个移动端设计专家。你的设计触摸友好（最小 44px 触摸区域），性能优先，善用原生手势交互，遵循 iOS/Android 设计规范。",
    },
    {
        "id": "minimalist",
        "name": "极简主义者",
        "icon": "⬜",
        "prompt": "你是一个极简主义设计师。你信奉 less is more，大量使用留白，配色克制（最多 2-3 种颜色），排版优雅，去除一切不必要的装饰。",
    },
]

# 内置 Skills 注册表（可从 GitHub 发现更多）
BUILTIN_SKILL_SOURCES = [
    {
        "repo": "vercel-labs/agent-skills",
        "url": "https://api.github.com/repos/vercel-labs/agent-skills/contents/skills",
        "description": "Vercel 官方 Agent Skills（React、设计、前端最佳实践）",
    },
    {
        "repo": "vercel-labs/skills",
        "url": "https://api.github.com/repos/vercel-labs/skills/contents/skills",
        "description": "Vercel Skills 生态（find-skills 等元技能）",
    },
]


def _load_registry() -> dict:
    """加载 skill 注册表"""
    if SKILL_REGISTRY_FILE.exists():
        try:
            return json.loads(SKILL_REGISTRY_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"skills": [], "sources": BUILTIN_SKILL_SOURCES, "last_scan": 0}


def _save_registry(registry: dict) -> None:
    """保存 skill 注册表"""
    SKILL_REGISTRY_FILE.write_text(
        json.dumps(registry, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _parse_skill_md(content: str) -> dict | None:
    """解析 SKILL.md 文件，提取 frontmatter 和 body"""
    # 匹配 YAML frontmatter
    match = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", content, re.DOTALL)
    if not match:
        return None

    frontmatter_text = match.group(1)
    body = match.group(2).strip()

    # 简单解析 YAML（不依赖 pyyaml）
    meta = {}
    for line in frontmatter_text.split("\n"):
        line = line.strip()
        if ":" in line:
            key, _, value = line.partition(":")
            meta[key.strip()] = value.strip().strip('"').strip("'")

    if not meta.get("name") or not meta.get("description"):
        return None

    return {
        "name": meta["name"],
        "description": meta.get("description", ""),
        "body": body,
        "metadata": meta,
    }


def _fetch_github_file(url: str) -> str | None:
    """从 GitHub API 获取文件内容"""
    try:
        resp = requests.get(url, timeout=15, headers={"Accept": "application/vnd.github.v3.raw"})
        if resp.status_code == 200:
            return resp.text
    except Exception:
        pass
    return None


def _discover_skills_from_repo(repo_api_url: str) -> list[dict]:
    """从 GitHub 仓库发现可用的 skills"""
    discovered = []
    try:
        resp = requests.get(repo_api_url, timeout=15)
        if resp.status_code != 200:
            return []
        items = resp.json()
        if not isinstance(items, list):
            return []

        for item in items:
            if item.get("type") != "dir":
                continue
            skill_name = item["name"]
            # 尝试获取 SKILL.md
            skill_md_url = f"{item['url']}"
            # 构造 SKILL.md 的 raw URL
            raw_url = f"https://raw.githubusercontent.com/{'/'.join(repo_api_url.split('/')[4:6])}/main/skills/{skill_name}/SKILL.md"
            content = _fetch_github_file(raw_url)
            if content:
                parsed = _parse_skill_md(content)
                if parsed:
                    discovered.append({
                        "name": parsed["name"],
                        "description": parsed["description"],
                        "source_url": raw_url,
                        "installed": False,
                        "body_preview": parsed["body"][:200],
                    })
    except Exception:
        pass
    return discovered


class DesignAgentService:
    """设计 Agent 服务 — 管理 Skills 并增强 AI 设计能力"""

    def __init__(self):
        self._lock = threading.Lock()
        self._registry = _load_registry()
        self._installed_skills: dict[str, dict] = {}
        self._load_installed_skills()

    def _load_installed_skills(self) -> None:
        """加载已安装的 skills"""
        for skill_dir in SKILLS_DIR.iterdir():
            if not skill_dir.is_dir():
                continue
            skill_md = skill_dir / "SKILL.md"
            if skill_md.exists():
                content = skill_md.read_text(encoding="utf-8")
                parsed = _parse_skill_md(content)
                if parsed:
                    self._installed_skills[parsed["name"]] = parsed

    def get_installed_skills(self) -> list[dict]:
        """获取已安装的 skills 列表"""
        return [
            {"name": s["name"], "description": s["description"]}
            for s in self._installed_skills.values()
        ]

    def get_skill_detail(self, name: str) -> dict | None:
        """获取 skill 详情"""
        return self._installed_skills.get(name)

    def discover_skills(self, query: str = "") -> list[dict]:
        """发现可用的 skills（从 GitHub 仓库扫描）"""
        all_skills = []
        for source in self._registry.get("sources", BUILTIN_SKILL_SOURCES):
            discovered = _discover_skills_from_repo(source["url"])
            for skill in discovered:
                skill["source_repo"] = source["repo"]
                # 标记是否已安装
                skill["installed"] = skill["name"] in self._installed_skills
            all_skills.extend(discovered)

        # 如果有搜索词，过滤
        if query:
            query_lower = query.lower()
            all_skills = [
                s for s in all_skills
                if query_lower in s["name"].lower()
                or query_lower in s["description"].lower()
            ]

        # 更新注册表
        with self._lock:
            self._registry["last_scan"] = time.time()
            self._registry["skills"] = all_skills
            _save_registry(self._registry)

        return all_skills

    def install_skill(self, name: str, source_url: str = "") -> dict | None:
        """安装一个 skill"""
        # 如果没给 URL，从注册表找
        if not source_url:
            for s in self._registry.get("skills", []):
                if s["name"] == name:
                    source_url = s.get("source_url", "")
                    break

        if not source_url:
            return None

        content = _fetch_github_file(source_url)
        if not content:
            return None

        parsed = _parse_skill_md(content)
        if not parsed:
            return None

        # 保存到本地
        skill_dir = SKILLS_DIR / name
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

        # 更新内存
        with self._lock:
            self._installed_skills[name] = parsed

        return {"name": name, "description": parsed["description"], "installed": True}

    def uninstall_skill(self, name: str) -> bool:
        """卸载一个 skill"""
        skill_dir = SKILLS_DIR / name
        if skill_dir.exists():
            import shutil
            shutil.rmtree(skill_dir)

        with self._lock:
            self._installed_skills.pop(name, None)
        return True

    def add_custom_skill(self, name: str, description: str, body: str) -> dict:
        """添加自定义 skill（用户自己写的设计规范）"""
        content = f"""---
name: {name}
description: {description}
---

{body}
"""
        skill_dir = SKILLS_DIR / name
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

        parsed = _parse_skill_md(content)
        if parsed:
            with self._lock:
                self._installed_skills[name] = parsed

        return {"name": name, "description": description, "installed": True}

    def add_source(self, repo: str, url: str, description: str = "") -> None:
        """添加新的 skill 来源仓库"""
        with self._lock:
            sources = self._registry.get("sources", [])
            # 去重
            if not any(s["repo"] == repo for s in sources):
                sources.append({"repo": repo, "url": url, "description": description})
                self._registry["sources"] = sources
                _save_registry(self._registry)

    def get_sources(self) -> list[dict]:
        """获取所有 skill 来源"""
        return self._registry.get("sources", BUILTIN_SKILL_SOURCES)

    # ===== 用户人设 & 偏好 =====

    def get_user_persona(self, user_id: str) -> dict:
        """获取用户的 Agent 人设配置"""
        persona_file = PERSONA_DIR / f"{user_id}.json"
        if persona_file.exists():
            try:
                return json.loads(persona_file.read_text(encoding="utf-8"))
            except Exception:
                pass
        return {
            "role_id": "",
            "custom_prompt": "",
            "style_keywords": [],
            "brand_colors": {},
            "active_preset": "",
        }

    def save_user_persona(self, user_id: str, data: dict) -> None:
        """保存用户的 Agent 人设配置"""
        # 合并现有数据
        current = self.get_user_persona(user_id)
        for key in ("role_id", "custom_prompt", "style_keywords", "brand_colors", "active_preset"):
            if key in data:
                current[key] = data[key]
        persona_file = PERSONA_DIR / f"{user_id}.json"
        persona_file.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")

    def build_persona_context(self, user_id: str) -> str:
        """根据用户人设构建额外的 prompt 上下文"""
        persona = self.get_user_persona(user_id)
        parts = []

        # Agent 角色
        role_id = persona.get("role_id", "")
        if role_id:
            for role in AGENT_ROLES:
                if role["id"] == role_id:
                    parts.append(f"\n你的设计风格定位：{role['prompt']}")
                    break

        # 自定义 prompt
        custom = persona.get("custom_prompt", "").strip()
        if custom:
            parts.append(f"\n用户的额外要求：{custom}")

        # 风格关键词
        keywords = persona.get("style_keywords", [])
        if keywords:
            parts.append(f"\n设计风格关键词：{', '.join(keywords)}")

        # 品牌色
        colors = persona.get("brand_colors", {})
        if colors:
            color_str = ", ".join(f"{k}: {v}" for k, v in colors.items() if v)
            if color_str:
                parts.append(f"\n品牌配色方案（必须使用）：{color_str}")

        return "".join(parts)

    # ===== Skill 预设组合 =====

    def get_skill_presets(self) -> list[dict]:
        """获取所有 Skill 预设组合"""
        # 标记哪些 skill 已安装
        result = []
        for preset in SKILL_PRESETS:
            p = {**preset}
            p["skills_status"] = [
                {"name": s, "installed": s in self._installed_skills}
                for s in preset["skills"]
            ]
            result.append(p)
        return result

    def activate_preset(self, preset_id: str) -> list[str] | None:
        """激活一个预设组合 — 确保其中的 skill 都已安装"""
        target = None
        for p in SKILL_PRESETS:
            if p["id"] == preset_id:
                target = p
                break
        if not target:
            return None

        activated = []
        for skill_name in target["skills"]:
            if skill_name in self._installed_skills:
                activated.append(skill_name)
            else:
                # 尝试从本地已有的 skill 目录加载
                skill_dir = SKILLS_DIR / skill_name
                skill_md = skill_dir / "SKILL.md"
                if skill_md.exists():
                    content = skill_md.read_text(encoding="utf-8")
                    parsed = _parse_skill_md(content)
                    if parsed:
                        self._installed_skills[skill_name] = parsed
                        activated.append(skill_name)
        return activated

    def get_agent_roles(self) -> list[dict]:
        """获取所有 Agent 角色预设"""
        return AGENT_ROLES

    def build_agent_context(self, user_prompt: str) -> str:
        """根据用户需求，自动选择相关 skills 构建增强 prompt

        这是 Agent 的核心能力：根据任务自动匹配 skills。
        """
        if not self._installed_skills:
            return ""

        # 基础 Skills — 每次都注入（配色和组件是设计的基础）
        base_skill_names = ["color-palettes", "ui-components"]
        selected = []
        for name in base_skill_names:
            if name in self._installed_skills:
                selected.append(self._installed_skills[name])

        # 简单的关键词匹配来选择额外相关 skills
        prompt_lower = user_prompt.lower()
        relevant_skills = []

        # 设计相关关键词映射
        design_keywords = {
            "响应式": ["responsive", "mobile", "tablet"],
            "动画": ["animation", "motion", "transition"],
            "动效": ["animation", "motion", "transition"],
            "颜色": ["color", "theme", "palette"],
            "布局": ["layout", "grid", "flex"],
            "组件": ["component", "ui", "widget"],
            "表单": ["form", "input", "validation"],
            "导航": ["navigation", "menu", "sidebar"],
            "卡片": ["card", "tile"],
            "图表": ["chart", "graph", "data"],
            "登录": ["login", "auth", "sign", "form"],
            "注册": ["register", "signup", "form"],
            "react": ["react", "jsx", "component"],
            "tailwind": ["tailwind", "css", "utility"],
            "设计系统": ["design-system", "tokens", "variables"],
            "无障碍": ["accessibility", "a11y", "aria"],
            "性能": ["performance", "optimize", "speed"],
            "暗色": ["dark", "mode", "theme"],
            "深色": ["dark", "mode", "theme"],
            "电商": ["ecommerce", "shop", "product", "cart"],
            "商品": ["ecommerce", "product", "shop"],
            "购物": ["ecommerce", "cart", "shop"],
            "落地页": ["landing", "page", "hero"],
            "首页": ["landing", "page", "hero"],
            "后台": ["dashboard", "admin", "panel"],
            "仪表盘": ["dashboard", "chart", "data"],
            "管理": ["dashboard", "admin", "panel"],
            "手机": ["mobile", "app", "responsive"],
            "移动端": ["mobile", "app", "responsive"],
            "app": ["mobile", "app", "pattern"],
        }

        for skill in self._installed_skills.values():
            score = 0
            skill_text = f"{skill['name']} {skill['description']}".lower()

            # 直接匹配
            for word in prompt_lower.split():
                if len(word) > 2 and word in skill_text:
                    score += 2

            # 关键词映射匹配
            for cn_key, en_keys in design_keywords.items():
                if cn_key in prompt_lower:
                    for en_key in en_keys:
                        if en_key in skill_text:
                            score += 3
                            break

            if score > 0:
                relevant_skills.append((score, skill))

        # 按相关度排序，取前 1 个（排除已选的基础 skill）
        relevant_skills.sort(key=lambda x: x[0], reverse=True)
        for score, skill in relevant_skills[:1]:
            if skill not in selected:
                selected.append(skill)

        if not selected:
            return ""

        # 构建增强上下文
        context_parts = ["\n\n--- AGENT SKILLS CONTEXT ---\n"]
        context_parts.append("以下是与当前设计任务相关的专业知识和最佳实践：\n")

        for skill in selected:
            context_parts.append(f"\n### Skill: {skill['name']}")
            context_parts.append(f"**{skill['description']}**\n")
            # 截取 body 的前 800 字符避免 token 爆炸
            body = skill["body"][:800]
            if len(skill["body"]) > 800:
                body += "\n...(更多内容已省略)"
            context_parts.append(body)

        context_parts.append("\n--- END SKILLS CONTEXT ---\n")
        return "\n".join(context_parts)

    def agent_think(self, user_prompt: str, conversation: list[dict] = None, user_id: str = "") -> dict:
        """Agent 思考过程：分析需求 → 选择 skills → 构建策略

        返回 Agent 的思考结果，包括：
        - skills_used: 使用了哪些 skills
        - enhanced_prompt: 增强后的系统 prompt
        - suggestions: 建议安装的新 skills
        """
        # 1. 构建 skill 上下文
        skill_context = self.build_agent_context(user_prompt)
        skills_used = []
        if skill_context:
            for skill in self._installed_skills.values():
                if skill["name"].lower() in skill_context.lower():
                    skills_used.append(skill["name"])

        # 1.5 注入用户人设
        if user_id:
            persona_context = self.build_persona_context(user_id)
            if persona_context:
                skill_context = persona_context + "\n" + skill_context

        # 2. 检查是否需要新 skills
        suggestions = []
        prompt_lower = user_prompt.lower()
        need_keywords = {
            "3d": "3d-design",
            "动效": "animation-design",
            "暗色模式": "dark-mode",
            "国际化": "i18n-design",
            "微交互": "micro-interactions",
        }
        for keyword, skill_name in need_keywords.items():
            if keyword in prompt_lower and skill_name not in self._installed_skills:
                suggestions.append({
                    "name": skill_name,
                    "reason": f"检测到需求包含「{keyword}」，建议安装相关 skill",
                })

        return {
            "skills_used": skills_used,
            "skill_context": skill_context,
            "suggestions": suggestions,
            "total_installed": len(self._installed_skills),
        }


# 单例
design_agent_service = DesignAgentService()
