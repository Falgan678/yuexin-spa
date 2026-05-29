FROM python:3.12-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    TZ=Asia/Shanghai

WORKDIR /app

# 系统依赖（curl 用于 HEALTHCHECK；tini 提供正确的信号转发）
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 先装依赖，利用 Docker 层缓存
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir gunicorn==22.0.0 'bcrypt>=4.1,<5.0' 'Pillow>=10.3,<12.0'

# 复制源码
COPY . .

# 非 root 用户
RUN groupadd -r yuexin && useradd -r -g yuexin -d /app yuexin \
    && mkdir -p /app/static/uploads \
    && chown -R yuexin:yuexin /app

USER yuexin

# 上传目录持久化（部署时必须挂载到外部卷，否则容器重启丢图）
VOLUME ["/app/static/uploads"]

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]

# 2 个 worker 起步；机器更大可提高 -w
CMD ["gunicorn", "main:app", \
     "-k", "uvicorn.workers.UvicornWorker", \
     "-w", "2", \
     "-b", "0.0.0.0:8000", \
     "--timeout", "60", \
     "--access-logfile", "-", \
     "--error-logfile",  "-"]
