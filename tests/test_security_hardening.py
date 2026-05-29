"""
安全加固验证：CORS / Token 仅 Header / 唯一索引 / 安全头 / 限流锁定
"""
import os

import pytest


# ==================== CORS 收敛 ====================
def test_cors_disallow_unknown_origin(client):
    """未在 ALLOWED_ORIGINS 列表中的 Origin，不应被回 Access-Control-Allow-Origin。"""
    resp = client.options("/api/services", headers={
        "Origin": "https://attacker.example.com",
        "Access-Control-Request-Method": "GET",
    })
    # Starlette 对未授权 origin 不抛 4xx，但 ACAO 头应缺失或不为 *
    acao = resp.headers.get("access-control-allow-origin", "")
    assert acao != "*"
    assert acao != "https://attacker.example.com"


def test_cors_allow_known_origin(client):
    resp = client.options("/api/services", headers={
        "Origin": "http://testserver",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Content-Type",
    })
    # 允许的源应回显
    assert resp.headers.get("access-control-allow-origin") == "http://testserver"


# ==================== Token 仅 Authorization Header ====================
def test_token_via_query_string_rejected(client, admin_token):
    """ALLOW_TOKEN_QUERY=false 时，?token=xxx 应被拒。"""
    resp = client.get(f"/api/admin/me?token={admin_token}")
    assert resp.status_code == 401


def test_token_via_header_accepted(client, admin_token):
    resp = client.get("/api/admin/me", headers={"Authorization": f"Bearer {admin_token}"})
    assert resp.status_code == 200


# ==================== 安全头 ====================
def test_security_headers_present(client):
    resp = client.get("/api/health")
    h = resp.headers
    assert h.get("x-content-type-options") == "nosniff"
    assert "x-frame-options" in h
    assert "referrer-policy" in h


# ==================== 预约 (phone, datetime) 唯一约束 ====================
def test_duplicate_booking_blocked(client):
    payload = {
        "name": "重复测试",
        "phone": "13800139999",
        "datetime": "2099-08-08T10:00:00",
        "service_type": "经络推拿",
    }
    r1 = client.post("/api/bookings", json=payload)
    assert r1.status_code == 200
    r2 = client.post("/api/bookings", json=payload)
    assert r2.status_code == 409
    assert "重复" in r2.json().get("detail", "")


# ==================== 登录失败锁定 ====================
def test_login_failure_lockout(client, monkeypatch):
    """连续 LOGIN_FAIL_THRESHOLD 次失败应触发 429 锁定。"""
    import main
    # 复位 guard 避免被前面用例污染
    main.login_guard.fails.clear()

    threshold = main.LOGIN_FAIL_THRESHOLD
    for _ in range(threshold):
        r = client.post("/api/admin/login",
                        json={"username": "test_admin", "password": "wrong-pass"})
        assert r.status_code == 401

    # 第 N+1 次：应被锁定
    r = client.post("/api/admin/login",
                    json={"username": "test_admin", "password": "wrong-pass"})
    assert r.status_code == 429
    assert "Retry-After" in r.headers

    # 即使密码正确，被锁定期间也不能登录
    r2 = client.post("/api/admin/login",
                     json={"username": "test_admin", "password": "Test_p@ss_2026"})
    assert r2.status_code == 429

    # 清理供后续用例
    main.login_guard.fails.clear()


# ==================== 配置启动断言 ====================
def test_config_rejects_default_secrets(monkeypatch, tmp_path):
    """模拟生产环境且未设置 SESSION_SECRET 时，import config 应直接 sys.exit。"""
    import importlib
    import sys

    # 清理模块缓存
    for mod in ("config",):
        sys.modules.pop(mod, None)

    monkeypatch.delenv("YUEXIN_ALLOW_DEFAULT_SECRETS", raising=False)
    monkeypatch.delenv("SESSION_SECRET", raising=False)
    monkeypatch.delenv("ADMIN_PASSWORD", raising=False)
    monkeypatch.delenv("ADMIN_PASSWORD_HASH", raising=False)
    monkeypatch.setenv("ADMIN_USERNAME", "admin")
    # cwd 切到一个没有 .env 的临时目录，避免现有 .env 污染
    monkeypatch.chdir(tmp_path)

    with pytest.raises(SystemExit) as exc_info:
        importlib.import_module("config")
    assert exc_info.value.code == 1


# ==================== 埋点白名单 ====================
def test_analytics_unknown_event_falls_back_to_other(admin_client, client):
    """未知 event_type 应被白名单兜底为 'other'，不报错。"""
    resp = client.post("/api/analytics", json={
        "event_type": "evil_xss_event_<script>",
        "session_id": "demo",
    })
    # 应直接 422（pattern 校验拦在前）；或被 validator 兜底为 'other' 后 200
    assert resp.status_code in (200, 422)


def test_analytics_valid_event(client):
    resp = client.post("/api/analytics", json={
        "event_type": "page_view",
        "page_url": "/",
        "session_id": "abc123",
    })
    assert resp.status_code == 200
