"""
鉴权与基础健康检查
"""


def test_health(client):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    # /api/health 历史返回 {status, database}，新版可能返回 {code, ...}，兼容判定
    assert body.get("status") == "healthy" or body.get("code") == 0


def test_login_success(client):
    resp = client.post(
        "/api/admin/login",
        json={"username": "test_admin", "password": "Test_p@ss_2026"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == 0
    assert "token" in body["data"]
    assert body["data"]["username"] == "test_admin"


def test_login_failed_wrong_password(client):
    resp = client.post(
        "/api/admin/login",
        json={"username": "test_admin", "password": "wrong-pass"},
    )
    assert resp.status_code == 401


def test_admin_endpoint_requires_token(client):
    resp = client.get("/api/admin/me")
    assert resp.status_code == 401


def test_admin_endpoint_with_token(admin_client):
    resp = admin_client.get("/api/admin/me")
    assert resp.status_code == 200
    assert resp.json()["code"] == 0
    assert resp.json()["data"]["username"] == "test_admin"


def test_admin_endpoint_with_invalid_token(client):
    client.headers.update({"Authorization": "Bearer invalid.token.payload"})
    resp = client.get("/api/admin/me")
    assert resp.status_code == 401
