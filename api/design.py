"""AI Design Studio - 类 Stitch 的 AI 设计工具

功能：
- 多项目管理（创建/保存/加载/删除）
- 多轮对话上下文（AI 理解之前的修改）
- 模板库快速开始
- 版本历史（可回退到任意版本）
- 图片上传参考
"""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Header, HTTPException, UploadFile, File, Form
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from api.support import require_identity
from services.config import config, DATA_DIR
from services.design_agent_service import design_agent_service

# 设计项目存储目录
DESIGNS_DIR = DATA_DIR / "designs"
DESIGNS_DIR.mkdir(parents=True, exist_ok=True)

SYSTEM_PROMPT = """你是一个顶级 UI 设计师。用户描述需求，你生成精美的 HTML + CSS 代码。

设计标准：
1. 只输出纯 HTML+CSS 代码，不要 markdown 包裹，不要解释
2. 设计必须现代、精致、专业级别，参考 Dribbble/Behance 上的优秀作品
3. 使用 CSS 变量定义主题色，确保配色协调统一
4. 使用渐变、阴影、圆角等现代视觉效果
5. 间距使用 8px 网格系统（8, 16, 24, 32, 48, 64）
6. 字体使用 system-ui, -apple-system, sans-serif
7. 图片使用 Unsplash：https://images.unsplash.com/photo-{id}?w={宽}&h={高}&fit=crop
8. 使用中文内容
9. 使用 flexbox/grid 布局
10. 确保移动端适配
11. 按钮要有 hover 效果和过渡动画
12. 卡片要有精致的阴影和圆角

配色规范（必须遵循）：
- 不要用刺眼的纯色（如纯黄#FFD700、纯绿#00FF00）
- 使用柔和的现代色调
- 推荐主色：#6366F1(靛蓝) #8B5CF6(紫) #EC4899(粉) #0EA5E9(蓝) #10B981(绿)
- 背景用 #FFFFFF 或 #F8FAFC，不要用彩色背景
- 文字用 #1E293B(主) #64748B(次) #94A3B8(辅)
- 按钮用主色实底 + 白色文字，圆角 8-12px

直接输出 HTML 代码，不要任何其他内容。"""

ITERATE_PROMPT = """你是一个专业的 UI 设计师和前端开发者。用户会给你当前页面的 HTML 代码，并描述要做的修改。

核心规则：
1. 只修改用户明确提到的部分，其他所有代码原封不动
2. 不要重新生成整个页面，只改需要改的元素
3. 保持现有的 CSS 变量、类名、结构不变
4. 如果用户要求修改样式，只改对应元素的 style/class
5. 如果用户要求添加新元素，在合理位置插入，不影响现有结构
6. 如果用户要求删除元素，直接移除对应代码
7. 输出修改后的完整 HTML（包含未修改的部分）
8. 不要 markdown 包裹，不要解释

直接输出完整的 HTML 代码，不要任何其他内容。"""

# 预设模板
TEMPLATES = [
    {
        "id": "landing",
        "name": "落地页",
        "description": "现代风格的产品落地页，包含 Hero、特性、CTA",
        "icon": "🚀",
        "prompt": "设计一个现代科技产品的落地页，包含：顶部导航栏（Logo + 菜单 + 登录按钮），Hero 区域（大标题 + 副标题 + CTA 按钮 + 产品截图），3 个特性卡片，底部 Footer。使用深紫色和白色为主色调。",
    },
    {
        "id": "dashboard",
        "name": "数据面板",
        "description": "管理后台仪表盘，数据卡片 + 图表区域",
        "icon": "📊",
        "prompt": "设计一个管理后台仪表盘页面，包含：顶部统计卡片（4 个，显示用户数、收入、订单、转化率），中间是一个大的图表区域（用占位符），下面是最近订单表格。使用浅灰背景 + 白色卡片风格。",
    },
    {
        "id": "login",
        "name": "登录页",
        "description": "简洁的登录/注册页面",
        "icon": "🔐",
        "prompt": "设计一个现代的登录页面，左侧是渐变色背景 + 品牌 slogan，右侧是登录表单（邮箱、密码、记住我、登录按钮、第三方登录、注册链接）。整体简洁大气。",
    },
    {
        "id": "pricing",
        "name": "定价页",
        "description": "SaaS 产品定价对比页面",
        "icon": "💰",
        "prompt": "设计一个 SaaS 产品的定价页面，包含 3 个定价卡片（基础版/专业版/企业版），中间的推荐卡片要突出显示。每个卡片包含价格、功能列表、CTA 按钮。使用蓝色系主题。",
    },
    {
        "id": "profile",
        "name": "个人主页",
        "description": "社交平台个人资料页",
        "icon": "👤",
        "prompt": "设计一个社交平台的个人主页，包含：封面图、头像、用户名、简介、统计数据（关注/粉丝/作品数）、标签页切换（作品/收藏/喜欢）、作品网格展示。使用圆角卡片风格。",
    },
    {
        "id": "ecommerce",
        "name": "电商首页",
        "description": "电商平台首页，轮播 + 商品网格",
        "icon": "🛒",
        "prompt": "设计一个电商平台首页，包含：顶部搜索栏、分类导航、Banner 轮播区域、热门商品网格（每个商品卡片有图片、标题、价格、评分）、底部推荐。使用暖色调。",
    },
    {
        "id": "blog",
        "name": "博客文章",
        "description": "简约风格的博客文章页",
        "icon": "📝",
        "prompt": "设计一个简约风格的博客文章页面，包含：文章标题、作者信息（头像+名字+日期）、文章正文（带标题、段落、引用块、代码块、图片）、标签、评论区。使用大量留白，阅读体验优先。",
    },
    {
        "id": "mobile-app",
        "name": "移动端 App",
        "description": "手机 App 界面设计（375px 宽）",
        "icon": "📱",
        "prompt": "设计一个手机 App 的首页界面（宽度 375px），包含：顶部状态栏、搜索框、横向滚动的分类图标、推荐内容卡片列表、底部 Tab 导航栏（首页/发现/消息/我的）。使用 iOS 风格的圆角和毛玻璃效果。",
    },
]


class DesignGenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=4000)
    current_html: str = ""
    conversation: list[dict] = []  # 对话历史
    project_id: str = ""
    page_id: str = ""  # 多页面支持
    model: str = "auto"
    stream: bool = False
    multi_agent: bool = True  # 多 Agent 流水线
    device_width: int = 393
    device_height: int = 852
    device_name: str = "iPhone 16"


class DesignGenerateResponse(BaseModel):
    html: str
    project_id: str = ""
    skills_used: list[str] = []
    suggestions: list[dict] = []


class ProjectCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    template_id: str = ""


class ProjectUpdateRequest(BaseModel):
    name: str | None = None
    html: str | None = None
    conversation: list[dict] | None = None


class PageCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    device: str = "mobile"  # mobile / tablet / desktop


class PageUpdateRequest(BaseModel):
    name: str | None = None
    html: str | None = None
    conversation: list[dict] | None = None
    device: str | None = None
    sort_order: int | None = None


class ProjectResponse(BaseModel):
    id: str
    name: str
    html: str
    conversation: list[dict]
    versions: list[dict]
    created_at: float
    updated_at: float
    thumbnail: str = ""


def _get_user_designs_dir(user_id: str) -> Path:
    """获取用户的设计项目目录"""
    user_dir = DESIGNS_DIR / user_id
    user_dir.mkdir(parents=True, exist_ok=True)
    return user_dir


def _load_project(user_id: str, project_id: str) -> dict | None:
    """加载项目"""
    project_file = _get_user_designs_dir(user_id) / f"{project_id}.json"
    if not project_file.exists():
        return None
    try:
        return json.loads(project_file.read_text(encoding="utf-8"))
    except Exception:
        return None


def _save_project(user_id: str, project: dict) -> None:
    """保存项目"""
    project_file = _get_user_designs_dir(user_id) / f"{project['id']}.json"
    project_file.write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8")


def _list_projects(user_id: str) -> list[dict]:
    """列出用户所有项目"""
    user_dir = _get_user_designs_dir(user_id)
    projects = []
    for f in user_dir.glob("*.json"):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            projects.append({
                "id": data["id"],
                "name": data["name"],
                "updated_at": data.get("updated_at", 0),
                "created_at": data.get("created_at", 0),
                "thumbnail": data.get("thumbnail", ""),
                "has_content": bool(data.get("html", "").strip()),
            })
        except Exception:
            continue
    projects.sort(key=lambda x: x.get("updated_at", 0), reverse=True)
    return projects


def _strip_html(html: str) -> str:
    """去掉可能的 markdown 代码块包裹"""
    html = html.strip()
    if html.startswith("```html"):
        html = html[7:]
    if html.startswith("```"):
        html = html[3:]
    if html.endswith("```"):
        html = html[:-3]
    return html.strip()


# ===== Multi-Agent 流水线 =====

AGENT_PM_PROMPT = """你是一个资深产品经理，精通用户体验、转化优化和信息架构。用户会描述他们想要的页面，你需要从产品角度分析需求并输出清晰的页面结构。

你的分析维度：
1. 识别页面类型和核心目标（这个页面要让用户做什么？）
2. 确定目标用户和使用场景
3. 运用用户心理学（F型阅读、3秒法则、注意力焦点）
4. 规划信息优先级（首屏放什么、什么最重要）
5. 设计转化路径（用户从进入到完成目标的步骤）
6. 参考同类竞品的最佳实践

输出格式：
页面类型：xxx
核心目标：xxx（用户完成什么动作算成功）
目标用户：xxx
风格方向：xxx

页面结构（从上到下）：
1. [区块名] - 内容描述 - 为什么放这里
2. [区块名] - 内容描述 - 为什么放这里
...

转化策略：
- xxx
- xxx

注意事项：
- xxx
"""

AGENT_DESIGNER_PROMPT = """你是一个专业的 UI 设计师。根据产品经理给出的页面结构，生成完整的 HTML + CSS 代码。

规则：
1. 严格按照给定的页面结构来设计
2. 使用现代、美观的视觉风格
3. 使用 CSS 变量定义主题色
4. 图片使用 Unsplash 真实图片：https://images.unsplash.com/photo-{id}?w={宽}&h={高}&fit=crop
5. 使用中文内容
6. 布局用 flexbox/grid
7. 确保移动端适配
8. 只输出 HTML 代码，不要解释

直接输出完整的 HTML+CSS 代码。"""

