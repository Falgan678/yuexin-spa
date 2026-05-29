"""
数据库抽象层
- 默认使用 SQLite（本地开发零依赖）
- 通过环境变量 DB_BACKEND=mysql 切换到 MySQL（线上）
- 统一暴露 get_db_connection() 上下文管理器
- 统一暴露 PH（参数占位符），SQLite=?  MySQL=%s
"""
from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

# ------------------------------------------------------------------
# 配置（从环境变量读取，提供本地默认值）
# ------------------------------------------------------------------
DB_BACKEND = os.getenv("DB_BACKEND", "sqlite").lower()

# SQLite 配置
SQLITE_PATH = os.getenv(
    "SQLITE_PATH",
    str(Path(__file__).parent / "yuexin.db"),
)

# MySQL 配置（仅当 DB_BACKEND=mysql 时使用）
MYSQL_CONFIG = {
    "host": os.getenv("DB_HOST", "127.0.0.1"),
    "port": int(os.getenv("DB_PORT", "3306")),
    "user": os.getenv("DB_USER", "root"),
    "password": os.getenv("DB_PASSWORD", ""),
    "database": os.getenv("DB_NAME", "yuexin"),
    "charset": "utf8mb4",
}

# 占位符：SQLite 用 ?  MySQL 用 %s
PH = "?" if DB_BACKEND == "sqlite" else "%s"


# ------------------------------------------------------------------
# 行工厂：让 cursor.fetchall() 返回 dict
# ------------------------------------------------------------------
def _sqlite_dict_factory(cursor, row):
    return {col[0]: row[idx] for idx, col in enumerate(cursor.description)}


# ------------------------------------------------------------------
# 连接上下文
# ------------------------------------------------------------------
@contextmanager
def get_db_connection() -> Iterator:
    """统一连接上下文，自动 commit / rollback / close。"""
    if DB_BACKEND == "sqlite":
        conn = sqlite3.connect(
            SQLITE_PATH,
            detect_types=sqlite3.PARSE_DECLTYPES,
            timeout=10.0,                   # 等锁最多 10s，避免高并发 OperationalError
            isolation_level="DEFERRED",
        )
        conn.row_factory = _sqlite_dict_factory
        # 开启外键、WAL 提升并发读写、合理 fsync 同步策略
        try:
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA synchronous = NORMAL")
            conn.execute("PRAGMA busy_timeout = 5000")
        except Exception:
            pass
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
    elif DB_BACKEND == "mysql":
        import pymysql  # 延迟导入，避免本地 SQLite 用户必须装 pymysql

        conn = pymysql.connect(
            cursorclass=pymysql.cursors.DictCursor,
            **MYSQL_CONFIG,
        )
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
    else:
        raise RuntimeError(f"不支持的 DB_BACKEND: {DB_BACKEND}")


def get_backend() -> str:
    return DB_BACKEND


def get_db_info() -> str:
    if DB_BACKEND == "sqlite":
        return f"sqlite://{SQLITE_PATH}"
    return f"mysql://{MYSQL_CONFIG['user']}@{MYSQL_CONFIG['host']}:{MYSQL_CONFIG['port']}/{MYSQL_CONFIG['database']}"
