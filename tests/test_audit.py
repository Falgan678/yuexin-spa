"""
审计日志 E2E 测试
"""
from datetime import datetime, timedelta


def _future_dt(hours=2):
    return (datetime.now() + timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%S")


def test_login_writes_audit(client, admin_client):
    # admin_client 的 fixture 已经执行过一次登录
    resp = admin_client.get("/api/admin/audit-logs?action=login&limit=5")
    assert resp.status_code == 200
    items = resp.json()["data"]["items"]
    assert any(it["action"] == "login" and it["actor"] == "test_admin" for it in items)


def test_login_failed_writes_audit(client, admin_client):
    # 触发一次失败登录
    client.post("/api/admin/login",
                json={"username": "test_admin", "password": "wrong"})
    resp = admin_client.get("/api/admin/audit-logs?action=login_failed&limit=5")
    assert resp.status_code == 200
    items = resp.json()["data"]["items"]
    assert any(it["action"] == "login_failed" for it in items)


def test_booking_status_update_writes_audit(admin_client):
    # 建一条预约 → 改状态 → 审计应记录
    create = admin_client.post("/api/bookings", json={
        "name": "审计-状态", "phone": "13700009999",
        "datetime": _future_dt(2),
        "service_type": "经络推拿",
    })
    bid = create.json()["data"]["booking_id"]

    admin_client.put(f"/api/bookings/{bid}/status",
                     json={"status": "confirmed"})

    resp = admin_client.get(
        f"/api/admin/audit-logs?resource=booking&resource_id={bid}&action=status_update"
    )
    items = resp.json()["data"]["items"]
    assert len(items) >= 1
    rec = items[0]
    assert rec["actor"] == "test_admin"
    assert rec["resource"] == "booking"
    assert rec["resource_id"] == str(bid)
    assert rec["diff"] is not None
    assert rec["diff"]["after"]["status"] == "confirmed"


def test_audit_logs_filter_validation(admin_client):
    # 无效 action 应 400
    resp = admin_client.get("/api/admin/audit-logs?action=__hack__")
    assert resp.status_code == 400


def test_audit_logs_requires_admin(client):
    resp = client.get("/api/admin/audit-logs")
    assert resp.status_code == 401


# ============================================================
# CSV 导出
# ============================================================
def test_audit_export_csv_requires_admin(client):
    resp = client.get("/api/admin/audit-logs/export.csv")
    assert resp.status_code == 401


def test_audit_export_csv_basic(admin_client):
    # 先制造若干审计：登录已经写过；再触发一次状态更新
    create = admin_client.post("/api/bookings", json={
        "name": "导出-A",
        "phone": "13700004001",
        "datetime": "2099-06-01T10:00:00",
        "service_type": "经络推拿",
    })
    bid = create.json()["data"]["booking_id"]
    admin_client.put(f"/api/bookings/{bid}/status",
                     json={"status": "confirmed"})

    resp = admin_client.get("/api/admin/audit-logs/export.csv")
    assert resp.status_code == 200
    assert "text/csv" in resp.headers["content-type"]
    assert "attachment" in resp.headers["content-disposition"]
    assert resp.headers.get("X-Audit-Export-Count") is not None

    text = resp.content.decode("utf-8-sig")  # 去掉 BOM
    lines = [l for l in text.splitlines() if l.strip()]
    # 表头 + 至少一行数据
    assert lines[0].startswith("id,created_at,actor,action,")
    assert len(lines) > 1
    assert "test_admin" in text


def test_audit_export_csv_filtered(admin_client):
    resp = admin_client.get(
        "/api/admin/audit-logs/export.csv?resource=booking&action=status_update"
    )
    assert resp.status_code == 200
    text = resp.content.decode("utf-8-sig")
    # 数据行（除表头）所有 action 都应是 status_update（若为空也能通过表头校验）
    lines = [l for l in text.splitlines() if l.strip()]
    assert lines[0].startswith("id,")
    for row in lines[1:]:
        # 简单包含校验，避免 csv 库分割复杂字段
        assert "status_update" in row
        assert ",booking," in row


def test_audit_export_csv_formula_injection_safe(admin_client, client):
    """验证 _csv_safe 对单元格起始字符的公式注入防御。

    审计表中 summary / actor / resource_id 等字段会直接作为单元格内容写入 CSV。
    若这些字段以 = / + / - / @ 开头，必须前置 ' 让 Excel 当字符串处理。
    diff_json 字段本身是 {} 起始的 JSON，不会触发公式，无需在内部转义。
    """
    # 直接通过审计模块写一条带恶意 actor / summary 的记录
    from audit import audit_log
    audit_log(
        actor="=HYPERLINK(\"http://evil\",\"x\")",  # 恶意 actor
        action="update", resource="admin",
        resource_id="-2+3*5",                       # 恶意 id
        summary="@SUM(A1:A9)",                       # 恶意 summary
    )

    resp = admin_client.get("/api/admin/audit-logs/export.csv")
    assert resp.status_code == 200
    text = resp.content.decode("utf-8-sig")

    # 找到刚写入的恶意 actor 行（必须以 ' 开头被防御）
    # csv.writer 对含 = 的字段会用双引号包裹，最终文本里出现 "'=HYPERLINK(""..."")"
    assert "'=HYPERLINK" in text, f"actor 字段公式注入未防御，CSV 文本：\n{text}"
    assert "'-2+3*5" in text or "'-2+3" in text, "resource_id 字段公式注入未防御"
    assert "'@SUM" in text, "summary 字段公式注入未防御"