AGENT_DEVELOPER_PROMPT = """你是一个资深前端开发者。你会收到一份 UI 设计的 HTML 代码，需要优化代码质量。

规则：
1. 保持视觉效果完全不变
2. 使用语义化 HTML 标签（header/main/nav/section/article/footer）
3. CSS 用变量管理颜色和间距
4. 确保代码整洁、有层次
5. 添加合理的 class 命名
6. 确保图片有 alt 属性
7. 确保按钮有 hover 效果
8. 只输出优化后的完整 HTML 代码，不要解释

直接输出完整的 HTML+CSS 代码。"""

AGENT_OPTIMIZER_PROMPT = """你是一个设计细节优化师。你会收到一份 HTML 页面代码，需要检查并优化细节。

检查清单：
1. 间距是否统一（用 4/8 的倍数）
2. 圆角是否一致
3. 颜色是否协调
4. 字号层级是否清晰
5. 对齐是否整齐
6. 是否有 hover/active 交互效果
7. 是否有平滑过渡动画（transition）
8. 阴影是否合理

规则：
1. 修复发现的问题
2. 添加微交互（hover 效果、过渡动画）
3. 确保响应式适配
4. 保持整体风格不变，只优化细节
5. 只输出优化后的完整 HTML 代码，不要解释

直接输出完整的 HTML+CSS 代码。"""


def _get_user_id(authorization: str | None) -> str:
    """从 authorization 中提取用户标识"""
    identity = require_identity(authorization)
    return str(identity.get("name") or identity.get("id") or "anonymous")


