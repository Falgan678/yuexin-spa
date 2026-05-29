#!/usr/bin/env bash
# ============================================================
# 悦心养生馆 - 一键部署脚本（Ubuntu 22.04 / Debian 12）
# 目标：服务器全新拿到手，跑完这个脚本即得到一个可用 HTTP 站
#       备案下来后再跑 deploy/enable_https.sh 升级 HTTPS
# ============================================================
set -euo pipefail

# 颜色输出
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC}  $*"; }
err()  { echo -e "${RED}[err]${NC}   $*"; }

# 必须 root
if [[ $EUID -ne 0 ]]; then
  err "请用 root 或 sudo 执行：sudo bash $0"; exit 1
fi

APP_DIR="${APP_DIR:-/opt/yuexin}"
UPLOAD_DIR="${UPLOAD_DIR:-/data/yuexin/uploads}"
PORT="${PORT:-8000}"

log "================================================================"
log "悦心养生馆 - 一键部署"
log "  应用目录: $APP_DIR"
log "  上传目录: $UPLOAD_DIR (持久化卷)"
log "  容器端口: 127.0.0.1:$PORT"
log "================================================================"

# ----------------------------------------------------------------
# 1. 系统依赖：docker / nginx / curl
# ----------------------------------------------------------------
log "[1/6] 安装系统依赖..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg lsb-release nginx ufw

if ! command -v docker >/dev/null 2>&1; then
  log "    安装 Docker（官方一键脚本）..."
  curl -fsSL https://get.docker.com | bash
  systemctl enable --now docker
else
  log "    Docker 已安装：$(docker --version)"
fi

# ----------------------------------------------------------------
# 2. 检查源码
# ----------------------------------------------------------------
log "[2/6] 检查源码目录..."
if [[ ! -f "$APP_DIR/Dockerfile" ]]; then
  err "未在 $APP_DIR 找到 Dockerfile。请先把项目上传到该目录："
  err "  例如：scp -r ./悦心养生馆/* root@<server>:$APP_DIR/"
  err "  或：在服务器上 git clone <你的仓库> $APP_DIR"
  exit 1
fi
log "    ok：找到 $APP_DIR/Dockerfile"

