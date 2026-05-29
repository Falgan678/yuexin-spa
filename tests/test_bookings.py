"""
预约 API E2E 测试：创建 / 查询 / 状态更新 / 备注 / 综合编辑 / 校验
"""
from datetime import datetime, timedelta


def _future_dt(hours=2):
    return (datetime.now() + timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%S")


def test_create_booking_success(client):
    payload = {
        "name": "测试用户",
        "phone": "13800138999",
        "datetime": _future_dt(3),
        "note": "pytest e2e",
        "service_type": "经络推拿",
        "category": "chinese",
        "source": "normal",
    }
    resp = client.post("/api/bookings", json=payload)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["code"] == 0
    assert body["data"]["name"] == "测试用户"
    assert body["data"]["category"] == "chinese"
    assert body["data"]["booking_id"] > 0


def test_create_booking_invalid_phone(client):
    resp = client.post("/api/bookings", json={
        "name": "x", "phone": "12345", "datetime": _future_dt(3),
    })
    assert resp.status_code == 422  # Pydantic pattern 校验


def test_create_booking_past_time_rejected(client):
    resp = client.post("/api/bookings", json={
        "name": "x", "phone": "13800138000",
        "datetime": (datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S"),
    })
    assert resp.status_code == 400
    assert "晚于当前时间" in resp.json()["detail"]


def test_create_booking_invalid_service_type(client):
    resp = client.post("/api/bookings", json={
        "name": "x", "phone": "13800138000",
        "datetime": _future_dt(3),
        "service_type": "<script>alert(1)</script>",
    })
    assert resp.status_code == 422


def test_create_booking_invalid_source(client):
    resp = client.post("/api/bookings", json={
        "name": "x", "phone": "13800138000",
        "datetime": _future_dt(3),
        "source": "totally-invalid-source",
    })
    assert resp.status_code == 422


def test_query_bookings_by_phone(client):
    # 先建一条
    phone = "13911223344"
    client.post("/api/bookings", json={
        "name": "查询测试", "phone": phone,
        "datetime": _future_dt(5),
        "service_type": "艾灸调理",
    })
    resp = client.get(f"/api/bookings/{phone}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == 0
    assert isinstance(body["data"], list)
    assert any(r["phone"] == phone for r in body["data"])


def test_query_bookings_by_phone_invalid(client):
    resp = client.get("/api/bookings/abc")
    assert resp.status_code == 400


def test_admin_list_bookings(admin_client):
    resp = admin_client.get("/api/admin/bookings?days=3650")
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == 0
    assert "data" in body


def test_admin_update_booking_status(admin_client):
    create = admin_client.post("/api/bookings", json={
        "name": "状态测试", "phone": "13700001111",
        "datetime": _future_dt(2),
        "service_type": "刮痧拔罐",
    })
    bid = create.json()["data"]["booking_id"]

    resp = admin_client.put(f"/api/bookings/{bid}/status",
                            json={"status": "confirmed"})
    assert resp.status_code == 200
    assert resp.json()["data"]["status"] == "confirmed"


def test_admin_update_booking_status_invalid(admin_client):
    create = admin_client.post("/api/bookings", json={
        "name": "状态测试2", "phone": "13700001112",
        "datetime": _future_dt(2),
        "service_type": "刮痧拔罐",
    })
    bid = create.json()["data"]["booking_id"]
    resp = admin_client.put(f"/api/bookings/{bid}/status",
                            json={"status": "invalid_xx"})
    assert resp.status_code == 422


def test_admin_update_booking_note(admin_client):
    create = admin_client.post("/api/bookings", json={
        "name": "备注测试", "phone": "13700002222",
        "datetime": _future_dt(2),
    })
    bid = create.json()["data"]["booking_id"]
    resp = admin_client.put(f"/api/bookings/{bid}/note",
                            json={"note": "VIP 客户"})
    assert resp.status_code == 200
    assert resp.json()["data"]["note"] == "VIP 客户"


def test_admin_update_booking_full(admin_client):
    create = admin_client.post("/api/bookings", json={
        "name": "综合编辑", "phone": "13700003333",
        "datetime": _future_dt(2),
        "service_type": "刮痧拔罐",
    })
    bid = create.json()["data"]["booking_id"]
    resp = admin_client.put(f"/api/bookings/{bid}", json={
        "doctor": "李医生",
        "status": "confirmed",
        "note": "综合更新过",
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == 0
    assert body["data"]["doctor"] == "李医生"
