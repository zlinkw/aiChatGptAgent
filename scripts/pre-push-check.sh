#!/usr/bin/env bash
# Pre-push 安全检查脚本
# 用法：bash scripts/pre-push-check.sh
# 在每次 git push 之前跑一遍，扫描即将提交的文件是否含敏感信息。
# 兼容 macOS 自带 bash 3.2。

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

ERRORS=0
WARNINGS=0

log_error()   { printf "${RED}[ERROR]${NC} %s\n" "$1"; ERRORS=$((ERRORS + 1)); }
log_warn()    { printf "${YELLOW}[WARN]${NC}  %s\n" "$1"; WARNINGS=$((WARNINGS + 1)); }
log_ok()      { printf "${GREEN}[OK]${NC}    %s\n" "$1"; }
log_info()    { printf "${BLUE}[INFO]${NC}  %s\n" "$1"; }

echo ""
echo "==============================================="
echo "  ChatGPT2API · Pre-push 安全检查"
echo "==============================================="
echo ""

# ---------- 1. 确认在 git 仓库中 ----------
if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    log_error "当前目录不是 git 仓库，请先运行 git init"
    exit 1
fi
log_ok "git 仓库已就绪"

# ---------- 2. 列出被 git 跟踪 / 暂存的文件 ----------
TRACKED=$(git ls-files)
if [ -z "$TRACKED" ]; then
    log_warn "git 索引为空，没有任何文件被跟踪。请先 git add"
    exit 1
fi
log_ok "已跟踪 $(echo "$TRACKED" | wc -l | tr -d ' ') 个文件"

# ---------- 3. 检查不该被跟踪的敏感文件 ----------
# 每行一个 basename / 子串模式（精确匹配 basename 或文件路径含子串）
echo ""
log_info "检查被跟踪的文件中是否含敏感文件..."

check_pattern() {
    local mode="$1"      # "basename" 精确匹配文件名 / "substring" 匹配路径子串
    local pat="$2"
    local hits=""
    if [ "$mode" = "basename" ]; then
        hits=$(echo "$TRACKED" | awk -F/ -v p="$pat" '$NF == p { print }')
    else
        hits=$(echo "$TRACKED" | grep -F -- "$pat" || true)
    fi
    if [ -n "$hits" ]; then
        log_error "敏感文件被跟踪（模式: $pat）"
        echo "$hits" | sed 's/^/        /'
        echo "        修复: git rm --cached <file> && git commit"
    fi
}

# 严格 basename 匹配（避免 tsconfig.json 误中 config.json）
check_pattern basename "config.json"
check_pattern basename "accounts.db"
check_pattern basename "accounts.json"
check_pattern basename "register.json"
check_pattern basename "registered_accounts.json"
check_pattern basename "api_backend.json"
check_pattern basename "gateway_config.json"
check_pattern basename ".env"
check_pattern basename ".env.local"

# 子串匹配（账号 / token 备份文件）
check_pattern substring "old_codex-"
check_pattern substring "old_chatgpt-"
check_pattern substring "@proton.me"
check_pattern substring "-free.json"
check_pattern substring "-plus.json"
check_pattern substring "-team.json"
check_pattern substring "-pro.json"

# ---------- 4. 扫描文件内容中的常见密钥模式 ----------
echo ""
log_info "扫描文件内容中可能的密钥..."

# 排除示例文件、文档、lock、二进制资源、脚本自身
EXCLUDE_PATHSPEC=(
    ":(exclude)README.md"
    ":(exclude)README*.md"
    ":(exclude)docs/*"
    ":(exclude)*.example.*"
    ":(exclude).env.example"
    ":(exclude)uv.lock"
    ":(exclude)web/bun.lock"
    ":(exclude)web/package-lock.json"
    ":(exclude)assets/*"
    ":(exclude)scripts/pre-push-check.sh"
)

scan_pattern() {
    local desc="$1"
    local pat="$2"
    local hits=""
    hits=$(git grep -nIE -- "$pat" "${EXCLUDE_PATHSPEC[@]}" 2>/dev/null || true)
    if [ -n "$hits" ]; then
        log_error "$desc"
        echo "$hits" | sed 's/^/        /'
    fi
}

scan_pattern "疑似 OpenAI API Key (sk-...)"           'sk-[a-zA-Z0-9]{20,}'
scan_pattern "疑似 GitHub Personal Access Token"       'ghp_[a-zA-Z0-9]{20,}'
scan_pattern "疑似 GitLab Personal Access Token"       'glpat-[a-zA-Z0-9_-]{20,}'
scan_pattern "疑似 AWS Access Key (AKIA...)"           'AKIA[0-9A-Z]{16}'
scan_pattern "疑似 JWT (RS256 header)"                 'eyJhbGciOiJSUzI1NiI'
scan_pattern "疑似 OpenAI refresh token (rt_pro...)"   'rt_pro[A-Za-z0-9_-]{20,}'

# ---------- 5. 检查是否有大文件 (>5MB) ----------
echo ""
log_info "检查是否有过大的文件 (>5MB)..."

LARGE_FILES=$(echo "$TRACKED" | while IFS= read -r f; do
    [ -f "$f" ] || continue
    size=$(wc -c < "$f" | tr -d ' ')
    if [ "$size" -gt 5242880 ]; then
        printf "%s\t%s\n" "$size" "$f"
    fi
done | sort -rn || true)

if [ -n "$LARGE_FILES" ]; then
    log_warn "发现大文件，可能不该入库："
    echo "$LARGE_FILES" | awk -F'\t' '{ printf "        %.2f MB  %s\n", $1/1048576, $2 }'
fi

# ---------- 6. 提示 .gitignore 是否生效 ----------
echo ""
log_info "确认 .gitignore 正在生效..."

EXPECTED_IGNORED=(data config.json web_dist .env)
for f in "${EXPECTED_IGNORED[@]}"; do
    if git check-ignore -q "$f" 2>/dev/null; then
        log_ok ".gitignore 已忽略 $f"
    else
        log_warn ".gitignore 似乎没有忽略 $f （如有同名实体文件请检查）"
    fi
done

# ---------- 7. 总结 ----------
echo ""
echo "==============================================="
if [ "$ERRORS" -gt 0 ]; then
    printf "${RED}检查未通过${NC}：发现 %d 个错误，%d 个警告\n" "$ERRORS" "$WARNINGS"
    echo "请修复上面标 [ERROR] 的问题后再 push"
    exit 1
elif [ "$WARNINGS" -gt 0 ]; then
    printf "${YELLOW}通过（带警告）${NC}：%d 个警告\n" "$WARNINGS"
    echo "建议人工 review 后再 push"
    exit 0
else
    printf "${GREEN}全部通过${NC}，可以安全 push\n"
    exit 0
fi