# ----------------------------------------------------------------
# 3. 准备 .env
# ----------------------------------------------------------------
log "[3/6] 准备环境变量 .env ..."
ENV_FILE="$APP_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  warn "    .env 已存在，跳过生成（如需重置请先 mv $ENV_FILE $ENV_FILE.bak）"
else
  if [[ ! -f "$APP_DIR/.env.production.example" ]]; then
    err "缺少 .env.production.example 模板"; exit 1
  fi

  # 自动生成 SESSION_SECRET 和 bcrypt 密码哈希
  log "    生成随机 SESSION_SECRET..."
  # 优先用系统自带的 openssl（Ubuntu 默认有），更快
  if command -v openssl >/dev/null 2>&1; then
    SESSION_SECRET=$(openssl rand -base64 48 | tr -d '\n=' | tr '+/' '-_')
  else
    SESSION_SECRET=$(docker run --rm python:3.12-slim \
      python -c "import secrets;print(secrets.token_urlsafe(48))")
  fi

  # 询问管理员密码
  echo ""
  read -r -p "  请输入要设置的管理员密码 (≥8 位，含字母+数字)：" -s ADMIN_PWD
  echo ""
  if [[ -z "$ADMIN_PWD" || ${#ADMIN_PWD} -lt 8 ]]; then
    err "密码必须 ≥ 8 位"; exit 1
  fi
  log "    用 bcrypt 生成密码哈希..."
  # 优先用系统 python3 + pip 装 bcrypt（首次约 5 秒）
  if command -v python3 >/dev/null 2>&1; then
    if ! python3 -c "import bcrypt" 2>/dev/null; then
      apt-get install -y python3-pip >/dev/null 2>&1 || true
      python3 -m pip install --quiet --break-system-packages bcrypt 2>/dev/null \
        || python3 -m pip install --quiet bcrypt
    fi
    ADMIN_HASH=$(python3 -c "import bcrypt,sys;print(bcrypt.hashpw(sys.argv[1].encode(),bcrypt.gensalt()).decode())" "$ADMIN_PWD")
  else
    ADMIN_HASH=$(docker run --rm python:3.12-slim sh -c \
      "pip install -q bcrypt >/dev/null 2>&1 && python -c \"import bcrypt,sys;print(bcrypt.hashpw(sys.argv[1].encode(),bcrypt.gensalt()).decode())\" '$ADMIN_PWD'")
  fi
  unset ADMIN_PWD

  # 询问域名（备案前可以先填 IP）
  echo ""
  read -r -p "  请输入网站域名（备案前先随便填个，备案下来再改，例：yuexinys.com）：" DOMAIN
  DOMAIN=${DOMAIN:-yuexin.local}

  # 生成 .env
  cp "$APP_DIR/.env.production.example" "$ENV_FILE"
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$SESSION_SECRET|" "$ENV_FILE"
  sed -i "s|^ADMIN_PASSWORD_HASH=.*|ADMIN_PASSWORD_HASH=$ADMIN_HASH|" "$ENV_FILE"
  sed -i "s|^ALLOWED_ORIGINS=.*|ALLOWED_ORIGINS=http://$DOMAIN,https://$DOMAIN|" "$ENV_FILE"
  # 备案前用 SQLite 也行；备案后流量大可改 mysql
  sed -i "s|^DB_BACKEND=.*|DB_BACKEND=sqlite|" "$ENV_FILE"
  # 注释掉 MySQL 字段，避免空值连接报错
  sed -i "s|^DB_HOST=|# DB_HOST=|"     "$ENV_FILE" || true
  sed -i "s|^DB_PORT=|# DB_PORT=|"     "$ENV_FILE" || true
  sed -i "s|^DB_USER=|# DB_USER=|"     "$ENV_FILE" || true
  sed -i "s|^DB_PASSWORD=|# DB_PASSWORD=|" "$ENV_FILE" || true
  sed -i "s|^DB_NAME=|# DB_NAME=|"     "$ENV_FILE" || true
  chmod 600 "$ENV_FILE"
  log "    .env 生成完毕（含管理员哈希、SESSION_SECRET、CORS 域名）"
fi

# ----------------------------------------------------------------
# 4. 上传目录
# ----------------------------------------------------------------
log "[4/6] 创建上传持久化目录 $UPLOAD_DIR ..."
mkdir -p "$UPLOAD_DIR"
chown -R 1000:1000 "$UPLOAD_DIR" 2>/dev/null || true

# ----------------------------------------------------------------
# 5. 构建 + 启动容器
# ----------------------------------------------------------------
log "[5/6] 构建并启动容器..."
cd "$APP_DIR"
docker build -t yuexin-spa:latest .

# 停掉旧容器
if docker ps -a --format '{{.Names}}' | grep -q '^yuexin$'; then
  log "    停止旧容器..."
  docker rm -f yuexin >/dev/null
fi

docker run -d \
  --name yuexin \
  --env-file "$ENV_FILE" \
  -p 127.0.0.1:${PORT}:8000 \
  -v "$UPLOAD_DIR":/app/static/uploads \
  --restart unless-stopped \
  --log-opt max-size=10m --log-opt max-file=5 \
  yuexin-spa:latest

# 等容器健康
log "    等待容器就绪..."
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    log "    ✅ 容器健康检查通过"
    break
  fi
  sleep 1
  if [[ $i -eq 30 ]]; then
    err "容器在 30 秒内未通过健康检查，请查看日志：docker logs yuexin"
    exit 1
  fi
done

# ----------------------------------------------------------------
# 6. Nginx 反向代理（HTTP）
# ----------------------------------------------------------------
log "[6/6] 配置 Nginx HTTP 反向代理..."

if [[ ! -f /etc/nginx/sites-available/yuexin.conf ]]; then
  cp "$APP_DIR/deploy/nginx_http.conf" /etc/nginx/sites-available/yuexin.conf
  read -r -p "  你的服务器公网 IP 或域名（用于 server_name，备案前可填 IP，例 1.2.3.4）：" SERVER_NAME
  SERVER_NAME=${SERVER_NAME:-_}
  sed -i "s|__SERVER_NAME__|$SERVER_NAME|g" /etc/nginx/sites-available/yuexin.conf
  sed -i "s|__APP_PORT__|$PORT|g" /etc/nginx/sites-available/yuexin.conf
  ln -sf /etc/nginx/sites-available/yuexin.conf /etc/nginx/sites-enabled/yuexin.conf
  rm -f /etc/nginx/sites-enabled/default
fi

# 测试并 reload
nginx -t
systemctl enable --now nginx
systemctl reload nginx

# 防火墙
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp  >/dev/null 2>&1 || true
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  yes | ufw enable  >/dev/null 2>&1 || true
fi

log ""
log "================================================================"
log "🎉 部署完成！"
log "  ▸ 容器状态：docker ps | grep yuexin"
log "  ▸ 容器日志：docker logs -f yuexin"
log "  ▸ 直接访问：http://<你的公网 IP>/"
log "  ▸ 前台预约：http://<你的公网 IP>/static/index.html"
log "  ▸ 后台管理：http://<你的公网 IP>/static/admin.html"
log ""
log "  备案下来后，请把域名 A 记录解析到本机 IP，然后："
log "    bash $APP_DIR/deploy/enable_https.sh <你的域名>"
log "================================================================"
