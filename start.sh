#!/usr/bin/env bash
# ============================================================
# 悦心养生馆 - Linux / macOS 一键启动
# 自动：建虚拟环境 → 装依赖 → 建库 → 启动服务
# ============================================================
set -e

cd "$(dirname "$0")"

echo ""
echo "============================================================"
echo "  悦心养生馆 - 本地一键启动"
echo "============================================================"
echo ""

# 1. 检查 Python
if ! command -v python3 >/dev/null 2>&1; then
    echo "[错误] 未检测到 python3，请先安装 Python 3.10+"
    exit 1
fi

python3 --version
echo ""

# 2. 创建虚拟环境
if [ ! -d ".venv" ]; then
    echo "[1/4] 创建虚拟环境 .venv ..."
    python3 -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate
echo "[✓] 虚拟环境已激活"

# 3. 安装依赖
echo ""
echo "[2/4] 安装依赖（首次约 1-3 分钟）..."
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple \
    || pip install -r requirements.txt
echo "[✓] 依赖安装完成"

# 4. 初始化数据库
echo ""
echo "[3/4] 初始化数据库 ..."
export YUEXIN_ALLOW_DEFAULT_SECRETS=1
python init_db.py --with-sample
echo "[✓] 数据库就绪"

# 5. 启动
echo ""
echo "[4/4] 启动服务 ..."
echo ""
echo "============================================================"
echo "  ✅ 启动成功！请在浏览器访问："
echo ""
echo "     客户首页：http://127.0.0.1:8000/"
echo "     管理后台：http://127.0.0.1:8000/static/admin.html"
echo ""
echo "  默认账号：admin"
echo "  默认密码：yuexin123"
echo ""
echo "  按 Ctrl+C 可停止服务"
echo "============================================================"
echo ""

# 后台尝试打开浏览器（macOS / Linux 各有不同命令）
( sleep 3 && {
    if command -v xdg-open >/dev/null; then xdg-open http://127.0.0.1:8000/ 2>/dev/null
    elif command -v open >/dev/null; then open http://127.0.0.1:8000/ 2>/dev/null
    fi
} ) &

uvicorn main:app --reload --host 127.0.0.1 --port 8000
