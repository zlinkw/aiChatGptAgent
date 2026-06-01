# ------------------ 第一阶段：构建依赖 ------------------
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder

WORKDIR /app

# 启用字节码编译以提升启动速度，使用 copy 模式避免 link 问题
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

# 1. 直接复制依赖声明文件（不使用 bind 挂载，防止 CI/CD 权限或路径异常）
COPY pyproject.toml uv.lock ./

# 2. 同步安装依赖。
# 注意：这里我们去掉了 --frozen。如果 uv.lock 和 pyproject.toml 有微小不一致，
# uv 将会自动在构建时将其修复，而不会报错中断。
RUN uv sync --no-install-project --no-dev

# 3. 复制其余的所有源码并完成项目同步
COPY . /app
RUN uv sync --no-dev

# ------------------ 第二阶段：最终运行 ------------------
FROM python:3.12-slim-bookworm

WORKDIR /app

# 将虚拟环境的可执行路径加到 PATH 最前
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

# 从编译阶段复制完整的虚拟环境和代码
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app /app

EXPOSE 80

CMD ["python", "main.py"]
