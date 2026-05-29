@echo off
chcp 65001 > nul
REM ============================================================
REM 悦心养生馆 - Windows 一键启动脚本
REM 双击即可运行，会自动：装依赖 → 建库 → 启动服务 → 打开浏览器
REM ============================================================
setlocal enabledelayedexpansion

echo.
echo ============================================================
echo   悦心养生馆 - 本地一键启动
echo ============================================================
echo.

REM 1. 检查 Python
where python > nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 Python，请先安装 Python 3.10+ 并加入 PATH
    echo        下载地址：https://www.python.org/downloads/
    pause
    exit /b 1
)

python --version
echo.

REM 2. 创建并激活虚拟环境（避免污染全局）
if not exist .venv (
    echo [1/4] 创建虚拟环境 .venv ...
    python -m venv .venv
    if errorlevel 1 (
        echo [错误] 创建虚拟环境失败
        pause
        exit /b 1
    )
)

call .venv\Scripts\activate.bat
echo [✓] 虚拟环境已激活

REM 3. 安装依赖（首次需要 1-3 分钟，之后秒级）
echo.
echo [2/4] 安装依赖（首次约 1-3 分钟）...
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
if errorlevel 1 (
    echo [警告] 清华源失败，尝试默认源 ...
    python -m pip install -r requirements.txt
)
echo [✓] 依赖安装完成

REM 4. 初始化数据库（含示例数据）
echo.
echo [3/4] 初始化数据库（首次会写入默认 16 服务 / 6 环境图 / 3 优惠 / 5 医生）...
REM 设置允许默认弱密码（仅本地开发用）
set YUEXIN_ALLOW_DEFAULT_SECRETS=1
python init_db.py --with-sample
echo [✓] 数据库就绪

REM 5. 启动服务（后台启动 + 自动打开浏览器）
echo.
echo [4/4] 启动服务 ...
echo.
echo ============================================================
echo   ✅ 启动成功！请在浏览器访问：
echo.
echo      客户首页：http://127.0.0.1:8000/
echo      管理后台：http://127.0.0.1:8000/static/admin.html
echo.
echo   默认账号：admin
echo   默认密码：yuexin123
echo.
echo   按 Ctrl+C 可停止服务
echo ============================================================
echo.

REM 5 秒后自动打开浏览器
start /min cmd /c "timeout /t 3 > nul && start http://127.0.0.1:8000/"

uvicorn main:app --reload --host 127.0.0.1 --port 8000

endlocal
