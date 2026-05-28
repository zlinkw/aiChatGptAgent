"""舆情搜索服务 — 深度搜索公司关键词，分析负面新闻和舆情

支持三种搜索范围：
- domestic: 国内（小红书、微博、知乎、百度、天眼查等）
- overseas: 国外（Google News、Reddit、Twitter 等）
- global: 全球（全部来源）

搜索维度：
- 负面新闻 / 投诉曝光 / 法律诉讼 / 监管处罚
- 员工爆料 / 财务问题 / 产品质量 / 用户口碑
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import httpx

from services.config import DATA_DIR

# 缓存目录
SENTIMENT_CACHE_DIR = DATA_DIR / "sentiment_cache"
SENTIMENT_CACHE_DIR.mkdir(parents=True, exist_ok=True)

# 缓存有效期（秒）
CACHE_TTL = 1800  # 30 分钟

SearchScope = Literal["domestic", "overseas", "global"]
SearchDepth = Literal["quick", "deep"]


@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str
    source: str
    published: str = ""
    sentiment: str = ""
    sentiment_score: float = 0.0
    category: str = ""  # 搜索维度分类
    tags: list[str] = field(default_factory=list)


def _cache_key(query: str, scope: SearchScope, depth: SearchDepth) -> str:
    raw = f"{query}:{scope}:{depth}"
    return hashlib.md5(raw.encode()).hexdigest()


def _get_cached(query: str, scope: SearchScope, depth: SearchDepth) -> list[dict] | None:
    key = _cache_key(query, scope, depth)
    cache_file = SENTIMENT_CACHE_DIR / f"{key}.json"
    if not cache_file.exists():
        return None
    try:
        data = json.loads(cache_file.read_text(encoding="utf-8"))
        if time.time() - data.get("timestamp", 0) > CACHE_TTL:
            return None
        return data.get("results", [])
    except Exception:
        return None


def _set_cache(query: str, scope: SearchScope, depth: SearchDepth, results: list[dict]) -> None:
    key = _cache_key(query, scope, depth)
    cache_file = SENTIMENT_CACHE_DIR / f"{key}.json"
    data = {"timestamp": time.time(), "query": query, "scope": scope, "depth": depth, "results": results}
    cache_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


# ===== 搜索维度定义 =====

DOMESTIC_DIMENSIONS = [
    {"category": "负面新闻", "queries": ["{company} 负面新闻 曝光", "{company} 丑闻 黑幕"]},
    {"category": "投诉维权", "queries": ["{company} 投诉 维权 骗局", "{company} 消费者投诉 黑猫"]},
    {"category": "法律诉讼", "queries": ["{company} 起诉 判决 法院", "{company} 被执行人 失信"]},
    {"category": "监管处罚", "queries": ["{company} 罚款 处罚 监管", "{company} 行政处罚 违规"]},
    {"category": "财务风险", "queries": ["{company} 暴雷 跑路 崩盘", "{company} 亏损 债务 资金链"]},
    {"category": "员工爆料", "queries": ["{company} 员工爆料 内幕 裁员", "{company} 欠薪 拖欠工资"]},
    {"category": "产品质量", "queries": ["{company} 质量问题 投诉 差评", "{company} 踩雷 避坑 不靠谱"]},
    {"category": "社交媒体", "queries": ["{company} 小红书 踩雷", "{company} 知乎 骗局", "{company} 微博 曝光"]},
    {"category": "企业信用", "queries": ["{company} 天眼查 风险", "{company} 企查查 经营异常"]},
]

OVERSEAS_DIMENSIONS = [
    {"category": "Scandal/News", "queries": ["{company} scandal news controversy", "{company} negative news latest"]},
    {"category": "Fraud/Scam", "queries": ["{company} fraud scam complaint", "{company} class action lawsuit"]},
    {"category": "Reviews", "queries": ["{company} negative review terrible avoid", "{company} worst experience warning"]},
    {"category": "Legal", "queries": ["{company} lawsuit settlement fine SEC", "{company} investigation regulatory penalty"]},
    {"category": "Financial", "queries": ["{company} bankruptcy debt crisis layoffs", "{company} financial trouble collapse"]},
    {"category": "Social Media", "queries": ["{company} reddit complaint scam", "{company} twitter controversy backlash"]},
]


# ===== 搜索引擎 =====

def _get_serper_key() -> str:
    """从 config.json 获取 Serper API key"""
    try:
        import json
        from services.config import CONFIG_FILE
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        return str(data.get("serper_api_key", "")).strip()
    except Exception:
        return ""


def _search_serper(query: str, gl: str = "cn", hl: str = "zh-cn", max_results: int = 10, tbs: str = "") -> list[dict]:
    """使用 Serper.dev Google 搜索 API"""
    results = []
    api_key = _get_serper_key()
    if not api_key:
        print("[sentiment] Serper API key not configured")
        return []
    try:
        headers = {
            "X-API-KEY": api_key,
            "Content-Type": "application/json",
        }
        payload = {
            "q": query,
            "gl": gl,
            "hl": hl,
            "num": max_results,
        }
        if tbs:
            payload["tbs"] = tbs
        print(f"[sentiment] Serper searching: {query[:30]}...")
        with httpx.Client(timeout=20) as client:
            resp = client.post("https://google.serper.dev/search", json=payload, headers=headers)
            if resp.status_code != 200:
                print(f"[sentiment] Serper error: {resp.status_code} {resp.text[:200]}")
                return []
            data = resp.json()

            # 解析 organic 结果
            organic = data.get("organic", [])
            print(f"[sentiment] Serper got {len(organic)} results for: {query[:30]}")
            for item in organic[:max_results]:
                title = item.get("title", "")
                url = item.get("link", "")
                snippet = item.get("snippet", "")
                if title and url:
                    results.append({
                        "title": title,
                        "url": url,
                        "snippet": snippet,
                        "source": _detect_source(url),
                    })
    except Exception as e:
        print(f"[sentiment] Serper search error: {e}")
    return results


def _fetch_page_content(url: str, max_chars: int = 2000) -> str:
    """尝试抓取页面正文内容用于深度分析"""
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            "Accept": "text/html",
        }
        with httpx.Client(timeout=10, follow_redirects=True) as client:
            resp = client.get(url, headers=headers)
            if resp.status_code != 200:
                return ""
            html = resp.text
            # 移除 script/style
            html = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL)
            html = re.sub(r'<style[^>]*>.*?</style>', '', html, flags=re.DOTALL)
            # 提取文本
            text = re.sub(r'<[^>]+>', ' ', html)
            text = re.sub(r'\s+', ' ', text).strip()
            return text[:max_chars]
    except Exception:
        return ""


def _detect_source(url: str) -> str:
    """根据 URL 检测来源平台"""
    url_lower = url.lower()
    source_map = {
        "xiaohongshu.com": "小红书",
        "xhslink.com": "小红书",
        "weibo.com": "微博",
        "zhihu.com": "知乎",
        "baidu.com": "百度",
        "tieba.baidu.com": "百度贴吧",
        "douyin.com": "抖音",
        "bilibili.com": "B站",
        "toutiao.com": "今日头条",
        "163.com": "网易",
        "sohu.com": "搜狐",
        "sina.com": "新浪",
        "qq.com": "腾讯",
        "tianyancha.com": "天眼查",
        "qcc.com": "企查查",
        "court.gov.cn": "中国裁判文书网",
        "creditchina.gov.cn": "信用中国",
        "12315.cn": "12315",
        "reddit.com": "Reddit",
        "twitter.com": "Twitter/X",
        "x.com": "Twitter/X",
        "facebook.com": "Facebook",
        "linkedin.com": "LinkedIn",
        "youtube.com": "YouTube",
        "bbc.com": "BBC",
        "cnn.com": "CNN",
        "reuters.com": "Reuters",
        "bloomberg.com": "Bloomberg",
        "nytimes.com": "NYT",
        "wsj.com": "WSJ",
        "theguardian.com": "Guardian",
        "ft.com": "Financial Times",
        "techcrunch.com": "TechCrunch",
        "glassdoor.com": "Glassdoor",
        "indeed.com": "Indeed",
    }
    for domain, name in source_map.items():
        if domain in url_lower:
            return name
    return "网页"


# ===== 情绪分析 =====

NEGATIVE_KEYWORDS_ZH = [
    "负面", "投诉", "曝光", "暴雷", "跑路", "骗局", "维权", "诈骗",
    "失败", "亏损", "倒闭", "裁员", "违规", "处罚", "罚款", "黑幕",
    "丑闻", "造假", "欺诈", "坑人", "垃圾", "差评", "踩雷", "割韭菜",
    "起诉", "判决", "被告", "原告", "赔偿", "违约", "欠款", "拖欠",
    "举报", "打假", "假货", "虚假宣传", "侵权", "盗版", "抄袭",
    "跑路", "失联", "卷款", "非法集资", "传销", "洗钱", "行贿",
    "安全事故", "伤亡", "泄露", "数据泄露", "隐私", "监控",
    "强制", "霸王条款", "套路", "陷阱", "黑心", "无良",
    "破产", "清算", "重整", "退市", "ST", "警示",
    "约谈", "整改", "下架", "封禁", "限制", "冻结",
    "资金盘", "崩盘", "提现困难", "提现难", "无法提现", "血本无归",
    "翻车", "坑民", "难退", "失声", "预警", "爆雷", "崩了",
    "被骗", "上当", "受害", "受害者", "报警", "立案",
    "操盘", "杀猪盘", "庞氏", "击鼓传花", "拉人头",
]

NEGATIVE_KEYWORDS_EN = [
    "scandal", "fraud", "scam", "lawsuit", "complaint", "negative",
    "controversy", "failure", "bankrupt", "layoff", "fine", "penalty",
    "fake", "misleading", "terrible", "worst", "avoid", "warning",
    "investigation", "indictment", "settlement", "violation", "breach",
    "recall", "defect", "unsafe", "toxic", "contamination",
    "whistleblower", "coverup", "corruption", "bribery", "embezzlement",
    "ponzi", "pyramid", "money laundering", "insider trading",
    "data breach", "privacy violation", "hack", "exploit",
    "class action", "SEC", "FTC", "FDA warning", "cease and desist",
    "delisted", "default", "insolvency", "restructuring",
]

POSITIVE_KEYWORDS_ZH = [
    "好评", "推荐", "优秀", "成功", "增长", "创新", "突破", "领先",
    "获奖", "荣誉", "上市", "融资", "合作", "战略", "升级",
]

POSITIVE_KEYWORDS_EN = [
    "praise", "recommend", "excellent", "success", "growth", "innovation",
    "leading", "award", "best", "great", "positive", "breakthrough",
    "partnership", "expansion", "profit", "revenue growth",
]


def _analyze_sentiment_simple(title: str, snippet: str) -> tuple[str, float]:
    """关键词情绪分析"""
    text = f"{title} {snippet}".lower()

    neg_count = sum(1 for kw in NEGATIVE_KEYWORDS_ZH if kw in text)
    neg_count += sum(1 for kw in NEGATIVE_KEYWORDS_EN if kw in text)
    pos_count = sum(1 for kw in POSITIVE_KEYWORDS_ZH if kw in text)
    pos_count += sum(1 for kw in POSITIVE_KEYWORDS_EN if kw in text)

    if neg_count > pos_count:
        score = min(1.0, neg_count * 0.15)
        return "negative", -score
    elif pos_count > neg_count:
        score = min(1.0, pos_count * 0.15)
        return "positive", score
    return "neutral", 0.0


def _analyze_sentiment_deep(title: str, snippet: str, content: str) -> tuple[str, float]:
    """深度情绪分析（结合正文内容）"""
    full_text = f"{title} {snippet} {content}"
    text = full_text.lower()

    neg_count = sum(1 for kw in NEGATIVE_KEYWORDS_ZH if kw in text)
    neg_count += sum(1 for kw in NEGATIVE_KEYWORDS_EN if kw in text)
    pos_count = sum(1 for kw in POSITIVE_KEYWORDS_ZH if kw in text)
    pos_count += sum(1 for kw in POSITIVE_KEYWORDS_EN if kw in text)

    # 深度分析权重更细
    if neg_count > pos_count * 2:
        score = min(1.0, neg_count * 0.1)
        return "negative", -score
    elif neg_count > pos_count:
        score = min(0.8, neg_count * 0.1)
        return "negative", -score
    elif pos_count > neg_count:
        score = min(1.0, pos_count * 0.1)
        return "positive", score
    return "neutral", 0.0


# ===== 主搜索逻辑 =====

def search_sentiment(company: str, scope: SearchScope = "global", depth: SearchDepth = "quick", time_range: str = "") -> dict:
    """搜索公司舆情

    Args:
        company: 公司名称关键词
        scope: 搜索范围 domestic/overseas/global
        depth: 搜索深度 quick=快速 / deep=深度（抓取正文+多引擎）
        time_range: 时间范围 qdr:d/qdr:w/qdr:m/qdr:y/空=不限

    Returns:
        包含搜索结果和统计的字典
    """
    # 检查缓存
    cached = _get_cached(company, scope, depth)
    if cached is not None:
        return _build_response(company, scope, cached)

    # 选择搜索维度
    dimensions: list[dict] = []
    if scope in ("domestic", "global"):
        dimensions.extend(DOMESTIC_DIMENSIONS)
    if scope in ("overseas", "global"):
        dimensions.extend(OVERSEAS_DIMENSIONS)

    # 构建所有查询任务
    tasks: list[dict] = []
    for dim in dimensions:
        for query_template in dim["queries"]:
            query = query_template.replace("{company}", company)
            gl = "cn" if scope in ("domestic", "global") else "us"
            hl = "zh-cn" if gl == "cn" else "en"
            max_per_query = 10 if depth == "deep" else 5
            tasks.append({"query": query, "gl": gl, "hl": hl, "num": max_per_query, "category": dim["category"], "tbs": time_range})

    # 并发执行所有搜索（用线程池）
    from concurrent.futures import ThreadPoolExecutor, as_completed
    all_results: list[dict] = []
    seen_urls: set[str] = set()

    def _run_search(task: dict) -> list[dict]:
        results = _search_serper(task["query"], gl=task["gl"], hl=task["hl"], max_results=task["num"], tbs=task.get("tbs", ""))
        for r in results:
            r["category"] = task["category"]
        return results

    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {executor.submit(_run_search, t): t for t in tasks}
        for future in as_completed(futures):
            try:
                results = future.result()
                for r in results:
                    if r["url"] in seen_urls:
                        continue
                    seen_urls.add(r["url"])

                    # 相关性过滤：标题或摘要必须包含公司名（或公司名的核心部分）
                    text_to_check = f"{r.get('title', '')} {r.get('snippet', '')}".lower()
                    company_lower = company.lower()
                    # 检查完整名称或去掉常见后缀的核心名
                    core_name = company_lower.rstrip("公司集团有限股份科技").rstrip("有限公司")
                    if len(core_name) < 2:
                        core_name = company_lower
                    if company_lower not in text_to_check and core_name not in text_to_check:
                        continue

                    # 情绪分析
                    if depth == "deep":
                        content = _fetch_page_content(r["url"])
                        sentiment, score = _analyze_sentiment_deep(r["title"], r["snippet"], content)
                        r["has_content"] = bool(content)
                    else:
                        sentiment, score = _analyze_sentiment_simple(r["title"], r["snippet"])
                        r["has_content"] = False

                    r["sentiment"] = sentiment
                    r["sentiment_score"] = score
                    all_results.append(r)
            except Exception:
                pass

    # 按情绪分数排序（负面优先）
    all_results.sort(key=lambda x: x.get("sentiment_score", 0))

    # 缓存结果
    _set_cache(company, scope, depth, all_results)

    return _build_response(company, scope, all_results)


def _build_response(company: str, scope: SearchScope, results: list[dict]) -> dict:
    """构建响应数据"""
    total = len(results)
    negative = sum(1 for r in results if r.get("sentiment") == "negative")
    positive = sum(1 for r in results if r.get("sentiment") == "positive")
    neutral = total - negative - positive

    # 来源统计
    source_stats: dict[str, int] = {}
    for r in results:
        src = r.get("source", "其他")
        source_stats[src] = source_stats.get(src, 0) + 1

    # 维度统计
    category_stats: dict[str, dict] = {}
    for r in results:
        cat = r.get("category", "其他")
        if cat not in category_stats:
            category_stats[cat] = {"total": 0, "negative": 0, "positive": 0, "neutral": 0}
        category_stats[cat]["total"] += 1
        sentiment = r.get("sentiment", "neutral")
        category_stats[cat][sentiment] = category_stats[cat].get(sentiment, 0) + 1

    # 风险等级（更精细）
    if total == 0:
        risk_level = "unknown"
    elif negative / max(total, 1) > 0.5:
        risk_level = "high"
    elif negative / max(total, 1) > 0.25:
        risk_level = "medium"
    else:
        risk_level = "low"

    # 关键发现（提取最严重的负面信息）
    key_findings = []
    neg_results = [r for r in results if r.get("sentiment") == "negative"]
    for r in neg_results[:5]:
        key_findings.append({
            "title": r["title"],
            "source": r["source"],
            "category": r.get("category", ""),
            "severity": abs(r.get("sentiment_score", 0)),
        })

    return {
        "company": company,
        "scope": scope,
        "results": results,
        "stats": {
            "total": total,
            "negative": negative,
            "positive": positive,
            "neutral": neutral,
            "risk_level": risk_level,
            "negative_ratio": round(negative / max(total, 1) * 100, 1),
        },
        "source_stats": source_stats,
        "category_stats": category_stats,
        "key_findings": key_findings,
        "cached": False,
    }


def clear_cache() -> int:
    """清除所有缓存"""
    count = 0
    for f in SENTIMENT_CACHE_DIR.glob("*.json"):
        f.unlink()
        count += 1
    return count


# ===== 流式搜索（SSE） =====

def search_sentiment_stream(company: str, scope: SearchScope = "global", depth: SearchDepth = "quick", model: str = "", time_range: str = "") -> list[dict]:
    """流式搜索 — 返回事件列表，每搜到一批结果就产生一个事件

    事件类型：
    - {"type": "progress", "dimension": "...", "found": N, "total": N}
    - {"type": "result", "item": {...}}
    - {"type": "stats", ...}  最终统计
    - {"type": "ai_summary", "summary": "..."}  AI 总结（如果选了模型）
    """
    events: list[dict] = []

    # 选择搜索维度
    dimensions: list[dict] = []
    if scope in ("domestic", "global"):
        dimensions.extend(DOMESTIC_DIMENSIONS)
    if scope in ("overseas", "global"):
        dimensions.extend(OVERSEAS_DIMENSIONS)

    all_results: list[dict] = []
    seen_urls: set[str] = set()
    region = "cn-zh" if scope == "domestic" else ("us-en" if scope == "overseas" else "wt-wt")
    time_range = "y" if depth == "deep" else "m"
    max_per_query = 10 if depth == "deep" else 5

    for dim_idx, dim in enumerate(dimensions):
        dim_found = 0
        for query_template in dim["queries"]:
            query = query_template.replace("{company}", company)
            dim_region = region
            is_domestic = any(s in query for s in ["site:xiaohongshu", "site:weibo", "site:zhihu", "site:tieba", "site:tianyancha", "site:qcc"])
            is_overseas = any(s in query for s in ["site:reddit", "site:twitter", "site:x.com", "site:reuters", "site:bbc", "site:bloomberg", "site:wsj"])
            if is_domestic:
                dim_region = "cn-zh"
            elif is_overseas:
                dim_region = "us-en"

            results: list[dict] = []
            gl = "cn" if (dim_region == "cn-zh" or scope == "domestic") else "us"
            hl = "zh-cn" if gl == "cn" else "en"
            results = _search_serper(query, gl=gl, hl=hl, max_results=max_per_query, tbs=time_range)

            for r in results:
                if r["url"] in seen_urls:
                    continue
                seen_urls.add(r["url"])

                # 相关性过滤
                text_to_check = f"{r.get('title', '')} {r.get('snippet', '')}".lower()
                company_lower = company.lower()
                core_name = company_lower.rstrip("公司集团有限股份科技").rstrip("有限公司")
                if len(core_name) < 2:
                    core_name = company_lower
                if company_lower not in text_to_check and core_name not in text_to_check:
                    continue

                r["category"] = dim["category"]
                if depth == "deep":
                    content = _fetch_page_content(r["url"])
                    sentiment, score = _analyze_sentiment_deep(r["title"], r["snippet"], content)
                    r["has_content"] = bool(content)
                else:
                    sentiment, score = _analyze_sentiment_simple(r["title"], r["snippet"])
                    r["has_content"] = False
                r["sentiment"] = sentiment
                r["sentiment_score"] = score
                all_results.append(r)
                dim_found += 1

                # 每条结果都推送
                events.append({"type": "result", "item": r})

        # 每个维度搜完推送进度
        events.append({
            "type": "progress",
            "dimension": dim["category"],
            "dimension_index": dim_idx + 1,
            "dimension_total": len(dimensions),
            "found": dim_found,
            "total_so_far": len(all_results),
        })

    # 排序
    all_results.sort(key=lambda x: x.get("sentiment_score", 0))

    # 最终统计
    response = _build_response(company, scope, all_results)
    events.append({"type": "stats", **response})

    # AI 总结（如果选了模型）
    if model:
        summary = _ai_summarize(company, all_results, model)
        if summary:
            events.append({"type": "ai_summary", "summary": summary})

    # 缓存
    _set_cache(company, scope, depth, all_results)

    return events


def _ai_summarize(company: str, results: list[dict], model: str) -> str:
    """用 AI 模型对搜索结果做总结分析 — 调用本平台自己的 /v1/chat/completions"""
    if not results:
        return ""

    try:
        from services.config import config

        # 构建摘要文本
        neg_items = [r for r in results if r.get("sentiment") == "negative"][:10]
        all_count = len(results)
        neg_count = len([r for r in results if r.get("sentiment") == "negative"])
        summary_text = f"公司: {company}\n搜索到 {all_count} 条结果，其中 {neg_count} 条负面。\n\n负面信息摘要:\n"
        for i, r in enumerate(neg_items, 1):
            summary_text += f"{i}. [{r.get('category','')}] {r['title']} ({r['source']})\n   {r.get('snippet','')[:100]}\n"

        # 调用本平台自己的 API（localhost）
        api_url = "http://127.0.0.1:80/v1/chat/completions"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config.auth_key}",
        }

        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": "你是一个专业的舆情分析师。请根据搜索结果，用中文简洁总结该公司的舆情风险状况，包括：1.主要风险点 2.风险等级评估 3.建议关注事项。控制在200字以内。"},
                {"role": "user", "content": summary_text},
            ],
            "max_tokens": 500,
            "temperature": 0.3,
        }

        with httpx.Client(timeout=60) as client:
            resp = client.post(api_url, json=payload, headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                choices = data.get("choices", [])
                if choices:
                    return choices[0].get("message", {}).get("content", "")
    except Exception as e:
        print(f"[sentiment] AI summarize error: {e}")
    return ""