def create_router() -> APIRouter:
    router = APIRouter(prefix="/api/design", tags=["design"])

    @router.post("/generate", response_model=DesignGenerateResponse)
    async def generate_design(
        body: DesignGenerateRequest,
        authorization: str | None = Header(default=None),
    ):
        """根据用户描述生成/迭代 UI 设计 HTML"""
        user_id = _get_user_id(authorization)

        # 构建消息
        has_existing = body.current_html and "在左侧" not in body.current_html and "AI Design Studio" not in body.current_html

        if has_existing:
            system_prompt = ITERATE_PROMPT
        else:
            system_prompt = SYSTEM_PROMPT

        # Agent 思考：自动匹配 skills 增强 prompt
        agent_result = design_agent_service.agent_think(body.prompt, body.conversation, user_id)
        if agent_result["skill_context"]:
            system_prompt += agent_result["skill_context"]

        # 构建完整 prompt
        if has_existing:
            user_message = f"当前页面的 HTML 代码如下：\n\n```html\n{body.current_html}\n```\n\n请在此基础上进行修改：{body.prompt}"
        else:
            user_message = f"目标设备：{body.device_name}（{body.device_width}×{body.device_height}px）\n顶部预留 44px 状态栏空间，底部预留 34px Home Indicator 空间。\n\n{body.prompt}"

        # 流式模式
        if body.stream:
            from services.protocol.conversation import ConversationRequest, stream_text_deltas, collect_text, text_backend
            from services.openai_api_backend import is_api_backend_enabled, simple_completion as api_simple, stream_completion as api_stream

            use_api_backend = is_api_backend_enabled()

            def _call_agent(prompt: str, model: str = "auto") -> str:
                """同步调用一个 Agent，返回完整文本"""
                if use_api_backend:
                    return api_simple(prompt, model=model)
                backend = text_backend()
                request = ConversationRequest(model=model, prompt=prompt)
                return collect_text(backend, request)

            def generate_stream():
                import json as _json

                # 先发送 meta 信息
                meta = {
                    "type": "meta",
                    "skills_used": agent_result.get("skills_used", []),
                    "suggestions": agent_result.get("suggestions", []),
                    "multi_agent": body.multi_agent,
                }
                yield f"data: {_json.dumps(meta, ensure_ascii=False)}\n\n"

                if body.multi_agent and not has_existing:
                    # ===== Multi-Agent 流水线（仅新建设计时使用）=====

                    # Step 1: 产品经理分析需求
                    yield f"data: {_json.dumps({'type': 'stage', 'stage': 'planning', 'label': '🧠 产品经理正在分析需求...'}, ensure_ascii=False)}\n\n"
                    try:
                        pm_prompt = f"{AGENT_PM_PROMPT}\n\n{agent_result.get('skill_context', '')}\n\n用户需求：{user_message}"
                        structure = _call_agent(pm_prompt, body.model or "auto")
                    except Exception:
                        structure = user_message  # fallback: 直接用用户原始需求
                    yield f"data: {_json.dumps({'type': 'stage_done', 'stage': 'planning', 'result': structure}, ensure_ascii=False)}\n\n"

                    # Step 2: 设计师生成 HTML
                    yield f"data: {_json.dumps({'type': 'stage', 'stage': 'designing', 'label': '🎨 设计师正在生成界面...'}, ensure_ascii=False)}\n\n"
                    designer_prompt = f"{AGENT_DESIGNER_PROMPT}\n\n{agent_result.get('skill_context', '')}\n\n产品经理的页面结构：\n{structure}\n\n用户原始需求：{user_message}"
                    design_html = ""
                    try:
                        if use_api_backend:
                            for delta in api_stream(designer_prompt, model=body.model or "auto"):
                                design_html += delta
                                yield f"data: {_json.dumps({'type': 'delta', 'delta': delta}, ensure_ascii=False)}\n\n"
                        else:
                            backend = text_backend()
                            request = ConversationRequest(model=body.model or "auto", prompt=designer_prompt)
                            for delta in stream_text_deltas(backend, request):
                                design_html += delta
                                yield f"data: {_json.dumps({'type': 'delta', 'delta': delta}, ensure_ascii=False)}\n\n"
                    except Exception:
                        pass
                    design_html = _strip_html(design_html)
                    if not design_html:
                        yield f"data: {_json.dumps({'type': 'stage', 'stage': 'designing', 'label': '🎨 重新生成...'}, ensure_ascii=False)}\n\n"
                        simple_prompt = f"{system_prompt}\n\n用户需求：{user_message}"
                        try:
                            if use_api_backend:
                                for delta in api_stream(simple_prompt, model=body.model or "auto"):
                                    design_html += delta
                                    yield f"data: {_json.dumps({'type': 'delta', 'delta': delta}, ensure_ascii=False)}\n\n"
                            else:
                                backend = text_backend()
                                request = ConversationRequest(model=body.model or "auto", prompt=simple_prompt)
                                for delta in stream_text_deltas(backend, request):
                                    design_html += delta
                                    yield f"data: {_json.dumps({'type': 'delta', 'delta': delta}, ensure_ascii=False)}\n\n"
                        except Exception:
                            pass
                        design_html = _strip_html(design_html)
                    yield f"data: {_json.dumps({'type': 'stage_done', 'stage': 'designing'}, ensure_ascii=False)}\n\n"

                    # Step 3: 开发者优化代码
                    yield f"data: {_json.dumps({'type': 'stage', 'stage': 'developing', 'label': '💻 开发者正在优化代码...'}, ensure_ascii=False)}\n\n"
                    try:
                        dev_prompt = f"{AGENT_DEVELOPER_PROMPT}\n\n以下是设计师生成的 HTML 代码，请优化代码质量：\n\n```html\n{design_html}\n```"
                        dev_html = _call_agent(dev_prompt, body.model or "auto")
                        dev_html = _strip_html(dev_html)
                        if not dev_html:
                            dev_html = design_html
                    except Exception:
                        dev_html = design_html  # fallback: 用设计师的结果
                    yield f"data: {_json.dumps({'type': 'stage_done', 'stage': 'developing'}, ensure_ascii=False)}\n\n"

                    # Step 4: 优化师精调细节
                    yield f"data: {_json.dumps({'type': 'stage', 'stage': 'optimizing', 'label': '✨ 优化师正在精调细节...'}, ensure_ascii=False)}\n\n"
                    try:
                        opt_prompt = f"{AGENT_OPTIMIZER_PROMPT}\n\n以下是需要优化的 HTML 代码：\n\n```html\n{dev_html}\n```"
                        final_html = _call_agent(opt_prompt, body.model or "auto")
                        final_html = _strip_html(final_html)
                        if not final_html:
                            final_html = dev_html
                    except Exception:
                        final_html = dev_html  # fallback: 用开发者的结果
                    yield f"data: {_json.dumps({'type': 'stage_done', 'stage': 'optimizing'}, ensure_ascii=False)}\n\n"

                    cleaned = final_html

                else:
                    # ===== 单 Agent 模式（迭代修改时使用）=====
                    yield f"data: {_json.dumps({'type': 'stage', 'stage': 'editing', 'label': '🎨 设计师正在修改...'}, ensure_ascii=False)}\n\n"
                    full_html = ""
                    edit_prompt = f"{system_prompt}\n\n用户需求：{user_message}"
                    if use_api_backend:
                        for delta in api_stream(edit_prompt, model=body.model or "auto"):
                            full_html += delta
                            yield f"data: {_json.dumps({'type': 'delta', 'delta': delta}, ensure_ascii=False)}\n\n"
                    else:
                        backend = text_backend()
                        request = ConversationRequest(
                            model=body.model or "auto",
                            prompt=edit_prompt,
                        )
                        for delta in stream_text_deltas(backend, request):
                            full_html += delta
                            yield f"data: {_json.dumps({'type': 'delta', 'delta': delta}, ensure_ascii=False)}\n\n"
                    cleaned = _strip_html(full_html)
                    yield f"data: {_json.dumps({'type': 'stage_done', 'stage': 'editing'}, ensure_ascii=False)}\n\n"

                # 发送最终结果
                yield f"data: {_json.dumps({'type': 'done', 'html': cleaned}, ensure_ascii=False)}\n\n"

                # 保存到项目
                if body.project_id:
                    project = _load_project(user_id, body.project_id)
                    if project:
                        if body.page_id:
                            pages = project.get("pages", [])
                            for page in pages:
                                if page["id"] == body.page_id:
                                    versions = page.get("versions", [])
                                    versions.append({"html": cleaned, "prompt": body.prompt, "timestamp": time.time()})
                                    page["versions"] = versions[-30:]
                                    page["html"] = cleaned
                                    conv = page.get("conversation", [])
                                    conv.append({"role": "user", "content": body.prompt})
                                    conv.append({"role": "assistant", "content": "已生成设计"})
                                    page["conversation"] = conv[-40:]
                                    break
                            project["pages"] = pages
                        else:
                            versions = project.get("versions", [])
                            versions.append({"html": cleaned, "prompt": body.prompt, "timestamp": time.time()})
                            project["versions"] = versions[-30:]
                            project["html"] = cleaned
                            conv = project.get("conversation", [])
                            conv.append({"role": "user", "content": body.prompt})
                            conv.append({"role": "assistant", "content": "已生成设计"})
                            project["conversation"] = conv[-40:]
                        project["updated_at"] = time.time()
                        _save_project(user_id, project)

            return StreamingResponse(
                generate_stream(),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )

        # 非流式模式（兼容旧逻辑）
        from services.protocol.conversation import ConversationRequest, collect_text, text_backend

        def call_ai():
            backend = text_backend()
            request = ConversationRequest(
                model=body.model or "auto",
                prompt=f"{system_prompt}\n\n用户需求：{user_message}",
            )
            return collect_text(backend, request)

        try:
            html = await run_in_threadpool(call_ai)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"AI 生成失败: {exc}") from exc

        html = _strip_html(html)

        # 如果有 project_id，自动保存版本
        project_id = body.project_id
        if project_id:
            project = _load_project(user_id, project_id)
            if project:
                # 添加版本
                versions = project.get("versions", [])
                versions.append({
                    "html": html,
                    "prompt": body.prompt,
                    "timestamp": time.time(),
                })
                # 只保留最近 30 个版本
                project["versions"] = versions[-30:]
                project["html"] = html
                project["updated_at"] = time.time()
                # 更新对话
                conv = project.get("conversation", [])
                conv.append({"role": "user", "content": body.prompt})
                conv.append({"role": "assistant", "content": "已生成设计"})
                project["conversation"] = conv[-40:]
                _save_project(user_id, project)

        return DesignGenerateResponse(
            html=html,
            project_id=project_id,
            skills_used=agent_result.get("skills_used", []),
            suggestions=agent_result.get("suggestions", []),
        )

    @router.get("/templates")
    async def get_templates(authorization: str | None = Header(default=None)):
        """获取模板列表"""
        require_identity(authorization)
        return {"templates": TEMPLATES}

    @router.get("/projects")
    async def list_projects(authorization: str | None = Header(default=None)):
        """列出用户所有设计项目"""
        user_id = _get_user_id(authorization)
        return {"projects": _list_projects(user_id)}

    @router.post("/projects")
    async def create_project(
        body: ProjectCreateRequest,
        authorization: str | None = Header(default=None),
    ):
        """创建新项目"""
        user_id = _get_user_id(authorization)
        project_id = uuid.uuid4().hex[:12]
        now = time.time()

        # 如果选了模板，用模板的 prompt
        initial_prompt = ""
        if body.template_id:
            for t in TEMPLATES:
                if t["id"] == body.template_id:
                    initial_prompt = t["prompt"]
                    break

        project = {
            "id": project_id,
            "name": body.name,
            "html": "",
            "conversation": [],
            "versions": [],
            "created_at": now,
            "updated_at": now,
            "thumbnail": "",
            "template_id": body.template_id,
            "initial_prompt": initial_prompt,
        }
        _save_project(user_id, project)
        return {"project": project}

    @router.get("/projects/{project_id}")
    async def get_project(
        project_id: str,
        authorization: str | None = Header(default=None),
    ):
        """获取项目详情"""
        user_id = _get_user_id(authorization)
        project = _load_project(user_id, project_id)
        if not project:
            raise HTTPException(status_code=404, detail="项目不存在")
        return {"project": project}

    @router.put("/projects/{project_id}")
    async def update_project(
        project_id: str,
        body: ProjectUpdateRequest,
        authorization: str | None = Header(default=None),
    ):
        """更新项目"""
        user_id = _get_user_id(authorization)
        project = _load_project(user_id, project_id)
        if not project:
            raise HTTPException(status_code=404, detail="项目不存在")

        if body.name is not None:
            project["name"] = body.name
        if body.html is not None:
            # 保存当前版本
            versions = project.get("versions", [])
            if project.get("html") and project["html"] != body.html:
                versions.append({
                    "html": project["html"],
                    "prompt": "手动编辑",
                    "timestamp": time.time(),
                })
                project["versions"] = versions[-30:]
            project["html"] = body.html
        if body.conversation is not None:
            project["conversation"] = body.conversation[-40:]

        project["updated_at"] = time.time()
        _save_project(user_id, project)
        return {"project": project}

    @router.delete("/projects/{project_id}")
    async def delete_project(
        project_id: str,
        authorization: str | None = Header(default=None),
    ):
        """删除项目"""
        user_id = _get_user_id(authorization)
        project_file = _get_user_designs_dir(user_id) / f"{project_id}.json"
        if project_file.exists():
            project_file.unlink()
        return {"ok": True}

    @router.post("/projects/{project_id}/revert/{version_index}")
    async def revert_to_version(
        project_id: str,
        version_index: int,
        authorization: str | None = Header(default=None),
    ):
        """回退到指定版本"""
        user_id = _get_user_id(authorization)
        project = _load_project(user_id, project_id)
        if not project:
            raise HTTPException(status_code=404, detail="项目不存在")

        versions = project.get("versions", [])
        if version_index < 0 or version_index >= len(versions):
            raise HTTPException(status_code=400, detail="版本索引无效")

        target = versions[version_index]
        project["html"] = target["html"]
        project["updated_at"] = time.time()
        _save_project(user_id, project)
        return {"project": project}

    # ===== 多页面 API =====

    @router.get("/projects/{project_id}/pages")
    async def list_pages(
        project_id: str,
        authorization: str | None = Header(default=None),
    ):
        """获取项目的所有页面"""
        user_id = _get_user_id(authorization)
        project = _load_project(user_id, project_id)
        if not project:
            raise HTTPException(status_code=404, detail="项目不存在")

        pages = project.get("pages", [])
        # 兼容旧项目：如果没有 pages 但有 html，自动创建第一个页面
        if not pages and project.get("html"):
            page = {
                "id": "page_main",
                "name": "首页",
                "html": project["html"],
                "conversation": project.get("conversation", []),
                "versions": project.get("versions", []),
                "device": "mobile",
                "sort_order": 0,
                "created_at": project.get("created_at", time.time()),
            }
            pages = [page]
            project["pages"] = pages
            _save_project(user_id, project)

        return {"pages": pages}

    @router.post("/projects/{project_id}/pages")
    async def create_page(
        project_id: str,
        body: PageCreateRequest,
        authorization: str | None = Header(default=None),
    ):
        """在项目中创建新页面"""
        user_id = _get_user_id(authorization)
        project = _load_project(user_id, project_id)
        if not project:
            raise HTTPException(status_code=404, detail="项目不存在")

        pages = project.get("pages", [])
        # 兼容旧项目
        if not pages and project.get("html"):
            pages = [{
                "id": "page_main",
                "name": "首页",
                "html": project["html"],
                "conversation": project.get("conversation", []),
                "versions": project.get("versions", []),
                "device": "mobile",
                "sort_order": 0,
                "created_at": project.get("created_at", time.time()),
            }]

        page_id = f"page_{uuid.uuid4().hex[:8]}"
        new_page = {
            "id": page_id,
            "name": body.name,
            "html": "",
            "conversation": [],
            "versions": [],
            "device": body.device,
            "sort_order": len(pages),
            "created_at": time.time(),
        }
        pages.append(new_page)
        project["pages"] = pages
        project["updated_at"] = time.time()
        _save_project(user_id, project)
        return {"page": new_page}

    @router.get("/projects/{project_id}/pages/{page_id}")
    async def get_page(
        project_id: str,
        page_id: str,
        authorization: str | None = Header(default=None),
    ):
        """获取单个页面详情"""
        user_id = _get_user_id(authorization)
        project = _load_project(user_id, project_id)
        if not project:
            raise HTTPException(status_code=404, detail="项目不存在")

        for page in project.get("pages", []):
            if page["id"] == page_id:
                return {"page": page}
        raise HTTPException(status_code=404, detail="页面不存在")

    @router.put("/projects/{project_id}/pages/{page_id}")
    async def update_page(
        project_id: str,
        page_id: str,
        body: PageUpdateRequest,
        authorization: str | None = Header(default=None),
    ):
        """更新页面"""
        user_id = _get_user_id(authorization)
        project = _load_project(user_id, project_id)
        if not project:
            raise HTTPException(status_code=404, detail="项目不存在")

        pages = project.get("pages", [])
        target = None
        for page in pages:
            if page["id"] == page_id:
                target = page
                break
        if not target:
            raise HTTPException(status_code=404, detail="页面不存在")

        if body.name is not None:
            target["name"] = body.name
        if body.html is not None:
            # 保存版本
            versions = target.get("versions", [])
            if target.get("html") and target["html"] != body.html:
                versions.append({
                    "html": target["html"],
                    "prompt": "手动编辑",
                    "timestamp": time.time(),
                })
                target["versions"] = versions[-30:]
            target["html"] = body.html
        if body.conversation is not None:
            target["conversation"] = body.conversation[-40:]
        if body.device is not None:
            target["device"] = body.device
        if body.sort_order is not None:
            target["sort_order"] = body.sort_order

        project["pages"] = pages
        project["updated_at"] = time.time()
        # 同步主 html 为第一个页面
        if pages:
            project["html"] = pages[0].get("html", "")
        _save_project(user_id, project)
        return {"page": target}

    @router.delete("/projects/{project_id}/pages/{page_id}")
    async def delete_page(
        project_id: str,
        page_id: str,
        authorization: str | None = Header(default=None),
    ):
        """删除页面"""
        user_id = _get_user_id(authorization)
        project = _load_project(user_id, project_id)
        if not project:
            raise HTTPException(status_code=404, detail="项目不存在")

        pages = project.get("pages", [])
        project["pages"] = [p for p in pages if p["id"] != page_id]
        project["updated_at"] = time.time()
        _save_project(user_id, project)
        return {"ok": True}

    @router.post("/projects/{project_id}/thumbnail")
    async def save_thumbnail(
        project_id: str,
        authorization: str | None = Header(default=None),
        thumbnail: str = "",
    ):
        """保存项目缩略图（base64）"""
        user_id = _get_user_id(authorization)
        project = _load_project(user_id, project_id)
        if not project:
            raise HTTPException(status_code=404, detail="项目不存在")

        project["thumbnail"] = thumbnail[:500000]  # 限制大小
        _save_project(user_id, project)
        return {"ok": True}

    # ===== Agent Skills API =====

    @router.get("/agent/skills")
    async def list_skills(authorization: str | None = Header(default=None)):
        """获取已安装的 skills"""
        require_identity(authorization)
        return {"skills": design_agent_service.get_installed_skills()}

    @router.get("/agent/skills/discover")
    async def discover_skills(
        q: str = "",
        authorization: str | None = Header(default=None),
    ):
        """发现可用的 skills（从 GitHub 扫描）"""
        require_identity(authorization)
        skills = await run_in_threadpool(design_agent_service.discover_skills, q)
        return {"skills": skills}

    @router.post("/agent/skills/install")
    async def install_skill(
        body: dict,
        authorization: str | None = Header(default=None),
    ):
        """安装一个 skill"""
        require_identity(authorization)
        name = str(body.get("name", "")).strip()
        source_url = str(body.get("source_url", "")).strip()
        if not name:
            raise HTTPException(status_code=400, detail="缺少 skill name")
        result = await run_in_threadpool(design_agent_service.install_skill, name, source_url)
        if not result:
            raise HTTPException(status_code=400, detail="安装失败，无法获取 skill 内容")
        return {"skill": result}

    @router.delete("/agent/skills/{skill_name}")
    async def uninstall_skill(
        skill_name: str,
        authorization: str | None = Header(default=None),
    ):
        """卸载一个 skill"""
        require_identity(authorization)
        design_agent_service.uninstall_skill(skill_name)
        return {"ok": True}

    @router.post("/agent/skills/custom")
    async def add_custom_skill(
        body: dict,
        authorization: str | None = Header(default=None),
    ):
        """添加自定义 skill"""
        require_identity(authorization)
        name = str(body.get("name", "")).strip()
        description = str(body.get("description", "")).strip()
        skill_body = str(body.get("body", "")).strip()
        if not name or not description:
            raise HTTPException(status_code=400, detail="缺少 name 或 description")
        result = design_agent_service.add_custom_skill(name, description, skill_body)
        return {"skill": result}

    @router.get("/agent/sources")
    async def list_sources(authorization: str | None = Header(default=None)):
        """获取 skill 来源仓库列表"""
        require_identity(authorization)
        return {"sources": design_agent_service.get_sources()}

    @router.post("/agent/sources")
    async def add_source(
        body: dict,
        authorization: str | None = Header(default=None),
    ):
        """添加新的 skill 来源仓库"""
        require_identity(authorization)
        repo = str(body.get("repo", "")).strip()
        url = str(body.get("url", "")).strip()
        description = str(body.get("description", "")).strip()
        if not repo or not url:
            raise HTTPException(status_code=400, detail="缺少 repo 或 url")
        design_agent_service.add_source(repo, url, description)
        return {"ok": True}

    # ===== Agent 人设 & 偏好 API =====

    @router.get("/agent/persona")
    async def get_persona(authorization: str | None = Header(default=None)):
        """获取用户的 Agent 人设配置"""
        user_id = _get_user_id(authorization)
        persona = design_agent_service.get_user_persona(user_id)
        return {"persona": persona}

    # ===== 导出 API =====

    @router.post("/agent/generate-colors")
    async def generate_colors(
        body: dict,
        authorization: str | None = Header(default=None),
    ):
        """AI 根据关键词生成配色方案"""
        require_identity(authorization)
        keywords = str(body.get("keywords", "")).strip()
        if not keywords:
            raise HTTPException(status_code=400, detail="请输入配色关键词")

        from services.protocol.conversation import ConversationRequest, collect_text, text_backend

        prompt = f"""根据以下关键词生成一组专业的 UI 配色方案。

关键词：{keywords}

要求：
1. 生成 4 个颜色：primary（主色）、secondary（辅色）、accent（强调色）、background（背景色）
2. 配色要协调、现代、专业
3. 确保主色和背景色对比度足够
4. 只输出 JSON 格式，不要解释

输出格式（严格 JSON）：
{{"primary": "#hex", "secondary": "#hex", "accent": "#hex", "background": "#hex"}}"""

        def call_ai():
            backend = text_backend()
            request = ConversationRequest(model="auto", prompt=prompt)
            return collect_text(backend, request)

        try:
            result = await run_in_threadpool(call_ai)
            # 提取 JSON
            import re
            match = re.search(r'\{[^}]+\}', result)
            if match:
                colors = json.loads(match.group())
                return {"colors": colors}
            raise HTTPException(status_code=502, detail="AI 返回格式错误")
        except json.JSONDecodeError:
            raise HTTPException(status_code=502, detail="AI 返回格式错误")
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"生成失败: {exc}") from exc

    @router.post("/export/convert")
    async def export_convert(
        body: dict,
        authorization: str | None = Header(default=None),
    ):
        """将 HTML 转换为 Vue/React 组件"""
        require_identity(authorization)
        html = str(body.get("html", "")).strip()
        target = str(body.get("target", "vue")).strip()  # vue / react
        if not html:
            raise HTTPException(status_code=400, detail="缺少 html")

        from services.protocol.conversation import ConversationRequest, collect_text, text_backend

        if target == "vue":
            prompt = f"""将以下 HTML 代码转换为 Vue 3 单文件组件（SFC）格式。

规则：
1. 使用 <template> + <script setup> + <style scoped> 结构
2. 提取内联样式为 scoped CSS class
3. 保持视觉效果完全一致
4. 使用 Composition API
5. 只输出 .vue 文件内容，不要解释

HTML 代码：
```html
{html}
```"""
        else:
            prompt = f"""将以下 HTML 代码转换为 React 函数组件（JSX）格式。

规则：
1. 使用函数组件 + CSS Module 或内联样式
2. class 改为 className
3. style 属性改为对象格式
4. 保持视觉效果完全一致
5. 导出为默认组件
6. 只输出 .jsx 文件内容，不要解释

HTML 代码：
```html
{html}
```"""

        def call_ai():
            backend = text_backend()
            request = ConversationRequest(model="auto", prompt=prompt)
            return collect_text(backend, request)

        try:
            code = await run_in_threadpool(call_ai)
            code = _strip_html(code)
            return {"code": code, "target": target}
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"转换失败: {exc}") from exc

    @router.get("/preview/{project_id}/{page_id}")
    async def preview_page(
        project_id: str,
        page_id: str,
    ):
        """公开预览页面（给 Figma 插件用）"""
        from fastapi.responses import HTMLResponse
        # 遍历所有用户目录找到项目
        for user_dir in DESIGNS_DIR.iterdir():
            if not user_dir.is_dir():
                continue
            project_file = user_dir / f"{project_id}.json"
            if project_file.exists():
                try:
                    project = json.loads(project_file.read_text(encoding="utf-8"))
                    # 找页面
                    for page in project.get("pages", []):
                        if page["id"] == page_id:
                            html = page.get("html", "")
                            return HTMLResponse(
                                f'<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><style>*{{margin:0;padding:0;box-sizing:border-box}}body{{font-family:system-ui,-apple-system,sans-serif;}}</style></head><body>{html}</body></html>'
                            )
                    # 如果没有 pages，用主 html
                    if project.get("html"):
                        return HTMLResponse(
                            f'<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><style>*{{margin:0;padding:0;box-sizing:border-box}}body{{font-family:system-ui,-apple-system,sans-serif;}}</style></head><body>{project["html"]}</body></html>'
                        )
                except Exception:
                    pass
        raise HTTPException(status_code=404, detail="页面不存在")
        return {"persona": persona}

    @router.put("/agent/persona")
    async def update_persona(
        body: dict,
        authorization: str | None = Header(default=None),
    ):
        """更新用户的 Agent 人设配置"""
        user_id = _get_user_id(authorization)
        design_agent_service.save_user_persona(user_id, body)
        return {"ok": True}

    # ===== Skill 预设组合 API =====

    @router.get("/agent/presets")
    async def list_presets(authorization: str | None = Header(default=None)):
        """获取 Skill 预设组合列表"""
        require_identity(authorization)
        return {"presets": design_agent_service.get_skill_presets()}

    @router.post("/agent/presets/activate")
    async def activate_preset(
        body: dict,
        authorization: str | None = Header(default=None),
    ):
        """激活一个 Skill 预设组合"""
        require_identity(authorization)
        preset_id = str(body.get("preset_id", "")).strip()
        if not preset_id:
            raise HTTPException(status_code=400, detail="缺少 preset_id")
        result = design_agent_service.activate_preset(preset_id)
        if not result:
            raise HTTPException(status_code=404, detail="预设不存在")
        return {"ok": True, "activated_skills": result}

    # ===== Skill 详情 API =====

    @router.get("/agent/roles")
    async def list_roles(authorization: str | None = Header(default=None)):
        """获取 Agent 角色预设列表"""
        require_identity(authorization)
        return {"roles": design_agent_service.get_agent_roles()}

    @router.get("/agent/skills/{skill_name}/detail")
    async def get_skill_detail(
        skill_name: str,
        authorization: str | None = Header(default=None),
    ):
        """获取 skill 完整内容"""
        require_identity(authorization)
        detail = design_agent_service.get_skill_detail(skill_name)
        if not detail:
            raise HTTPException(status_code=404, detail="Skill 不存在")
        return {"skill": detail}

    return router
