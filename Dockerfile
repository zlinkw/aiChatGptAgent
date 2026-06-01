# ------------------ 第一阶段：依赖安装与编译 ------------------
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder

# 启用字节码编译以提升启动速度，使用 copy 模式避免 link 问题
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /app

# 利用 Docker 的缓存层机制，先复制依赖描述文件并同步
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --frozen --no-install-project --no-dev

# 复制其余的项目源码
COPY . /app

# 同步项目自身
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

# ------------------ 第二阶段：最终运行镜像（不含 uv，体积更小） ------------------
FROM python:3.12-slim-bookworm

WORKDIR /app

# 将 builder 阶段生成的虚拟环境加入 PATH，以便直接调用 python 命令
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

# 从第一阶段复制虚拟环境和源码
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app /app

# 暴露出项目的端口（根据 pyproject.toml 或原项目中定义的端口，这里假设为 8000）
EXPOSE 80

# 运行主程序
CMD ["python", "main.py"]
