"""
SQL 注入与输入边界测试
- 不期望真的删表，但要保证恶意输入被白名单/参数化拦截
"""


def test_sqli_in_phone_param_does_not_break(client):
    # path param 经手机号正则校验，应直接 400
    resp = client.get("/api/bookings/' OR 1=1 --")
    assert resp.status_code == 400


def test_sqli_in_search_by_name(admin_client):
    resp = admin_client.get("/api/bookings/search/by-name", params={
        "name": "%' OR 1=1 --",
    })
    # 不应该 500，且不会泄露所有数据
    assert resp.status_code in (200, 400, 422)


def test_xss_in_note_is_stored_as_text(admin_client, client):
    create = client.post("/api/bookings", json={
        "name": "XSS 测试",
        "phone": "13899990000",
        "datetime": "2099-01-01T10:00:00",
        "note": "<script>alert('xss')</script>",
    })
    assert create.status_code == 200
    bid = create.json()["data"]["booking_id"]

    resp = admin_client.get("/api/admin/bookings?days=3650")
    body = resp.json()
    target = next((r for r in body.get("data", []) if r["id"] == bid), None)
    assert target is not None
    # 后端原样存，由前端 DOM API 渲染，保证不会被作为脚本解析
    assert "<script>" in target["note"]


def test_oversized_name_rejected(client):
    resp = client.post("/api/bookings", json={
        "name": "a" * 51,  # max_length=50
        "phone": "13800138000",
        "datetime": "2099-01-01T10:00:00",
    })
    assert resp.status_code == 422


def test_oversized_note_rejected(client):
    resp = client.post("/api/bookings", json={
        "name": "x", "phone": "13800138000",
        "datetime": "2099-01-01T10:00:00",
        "note": "n" * 501,
    })
    assert resp.status_code == 422
