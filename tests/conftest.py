"""
pytest 全局 fixture
============================================================
- 每个测试用例都使用全新的临时 SQLite，避免污染线上 yuexin.db
- 启动前调用 init_db.main() 建表 + 种入默认数据
- 提供 client（公开访问）与 admin_client（已登录管理员）两个 TestClient

注意：
    必须在 import main 之前完成环境变量设置，所以放在 conftest 顶部。
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def _set_test_env(db_path: str) -> None:
    os.environ["DB_BACKEND"] = "sqlite"
    os.environ["SQLITE_PATH"] = db_path
    os.environ["ADMIN_USERNAME"] = "test_admin"
    os.environ["ADMIN_PASSWORD"] = "Test_p@ss_2026"
    os.environ["ADMIN_AUTH_ENABLED"] = "true"
    os.environ["SESSION_SECRET"] = "test-secret-" + "x" * 40
    # 测试中允许默认本地源（不触发 _validate_origins）
    os.environ["YUEXIN_ALLOW_DEFAULT_SECRETS"] = "1"
    os.environ.setdefault("ALLOWED_ORIGINS",
                          "http://testserver,http://localhost,http://127.0.0.1")
    # 测试默认关闭限流，避免连发用例触发 429；专门测试限流的用例会临时启用
    os.environ.setdefault("RATE_LIMIT_ENABLED", "false")
    os.environ.setdefault("ALLOW_TOKEN_QUERY", "false")
    os.environ.setdefault("DOCS_ENABLED", "true")


@pytest.fixture(scope="session")
def temp_db_path():
    """会话级临时 DB 文件，所有用例共用同一份种子数据。"""
    fd, path = tempfile.mkstemp(prefix="yuexin_test_", suffix=".db")
    os.close(fd)
    _set_test_env(path)

    # 必须在设置完环境变量后才能 import init_db
    import init_db
    init_db.main_no_args = init_db.main  # 兼容旧版无参 main
    # 模拟 sys.argv 让 argparse 不出错
    old_argv = sys.argv
    sys.argv = ["init_db.py"]
    try:
        init_db.main()
    finally:
        sys.argv = old_argv

    yield path

    try:
        os.unlink(path)
    except OSError:
        pass


@pytest.fixture(scope="session")
def app(temp_db_path):
    """加载 FastAPI app（需在临时 DB 就绪后才能 import）。"""
    # 确保 lifespan 内的 ensure_*** 在 client 触发时执行
    import importlib

    # 防止上一次 import 残留的 app 用了真实库
    for mod in ("main", "audit", "db", "init_db", "config"):
        sys.modules.pop(mod, None)

    main = importlib.import_module("main")
    return main.app


@pytest.fixture()
def client(app):
    """普通客户端（公开 API）。"""
    from fastapi.testclient import TestClient
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def admin_token(client):
    """登录管理员，返回 token。"""
    resp = client.post(
        "/api/admin/login",
        json={"username": "test_admin", "password": "Test_p@ss_2026"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]["token"]


@pytest.fixture()
def admin_client(client, admin_token):
    """已带 Authorization 头的客户端。"""
    client.headers.update({"Authorization": f"Bearer {admin_token}"})
    return client
