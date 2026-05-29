#!/usr/bin/env bash
# ============================================================
# 备案下来后，把域名解析到服务器 IP，再执行此脚本：
#   bash enable_https.sh yuexinys.com
# 自动用 Let's Encrypt 申请证书 + 配置 Nginx 强制 HTTPS
# ============================================================
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "请用 root 或 sudo 执行"; exit 1
fi

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "用法：bash enable_https.sh <你的域名>"
  echo "示例：bash enable_https.sh yuexinys.com"
  exit 1
fi

# 1. 安装 certbot
if ! command -v certbot >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y certbot python3-certbot-nginx
fi

# 2. 替换 Nginx server_name
sed -i "s|server_name .*;|server_name $DOMAIN www.$DOMAIN;|" /etc/nginx/sites-available/yuexin.conf
nginx -t
systemctl reload nginx

# 3. 申请证书（HTTP-01 验证，需要 80 端口可达）
certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" \
  --non-interactive --agree-tos --register-unsafely-without-email \
  --redirect

# 4. 自动续期已由 certbot 系统服务接管，验证一次：
certbot renew --dry-run

# 5. 同步 .env 中的 ALLOWED_ORIGINS
ENV_FILE="/opt/yuexin/.env"
if [[ -f "$ENV_FILE" ]]; then
  sed -i "s|^ALLOWED_ORIGINS=.*|ALLOWED_ORIGINS=https://$DOMAIN,https://www.$DOMAIN|" "$ENV_FILE"
  docker restart yuexin
fi

echo ""
echo "🎉 HTTPS 已启用！请访问："
echo "    https://$DOMAIN/"
echo "    https://$DOMAIN/static/admin.html"
echo ""
echo "证书有效期 90 天，已自动加入 cron 每日续期检查。"
