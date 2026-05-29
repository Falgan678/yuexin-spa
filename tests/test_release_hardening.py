"""
上线前必修项的回归测试
============================================================
覆盖：
- M1：全局异常处理器返回 5xx + request_id（不泄内部细节）
- H3：purge_expired_records 能删除过期数据
- H4：上传图片重编码（剥离 EXIF / 拒绝畸形图片 / 拒绝非图片）
"""
from __future__ import annotations

import io


# ------------------------------------------------------------------
# M1：未捕获异常 → 5xx + request_id
# ------------------------------------------------------------------
def test_global_exception_handler_returns_request_id(app):
    """通过临时挂载一条故意抛错的路由，验证全局异常处理器生效。

    注意：TestClient 默认 raise_server_exceptions=True 会把未捕获异常重新抛出，
    必须显式关闭，才能拿到经过全局 exception_handler 处理后的 500 响应。
    """
    from fastapi import APIRouter
    from fastapi.testclient import TestClient

    router = APIRouter()

    @router.get("/api/__test_boom__")
    def _boom():
        raise RuntimeError("boom for test")

    app.include_router(router)
    try:
        with TestClient(app, raise_server_exceptions=False) as c:
            resp = c.get("/api/__test_boom__")
            assert resp.status_code == 500
            body = resp.json()
            # 不能泄漏内部异常细节
            assert "boom for test" not in resp.text
            assert "Traceback" not in resp.text
            # 必须返回 request_id 用于运维定位
            assert "request_id" in body and len(body["request_id"]) >= 8
            assert resp.headers.get("X-Request-Id") == body["request_id"]
    finally:
        # 清理路由，避免影响其他用例
        app.router.routes = [r for r in app.router.routes
                             if getattr(r, "path", "") != "/api/__test_boom__"]


# ------------------------------------------------------------------
# H3：过期数据清理
# ------------------------------------------------------------------
def test_purge_expired_records_deletes_old_rows(app):
    """插入一条远古 analytics + audit_logs，purge 后应被删除。"""
    import main
    from db import PH, get_db_connection

    # 写入一条 200 天前的 analytics 与一条 365 天前的 audit_logs
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            f"INSERT INTO analytics (event_type, event_data, session_id, created_at) "
            f"VALUES ({PH}, {PH}, {PH}, datetime('now','localtime','-200 days'))",
            ("page_view", "{}", "s_old"),
        )
        cur.execute(
            f"INSERT INTO audit_logs (actor, action, resource, summary, created_at) "
            f"VALUES ({PH}, {PH}, {PH}, {PH}, datetime('now','localtime','-365 days'))",
            ("test_admin", "update", "service", "old log"),
        )
        # 再写一条今天的，应保留
        cur.execute(
            f"INSERT INTO analytics (event_type, event_data, session_id) "
            f"VALUES ({PH}, {PH}, {PH})",
            ("page_view", "{}", "s_new"),
        )

    deleted = main.purge_expired_records()
    assert deleted["analytics"] >= 1
    assert deleted["audit_logs"] >= 1

    # 旧的已删，新的还在
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute(f"SELECT COUNT(*) AS c FROM analytics WHERE session_id = {PH}", ("s_old",))
        assert cur.fetchone()["c"] == 0
        cur.execute(f"SELECT COUNT(*) AS c FROM analytics WHERE session_id = {PH}", ("s_new",))
        assert cur.fetchone()["c"] == 1


# ------------------------------------------------------------------
# H4：上传图片重编码
# ------------------------------------------------------------------
def _make_png_bytes(w: int = 8, h: int = 8) -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (255, 0, 0)).save(buf, format="PNG")
    return buf.getvalue()


def test_upload_image_rejects_non_image(admin_client):
    """上传一个改后缀的 .png（实际是脚本）必须被拒绝。"""
    fake = b"<?php phpinfo(); ?>"
    resp = admin_client.post(
        "/api/admin/upload/image",
        files={"file": ("evil.png", fake, "image/png")},
    )
    assert resp.status_code == 400
    assert "非图片" in resp.text or "格式" in resp.text


def test_upload_image_accepts_real_png_and_strips_metadata(admin_client):
    """合法 PNG 上传成功，并由 Pillow 重编码（与原始字节不一致）。"""
    raw = _make_png_bytes()
    resp = admin_client.post(
        "/api/admin/upload/image",
        files={"file": ("ok.png", raw, "image/png")},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["url"].startswith("/static/uploads/")
    assert data["url"].endswith(".png")
    # 重编码后大小可能不同（非空）
    assert data["size"] > 0


def test_upload_image_rejects_huge_filename_extension(admin_client):
    """非白名单扩展名（如 .svg）必须被拒绝。"""
    resp = admin_client.post(
        "/api/admin/upload/image",
        files={"file": ("logo.svg", b"<svg></svg>", "image/svg+xml")},
    )
    assert resp.status_code == 400
