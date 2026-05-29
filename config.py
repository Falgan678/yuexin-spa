"""
应用配置 - 通过 .env 文件 / 环境变量加载

安全策略：
1. 生产环境必须显式设置 ADMIN_PASSWORD 与 SESSION_SECRET，否则启动失败
2. 密码支持两种形式（自动识别）：
   - 明文：ADMIN_PASSWORD=xxxxx                （会强制最小长度 8）
   - bcrypt 哈希：ADMIN_PASSWORD_HASH=$2b$...   （推荐，生成方式见下方）
3. SESSION_SECRET 至少 32 位
4. 通过环境变量 YUEXIN_ALLOW_DEFAULT_SECRETS=1 可在仅本地开发时临时跳过断言

bcrypt 密码生成（一次性）：
    python -c "import bcrypt;print(bcrypt.hashpw(b'你的强密码', bcrypt.gensalt()).decode())"
"""
from __future__ import annotations

import os
import secrets
import sys
from pathlib import Path


# ------------------------------------------------------------------
# .env 加载（避免引入额外依赖）
# ------------------------------------------------------------------
def _load_dotenv() -> None:
    env_path = Path(__file__).parent / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


_load_dotenv()


# ------------------------------------------------------------------
# 是否允许默认弱密码 / 默认密钥（仅本地开发）
# ------------------------------------------------------------------
_ALLOW_DEFAULT = os.getenv("YUEXIN_ALLOW_DEFAULT_SECRETS", "").strip() in ("1", "true", "yes")


# ------------------------------------------------------------------
# 管理后台登录配置
# ------------------------------------------------------------------
ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "admin")

# 优先使用 bcrypt 哈希；兼容历史明文配置
ADMIN_PASSWORD_HASH = os.getenv("ADMIN_PASSWORD_HASH", "").strip()
_admin_password_plain_raw = os.getenv("ADMIN_PASSWORD", "")

# 是否启用管理后台登录
ADMIN_AUTH_ENABLED = os.getenv("ADMIN_AUTH_ENABLED", "true").lower() in ("1", "true", "yes")

# Session 密钥（启动期校验后才赋给最终常量 SESSION_SECRET）
_session_secret_raw = os.getenv("SESSION_SECRET", "")

# CORS 允许源（逗号分隔），生产强烈建议明确域名
ALLOWED_ORIGINS = [
    o.strip() for o in os.getenv(
        "ALLOWED_ORIGINS",
        "http://localhost,http://127.0.0.1,http://localhost:8000,http://127.0.0.1:8000",
    ).split(",") if o.strip()
]

# 是否信任 Token 通过 query string 传递（生产必须 false）
ALLOW_TOKEN_QUERY = os.getenv("ALLOW_TOKEN_QUERY", "false").lower() in ("1", "true", "yes")

# 速率限制总开关（CI / 单元测试可关掉，避免连发 fail）
RATE_LIMIT_ENABLED = os.getenv("RATE_LIMIT_ENABLED", "true").lower() in ("1", "true", "yes")

# 登录失败锁定阈值（同 IP）
LOGIN_FAIL_THRESHOLD = int(os.getenv("LOGIN_FAIL_THRESHOLD", "10"))
LOGIN_FAIL_LOCK_MINUTES = int(os.getenv("LOGIN_FAIL_LOCK_MINUTES", "15"))

# 生产环境是否暴露 OpenAPI 文档（/docs /redoc /openapi.json）
# 默认关闭；本地开发可在 .env 中设 DOCS_ENABLED=true
DOCS_ENABLED = os.getenv("DOCS_ENABLED", "false").lower() in ("1", "true", "yes")

# 是否信任反向代理注入的 X-Forwarded-For（仅在 Nginx/网关后才设 true，
# 否则攻击者可伪造 IP 绕过登录失败锁定 / 限流）
TRUST_PROXY_HEADERS = os.getenv("TRUST_PROXY_HEADERS", "false").lower() in ("1", "true", "yes")


# ------------------------------------------------------------------
# 启动期安全断言（异常即拒绝启动）
# ------------------------------------------------------------------
_DEFAULT_WEAK_PASSWORDS = {
    "yuexin123", "admin", "admin123", "password", "123456", "test",
}
_DEFAULT_WEAK_SECRETS = {
    "yuexin-dev-secret-change-me", "change-me", "secret", "",
}


def _fail(msg: str) -> None:
    _ = sys.stderr.write("\n[FATAL] 配置不安全：" + msg + "\n")
    _ = sys.stderr.write(
        "  → 解决：在 .env 或环境变量中正确配置；"
        + "本地仅本机开发可设置 YUEXIN_ALLOW_DEFAULT_SECRETS=1 临时跳过此校验。\n\n"
    )
    _ = sys.stderr.flush()
    sys.exit(1)


def _validate_secrets() -> "tuple[str, str]":
    """返回最终生效的 (session_secret, admin_password_plain)。"""
    session_secret = _session_secret_raw
    admin_password_plain = _admin_password_plain_raw

    if _ALLOW_DEFAULT:
        # 本地开发模式：自动补齐缺失项，不退出
        if not session_secret:
            session_secret = secrets.token_urlsafe(48)
        if not ADMIN_PASSWORD_HASH and not admin_password_plain:
            admin_password_plain = "yuexin123"
        return session_secret, admin_password_plain

    # SESSION_SECRET 必须 ≥ 32 位且非默认
    if (not session_secret or len(session_secret) < 32
            or session_secret in _DEFAULT_WEAK_SECRETS):
        _fail(
            "SESSION_SECRET 未设置或过短（< 32 位）。\n"
            + '  生成方式：python -c "import secrets;print(secrets.token_urlsafe(48))"'
        )

    # 密码必须显式配置（哈希优先）
    if not ADMIN_PASSWORD_HASH and not admin_password_plain:
        _fail("ADMIN_PASSWORD 或 ADMIN_PASSWORD_HASH 必须至少配置一个。")

    if admin_password_plain:
        if admin_password_plain.lower() in _DEFAULT_WEAK_PASSWORDS:
            _fail(
                "ADMIN_PASSWORD 使用了默认弱密码 ("
                + admin_password_plain + ")，请改成 ≥ 8 位强密码。"
            )
        if len(admin_password_plain) < 8:
            _fail("ADMIN_PASSWORD 长度必须 ≥ 8 位。")

    return session_secret, admin_password_plain


SESSION_SECRET, ADMIN_PASSWORD_PLAIN = _validate_secrets()


def _validate_origins() -> None:
    """生产环境必须显式配置 ALLOWED_ORIGINS，且不允许仍包含 localhost / 127.0.0.1。"""
    if _ALLOW_DEFAULT:
        return
    bad = [o for o in ALLOWED_ORIGINS
           if o.startswith("http://localhost") or o.startswith("http://127.")]
    if bad:
        _fail(
            "ALLOWED_ORIGINS 仍包含本地源："
            + str(bad)
            + "；生产请配置为正式域名（逗号分隔），如：\n"
            + "  ALLOWED_ORIGINS=https://yuexin.example.com"
        )


_validate_origins()


# ------------------------------------------------------------------
# 兼容入口：暴露给 main.py 的统一接口
# ------------------------------------------------------------------
ADMIN_PASSWORD = ADMIN_PASSWORD_PLAIN  # 仅当未配置 HASH 时由 main.verify_password 走 compare_digest
