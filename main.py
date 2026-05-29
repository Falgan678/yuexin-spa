"""
悦心养生馆 - FastAPI 后端
- 数据库可切换 SQLite / MySQL（见 db.py）
- 安全：CORS 白名单、Token 仅 Authorization header、限流、登录失败锁定、统一安全头
- 输入校验：Pydantic + 白名单；SQL 100% 参数化
- 审计：见 audit.py，所有关键写操作落库
"""
from __future__ import annotations

import csv
import hmac
import io
import json
import logging
import os
import re
import secrets
import time
import asyncio
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime
from hashlib import sha256
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional, Tuple

from fastapi import Depends, FastAPI, File, HTTPException, Path as FPath, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from starlette.middleware.base import BaseHTTPMiddleware

from config import (
    ADMIN_AUTH_ENABLED, ADMIN_PASSWORD, ADMIN_PASSWORD_HASH, ADMIN_USERNAME,
    ALLOWED_ORIGINS, ALLOW_TOKEN_QUERY, DOCS_ENABLED, LOGIN_FAIL_LOCK_MINUTES,
    LOGIN_FAIL_THRESHOLD, RATE_LIMIT_ENABLED, SESSION_SECRET, TRUST_PROXY_HEADERS,
)
from db import PH, get_db_connection, get_db_info
from audit import (
    audit_log, ensure_audit_table, list_audit_logs,
    ALLOWED_FILTER_ACTIONS, ALLOWED_FILTER_RESOURCES,
)
import users as users_mod

# ------------------------------------------------------------------
# 日志
# ------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("yuexin")


# ------------------------------------------------------------------
# 业务常量：与客户端 services.js 保持同步
# ------------------------------------------------------------------
ALLOWED_STATUSES = {
    "pending", "confirmed", "cancelled",
    "rescheduled", "completed", "other",
}

# 4 大分类
ALLOWED_CATEGORIES = {"chinese", "thai", "aroma", "foot"}

# 来源（套餐/优惠类型）
ALLOWED_SOURCES = {
    "normal",           # 普通预约
    "new_customer",     # 新客体验价
    "member",           # 会员套餐
    "couple_package",   # 双人套餐
    "flash_sale",       # 限时秒杀
    "promo",            # 其他优惠抢购
}


def get_allowed_booking_sources() -> set:
    """预约的有效来源 = 基础 6 项 + offers 表中所有 offer_key（不论是否上架）。

    用于 BookingCreate / BookingUpdate / list_bookings 的 source 校验，
    保证后台新增的优惠 offer_key 立即可作为预约来源被接受。
    DB 异常时退化为基础集合，避免请求 500。
    """
    base = set(ALLOWED_SOURCES)
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT offer_key FROM offers")
            for r in cur.fetchall():
                k = (dict(r).get("offer_key") or "").strip()
                if k:
                    base.add(k)
    except Exception:
        # offers 表不存在 / 异常时不阻塞正常预约
        pass
    return base


def get_allowed_service_names() -> set:
    """预约可选服务名 = 内置完整服务 + 兼容旧名 + services 表中当前项目名。"""
    names = set(ALLOWED_SERVICES)
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT name FROM services WHERE name IS NOT NULL AND name <> ''")
            for r in cur.fetchall():
                name = (dict(r).get("name") or "").strip()
                if name:
                    names.add(name)
    except Exception:
        # services 表不可用时退化为内置集合，避免校验阶段 500
        pass
    return names


def get_service_meta_entries() -> List[Dict[str, str]]:
    """返回后台筛选/编辑可用的服务名与分类，优先使用数据库真实服务。"""
    entries: Dict[str, str] = {
        name: SERVICE_TO_CATEGORY.get(name, "")
        for name in sorted(ALLOWED_SERVICES_FULL)
    }
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT name, category FROM services "
                "WHERE name IS NOT NULL AND name <> '' "
                "ORDER BY sort_order ASC, id ASC"
            )
            for r in cur.fetchall():
                d = dict(r)
                name = (d.get("name") or "").strip()
                if name:
                    entries[name] = (d.get("category") or SERVICE_TO_CATEGORY.get(name, "") or "").strip()
    except Exception:
        pass
    return [{"name": name, "category": category} for name, category in entries.items()]

# 16 个完整服务名（与 static/data/services.js 中 SERVICES.name 一一对应）
ALLOWED_SERVICES_FULL = {
    # 中式调理
    "经络推拿", "刮痧拔罐", "艾灸调理", "小儿推拿",
    # 泰式 SPA
    "泰式古法", "皇家泰式 SPA", "热石能量按摩", "四手联弹按摩",
    # 芳疗护理
    "精油全身 SPA", "香薰背部护理", "淋巴排毒按摩", "面部芳疗护理",
    # 足疗保健
    "中式足底按摩", "中药养生足浴", "肩颈头部调理", "印度头部 SPA",
}

# 兼容旧数据：旧数据中可能存在的 4 个粗粒度分类
LEGACY_SERVICE_NAMES = {"中式推拿", "泰式古法", "精油SPA", "足底按摩"}

# 完整可接受的 service_type 集合（兼容旧数据，避免历史预约更新失败）
ALLOWED_SERVICES = ALLOWED_SERVICES_FULL | LEGACY_SERVICE_NAMES

# 服务名 → 分类映射，用于在 service_type 提交时自动填充 category
SERVICE_TO_CATEGORY: Dict[str, str] = {
    # 中式
    "经络推拿": "chinese", "刮痧拔罐": "chinese", "艾灸调理": "chinese", "小儿推拿": "chinese",
    "中式推拿": "chinese",
    # 泰式
    "泰式古法": "thai", "皇家泰式 SPA": "thai", "热石能量按摩": "thai", "四手联弹按摩": "thai",
    # 芳疗
    "精油全身 SPA": "aroma", "香薰背部护理": "aroma", "淋巴排毒按摩": "aroma", "面部芳疗护理": "aroma",
    "精油SPA": "aroma",
    # 足疗
    "中式足底按摩": "foot", "中药养生足浴": "foot", "肩颈头部调理": "foot", "印度头部 SPA": "foot",
    "足底按摩": "foot",
}

ALLOWED_DOCTORS = {"李医生", "王医生", "张医生", "刘医生", "陈医生"}  # 仅作为兜底（DB 不可用时用）；运行期请通过 fetch_doctors() 取最新
PHONE_RE = re.compile(r"^1[3-9]\d{9}$")

# ------------------------------------------------------------------
# 服务项目相关常量
# ------------------------------------------------------------------
# 内置标签（仅用于回显默认 chip 与列表筛选保留兼容），实际保存允许任意标签
SERVICE_TAGS = {"hot", "new", "female", "couple", "recommend"}
# 自定义分类/标签格式：仅做长度与字符合法性校验（允许中英文/数字/-_/空格）
CUSTOM_LABEL_RE = re.compile(r"^[\u4e00-\u9fa5A-Za-z0-9_\-\s]{1,20}$")
# 自定义分类 id：与标签同规则，允许中英文/数字/-_/空格 1-20 位
CUSTOM_CATEGORY_ID_RE = CUSTOM_LABEL_RE
SERVICE_ID_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]{1,39}$")
ALLOWED_IMAGE_EXTS = {"jpg", "jpeg", "png", "webp", "gif"}
MAX_IMAGE_SIZE = 5 * 1024 * 1024  # 5MB
UPLOADS_DIR = Path(__file__).parent / "static" / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

# 数据保留策略：避免 analytics / audit_logs 长期只增不删撑爆库
ANALYTICS_RETENTION_DAYS = max(1, int(os.getenv("ANALYTICS_RETENTION_DAYS", "90")))
AUDIT_RETENTION_DAYS = max(1, int(os.getenv("AUDIT_RETENTION_DAYS", "180")))


# ------------------------------------------------------------------
# 分类 / 标签 元数据：权威源在数据库（service_categories / service_tags）
# 启动时自动建表 + 对齐内置项，确保老库无须手动迁移
# ------------------------------------------------------------------
DEFAULT_CATEGORIES_SEED = [
    # id, name, icon, builtin, sort_order
    ("chinese", "中式调理", "fa-yin-yang",     1, 10),
    ("thai",    "泰式 SPA", "fa-leaf",         1, 20),
    ("aroma",   "芳疗护理", "fa-pump-soap",    1, 30),
    ("foot",    "足疗保健", "fa-shoe-prints",  1, 40),
]

DEFAULT_TAGS_SEED = [
    # id, label, color, builtin, sort_order
    ("hot",       "热门",     "bg-rose-500",    1, 10),
    ("new",       "新品",     "bg-emerald-500", 1, 20),
    ("female",    "女士专享", "bg-pink-500",    1, 30),
    ("couple",    "情侣套餐", "bg-violet-500",  1, 40),
    ("recommend", "主推",     "bg-amber-500",   1, 50),
]


def _meta_table_ddl_sqlite() -> List[str]:
    return [
        """
        CREATE TABLE IF NOT EXISTS service_categories (
            id          TEXT    PRIMARY KEY,
            name        TEXT    NOT NULL,
            icon        TEXT    NOT NULL DEFAULT 'fa-spa',
            builtin     INTEGER NOT NULL DEFAULT 0,
            sort_order  INTEGER NOT NULL DEFAULT 100,
            created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
            updated_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS service_tags (
            id          TEXT    PRIMARY KEY,
            label       TEXT    NOT NULL,
            color       TEXT    NOT NULL DEFAULT 'bg-slate-500',
            builtin     INTEGER NOT NULL DEFAULT 0,
            sort_order  INTEGER NOT NULL DEFAULT 100,
            created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
            updated_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
        )
        """,
    ]


def _meta_table_ddl_mysql() -> List[str]:
    return [
        """
        CREATE TABLE IF NOT EXISTS service_categories (
            id          VARCHAR(40)  NOT NULL,
            name        VARCHAR(60)  NOT NULL,
            icon        VARCHAR(40)  NOT NULL DEFAULT 'fa-spa',
            builtin     TINYINT      NOT NULL DEFAULT 0,
            sort_order  INT          NOT NULL DEFAULT 100,
            created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """,
        """
        CREATE TABLE IF NOT EXISTS service_tags (
            id          VARCHAR(40)  NOT NULL,
            label       VARCHAR(60)  NOT NULL,
            color       VARCHAR(60)  NOT NULL DEFAULT 'bg-slate-500',
            builtin     TINYINT      NOT NULL DEFAULT 0,
            sort_order  INT          NOT NULL DEFAULT 100,
            created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """,
    ]


def ensure_meta_tables_and_seed() -> None:
    """启动时确保分类/标签表存在，并对齐内置项（仅在不存在时插入，已存在则强制对齐 name/icon/color/builtin）。"""
    ddl = _meta_table_ddl_sqlite() if PH == "?" else _meta_table_ddl_mysql()
    with get_db_connection() as conn:
        cur = conn.cursor()
        for sql in ddl:
            cur.execute(sql)
        # 环境表（启动兜底，避免老库未重跑 init_db.py 时 API 报错）
        if PH == "?":
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS environment_items (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    image       TEXT    NOT NULL DEFAULT '',
                    title       TEXT    NOT NULL DEFAULT '',
                    description TEXT    NOT NULL DEFAULT '',
                    alt         TEXT    NOT NULL DEFAULT '',
                    size        TEXT    NOT NULL DEFAULT 'medium',
                    is_active   INTEGER NOT NULL DEFAULT 1,
                    sort_order  INTEGER NOT NULL DEFAULT 100,
                    duration_ms INTEGER NOT NULL DEFAULT 0,
                    created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
                    updated_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
                )
                """
            )
            # 老库增量加列（旧 schema 不存在 duration_ms 时静默补上）
            try:
                cur.execute("SELECT duration_ms FROM environment_items LIMIT 1")
            except Exception:
                try:
                    cur.execute(
                        "ALTER TABLE environment_items "
                        "ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0"
                    )
                except Exception:
                    logger.exception("environment_items 增量加列 duration_ms 失败")
        else:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS environment_items (
                    id          BIGINT       NOT NULL AUTO_INCREMENT,
                    image       VARCHAR(500) NOT NULL DEFAULT '',
                    title       VARCHAR(80)  NOT NULL DEFAULT '',
                    description VARCHAR(300) NOT NULL DEFAULT '',
                    alt         VARCHAR(200) NOT NULL DEFAULT '',
                    size        VARCHAR(20)  NOT NULL DEFAULT 'medium',
                    is_active   TINYINT      NOT NULL DEFAULT 1,
                    sort_order  INT          NOT NULL DEFAULT 100,
                    duration_ms INT          NOT NULL DEFAULT 0,
                    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    PRIMARY KEY (id),
                    KEY idx_active (is_active),
                    KEY idx_sort   (sort_order)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """
            )
            # MySQL 老库增量
            try:
                cur.execute("SELECT duration_ms FROM environment_items LIMIT 1")
            except Exception:
                try:
                    cur.execute(
                        "ALTER TABLE environment_items "
                        "ADD COLUMN duration_ms INT NOT NULL DEFAULT 0"
                    )
                except Exception:
                    logger.exception("environment_items 增量加列 duration_ms 失败 (mysql)")
        # 医生表（启动兜底）
        if PH == "?":
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS doctors (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    name        TEXT    NOT NULL UNIQUE,
                    title       TEXT    NOT NULL DEFAULT '',
                    avatar      TEXT    NOT NULL DEFAULT '',
                    bio         TEXT    NOT NULL DEFAULT '',
                    is_active   INTEGER NOT NULL DEFAULT 1,
                    sort_order  INTEGER NOT NULL DEFAULT 100,
                    created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
                    updated_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
                )
                """
            )
        else:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS doctors (
                    id          BIGINT       NOT NULL AUTO_INCREMENT,
                    name        VARCHAR(50)  NOT NULL,
                    title       VARCHAR(80)  NOT NULL DEFAULT '',
                    avatar      VARCHAR(500) NOT NULL DEFAULT '',
                    bio         VARCHAR(500) NOT NULL DEFAULT '',
                    is_active   TINYINT      NOT NULL DEFAULT 1,
                    sort_order  INT          NOT NULL DEFAULT 100,
                    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    PRIMARY KEY (id),
                    UNIQUE KEY uk_doctor_name (name),
                    KEY idx_active (is_active),
                    KEY idx_sort   (sort_order)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """
            )
        # 对齐内置分类
        for cid, name, icon, builtin, sort_order in DEFAULT_CATEGORIES_SEED:
            cur.execute(f"SELECT id FROM service_categories WHERE id = {PH}", (cid,))
            if cur.fetchone():
                cur.execute(
                    f"UPDATE service_categories SET name = {PH}, icon = {PH}, builtin = {PH} "
                    f"WHERE id = {PH}",
                    (name, icon, builtin, cid),
                )
            else:
                cur.execute(
                    f"INSERT INTO service_categories (id, name, icon, builtin, sort_order) "
                    f"VALUES ({PH}, {PH}, {PH}, {PH}, {PH})",
                    (cid, name, icon, builtin, sort_order),
                )
        # 对齐内置标签
        for tid, label, color, builtin, sort_order in DEFAULT_TAGS_SEED:
            cur.execute(f"SELECT id FROM service_tags WHERE id = {PH}", (tid,))
            if cur.fetchone():
                cur.execute(
                    f"UPDATE service_tags SET label = {PH}, color = {PH}, builtin = {PH} "
                    f"WHERE id = {PH}",
                    (label, color, builtin, tid),
                )
            else:
                cur.execute(
                    f"INSERT INTO service_tags (id, label, color, builtin, sort_order) "
                    f"VALUES ({PH}, {PH}, {PH}, {PH}, {PH})",
                    (tid, label, color, builtin, sort_order),
                )

        # ---- bookings 去重唯一索引（同手机同时间禁止重复）----
        # 已有重复历史数据时，CREATE UNIQUE 会失败 → 退化为非唯一索引，避免阻塞启动
        try:
            if PH == "?":
                cur.execute(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uk_bookings_phone_dt "
                    "ON bookings(phone, datetime)"
                )
            else:
                # MySQL：用 SHOW INDEX 检查后再创建，避免重复
                cur.execute(
                    "SELECT COUNT(*) AS c FROM information_schema.STATISTICS "
                    "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='bookings' "
                    "AND INDEX_NAME='uk_bookings_phone_dt'"
                )
                if (dict(cur.fetchone() or {}).get("c") or 0) == 0:
                    cur.execute(
                        "CREATE UNIQUE INDEX uk_bookings_phone_dt "
                        "ON bookings(phone, datetime)"
                    )
        except Exception:
            logger.warning("创建 bookings 唯一索引失败（可能因历史重复数据），降级为普通索引")
            try:
                cur.execute(
                    "CREATE INDEX IF NOT EXISTS idx_bookings_phone_dt "
                    "ON bookings(phone, datetime)"
                )
            except Exception:
                logger.exception("创建 bookings 普通索引也失败")


def fetch_categories() -> List[Dict[str, Any]]:
    """读取所有分类（按 sort_order 升序）。"""
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT id, name, icon, builtin, sort_order, updated_at "
            "FROM service_categories ORDER BY sort_order ASC, id ASC"
        )
        rows = []
        for r in cur.fetchall():
            d = dict(r)
            d["builtin"] = bool(d.get("builtin"))
            if d.get("updated_at") and not isinstance(d["updated_at"], str):
                d["updated_at"] = str(d["updated_at"])
            rows.append(d)
        return rows


def fetch_tags() -> List[Dict[str, Any]]:
    """读取所有标签（按 sort_order 升序）。"""
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT id, label, color, builtin, sort_order, updated_at "
            "FROM service_tags ORDER BY sort_order ASC, id ASC"
        )
        rows = []
        for r in cur.fetchall():
            d = dict(r)
            d["builtin"] = bool(d.get("builtin"))
            if d.get("updated_at") and not isinstance(d["updated_at"], str):
                d["updated_at"] = str(d["updated_at"])
            rows.append(d)
        return rows


def fetch_doctors(active_only: bool = False) -> List[Dict[str, Any]]:
    """读取所有医生（按 sort_order 升序）。
    active_only=True 仅返回 is_active=1 的医生（用于客户端展示与下拉默认列表）。
    """
    with get_db_connection() as conn:
        cur = conn.cursor()
        sql = (
            "SELECT id, name, title, avatar, bio, is_active, sort_order, "
            "       created_at, updated_at "
            "FROM doctors"
        )
        if active_only:
            sql += " WHERE is_active = 1"
        sql += " ORDER BY sort_order ASC, id ASC"
        cur.execute(sql)
        rows = []
        for r in cur.fetchall():
            d = dict(r)
            d["is_active"] = bool(d.get("is_active"))
            for k in ("created_at", "updated_at"):
                if d.get(k) and not isinstance(d[k], str):
                    d[k] = str(d[k])
            rows.append(d)
        return rows


def get_known_doctor_names(active_only: bool = False) -> set:
    """返回数据库中已存在的医生姓名集合（带兜底：空表/异常时用 ALLOWED_DOCTORS）。"""
    try:
        rows = fetch_doctors(active_only=active_only)
        names = {r["name"] for r in rows if r.get("name")}
        if names:
            return names
    except Exception:
        logger.exception("读取医生表失败，回退到兜底集合")
    return set(ALLOWED_DOCTORS)


def _safe_fetch_doctors(active_only: bool = False) -> List[Dict[str, Any]]:
    """只读取，捕获异常：数据库未建表时不报错。"""
    try:
        return fetch_doctors(active_only=active_only)
    except Exception:
        logger.exception("读取 doctors 表失败")
        return []


def _safe_fetch_offer_sources(active_only: bool = True) -> List[Dict[str, str]]:
    """读取 offers 表，返回 [{id: offer_key, name}, ...]，用于"来源/套餐"下拉动态扩展。

    - active_only=True：仅返回 is_active=1 的优惠（默认；预约下拉只用上架的）
    - 表不存在 / 异常时返回空列表，调用方自行兜底
    """
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            sql = "SELECT offer_key, name FROM offers"
            if active_only:
                sql += " WHERE is_active = 1"
            sql += " ORDER BY sort_order ASC, id ASC"
            cur.execute(sql)
            out: List[Dict[str, str]] = []
            for r in cur.fetchall():
                d = dict(r)
                key = (d.get("offer_key") or "").strip()
                name = (d.get("name") or "").strip()
                if key and name:
                    out.append({"id": key, "name": name})
            return out
    except Exception:
        logger.exception("读取 offers 表（动态来源）失败")
        return []


# 6 个内置基础"来源 / 套餐"——始终保留在最前面
BUILTIN_BOOKING_SOURCES: List[Dict[str, str]] = [
    {"id": "normal",         "name": "普通预约"},
    {"id": "new_customer",   "name": "新客体验价"},
    {"id": "member",         "name": "会员套餐"},
    {"id": "couple_package", "name": "双人套餐"},
    {"id": "flash_sale",     "name": "限时秒杀"},
    {"id": "promo",          "name": "优惠抢购"},
]


def _build_meta_sources(active_only: bool = True) -> List[Dict[str, str]]:
    """合并"内置 6 来源 + offers 表动态来源"，去重，保持稳定顺序。

    - 内置项始终在前；offers 表中如有同 offer_key 与内置 id 重名，则保留内置（不重复出现）
    - offers 内部按 sort_order/id 顺序紧跟其后
    """
    seen = {item["id"] for item in BUILTIN_BOOKING_SOURCES}
    merged = list(BUILTIN_BOOKING_SOURCES)
    for o in _safe_fetch_offer_sources(active_only=active_only):
        if o["id"] in seen:
            continue
        seen.add(o["id"])
        merged.append(o)
    return merged


def upsert_category_if_missing(cid: str) -> None:
    """新增项目/编辑项目时，若分类 id 在 service_categories 不存在则自动创建为自定义项。"""
    cid = (cid or "").strip()
    if not cid:
        return
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute(f"SELECT id FROM service_categories WHERE id = {PH}", (cid,))
        if cur.fetchone():
            return
        cur.execute(
            f"INSERT INTO service_categories (id, name, icon, builtin, sort_order) "
            f"VALUES ({PH}, {PH}, {PH}, 0, 200)",
            (cid, cid, "fa-tag"),
        )


def upsert_tags_if_missing(tag_ids: List[str]) -> None:
    if not tag_ids:
        return
    with get_db_connection() as conn:
        cur = conn.cursor()
        for tid in tag_ids:
            tid = (tid or "").strip()
            if not tid:
                continue
            cur.execute(f"SELECT id FROM service_tags WHERE id = {PH}", (tid,))
            if cur.fetchone():
                continue
            cur.execute(
                f"INSERT INTO service_tags (id, label, color, builtin, sort_order) "
                f"VALUES ({PH}, {PH}, {PH}, 0, 200)",
                (tid, tid, "bg-slate-500"),
            )


def get_known_category_ids() -> set:
    return {c["id"] for c in fetch_categories()}


def get_known_tag_ids() -> set:
    return {t["id"] for t in fetch_tags()}


# ------------------------------------------------------------------
# 优惠活动（offers）相关常量
# ------------------------------------------------------------------
OFFER_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{1,39}$")
ALLOWED_OFFER_THEMES = {
    "offer-1",  "offer-2",  "offer-3",  "offer-4",
    "offer-5",  "offer-6",  "offer-7",  "offer-8",
    "offer-9",  "offer-10", "offer-11", "offer-12",
}
# 优惠的 source 必须在 ALLOWED_SOURCES 之内（已在文件顶部定义）

# 默认 3 条优惠（启动时若 offers 表为空则自动补齐，避免老库忘了跑 init_db）
DEFAULT_OFFERS_SEED = [
    # (offer_key, name, icon, theme, price, original_price, price_suffix,
    #  features(JSON list), btn_text, source, sort_order)
    ("new_customer", "新客体验价", "fa-gift", "offer-1",
     "¥99", "原价 ¥198", "",
     ["60 分钟经络推拿", "赠送养生茶饮", "仅限首次到店"],
     "立即抢购", "new_customer", 10),
    ("member", "会员套餐", "fa-crown", "offer-2",
     "¥1888", "10 次卡 · 立省 ¥520", "",
     ["任选项目 10 次", "赠送 2 次足底按摩", "会员专属优惠"],
     "立即办理", "member", 20),
    ("couple_package", "双人套餐", "fa-heart", "offer-3",
     "¥498", "原价 ¥656", "",
     ["90 分钟精油 SPA", "双人独立包间", "赠送水果茶点"],
     "立即预约", "couple_package", 30),
]


def _offer_table_ddl() -> List[str]:
    if PH == "?":  # sqlite
        return [
            """
            CREATE TABLE IF NOT EXISTS offers (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                offer_key       TEXT    NOT NULL UNIQUE,
                name            TEXT    NOT NULL,
                icon            TEXT    NOT NULL DEFAULT 'fa-gift',
                theme           TEXT    NOT NULL DEFAULT 'offer-1',
                price           TEXT    NOT NULL DEFAULT '',
                original_price  TEXT    NOT NULL DEFAULT '',
                price_suffix    TEXT    NOT NULL DEFAULT '',
                features        TEXT    NOT NULL DEFAULT '[]',
                btn_text        TEXT    NOT NULL DEFAULT '立即预约',
                source          TEXT    NOT NULL DEFAULT 'promo',
                is_active       INTEGER NOT NULL DEFAULT 1,
                sort_order      INTEGER NOT NULL DEFAULT 100,
                created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
                updated_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
            )
            """,
            "CREATE INDEX IF NOT EXISTS idx_offers_active ON offers(is_active)",
            "CREATE INDEX IF NOT EXISTS idx_offers_sort   ON offers(sort_order)",
        ]
    return [
        """
        CREATE TABLE IF NOT EXISTS offers (
            id              BIGINT       NOT NULL AUTO_INCREMENT,
            offer_key       VARCHAR(40)  NOT NULL,
            name            VARCHAR(80)  NOT NULL,
            icon            VARCHAR(40)  NOT NULL DEFAULT 'fa-gift',
            theme           VARCHAR(40)  NOT NULL DEFAULT 'offer-1',
            price           VARCHAR(40)  NOT NULL DEFAULT '',
            original_price  VARCHAR(80)  NOT NULL DEFAULT '',
            price_suffix    VARCHAR(120) NOT NULL DEFAULT '',
            features        VARCHAR(1000) NOT NULL DEFAULT '[]',
            btn_text        VARCHAR(40)  NOT NULL DEFAULT '立即预约',
            source          VARCHAR(40)  NOT NULL DEFAULT 'promo',
            is_active       TINYINT      NOT NULL DEFAULT 1,
            sort_order      INT          NOT NULL DEFAULT 100,
            created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uk_offer_key (offer_key),
            KEY idx_active (is_active),
            KEY idx_sort   (sort_order)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """,
    ]


def ensure_offers_table_and_seed() -> None:
    """启动时确保 offers 表存在；若为空则种入默认 3 条。"""
    with get_db_connection() as conn:
        cur = conn.cursor()
        for sql in _offer_table_ddl():
            cur.execute(sql)
        cur.execute("SELECT COUNT(*) AS c FROM offers")
        cnt = (cur.fetchone() or {}).get("c", 0) or 0
        if cnt > 0:
            return
        for o in DEFAULT_OFFERS_SEED:
            (okey, name, icon, theme, price, orig, suffix,
             features, btn_text, source, sort_order) = o
            cur.execute(
                f"INSERT INTO offers "
                f"(offer_key, name, icon, theme, price, original_price, price_suffix, "
                f" features, btn_text, source, is_active, sort_order) "
                f"VALUES ({PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH})",
                (okey, name, icon, theme, price, orig, suffix,
                 json.dumps(features, ensure_ascii=False),
                 btn_text, source, 1, sort_order),
            )


def _offer_row(row: Dict[str, Any]) -> Dict[str, Any]:
    """规范化 offers 行：features 反序列化、is_active 转 bool、时间转字符串。"""
    try:
        row["features"] = json.loads(row.get("features") or "[]")
    except Exception:
        row["features"] = []
    row["is_active"] = bool(row.get("is_active"))
    for k in ("created_at", "updated_at"):
        if row.get(k) and not isinstance(row[k], str):
            row[k] = str(row[k])
    return row


# ------------------------------------------------------------------
# 联系我们配置项校验
# ------------------------------------------------------------------
SETTING_TYPES = {"phone", "text", "wechat", "email", "url"}

# 不同 type 的校验规则：返回 (ok, error_message)
SETTING_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{1,39}$")
# 业务电话：手机号 / 座机 / 400 电话
BUSINESS_PHONE_RE = re.compile(
    r"^(?:"
    r"1[3-9]\d{9}"                      # 手机号
    r"|0\d{2,3}-?\d{7,8}"               # 座机
    r"|400-?\d{3}-?\d{4}"               # 400
    r"|800-?\d{3}-?\d{4}"               # 800
    r")$"
)
WECHAT_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{5,29}$")
EMAIL_RE  = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
URL_RE    = re.compile(r"^https?://[^\s]{3,500}$")

def validate_setting_value(value: str, type_: str) -> Optional[str]:
    """返回错误信息或 None。"""
    if type_ == "phone":
        v = value.replace(" ", "")
        if not BUSINESS_PHONE_RE.match(v):
            return "电话格式不正确（支持手机号 / 区号-座机 / 400 / 800）"
    elif type_ == "wechat":
        if not WECHAT_RE.match(value):
            return "微信号格式不正确（字母开头，6-30 位字母数字下划线连字符）"
    elif type_ == "email":
        if not EMAIL_RE.match(value):
            return "邮箱格式不正确"
    elif type_ == "url":
        if not URL_RE.match(value):
            return "链接必须以 http:// 或 https:// 开头"
    elif type_ == "text":
        if len(value.strip()) == 0:
            return "内容不能为空"
    return None


# ------------------------------------------------------------------
# 应用生命周期
# ------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("启动应用，数据库：%s", get_db_info())
    logger.info("管理后台登录：%s", "已启用" if ADMIN_AUTH_ENABLED else "已关闭")

    # 生产部署提醒：SQLite 在多 worker 写并发下容易 'database is locked'
    try:
        from db import DB_BACKEND as _db_backend
        web_concurrency = int(os.getenv("WEB_CONCURRENCY", "0") or 0)
        gunicorn_workers = int(os.getenv("GUNICORN_WORKERS", "0") or 0)
        worker_count = max(web_concurrency, gunicorn_workers)
        if _db_backend == "sqlite" and worker_count > 1:
            logger.warning(
                "[risk] 检测到 DB_BACKEND=sqlite 且 worker=%d。SQLite 多 worker 写并发"
                "易出现 'database is locked'，生产强烈建议切换到 MySQL。",
                worker_count,
            )
    except Exception:
        pass
    try:
        with get_db_connection() as conn:
            conn.cursor().execute("SELECT 1")
        logger.info("数据库连接正常")
        # 启动时自动确保分类/标签表存在并对齐内置项（避免老库忘了跑 init_db）
        try:
            ensure_meta_tables_and_seed()
        except Exception:
            logger.exception("分类/标签表初始化失败（不阻塞启动）")
        # 启动时自动确保 offers 表存在并种入默认 3 条
        try:
            ensure_offers_table_and_seed()
        except Exception:
            logger.exception("优惠活动表初始化失败（不阻塞启动）")
        # 启动时自动确保 audit_logs 表存在
        try:
            ensure_audit_table()
        except Exception:
            logger.exception("审计日志表初始化失败（不阻塞启动）")
        # 启动时自动确保 admin_users / admin_roles 表存在并种入内置角色
        try:
            users_mod.ensure_users_tables_and_seed(ADMIN_USERNAME)
        except Exception:
            logger.exception("人员/角色表初始化失败（不阻塞启动）")
        # 启动时执行一次过期数据清理，并启动每日定时清理任务
        try:
            purge_expired_records()
        except Exception:
            logger.exception("过期数据清理失败（不阻塞启动）")
    except Exception:
        logger.exception("数据库连接失败（请先运行 python init_db.py）")

    # 后台周期清理（每 24 小时一次）。失败不影响主流程。
    cleanup_task = asyncio.create_task(_periodic_cleanup_loop())
    try:
        yield
    finally:
        cleanup_task.cancel()
        try:
            await cleanup_task
        except (asyncio.CancelledError, Exception):
            pass
        logger.info("应用已停止")


# ------------------------------------------------------------------
# 数据保留 / 周期清理
# ------------------------------------------------------------------
def purge_expired_records() -> Dict[str, int]:
    """删除超出保留期的 analytics / audit_logs 记录。返回各表删除条数。"""
    deleted = {"analytics": 0, "audit_logs": 0}
    if PH == "?":
        # SQLite：created_at 存的是 'YYYY-MM-DD HH:MM:SS' localtime 字符串
        cutoff_a = f"datetime('now','localtime','-{ANALYTICS_RETENTION_DAYS} days')"
        cutoff_u = f"datetime('now','localtime','-{AUDIT_RETENTION_DAYS} days')"
        sql_a = f"DELETE FROM analytics  WHERE created_at < {cutoff_a}"
        sql_u = f"DELETE FROM audit_logs WHERE created_at < {cutoff_u}"
    else:
        sql_a = f"DELETE FROM analytics  WHERE created_at < (NOW() - INTERVAL {ANALYTICS_RETENTION_DAYS} DAY)"
        sql_u = f"DELETE FROM audit_logs WHERE created_at < (NOW() - INTERVAL {AUDIT_RETENTION_DAYS} DAY)"
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(sql_a)
            deleted["analytics"] = cur.rowcount or 0
            cur.execute(sql_u)
            deleted["audit_logs"] = cur.rowcount or 0
        if deleted["analytics"] or deleted["audit_logs"]:
            logger.info(
                "周期清理完成：analytics=-%d, audit_logs=-%d (保留 %d/%d 天)",
                deleted["analytics"], deleted["audit_logs"],
                ANALYTICS_RETENTION_DAYS, AUDIT_RETENTION_DAYS,
            )
    except Exception:
        logger.exception("过期记录清理执行失败")
    return deleted


async def _periodic_cleanup_loop() -> None:
    """每 24 小时跑一次清理；进程取消时安全退出。"""
    interval = 24 * 3600
    try:
        while True:
            await asyncio.sleep(interval)
            try:
                purge_expired_records()
            except Exception:
                logger.exception("周期清理任务异常")
    except asyncio.CancelledError:
        return


app = FastAPI(
    title="悦心养生馆 API",
    version="1.2.0",
    lifespan=lifespan,
    docs_url="/docs" if DOCS_ENABLED else None,
    redoc_url="/redoc" if DOCS_ENABLED else None,
    openapi_url="/openapi.json" if DOCS_ENABLED else None,
)


# ------------------------------------------------------------------
# 安全中间件
# ------------------------------------------------------------------
# 1) CORS 白名单（生产请通过 ALLOWED_ORIGINS 环境变量收敛）
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=None,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Requested-With"],
    expose_headers=["X-Audit-Export-Count"],
    max_age=600,
)


# 2) 安全 HTTP 头
class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """统一注入安全头，Nginx 反代会再叠加一次也不冲突。"""

    async def dispatch(self, request: Request, call_next):
        resp = await call_next(request)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        resp.headers.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
        # uploads 目录禁缓存外部脚本，防图床滥用
        if request.url.path.startswith("/static/uploads/"):
            resp.headers["Content-Disposition"] = "inline"
            resp.headers["X-Content-Type-Options"] = "nosniff"
            # 严格 CSP：即便未来误把可执行类型加入白名单，浏览器也不会执行
            resp.headers["Content-Security-Policy"] = (
                "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox"
            )
        return resp


app.add_middleware(SecurityHeadersMiddleware)


# ------------------------------------------------------------------
# 全局异常处理器：未捕获异常统一返回 5xx + request_id，避免泄露内部细节
# ------------------------------------------------------------------
@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception):
    # 让 HTTPException 走 FastAPI 默认处理（不进这里）
    if isinstance(exc, HTTPException):
        raise exc  # pragma: no cover
    request_id = secrets.token_hex(8)
    logger.exception(
        "[req=%s] 未捕获异常 %s %s",
        request_id, request.method, request.url.path,
    )
    return JSONResponse(
        status_code=500,
        content={
            "code": 500,
            "detail": "服务器内部错误，请稍后重试",
            "request_id": request_id,
        },
        headers={"X-Request-Id": request_id},
    )


# 3) 简易内存级限流（生产可换成 Nginx limit_req 或 Redis）
class RateLimiter:
    """
    滑动窗口限流：每个 (路径前缀, IP) 维护一个最近时间戳队列。
    线程安全：FastAPI/Uvicorn 单进程下足够；多 worker 部署请改用 Redis。
    """

    def __init__(self) -> None:
        self.buckets: Dict[Tuple[str, str], Deque[float]] = defaultdict(deque)

    def hit(self, key: Tuple[str, str], capacity: int, window: float) -> bool:
        now = time.time()
        q = self.buckets[key]
        # 清理过期
        while q and now - q[0] > window:
            q.popleft()
        if len(q) >= capacity:
            return False
        q.append(now)
        return True


rate_limiter = RateLimiter()

# 限流规则：(URL 前缀+方法 → (容量, 窗口秒))
# 注意：使用前缀匹配，越具体的规则放越靠前；同一请求只命中第一条
RATE_RULES: List[Tuple[str, str, int, float]] = [
    # path_prefix, method, capacity, window
    ("/api/admin/login",                  "POST", 5,   60.0),    # 5 次/分钟
    ("/api/admin/change-password",        "POST", 5,   300.0),   # 5 次/5 分钟，防 old_password 枚举
    ("/api/admin/upload/image",           "POST", 30,  60.0),    # 30 次/分钟，防上传刷盘
    ("/api/admin/audit-logs/export.csv",  "GET",  3,   60.0),    # 3 次/分钟
    ("/api/bookings/search",              "GET",  20,  60.0),    # 管理员按姓名查询，先于下面公开规则
    ("/api/bookings/",                    "GET",  20,  300.0),   # 公开按手机号查询：5 分钟 20 次（防枚举）
    ("/api/bookings",                     "POST", 10,  60.0),    # 10 次/分钟
    ("/api/analytics",                    "POST", 60,  60.0),    # 60 次/分钟
]


def _client_ip(request: Request) -> str:
    """获取客户端真实 IP。

    安全策略：
    - 默认仅采用 TCP 直连 IP（request.client.host），避免攻击者伪造
      X-Forwarded-For 绕过登录失败锁定 / 限流；
    - 仅当显式配置 TRUST_PROXY_HEADERS=true（部署在 Nginx/网关后）时，
      才采用 X-Forwarded-For 第一个 IP。
    """
    if TRUST_PROXY_HEADERS:
        xff = request.headers.get("x-forwarded-for", "")
        if xff:
            return xff.split(",")[0].strip()[:64]
    return (request.client.host if request.client else "")[:64]


class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if not RATE_LIMIT_ENABLED:
            return await call_next(request)
        path = request.url.path
        method = request.method
        for prefix, m, cap, window in RATE_RULES:
            if method == m and path.startswith(prefix):
                ip = _client_ip(request) or "unknown"
                key = (prefix, ip)
                if not rate_limiter.hit(key, cap, window):
                    return JSONResponse(
                        status_code=429,
                        content={
                            "code": 429,
                            "message": "请求过于频繁，请稍后再试",
                            "detail": f"limit {cap}/{int(window)}s",
                        },
                        headers={"Retry-After": str(int(window))},
                    )
                break
        return await call_next(request)


app.add_middleware(RateLimitMiddleware)


# ------------------------------------------------------------------
# 工具函数
# ------------------------------------------------------------------
def parse_booking_datetime(s: str) -> datetime:
    if not s:
        raise ValueError("时间不能为空")
    s_clean = s.strip()
    if s_clean.endswith("Z"):
        s_clean = s_clean[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s_clean)
    except ValueError as e:
        raise ValueError(f"时间格式错误: {s}") from e
    if dt.tzinfo is not None:
        dt = dt.astimezone().replace(tzinfo=None)
    return dt


def escape_like(s: str) -> str:
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def to_iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def normalize_booking_row(row: Dict[str, Any]) -> Dict[str, Any]:
    row["datetime"] = to_iso(row.get("datetime"))
    row["created_at"] = to_iso(row.get("created_at"))
    # 兜底字段：旧数据可能缺失
    row.setdefault("category", None)
    row.setdefault("source", "normal")
    return row


# ------------------------------------------------------------------
# 简易 Token 鉴权（HMAC 签名 + 过期时间）
# ------------------------------------------------------------------
TOKEN_TTL_SECONDS = 8 * 3600  # 8 小时


def _sign(payload: str) -> str:
    return hmac.new(SESSION_SECRET.encode(), payload.encode(), sha256).hexdigest()


def make_token(username: str) -> str:
    expires = int(time.time()) + TOKEN_TTL_SECONDS
    payload = f"{username}.{expires}"
    sig = _sign(payload)
    return f"{payload}.{sig}"


def parse_token(token: str) -> Optional[str]:
    """返回 username（若有效）或 None。"""
    if not token:
        return None
    try:
        username, expires_s, sig = token.rsplit(".", 2)
    except ValueError:
        return None
    payload = f"{username}.{expires_s}"
    if not hmac.compare_digest(sig, _sign(payload)):
        return None
    try:
        if int(expires_s) < int(time.time()):
            return None
    except ValueError:
        return None
    return username


def require_admin(request: Request) -> str:
    """FastAPI 依赖：要求请求头携带有效 token。

    安全策略：
    - 默认仅接受 ``Authorization: Bearer <token>``
    - 如果显式开启 ALLOW_TOKEN_QUERY=1（仅本地调试），才允许 query 兜底
    """
    if not ADMIN_AUTH_ENABLED:
        return "anonymous"
    auth = request.headers.get("authorization", "")
    token = ""
    if auth.lower().startswith("bearer "):
        token = auth[7:].strip()
    if not token and ALLOW_TOKEN_QUERY:
        token = request.query_params.get("token", "")
    user = parse_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="未登录或登录已过期")
    return user


def require_perm(perm: str):
    """FastAPI 依赖工厂：要求登录 + 拥有指定权限（如 'service:write'）。

    - super_admin 永远直通（由 users_mod.has_permission 内部处理）
    - 鉴权关闭模式（ADMIN_AUTH_ENABLED=false）下直接放行，便于本地调试
    """
    def _dep(user: str = Depends(require_admin)) -> str:
        if not ADMIN_AUTH_ENABLED:
            return user
        try:
            ok = users_mod.has_permission(user, perm)
        except Exception:
            logger.exception("权限校验异常 perm=%s user=%s", perm, user)
            raise HTTPException(status_code=500, detail="权限校验异常")
        if not ok:
            raise HTTPException(status_code=403, detail=f"无权限：{perm}")
        return user
    return _dep


# ------------------------------------------------------------------
# 密码校验：优先 bcrypt 哈希；回退 compare_digest（明文）
# ------------------------------------------------------------------
def verify_admin_password(plain: str) -> bool:
    """常量时间比较；任何异常一律返回 False。"""
    try:
        if ADMIN_PASSWORD_HASH:
            try:
                import bcrypt  # 延迟导入：未启用哈希时不强制依赖
            except ImportError:
                logger.error("配置了 ADMIN_PASSWORD_HASH 但未安装 bcrypt：pip install bcrypt")
                return False
            return bcrypt.checkpw(plain.encode("utf-8"), ADMIN_PASSWORD_HASH.encode("utf-8"))
        # 明文兜底（开发环境）
        if ADMIN_PASSWORD:
            return secrets.compare_digest(plain, ADMIN_PASSWORD)
        return False
    except Exception:
        logger.exception("密码校验异常")
        return False


# ------------------------------------------------------------------
# 登录失败锁定（同 IP 滑动窗口）
# ------------------------------------------------------------------
class LoginGuard:
    def __init__(self) -> None:
        # ip -> deque[timestamp]
        self.fails: Dict[str, Deque[float]] = defaultdict(deque)

    def is_locked(self, ip: str) -> Tuple[bool, int]:
        now = time.time()
        window = LOGIN_FAIL_LOCK_MINUTES * 60
        q = self.fails[ip]
        while q and now - q[0] > window:
            q.popleft()
        if len(q) >= LOGIN_FAIL_THRESHOLD:
            remain = int(window - (now - q[0]))
            return True, max(1, remain)
        return False, 0

    def record_fail(self, ip: str) -> None:
        self.fails[ip].append(time.time())

    def clear(self, ip: str) -> None:
        self.fails.pop(ip, None)


login_guard = LoginGuard()


# ------------------------------------------------------------------
# 数据模型
# ------------------------------------------------------------------
class BookingRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=50)
    phone: str = Field(..., pattern=r"^1[3-9]\d{9}$")
    datetime: str = Field(..., max_length=64)
    note: Optional[str] = Field(None, max_length=500)
    service_type: Optional[str] = Field(None, max_length=50)
    category: Optional[str] = Field(None, max_length=20)
    source: Optional[str] = Field("normal", max_length=40)

    @field_validator("name")
    @classmethod
    def strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("姓名不能为空")
        return v

    @field_validator("service_type")
    @classmethod
    def check_service(cls, v: Optional[str]) -> Optional[str]:
        if v in (None, ""):
            return None
        v = v.strip()
        if v not in get_allowed_service_names():
            raise ValueError(f"无效的服务类型: {v}")
        return v

    @field_validator("category")
    @classmethod
    def check_category(cls, v: Optional[str]) -> Optional[str]:
        if v in (None, ""):
            return None
        v = v.strip()
        # 内置 4 类直通；其余按自定义 id 规则校验（与 ServiceCreate 对齐）
        if v in ALLOWED_CATEGORIES:
            return v
        if not CUSTOM_CATEGORY_ID_RE.match(v):
            raise ValueError(f"无效的分类: {v}")
        return v

    @field_validator("source")
    @classmethod
    def check_source(cls, v: Optional[str]) -> Optional[str]:
        if v in (None, ""):
            return "normal"
        # 基础来源 + 后台新增的 offers offer_key 都允许
        if v not in get_allowed_booking_sources():
            raise ValueError(f"无效的来源: {v}")
        return v


class BookingUpdate(BaseModel):
    datetime: Optional[str] = Field(None, max_length=64)
    doctor: Optional[str] = Field(None, max_length=50)
    note: Optional[str] = Field(None, max_length=500)
    status: Optional[str] = Field(None, max_length=20)
    service_type: Optional[str] = Field(None, max_length=50)
    category: Optional[str] = Field(None, max_length=20)
    source: Optional[str] = Field(None, max_length=40)

    @field_validator("status")
    @classmethod
    def check_status(cls, v: Optional[str]) -> Optional[str]:
        if v in (None, ""):
            return None
        if v not in ALLOWED_STATUSES:
            raise ValueError("无效的状态值")
        return v

    @field_validator("doctor")
    @classmethod
    def check_doctor(cls, v: Optional[str]) -> Optional[str]:
        if v in (None, ""):
            return None
        v = v.strip()
        if not v:
            return None
        # 动态读取 doctors 表（含未上架的也允许，避免老预约更新失败）
        try:
            known = get_known_doctor_names(active_only=False)
        except Exception:
            known = set(ALLOWED_DOCTORS)
        if v not in known and v not in ALLOWED_DOCTORS:
            raise ValueError(f"无效的医生: {v}")
        return v

    @field_validator("service_type")
    @classmethod
    def check_service(cls, v: Optional[str]) -> Optional[str]:
        if v in (None, ""):
            return None
        v = v.strip()
        if v not in get_allowed_service_names():
            raise ValueError(f"无效的服务类型: {v}")
        return v

    @field_validator("category")
    @classmethod
    def check_category(cls, v: Optional[str]) -> Optional[str]:
        if v in (None, ""):
            return None
        v = v.strip()
        if v in ALLOWED_CATEGORIES:
            return v
        if not CUSTOM_CATEGORY_ID_RE.match(v):
            raise ValueError(f"无效的分类: {v}")
        return v

    @field_validator("source")
    @classmethod
    def check_source(cls, v: Optional[str]) -> Optional[str]:
        if v in (None, ""):
            return None
        # 基础来源 + 后台新增的 offers offer_key 都允许
        if v not in get_allowed_booking_sources():
            raise ValueError(f"无效的来源: {v}")
        return v


class StatusUpdate(BaseModel):
    status: str

    @field_validator("status")
    @classmethod
    def check(cls, v: str) -> str:
        if v not in ALLOWED_STATUSES:
            raise ValueError("无效的状态值")
        return v


class NoteUpdate(BaseModel):
    note: str = Field("", max_length=500)


# 埋点事件白名单（与前端 analytics.js 保持同步）
ALLOWED_EVENT_TYPES = {
    "page_view", "service_view", "service_detail_view",
    "booking_click", "booking_open", "booking_submit", "booking_success",
    "phone_click", "phone_copy", "navigate_click",
    "filter_apply", "category_click", "tag_click", "search",
    "favorite_add", "favorite_remove",
    "offer_click", "scroll_depth", "outbound_click",
}


class AnalyticsEvent(BaseModel):
    event_type: str = Field(..., min_length=1, max_length=50, pattern=r"^[a-z0-9_]+$")
    event_data: Optional[Dict[str, Any]] = None
    page_url: Optional[str] = Field(None, max_length=500)
    referrer: Optional[str] = Field(None, max_length=500)
    session_id: Optional[str] = Field(None, max_length=100, pattern=r"^[A-Za-z0-9_\-]*$")

    @field_validator("event_type")
    @classmethod
    def check_event_type(cls, v: str) -> str:
        # 不在白名单时统一打到 "other"，避免脏数据扩散
        return v if v in ALLOWED_EVENT_TYPES else "other"

    @field_validator("page_url", "referrer")
    @classmethod
    def check_url(cls, v: Optional[str]) -> Optional[str]:
        if not v:
            return v
        v = v.strip()
        # 仅接受 http/https/相对路径
        if not (v.startswith("http://") or v.startswith("https://") or v.startswith("/")):
            return ""
        return v


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=50)
    password: str = Field(..., min_length=1, max_length=100)


class SettingCreate(BaseModel):
    key: str = Field(..., min_length=2, max_length=40)
    value: str = Field(..., min_length=1, max_length=500)
    label: str = Field(..., min_length=1, max_length=40)
    type: str = Field("text", max_length=20)
    icon: Optional[str] = Field("fa-circle-info", max_length=40)
    sort_order: int = Field(100, ge=0, le=9999)

    @field_validator("key")
    @classmethod
    def check_key(cls, v: str) -> str:
        v = v.strip().lower()
        if not SETTING_KEY_RE.match(v):
            raise ValueError("key 只能包含小写字母/数字/下划线，且必须以字母开头（2-40 位）")
        return v

    @field_validator("type")
    @classmethod
    def check_type(cls, v: str) -> str:
        if v not in SETTING_TYPES:
            raise ValueError(f"type 必须是 {sorted(SETTING_TYPES)} 之一")
        return v


class SettingUpdate(BaseModel):
    value: Optional[str] = Field(None, max_length=500)
    label: Optional[str] = Field(None, min_length=1, max_length=40)
    type: Optional[str] = Field(None, max_length=20)
    icon: Optional[str] = Field(None, max_length=40)
    sort_order: Optional[int] = Field(None, ge=0, le=9999)

    @field_validator("type")
    @classmethod
    def check_type(cls, v: Optional[str]) -> Optional[str]:
        if v in (None, ""):
            return None
        if v not in SETTING_TYPES:
            raise ValueError(f"type 必须是 {sorted(SETTING_TYPES)} 之一")
        return v


# ------------------------------------------------------------------
# 服务项目模型
# ------------------------------------------------------------------
class ServiceCreate(BaseModel):
    id: str = Field(..., min_length=2, max_length=40)
    name: str = Field(..., min_length=1, max_length=50)
    subtitle: str = Field("", max_length=120)
    category: str = Field(..., max_length=20)
    image: str = Field("", max_length=500)
    duration: int = Field(..., ge=10, le=300)
    price: int = Field(..., ge=1, le=99999)
    original_price: int = Field(0, ge=0, le=99999)
    popularity: int = Field(50, ge=0, le=100)
    tags: List[str] = Field(default_factory=list)
    effects: List[str] = Field(default_factory=list)
    suitable_for: str = Field("", max_length=120)
    description: str = Field("", max_length=1000)
    contact_phone: str = Field("", max_length=40)
    is_active: bool = True
    sort_order: int = Field(100, ge=0, le=9999)

    @field_validator("id")
    @classmethod
    def check_id(cls, v: str) -> str:
        v = v.strip()
        if not SERVICE_ID_RE.match(v):
            raise ValueError("ID 只能包含字母/数字/下划线/连字符，且必须以字母开头（2-40 位）")
        return v

    @field_validator("category")
    @classmethod
    def check_category(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("分类不能为空")
        # 内置 id 直接通过；否则按自定义 id 校验
        if v in ALLOWED_CATEGORIES:
            return v
        if not CUSTOM_CATEGORY_ID_RE.match(v):
            raise ValueError("无效的分类（字母数字开头，1-30 位字母数字-_）")
        return v

    @field_validator("tags")
    @classmethod
    def check_tags(cls, v: List[str]) -> List[str]:
        if not isinstance(v, list):
            raise ValueError("tags 必须是数组")
        cleaned: List[str] = []
        seen = set()
        for t in v:
            t = str(t or "").strip()
            if not t:
                continue
            # 内置 id 直接通过；否则按自定义标签字符校验
            if t not in SERVICE_TAGS and not CUSTOM_LABEL_RE.match(t):
                raise ValueError(f"无效标签：{t}（1-20 位中英文/数字/-_）")
            if t in seen:
                continue
            seen.add(t)
            cleaned.append(t)
        return cleaned[:20]

    @field_validator("effects")
    @classmethod
    def check_effects(cls, v: List[str]) -> List[str]:
        if not isinstance(v, list):
            raise ValueError("effects 必须是数组")
        return [str(x).strip()[:30] for x in v if str(x).strip()][:10]

    @field_validator("contact_phone")
    @classmethod
    def check_phone(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            return ""
        err = validate_setting_value(v, "phone")
        if err:
            raise ValueError(err)
        return v


class ServiceUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=50)
    subtitle: Optional[str] = Field(None, max_length=120)
    category: Optional[str] = Field(None, max_length=20)
    image: Optional[str] = Field(None, max_length=500)
    duration: Optional[int] = Field(None, ge=10, le=300)
    price: Optional[int] = Field(None, ge=1, le=99999)
    original_price: Optional[int] = Field(None, ge=0, le=99999)
    popularity: Optional[int] = Field(None, ge=0, le=100)
    tags: Optional[List[str]] = None
    effects: Optional[List[str]] = None
    suitable_for: Optional[str] = Field(None, max_length=120)
    description: Optional[str] = Field(None, max_length=1000)
    contact_phone: Optional[str] = Field(None, max_length=40)
    is_active: Optional[bool] = None
    sort_order: Optional[int] = Field(None, ge=0, le=9999)

    @field_validator("category")
    @classmethod
    def check_category(cls, v: Optional[str]) -> Optional[str]:
        if v in (None, ""):
            return None
        v = v.strip()
        if v in ALLOWED_CATEGORIES:
            return v
        if not CUSTOM_CATEGORY_ID_RE.match(v):
            raise ValueError("无效的分类（字母数字开头，1-30 位字母数字-_）")
        return v

    @field_validator("tags")
    @classmethod
    def check_tags(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        if v is None:
            return None
        if not isinstance(v, list):
            raise ValueError("tags 必须是数组")
        cleaned: List[str] = []
        seen = set()
        for t in v:
            t = str(t or "").strip()
            if not t:
                continue
            if t not in SERVICE_TAGS and not CUSTOM_LABEL_RE.match(t):
                raise ValueError(f"无效标签：{t}（1-20 位中英文/数字/-_）")
            if t in seen:
                continue
            seen.add(t)
            cleaned.append(t)
        return cleaned[:20]

    @field_validator("effects")
    @classmethod
    def check_effects(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        if v is None:
            return None
        return [str(x).strip()[:30] for x in v if str(x).strip()][:10]

    @field_validator("contact_phone")
    @classmethod
    def check_phone(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip()
        if not v:
            return ""
        err = validate_setting_value(v, "phone")
        if err:
            raise ValueError(err)
        return v


# ------------------------------------------------------------------
# 优惠活动数据模型
# ------------------------------------------------------------------
def _check_offer_features(v: List[str]) -> List[str]:
    if not isinstance(v, list):
        raise ValueError("features 必须是数组")
    cleaned: List[str] = []
    for x in v:
        s = str(x or "").strip()
        if not s:
            continue
        if len(s) > 60:
            raise ValueError("每条卖点不能超过 60 字")
        cleaned.append(s)
    return cleaned[:8]


class OfferCreate(BaseModel):
    offer_key: str = Field(..., min_length=2, max_length=40)
    name: str = Field(..., min_length=1, max_length=50)
    icon: str = Field("fa-gift", max_length=40)
    theme: str = Field("offer-1", max_length=40)
    price: str = Field("", max_length=40)
    original_price: str = Field("", max_length=80)
    price_suffix: str = Field("", max_length=120)
    features: List[str] = Field(default_factory=list)
    btn_text: str = Field("立即预约", max_length=40)
    source: str = Field("promo", max_length=40)
    is_active: bool = True
    sort_order: int = Field(100, ge=0, le=9999)

    @field_validator("offer_key")
    @classmethod
    def check_key(cls, v: str) -> str:
        v = v.strip().lower()
        if not OFFER_KEY_RE.match(v):
            raise ValueError("offer_key 只能包含小写字母/数字/下划线，且必须以字母开头（2-40 位）")
        return v

    @field_validator("theme")
    @classmethod
    def check_theme(cls, v: str) -> str:
        v = (v or "").strip()
        if v not in ALLOWED_OFFER_THEMES:
            raise ValueError(f"theme 必须是 {sorted(ALLOWED_OFFER_THEMES)} 之一")
        return v

    @field_validator("source")
    @classmethod
    def check_source(cls, v: str) -> str:
        v = (v or "").strip() or "promo"
        if v not in ALLOWED_SOURCES:
            raise ValueError(f"source 必须是 {sorted(ALLOWED_SOURCES)} 之一")
        return v

    @field_validator("features")
    @classmethod
    def check_features(cls, v: List[str]) -> List[str]:
        return _check_offer_features(v)


class OfferUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=50)
    icon: Optional[str] = Field(None, max_length=40)
    theme: Optional[str] = Field(None, max_length=40)
    price: Optional[str] = Field(None, max_length=40)
    original_price: Optional[str] = Field(None, max_length=80)
    price_suffix: Optional[str] = Field(None, max_length=120)
    features: Optional[List[str]] = None
    btn_text: Optional[str] = Field(None, max_length=40)
    source: Optional[str] = Field(None, max_length=40)
    is_active: Optional[bool] = None
    sort_order: Optional[int] = Field(None, ge=0, le=9999)

    @field_validator("theme")
    @classmethod
    def check_theme(cls, v: Optional[str]) -> Optional[str]:
        if v in (None, ""):
            return None
        if v not in ALLOWED_OFFER_THEMES:
            raise ValueError(f"theme 必须是 {sorted(ALLOWED_OFFER_THEMES)} 之一")
        return v

    @field_validator("source")
    @classmethod
    def check_source(cls, v: Optional[str]) -> Optional[str]:
        if v in (None, ""):
            return None
        if v not in ALLOWED_SOURCES:
            raise ValueError(f"source 必须是 {sorted(ALLOWED_SOURCES)} 之一")
        return v

    @field_validator("features")
    @classmethod
    def check_features(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        if v is None:
            return None
        return _check_offer_features(v)


# ------------------------------------------------------------------
# settings 内部工具
# ------------------------------------------------------------------
SETTINGS_KEY_COL = '"key"'  # SQLite 关键字需引号；MySQL 用 `key`
def _key_col() -> str:
    return '`key`' if PH == "%s" else '"key"'

# 环境模块专属隐藏 key：
# 这些键虽然存在 settings 表，但只供"环境模块"内部读取，
# 不在「联系方式/站点配置」列表（公开接口和后台列表）里展示。
HIDDEN_SETTING_KEYS = (
    "env_eyebrow",
    "env_title",
    "env_subtitle",
    "env_autoplay_ms",
)


def _setting_row(row: Dict[str, Any]) -> Dict[str, Any]:
    row["builtin"] = bool(row.get("builtin"))
    if row.get("updated_at") and not isinstance(row["updated_at"], str):
        row["updated_at"] = str(row["updated_at"])
    return row


# ------------------------------------------------------------------
# 路由
# ------------------------------------------------------------------
@app.get("/")
async def root():
    return RedirectResponse(url="/static/index.html")


# ============== 鉴权 ==============
@app.post("/api/admin/login")
async def admin_login(req: LoginRequest, request: Request):
    if not ADMIN_AUTH_ENABLED:
        return {"code": 0, "message": "鉴权已关闭", "data": {"token": "no-auth", "username": req.username}}

    ip = _client_ip(request) or "unknown"

    # 锁定检查
    locked, remain = login_guard.is_locked(ip)
    if locked:
        audit_log(
            actor=req.username[:80], action="login_failed", resource="admin",
            resource_id=req.username[:80],
            summary=f"IP {ip} 已被锁定，剩余 {remain}s",
            request=request,
        )
        raise HTTPException(
            status_code=429,
            detail=f"登录失败次数过多，请 {remain} 秒后再试",
            headers={"Retry-After": str(remain)},
        )

    # 双通道认证：1) 数据库账号（admin_users 表，bcrypt） 2) ENV admin 兼容（首次启动/未改密时）
    auth_ok = False
    auth_username = ""
    db_user = users_mod.authenticate_db_user(req.username, req.password)
    if db_user:
        auth_ok = True
        auth_username = db_user["username"]
    else:
        # ENV 兼容：仅当用户名等于 ADMIN_USERNAME 且 admin_users 中该账号尚未设置 password_hash 时
        u_ok = secrets.compare_digest(req.username, ADMIN_USERNAME)
        if u_ok:
            existing = users_mod.get_user_by_username(ADMIN_USERNAME)
            # 已设置 DB 密码后，ENV 密码失效（避免双密码并存）
            if existing is None or not existing.get("password_hash"):
                if verify_admin_password(req.password):
                    auth_ok = True
                    auth_username = ADMIN_USERNAME

    if not auth_ok:
        await asyncio.sleep(0.3)
        login_guard.record_fail(ip)
        audit_log(
            actor=req.username[:80], action="login_failed", resource="admin",
            resource_id=req.username[:80],
            summary=f"登录失败：{req.username}@{ip}",
            request=request,
        )
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    login_guard.clear(ip)
    users_mod.touch_last_login(auth_username)
    token = make_token(auth_username)
    audit_log(
        actor=auth_username, action="login", resource="admin",
        resource_id=auth_username,
        summary=f"管理员 {auth_username} 登录成功 @ {ip}",
        request=request,
    )

    user_info = users_mod.get_user_public(auth_username) or {}
    role = users_mod.get_role(user_info.get("role_key") or users_mod.BUILTIN_ROLE_VIEWER)
    perms = users_mod.get_permissions_for(auth_username)
    return {
        "code": 0, "message": "登录成功",
        "data": {
            "token": token,
            "username": auth_username,
            "display_name": user_info.get("display_name") or auth_username,
            "role_key": user_info.get("role_key"),
            "role_name": (role or {}).get("name") or "",
            "permissions": perms,
            "expires_in": TOKEN_TTL_SECONDS,
        },
    }


@app.get("/api/admin/me")
async def admin_me(user: str = Depends(require_admin)):
    info = users_mod.get_user_public(user) or {}
    role = users_mod.get_role(info.get("role_key") or users_mod.BUILTIN_ROLE_VIEWER)
    perms = users_mod.get_permissions_for(user)
    return {
        "code": 0,
        "data": {
            "username": user,
            "auth_enabled": ADMIN_AUTH_ENABLED,
            "display_name": info.get("display_name") or user,
            "role_key": info.get("role_key"),
            "role_name": (role or {}).get("name") or "",
            "permissions": perms,
            "is_builtin": info.get("is_builtin", False),
        },
    }


# 提供给后台前端的元数据，与 services.js 保持一致
@app.get("/api/admin/meta")
async def admin_meta(_: str = Depends(require_admin)):
    # 分类从 service_categories 表读取（含内置 + 自定义），而非硬编码 4 个
    try:
        cats = fetch_categories()
    except Exception:
        logger.exception("读取分类表失败，回退到内置 4 类")
        cats = [
            {"id": "chinese", "name": "中式调理", "icon": "fa-yin-yang",   "builtin": True, "sort_order": 10},
            {"id": "thai",    "name": "泰式 SPA", "icon": "fa-leaf",        "builtin": True, "sort_order": 20},
            {"id": "aroma",   "name": "芳疗护理", "icon": "fa-pump-soap",   "builtin": True, "sort_order": 30},
            {"id": "foot",    "name": "足疗保健", "icon": "fa-shoe-prints", "builtin": True, "sort_order": 40},
        ]
    try:
        tags = fetch_tags()
    except Exception:
        logger.exception("读取标签表失败")
        tags = []
    return {
        "code": 0,
        "data": {
            "categories": cats,
            "tags": tags,
            "services": get_service_meta_entries(),
            "statuses": [
                {"id": "pending",     "name": "待确认"},
                {"id": "confirmed",   "name": "已确认"},
                {"id": "rescheduled", "name": "改签"},
                {"id": "completed",   "name": "消费成功"},
                {"id": "cancelled",   "name": "已取消"},
                {"id": "other",       "name": "其他特殊情况"},
            ],
            "sources": _build_meta_sources(),
            "doctors": [d["name"] for d in _safe_fetch_doctors(active_only=True)] or sorted(ALLOWED_DOCTORS),
            "doctors_full": _safe_fetch_doctors(active_only=False),
        },
    }


# ============== 公开：客户端拉取分类与标签元数据（用于 Tab/筛选/芯片） ==============
@app.get("/api/meta")
async def public_meta():
    """无须鉴权。客户端启动时调用一次，确保分类 Tab 与标签芯片与管理端实时一致。"""
    try:
        cats = fetch_categories()
        tags = fetch_tags()
    except Exception:
        logger.exception("公开元数据查询失败")
        # 兜底：返回内置 4 类 + 5 标签，避免客户端崩
        cats = [
            {"id": "chinese", "name": "中式调理", "icon": "fa-yin-yang",   "builtin": True, "sort_order": 10},
            {"id": "thai",    "name": "泰式 SPA", "icon": "fa-leaf",        "builtin": True, "sort_order": 20},
            {"id": "aroma",   "name": "芳疗护理", "icon": "fa-pump-soap",   "builtin": True, "sort_order": 30},
            {"id": "foot",    "name": "足疗保健", "icon": "fa-shoe-prints", "builtin": True, "sort_order": 40},
        ]
        tags = [
            {"id": "hot",       "label": "热门",     "color": "bg-rose-500",    "builtin": True, "sort_order": 10},
            {"id": "new",       "label": "新品",     "color": "bg-emerald-500", "builtin": True, "sort_order": 20},
            {"id": "female",    "label": "女士专享", "color": "bg-pink-500",    "builtin": True, "sort_order": 30},
            {"id": "couple",    "label": "情侣套餐", "color": "bg-violet-500",  "builtin": True, "sort_order": 40},
            {"id": "recommend", "label": "主推",     "color": "bg-amber-500",   "builtin": True, "sort_order": 50},
        ]
    return {"code": 0, "data": {"categories": cats, "tags": tags}}


# ============== 管理员：分类 CRUD ==============
class CategoryCreate(BaseModel):
    id: str = Field(..., min_length=1, max_length=20)
    name: str = Field(..., min_length=1, max_length=30)
    icon: Optional[str] = Field("fa-tag", max_length=40)
    sort_order: int = Field(200, ge=0, le=9999)

    @field_validator("id")
    @classmethod
    def check_id(cls, v: str) -> str:
        v = v.strip()
        if not CUSTOM_CATEGORY_ID_RE.match(v):
            raise ValueError("分类 id 格式无效（中英文/数字/-_/空格，1-20 位）")
        return v


class CategoryUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=30)
    icon: Optional[str] = Field(None, max_length=40)
    sort_order: Optional[int] = Field(None, ge=0, le=9999)


class TagCreate(BaseModel):
    id: str = Field(..., min_length=1, max_length=20)
    label: str = Field(..., min_length=1, max_length=30)
    color: Optional[str] = Field("bg-slate-500", max_length=60)
    sort_order: int = Field(200, ge=0, le=9999)

    @field_validator("id")
    @classmethod
    def check_id(cls, v: str) -> str:
        v = v.strip()
        if not CUSTOM_LABEL_RE.match(v):
            raise ValueError("标签 id 格式无效（中英文/数字/-_/空格，1-20 位）")
        return v


class TagUpdate(BaseModel):
    label: Optional[str] = Field(None, min_length=1, max_length=30)
    color: Optional[str] = Field(None, max_length=60)
    sort_order: Optional[int] = Field(None, ge=0, le=9999)


@app.get("/api/admin/categories")
async def admin_list_categories(_: str = Depends(require_admin)):
    try:
        return {"code": 0, "data": fetch_categories()}
    except Exception:
        logger.exception("查询分类失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")


@app.post("/api/admin/categories")
async def admin_create_category(payload: CategoryCreate, _: str = Depends(require_perm("service:write"))):
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(f"SELECT id FROM service_categories WHERE id = {PH}", (payload.id,))
            if cur.fetchone():
                raise HTTPException(status_code=409, detail=f"分类已存在：{payload.id}")
            cur.execute(
                f"INSERT INTO service_categories (id, name, icon, builtin, sort_order) "
                f"VALUES ({PH}, {PH}, {PH}, 0, {PH})",
                (payload.id, payload.name.strip(), payload.icon or "fa-tag", payload.sort_order),
            )
    except HTTPException:
        raise
    except Exception:
        logger.exception("新增分类失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "message": "新增成功", "data": {"id": payload.id}}


@app.put("/api/admin/categories/{cat_id}")
async def admin_update_category(
    cat_id: str = FPath(..., min_length=1, max_length=20),
    payload: CategoryUpdate = ...,
    _: str = Depends(require_perm("service:write")),
):
    if not CUSTOM_CATEGORY_ID_RE.match(cat_id):
        raise HTTPException(status_code=400, detail="无效的分类 id")
    fields: List[str] = []
    values: List[Any] = []
    if payload.name is not None:
        fields.append(f"name = {PH}"); values.append(payload.name.strip())
    if payload.icon is not None:
        fields.append(f"icon = {PH}"); values.append(payload.icon)
    if payload.sort_order is not None:
        fields.append(f"sort_order = {PH}"); values.append(payload.sort_order)
    if not fields:
        raise HTTPException(status_code=400, detail="没有要更新的字段")
    if PH == "?":
        fields.append("updated_at = datetime('now','localtime')")
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(f"SELECT id FROM service_categories WHERE id = {PH}", (cat_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="分类不存在")
            values.append(cat_id)
            cur.execute(
                f"UPDATE service_categories SET {', '.join(fields)} WHERE id = {PH}",
                tuple(values),
            )
    except HTTPException:
        raise
    except Exception:
        logger.exception("更新分类失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "message": "更新成功", "data": {"id": cat_id}}


@app.delete("/api/admin/categories/{cat_id}")
async def admin_delete_category(
    cat_id: str = FPath(..., min_length=1, max_length=20),
    force: int = Query(0, ge=0, le=1),
    _: str = Depends(require_perm("service:write")),
):
    if not CUSTOM_CATEGORY_ID_RE.match(cat_id):
        raise HTTPException(status_code=400, detail="无效的分类 id")
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                f"SELECT id, builtin FROM service_categories WHERE id = {PH}", (cat_id,),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="分类不存在")
            if dict(row).get("builtin"):
                raise HTTPException(status_code=400, detail="内置分类不可删除")
            # 引用计数：仍被服务项目使用时拒绝删除（除非 force=1）
            cur.execute(
                f"SELECT COUNT(*) AS c FROM services WHERE category = {PH}", (cat_id,),
            )
            ref = (cur.fetchone() or {}).get("c", 0) or 0
            if ref and not force:
                raise HTTPException(
                    status_code=400,
                    detail=f"该分类下仍有 {ref} 个服务项目，请先迁移或在删除时附带 force=1",
                )
            cur.execute(f"DELETE FROM service_categories WHERE id = {PH}", (cat_id,))
    except HTTPException:
        raise
    except Exception:
        logger.exception("删除分类失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "message": "删除成功"}


@app.get("/api/admin/tags")
async def admin_list_tags(_: str = Depends(require_admin)):
    try:
        return {"code": 0, "data": fetch_tags()}
    except Exception:
        logger.exception("查询标签失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")


@app.post("/api/admin/tags")
async def admin_create_tag(payload: TagCreate, _: str = Depends(require_perm("service:write"))):
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(f"SELECT id FROM service_tags WHERE id = {PH}", (payload.id,))
            if cur.fetchone():
                raise HTTPException(status_code=409, detail=f"标签已存在：{payload.id}")
            cur.execute(
                f"INSERT INTO service_tags (id, label, color, builtin, sort_order) "
                f"VALUES ({PH}, {PH}, {PH}, 0, {PH})",
                (payload.id, payload.label.strip(), payload.color or "bg-slate-500", payload.sort_order),
            )
    except HTTPException:
        raise
    except Exception:
        logger.exception("新增标签失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "message": "新增成功", "data": {"id": payload.id}}


@app.put("/api/admin/tags/{tag_id}")
async def admin_update_tag(
    tag_id: str = FPath(..., min_length=1, max_length=20),
    payload: TagUpdate = ...,
    _: str = Depends(require_perm("service:write")),
):
    if not CUSTOM_LABEL_RE.match(tag_id):
        raise HTTPException(status_code=400, detail="无效的标签 id")
    fields: List[str] = []
    values: List[Any] = []
    if payload.label is not None:
        fields.append(f"label = {PH}"); values.append(payload.label.strip())
    if payload.color is not None:
        fields.append(f"color = {PH}"); values.append(payload.color)
    if payload.sort_order is not None:
        fields.append(f"sort_order = {PH}"); values.append(payload.sort_order)
    if not fields:
        raise HTTPException(status_code=400, detail="没有要更新的字段")
    if PH == "?":
        fields.append("updated_at = datetime('now','localtime')")
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(f"SELECT id FROM service_tags WHERE id = {PH}", (tag_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="标签不存在")
            values.append(tag_id)
            cur.execute(
                f"UPDATE service_tags SET {', '.join(fields)} WHERE id = {PH}",
                tuple(values),
            )
    except HTTPException:
        raise
    except Exception:
        logger.exception("更新标签失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "message": "更新成功", "data": {"id": tag_id}}


@app.delete("/api/admin/tags/{tag_id}")
async def admin_delete_tag(
    tag_id: str = FPath(..., min_length=1, max_length=20),
    force: int = Query(0, ge=0, le=1),
    _: str = Depends(require_perm("service:write")),
):
    if not CUSTOM_LABEL_RE.match(tag_id):
        raise HTTPException(status_code=400, detail="无效的标签 id")
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(f"SELECT id, builtin FROM service_tags WHERE id = {PH}", (tag_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="标签不存在")
            if dict(row).get("builtin"):
                raise HTTPException(status_code=400, detail="内置标签不可删除")
            cur.execute(
                f"SELECT COUNT(*) AS c FROM services WHERE tags LIKE {PH}",
                (f'%"{tag_id}"%',),
            )
            ref = (cur.fetchone() or {}).get("c", 0) or 0
            if ref and not force:
                raise HTTPException(
                    status_code=400,
                    detail=f"该标签仍被 {ref} 个服务使用，请先迁移或在删除时附带 force=1",
                )
            cur.execute(f"DELETE FROM service_tags WHERE id = {PH}", (tag_id,))
    except HTTPException:
        raise
    except Exception:
        logger.exception("删除标签失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "message": "删除成功"}


# ============== 客户端：公开获取联系方式 ==============
@app.get("/api/contact-info")
async def public_contact_info():
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            kc = _key_col()
            # 排除环境模块专属隐藏 key（env_eyebrow/env_title/env_subtitle/env_autoplay_ms）
            placeholders = ",".join([PH] * len(HIDDEN_SETTING_KEYS))
            cur.execute(
                f"SELECT {kc} AS key, value, label, type, icon, sort_order, updated_at "
                f"FROM settings "
                f"WHERE value <> '' AND {kc} NOT IN ({placeholders}) "
                f"ORDER BY sort_order ASC, {kc} ASC",
                tuple(HIDDEN_SETTING_KEYS),
            )
            rows = [dict(r) for r in cur.fetchall()]
    except Exception:
        logger.exception("获取联系方式失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "data": rows}


# ============== 管理员：联系方式 CRUD ==============
@app.get("/api/admin/settings")
async def list_settings(
    keyword: Optional[str] = Query(None, max_length=50),
    _: str = Depends(require_admin),
):
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            kc = _key_col()
            params: List[Any] = []
            sql = (f"SELECT {kc} AS key, value, label, type, icon, builtin, sort_order, updated_at "
                   f"FROM settings")
            # 始终排除环境模块专属隐藏 key
            placeholders = ",".join([PH] * len(HIDDEN_SETTING_KEYS))
            where_parts = [f"{kc} NOT IN ({placeholders})"]
            params.extend(HIDDEN_SETTING_KEYS)
            if keyword:
                kw = f"%{escape_like(keyword.strip())}%"
                where_parts.append(
                    f"({kc} LIKE {PH} ESCAPE '\\' "
                    f"OR label LIKE {PH} ESCAPE '\\' "
                    f"OR value LIKE {PH} ESCAPE '\\')"
                )
                params.extend([kw, kw, kw])
            sql += " WHERE " + " AND ".join(where_parts)
            sql += f" ORDER BY sort_order ASC, {kc} ASC"
            cur.execute(sql, tuple(params))
            rows = [_setting_row(dict(r)) for r in cur.fetchall()]
    except Exception:
        logger.exception("查询联系方式失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "data": rows}


@app.post("/api/admin/settings")
async def create_setting(payload: SettingCreate, _: str = Depends(require_perm("setting:write"))):
    err = validate_setting_value(payload.value, payload.type)
    if err:
        raise HTTPException(status_code=400, detail=err)
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            kc = _key_col()
            cur.execute(f"SELECT {kc} AS key FROM settings WHERE {kc} = {PH}", (payload.key,))
            if cur.fetchone():
                raise HTTPException(status_code=409, detail=f"key 已存在：{payload.key}")
            cur.execute(
                f"INSERT INTO settings ({kc}, value, label, type, icon, builtin, sort_order) "
                f"VALUES ({PH}, {PH}, {PH}, {PH}, {PH}, 0, {PH})",
                (payload.key, payload.value.strip(), payload.label.strip(),
                 payload.type, payload.icon or "fa-circle-info", payload.sort_order),
            )
    except HTTPException:
        raise
    except Exception:
        logger.exception("新增联系方式失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "message": "新增成功", "data": {"key": payload.key}}


@app.put("/api/admin/settings/{key}")
async def update_setting(
    key: str = FPath(..., min_length=2, max_length=40),
    payload: SettingUpdate = ...,
    _: str = Depends(require_perm("setting:write")),
):
    if not SETTING_KEY_RE.match(key):
        raise HTTPException(status_code=400, detail="无效的 key")
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            kc = _key_col()
            cur.execute(
                f"SELECT {kc} AS key, value, label, type, icon, builtin, sort_order "
                f"FROM settings WHERE {kc} = {PH}",
                (key,),
            )
            current = cur.fetchone()
            if not current:
                raise HTTPException(status_code=404, detail="配置项不存在")
            current = dict(current)

            new_type = payload.type or current.get("type") or "text"
            new_value = payload.value if payload.value is not None else current.get("value", "")
            err = validate_setting_value(new_value or "", new_type)
            if payload.value is not None and err:
                raise HTTPException(status_code=400, detail=err)

            fields: List[str] = []
            values: List[Any] = []
            if payload.value is not None:
                fields.append(f"value = {PH}"); values.append(payload.value.strip())
            if payload.label is not None:
                fields.append(f"label = {PH}"); values.append(payload.label.strip())
            if payload.type is not None:
                fields.append(f"type = {PH}"); values.append(payload.type)
            if payload.icon is not None:
                fields.append(f"icon = {PH}"); values.append(payload.icon)
            if payload.sort_order is not None:
                fields.append(f"sort_order = {PH}"); values.append(payload.sort_order)
            if not fields:
                raise HTTPException(status_code=400, detail="没有要更新的字段")

            # 更新时间
            if PH == "?":
                fields.append("updated_at = datetime('now','localtime')")
            # MySQL 由 ON UPDATE CURRENT_TIMESTAMP 自动维护

            values.append(key)
            cur.execute(
                f"UPDATE settings SET {', '.join(fields)} WHERE {kc} = {PH}",
                tuple(values),
            )
    except HTTPException:
        raise
    except Exception:
        logger.exception("更新联系方式失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "message": "更新成功", "data": {"key": key}}


@app.delete("/api/admin/settings/{key}")
async def delete_setting(
    key: str = FPath(..., min_length=2, max_length=40),
    _: str = Depends(require_perm("setting:write")),
):
    if not SETTING_KEY_RE.match(key):
        raise HTTPException(status_code=400, detail="无效的 key")
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            kc = _key_col()
            cur.execute(
                f"SELECT builtin FROM settings WHERE {kc} = {PH}",
                (key,),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="配置项不存在")
            if dict(row).get("builtin"):
                raise HTTPException(status_code=400, detail="内置项不可删除（可清空内容禁用）")
            cur.execute(f"DELETE FROM settings WHERE {kc} = {PH}", (key,))
    except HTTPException:
        raise
    except Exception:
        logger.exception("删除联系方式失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "message": "删除成功"}


# ============================================================
# 服务项目管理（CRUD + 图片上传）
# ============================================================
def _service_row(row: Dict[str, Any]) -> Dict[str, Any]:
    """规范化数据库行：tags/effects 反序列化、is_active 转 bool。"""
    try:
        row["tags"] = json.loads(row.get("tags") or "[]")
    except Exception:
        row["tags"] = []
    try:
        row["effects"] = json.loads(row.get("effects") or "[]")
    except Exception:
        row["effects"] = []
    row["is_active"] = bool(row.get("is_active"))
    for k in ("created_at", "updated_at"):
        if row.get(k) and not isinstance(row[k], str):
            row[k] = str(row[k])
    return row


# -------- 公开：客户端拉取上架项目 --------
@app.get("/api/services")
async def public_services():
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT id, name, subtitle, category, image, duration, price, original_price, "
                "       popularity, tags, effects, suitable_for, description, contact_phone, "
                "       is_active, sort_order "
                "FROM services WHERE is_active = 1 "
                "ORDER BY sort_order ASC, id ASC"
            )
            rows = [_service_row(dict(r)) for r in cur.fetchall()]
    except Exception:
        logger.exception("获取服务列表失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "data": rows}


# -------- 管理员：列表（分页 + 筛选） --------
@app.get("/api/admin/services")
async def list_services(
    page: int = Query(1, ge=1, le=10000),
    page_size: int = Query(20, ge=1, le=100),
    category: Optional[str] = Query(None),
    tag: Optional[str] = Query(None),
    is_active: Optional[int] = Query(None, ge=0, le=1),
    keyword: Optional[str] = Query(None, max_length=50),
    min_price: Optional[int] = Query(None, ge=0, le=99999),
    max_price: Optional[int] = Query(None, ge=0, le=99999),
    _: str = Depends(require_admin),
):
    if category and category not in ALLOWED_CATEGORIES and not CUSTOM_CATEGORY_ID_RE.match(category):
        raise HTTPException(status_code=400, detail="无效分类")
    if tag and tag not in SERVICE_TAGS and not CUSTOM_LABEL_RE.match(tag):
        raise HTTPException(status_code=400, detail="无效标签")

    where_parts: List[str] = ["1=1"]
    params: List[Any] = []
    if category:
        where_parts.append(f"category = {PH}"); params.append(category)
    if is_active is not None:
        where_parts.append(f"is_active = {PH}"); params.append(is_active)
    if min_price is not None:
        where_parts.append(f"price >= {PH}"); params.append(min_price)
    if max_price is not None:
        where_parts.append(f"price <= {PH}"); params.append(max_price)
    if keyword:
        kw = f"%{escape_like(keyword.strip())}%"
        where_parts.append(f"(name LIKE {PH} ESCAPE '\\' OR subtitle LIKE {PH} ESCAPE '\\' OR id LIKE {PH} ESCAPE '\\')")
        params.extend([kw, kw, kw])
    if tag:
        # tags 存的是 JSON 字符串，简单 LIKE 即可
        where_parts.append(f"tags LIKE {PH}"); params.append(f'%"{tag}"%')

    where_sql = " AND ".join(where_parts)

    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(f"SELECT COUNT(*) AS c FROM services WHERE {where_sql}", tuple(params))
            total = (cur.fetchone() or {}).get("c", 0) or 0

            offset = (page - 1) * page_size
            cur.execute(
                f"SELECT id, name, subtitle, category, image, duration, price, original_price, "
                f"       popularity, tags, effects, suitable_for, description, contact_phone, "
                f"       is_active, sort_order, created_at, updated_at "
                f"FROM services WHERE {where_sql} "
                f"ORDER BY sort_order ASC, id ASC LIMIT {PH} OFFSET {PH}",
                tuple(params) + (page_size, offset),
            )
            rows = [_service_row(dict(r)) for r in cur.fetchall()]
    except Exception:
        logger.exception("查询服务列表失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {
        "code": 0,
        "data": {
            "items": rows, "total": total,
            "page": page, "page_size": page_size,
            "total_pages": max(1, (total + page_size - 1) // page_size),
        },
    }


# -------- 管理员：已存在的分类/标签集合（含内置 + 自定义） --------
@app.get("/api/admin/services/facets")
async def list_service_facets(_: str = Depends(require_admin)):
    """返回数据库中实际出现过的所有分类与标签，便于前端回显自定义项。"""
    categories: List[str] = []
    tags: List[str] = []
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT DISTINCT category FROM services WHERE category IS NOT NULL AND category <> ''")
            categories = [dict(r).get("category") for r in cur.fetchall() if dict(r).get("category")]
            cur.execute("SELECT tags FROM services WHERE tags IS NOT NULL AND tags <> '' AND tags <> '[]'")
            seen = set()
            for r in cur.fetchall():
                raw = dict(r).get("tags") or "[]"
                try:
                    arr = json.loads(raw)
                except Exception:
                    arr = []
                for t in arr:
                    if isinstance(t, str) and t and t not in seen:
                        seen.add(t)
                        tags.append(t)
    except Exception:
        logger.exception("获取分类/标签集合失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "data": {"categories": sorted(categories), "tags": sorted(tags)}}


# -------- 管理员：单条详情 --------
@app.get("/api/admin/services/{service_id}")
async def get_service(
    service_id: str = FPath(..., min_length=2, max_length=40),
    _: str = Depends(require_admin),
):
    if not SERVICE_ID_RE.match(service_id):
        raise HTTPException(status_code=400, detail="无效的 ID")
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                f"SELECT id, name, subtitle, category, image, duration, price, original_price, "
                f"       popularity, tags, effects, suitable_for, description, contact_phone, "
                f"       is_active, sort_order, created_at, updated_at "
                f"FROM services WHERE id = {PH}", (service_id,),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="项目不存在")
    except HTTPException:
        raise
    except Exception:
        logger.exception("获取服务详情失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "data": _service_row(dict(row))}


# -------- 管理员：新增 --------
@app.post("/api/admin/services")
async def create_service(payload: ServiceCreate, request: Request, user: str = Depends(require_perm("service:write"))):
    # original_price >= price
    if payload.original_price and payload.original_price < payload.price:
        raise HTTPException(status_code=400, detail="原价不能低于现价")
    # 自动 upsert 分类/标签到权威表，确保跨端立即可见
    try:
        upsert_category_if_missing(payload.category)
        upsert_tags_if_missing(payload.tags)
    except Exception:
        logger.exception("分类/标签自动入库失败（不阻塞主流程）")
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(f"SELECT id FROM services WHERE id = {PH}", (payload.id,))
            if cur.fetchone():
                raise HTTPException(status_code=409, detail=f"ID 已存在：{payload.id}")
            cur.execute(
                f"INSERT INTO services "
                f"(id, name, subtitle, category, image, duration, price, original_price, "
                f" popularity, tags, effects, suitable_for, description, contact_phone, "
                f" is_active, sort_order) "
                f"VALUES ({PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, "
                f"        {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH})",
                (
                    payload.id, payload.name, payload.subtitle, payload.category, payload.image,
                    payload.duration, payload.price, payload.original_price, payload.popularity,
                    json.dumps(payload.tags, ensure_ascii=False),
                    json.dumps(payload.effects, ensure_ascii=False),
                    payload.suitable_for, payload.description, payload.contact_phone,
                    1 if payload.is_active else 0, payload.sort_order,
                ),
            )
    except HTTPException:
        raise
    except Exception:
        logger.exception("新增服务项目失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    audit_log(
        actor=user, action="create", resource="service",
        resource_id=payload.id,
        summary=f"新增服务: {payload.name}({payload.id})",
        after=payload.model_dump(),
        request=request,
    )
    return {"code": 0, "message": "新增成功", "data": {"id": payload.id}}


# -------- 管理员：更新 --------
@app.put("/api/admin/services/{service_id}")
async def update_service(
    request: Request,
    service_id: str = FPath(..., min_length=2, max_length=40),
    payload: ServiceUpdate = ...,
    user: str = Depends(require_perm("service:write")),
):
    if not SERVICE_ID_RE.match(service_id):
        raise HTTPException(status_code=400, detail="无效的 ID")

    fields: List[str] = []
    values: List[Any] = []
    data = payload.model_dump(exclude_unset=True)
    field_map = {
        "name": "name", "subtitle": "subtitle", "category": "category", "image": "image",
        "duration": "duration", "price": "price", "original_price": "original_price",
        "popularity": "popularity", "suitable_for": "suitable_for",
        "description": "description", "contact_phone": "contact_phone",
        "sort_order": "sort_order",
    }
    for k, col in field_map.items():
        if k in data:
            fields.append(f"{col} = {PH}"); values.append(data[k])
    if "tags" in data and data["tags"] is not None:
        fields.append(f"tags = {PH}"); values.append(json.dumps(data["tags"], ensure_ascii=False))
    if "effects" in data and data["effects"] is not None:
        fields.append(f"effects = {PH}"); values.append(json.dumps(data["effects"], ensure_ascii=False))
    if "is_active" in data and data["is_active"] is not None:
        fields.append(f"is_active = {PH}"); values.append(1 if data["is_active"] else 0)
    if not fields:
        raise HTTPException(status_code=400, detail="没有要更新的字段")

    # 自动 upsert 分类/标签到权威表，确保跨端立即可见
    try:
        if "category" in data and data.get("category"):
            upsert_category_if_missing(data["category"])
        if "tags" in data and isinstance(data.get("tags"), list):
            upsert_tags_if_missing(data["tags"])
    except Exception:
        logger.exception("分类/标签自动入库失败（不阻塞主流程）")

    if PH == "?":
        fields.append("updated_at = datetime('now','localtime')")

    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(f"SELECT id, price FROM services WHERE id = {PH}", (service_id,))
            current = cur.fetchone()
            if not current:
                raise HTTPException(status_code=404, detail="项目不存在")
            current = dict(current)
            # 如果同时改了 price 或 original_price，校验
            new_price = data.get("price", current.get("price", 0))
            new_orig = data.get("original_price")
            if new_orig is not None and new_orig and new_orig < new_price:
                raise HTTPException(status_code=400, detail="原价不能低于现价")

            values.append(service_id)
            cur.execute(
                f"UPDATE services SET {', '.join(fields)} WHERE id = {PH}",
                tuple(values),
            )
    except HTTPException:
        raise
    except Exception:
        logger.exception("更新服务项目失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    audit_log(
        actor=user, action="update", resource="service",
        resource_id=service_id,
        summary=f"编辑服务: {service_id}",
        before={k: current.get(k) for k in data.keys() if k in current} if isinstance(current, dict) else None,
        after=data,
        request=request,
    )
    return {"code": 0, "message": "更新成功", "data": {"id": service_id}}


# -------- 管理员：删除 --------
@app.delete("/api/admin/services/{service_id}")
async def delete_service(
    request: Request,
    service_id: str = FPath(..., min_length=2, max_length=40),
    user: str = Depends(require_perm("service:write")),
):
    if not SERVICE_ID_RE.match(service_id):
        raise HTTPException(status_code=400, detail="无效的 ID")
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(f"SELECT id, name FROM services WHERE id = {PH}", (service_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="项目不存在")
            row = dict(row)
            cur.execute(f"DELETE FROM services WHERE id = {PH}", (service_id,))
    except HTTPException:
        raise
    except Exception:
        logger.exception("删除服务项目失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    audit_log(
        actor=user, action="delete", resource="service",
        resource_id=service_id,
        summary=f"删除服务: {row.get('name','')}({service_id})",
        before=row,
        request=request,
    )
    return {"code": 0, "message": "删除成功"}


# -------- 管理员：图片上传 --------
@app.post("/api/admin/upload/image")
async def upload_image(
    file: UploadFile = File(...),
    _: str = Depends(require_perm("service:write")),
):
    # 校验扩展名（gif 走原样保存；其他统一用 Pillow 重编码）
    filename = (file.filename or "").lower()
    ext = filename.rsplit(".", 1)[-1] if "." in filename else ""
    if ext not in ALLOWED_IMAGE_EXTS:
        raise HTTPException(status_code=400, detail=f"仅支持图片：{', '.join(sorted(ALLOWED_IMAGE_EXTS))}")

    # 读取并校验大小
    content = await file.read()
    if len(content) > MAX_IMAGE_SIZE:
        raise HTTPException(status_code=400, detail=f"图片大小不能超过 {MAX_IMAGE_SIZE // 1024 // 1024}MB")
    if len(content) == 0:
        raise HTTPException(status_code=400, detail="文件内容为空")

    # 一道：魔数校验（防止改后缀名上传 exe）
    magic = content[:12]
    is_image = (
        magic[:3] == b"\xff\xd8\xff"                       # JPEG
        or magic[:8] == b"\x89PNG\r\n\x1a\n"               # PNG
        or magic[:6] in (b"GIF87a", b"GIF89a")             # GIF
        or (magic[:4] == b"RIFF" and magic[8:12] == b"WEBP")  # WebP
    )
    if not is_image:
        raise HTTPException(status_code=400, detail="文件内容非图片")

    # 二道：用 Pillow 重新解码 + 重新编码，剥离 EXIF / 元数据 / 嵌入脚本
    # 防御点：① 拒绝畸形图片（PIL 解码异常）
    #         ② 阻断 EXIF 中的 polyglot payload
    #         ③ 阻断 PNG/WEBP 元数据中的 HTML/JS 注入
    out_bytes: bytes
    save_ext = ext
    try:
        from PIL import Image, ImageFile  # 延迟导入
        ImageFile.LOAD_TRUNCATED_IMAGES = False
        with Image.open(io.BytesIO(content)) as im:
            im.load()  # 真正解码，校验图像合法性
            fmt = (im.format or "").upper()
            # 限制最大像素数（防 decompression bomb，按 Pillow 默认 89478485 即可）
            w, h = im.size
            if w * h > 60_000_000:  # ≈ 60M 像素
                raise HTTPException(status_code=400, detail="图片分辨率过大")

            buf = io.BytesIO()
            if fmt == "GIF":
                # GIF 保留动图：用 Pillow 重新写出，剥离注释扩展块
                im.save(buf, format="GIF", save_all=True, optimize=True)
                save_ext = "gif"
            elif fmt == "PNG" or ext == "png":
                im.save(buf, format="PNG", optimize=True)
                save_ext = "png"
            elif fmt == "WEBP" or ext == "webp":
                im.save(buf, format="WEBP", quality=85, method=4)
                save_ext = "webp"
            else:
                # JPEG 或其他 → 统一转 RGB 后另存 JPEG
                if im.mode not in ("RGB", "L"):
                    im = im.convert("RGB")
                im.save(buf, format="JPEG", quality=85, optimize=True, progressive=True)
                save_ext = "jpg"
            out_bytes = buf.getvalue()
    except HTTPException:
        raise
    except Exception:
        logger.exception("图片解码/重编码失败")
        raise HTTPException(status_code=400, detail="图片格式不合法或已损坏")

    # 二次大小校验（重编码后通常更小，仍兜底防极端情况）
    if len(out_bytes) > MAX_IMAGE_SIZE:
        raise HTTPException(status_code=400, detail=f"图片处理后大小仍超过 {MAX_IMAGE_SIZE // 1024 // 1024}MB")

    # 保存：随机文件名，绝不使用用户原始 filename，防路径穿越
    safe_name = f"{int(time.time() * 1000)}_{secrets.token_hex(4)}.{save_ext}"
    save_path = (UPLOADS_DIR / safe_name).resolve()
    # 路径穿越兜底（理论上随机名已不可能，但加一道保险）
    if UPLOADS_DIR.resolve() not in save_path.parents:
        raise HTTPException(status_code=400, detail="非法路径")
    try:
        save_path.write_bytes(out_bytes)
    except Exception:
        logger.exception("保存上传图片失败")
        raise HTTPException(status_code=500, detail="保存失败")

    url = f"/static/uploads/{safe_name}"
    return {"code": 0, "message": "上传成功", "data": {"url": url, "size": len(out_bytes)}}


# ============== 客户端：创建预约 ==============
@app.post("/api/bookings")
async def create_booking(booking: BookingRequest):
    try:
        booking_time = parse_booking_datetime(booking.datetime)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if booking_time <= datetime.now():
        raise HTTPException(status_code=400, detail="预约时间必须晚于当前时间")

    # 如果前端没传 category，根据 service_type 自动推断
    category = booking.category
    if not category and booking.service_type:
        category = SERVICE_TO_CATEGORY.get(booking.service_type)

    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                f"""
                INSERT INTO bookings (name, phone, datetime, note, service_type, category, source)
                VALUES ({PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH})
                """,
                (
                    booking.name,
                    booking.phone,
                    booking_time.strftime("%Y-%m-%d %H:%M:%S"),
                    booking.note,
                    booking.service_type,
                    category,
                    booking.source or "normal",
                ),
            )
            booking_id = cur.lastrowid
    except HTTPException:
        raise
    except Exception as e:
        # 唯一索引冲突 → 友好提示
        msg = str(e).lower()
        if ("unique" in msg) or ("duplicate" in msg) or ("uk_bookings_phone_dt" in msg):
            raise HTTPException(
                status_code=409,
                detail="您已提交过同一时间的预约，请勿重复提交。如需修改请联系前台。",
            )
        logger.exception("创建预约失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")

    return {
        "code": 0,
        "message": "预约成功！我们会尽快与您联系确认",
        "data": {
            "booking_id": booking_id,
            "name": booking.name,
            "phone": booking.phone,
            "datetime": booking_time.isoformat(),
            "service_type": booking.service_type,
            "category": category,
            "source": booking.source or "normal",
        },
    }


# ============== 客户端：按手机号查询自己的预约 ==============
def _mask_name(name: str) -> str:
    """姓名脱敏：保留首字符，其余打星号。"""
    if not name:
        return ""
    name = str(name)
    if len(name) <= 1:
        return name + "*"
    return name[0] + "*" * (len(name) - 1)


@app.get("/api/bookings/{phone}")
async def get_bookings_by_phone(
    phone: str = FPath(..., description="客户手机号"),
):
    if not PHONE_RE.match(phone):
        raise HTTPException(status_code=400, detail="手机号格式错误")
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                f"""
                SELECT id, name, phone, datetime, note, service_type, category, source,
                       doctor, status, created_at
                FROM bookings WHERE phone = {PH}
                ORDER BY created_at DESC LIMIT 50
                """,
                (phone,),
            )
            rows = [normalize_booking_row(dict(r)) for r in cur.fetchall()]
            # 公开接口：姓名脱敏、备注不外发，降低被手机号枚举撞库时的 PII 暴露面
            for r in rows:
                r["name"] = _mask_name(r.get("name", ""))
                r["note"] = ""
    except Exception:
        logger.exception("按手机号查询失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "message": "查询成功", "data": rows}


# ============== 管理员：按姓名搜索 ==============
@app.get("/api/bookings/search/by-name")
async def get_bookings_by_name(
    name: str = Query(..., min_length=1, max_length=50),
    _: str = Depends(require_admin),
):
    pattern = f"%{escape_like(name.strip())}%"
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                f"""
                SELECT id, name, phone, datetime, note, service_type, category, source,
                       doctor, status, created_at
                FROM bookings WHERE name LIKE {PH} ESCAPE '\\'
                ORDER BY created_at DESC LIMIT 50
                """,
                (pattern,),
            )
            rows = [normalize_booking_row(dict(r)) for r in cur.fetchall()]
    except Exception:
        logger.exception("按姓名查询失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "message": "查询成功", "data": rows}


# ============== 管理员：预约列表（支持多维筛选） ==============
@app.get("/api/admin/bookings")
async def get_all_bookings(
    days: int = Query(7, ge=1, le=3650),
    limit: int = Query(100, ge=1, le=1000),
    category: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    service_type: Optional[str] = Query(None),
    source: Optional[str] = Query(None),
    keyword: Optional[str] = Query(None, max_length=50),
    _: str = Depends(require_admin),
):
    # 校验枚举
    if category and category not in ALLOWED_CATEGORIES and not CUSTOM_CATEGORY_ID_RE.match(category):
        raise HTTPException(status_code=400, detail="无效的分类")
    if status and status not in ALLOWED_STATUSES:
        raise HTTPException(status_code=400, detail="无效的状态")
    if service_type and service_type not in ALLOWED_SERVICES:
        raise HTTPException(status_code=400, detail="无效的服务类型")
    if source and source not in get_allowed_booking_sources():
        raise HTTPException(status_code=400, detail="无效的来源")

    # 动态 WHERE
    where_parts: List[str] = []
    params: List[Any] = []

    if PH == "?":  # sqlite
        where_parts.append(f"datetime(created_at) >= datetime('now', '-' || {PH} || ' days', 'localtime')")
    else:
        where_parts.append(f"created_at >= DATE_SUB(NOW(), INTERVAL {PH} DAY)")
    params.append(days)

    if category:
        where_parts.append(f"category = {PH}"); params.append(category)
    if status:
        where_parts.append(f"status = {PH}"); params.append(status)
    if service_type:
        where_parts.append(f"service_type = {PH}"); params.append(service_type)
    if source:
        where_parts.append(f"source = {PH}"); params.append(source)
    if keyword:
        kw = f"%{escape_like(keyword.strip())}%"
        where_parts.append(f"(name LIKE {PH} ESCAPE '\\' OR phone LIKE {PH} ESCAPE '\\')")
        params.extend([kw, kw])

    sql = f"""
        SELECT id, name, phone, datetime, note, service_type, category, source,
               doctor, status, created_at
        FROM bookings
        WHERE {' AND '.join(where_parts)}
        ORDER BY created_at DESC
        LIMIT {PH}
    """
    params.append(limit)

    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(sql, tuple(params))
            rows = [normalize_booking_row(dict(r)) for r in cur.fetchall()]
    except Exception:
        logger.exception("管理员列表查询失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "message": "查询成功", "data": rows}


# ============== 管理员：更新状态 ==============
@app.put("/api/bookings/{booking_id}/status")
async def update_booking_status(
    booking_id: int, payload: StatusUpdate,
    request: Request,
    user: str = Depends(require_perm("booking:write")),
):
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                f"SELECT id, name, phone, status FROM bookings WHERE id = {PH}",
                (booking_id,),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="预约记录不存在")
            before = dict(row)
            cur.execute(
                f"UPDATE bookings SET status = {PH} WHERE id = {PH}",
                (payload.status, booking_id),
            )
    except HTTPException:
        raise
    except Exception:
        logger.exception("状态更新失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    # 审计
    audit_log(
        actor=user, action="status_update", resource="booking",
        resource_id=booking_id,
        summary=f"预约#{booking_id}({before.get('name','')}) 状态: {before.get('status')} → {payload.status}",
        before={"status": before.get("status")},
        after={"status": payload.status},
        request=request,
    )
    return {"code": 0, "message": "状态更新成功",
            "data": {"booking_id": booking_id, "status": payload.status}}


# ============== 管理员：更新备注 ==============
@app.put("/api/bookings/{booking_id}/note")
async def update_booking_note(
    booking_id: int, payload: NoteUpdate,
    request: Request,
    user: str = Depends(require_perm("booking:write")),
):
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                f"SELECT id, name, note FROM bookings WHERE id = {PH}",
                (booking_id,),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="预约记录不存在")
            before = dict(row)
            cur.execute(
                f"UPDATE bookings SET note = {PH} WHERE id = {PH}",
                (payload.note, booking_id),
            )
    except HTTPException:
        raise
    except Exception:
        logger.exception("备注更新失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    audit_log(
        actor=user, action="note_update", resource="booking",
        resource_id=booking_id,
        summary=f"预约#{booking_id}({before.get('name','')}) 备注更新",
        before={"note": before.get("note")},
        after={"note": payload.note},
        request=request,
    )
    return {"code": 0, "message": "备注更新成功",
            "data": {"booking_id": booking_id, "note": payload.note}}


# ============== 管理员：综合更新 ==============
@app.put("/api/bookings/{booking_id}")
async def update_booking(
    booking_id: int, payload: BookingUpdate,
    request: Request,
    user: str = Depends(require_perm("booking:write")),
):
    dt_value: Optional[str] = None
    if payload.datetime:
        try:
            dt = parse_booking_datetime(payload.datetime)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        if dt <= datetime.now():
            raise HTTPException(status_code=400, detail="预约时间必须晚于当前时间")
        dt_value = dt.strftime("%Y-%m-%d %H:%M:%S")

    # 若改了 service_type 但没改 category，自动推导
    new_category = payload.category
    if payload.service_type and not new_category:
        new_category = SERVICE_TO_CATEGORY.get(payload.service_type)

    fields: List[str] = []
    values: List[Any] = []
    if dt_value is not None:
        fields.append(f"datetime = {PH}"); values.append(dt_value)
    if payload.doctor is not None:
        fields.append(f"doctor = {PH}"); values.append(payload.doctor)
    if payload.note is not None:
        fields.append(f"note = {PH}"); values.append(payload.note)
    if payload.status is not None:
        fields.append(f"status = {PH}"); values.append(payload.status)
    if payload.service_type is not None:
        fields.append(f"service_type = {PH}"); values.append(payload.service_type)
    if new_category is not None:
        fields.append(f"category = {PH}"); values.append(new_category)
    if payload.source is not None:
        fields.append(f"source = {PH}"); values.append(payload.source)
    if not fields:
        raise HTTPException(status_code=400, detail="没有要更新的字段")

    before: Dict[str, Any] = {}
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                f"""SELECT id, name, phone, datetime, doctor, note, status,
                           service_type, category, source
                    FROM bookings WHERE id = {PH}""",
                (booking_id,),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="预约记录不存在")
            before = dict(row)
            values.append(booking_id)
            cur.execute(
                f"UPDATE bookings SET {', '.join(fields)} WHERE id = {PH}",
                tuple(values),
            )
    except HTTPException:
        raise
    except Exception:
        logger.exception("预约更新失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")

    after = {
        "datetime": dt_value if dt_value is not None else before.get("datetime"),
        "doctor": payload.doctor if payload.doctor is not None else before.get("doctor"),
        "note": payload.note if payload.note is not None else before.get("note"),
        "status": payload.status if payload.status is not None else before.get("status"),
        "service_type": payload.service_type if payload.service_type is not None else before.get("service_type"),
        "category": new_category if new_category is not None else before.get("category"),
        "source": payload.source if payload.source is not None else before.get("source"),
    }
    audit_log(
        actor=user, action="update", resource="booking",
        resource_id=booking_id,
        summary=f"编辑预约#{booking_id}({before.get('name','')})",
        before={k: before.get(k) for k in after.keys()},
        after=after,
        request=request,
    )

    return {
        "code": 0,
        "message": "预约信息更新成功",
        "data": {
            "booking_id": booking_id,
            "datetime": dt_value,
            "doctor": payload.doctor,
            "note": payload.note,
            "status": payload.status,
            "service_type": payload.service_type,
            "category": new_category,
            "source": payload.source,
        },
    }


# ============== 客户端：埋点 ==============
@app.post("/api/analytics")
async def track_event(event: AnalyticsEvent, request: Request):
    try:
        user_agent = (request.headers.get("user-agent") or "")[:500]
        client_host = (request.client.host if request.client else "")[:64]
        event_data_json = (
            json.dumps(event.event_data, ensure_ascii=False)[:4000]
            if event.event_data is not None else None
        )
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                f"""
                INSERT INTO analytics
                    (event_type, event_data, user_agent, ip_address,
                     page_url, referrer, session_id)
                VALUES ({PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH})
                """,
                (
                    event.event_type, event_data_json, user_agent, client_host,
                    event.page_url, event.referrer, event.session_id,
                ),
            )
    except Exception:
        logger.exception("埋点写入失败")
    return {"code": 0, "message": "事件记录成功"}


# ============== 管理员：综合统计 ==============
@app.get("/api/analytics/stats")
async def get_analytics_stats(
    days: int = Query(7, ge=1, le=3650),
    _: str = Depends(require_admin),
):
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            if PH == "?":
                where_time = f"datetime(created_at) >= datetime('now', '-' || {PH} || ' days', 'localtime')"
                date_func = "date(created_at)"
                json_service = "json_extract(event_data, '$.service')"
            else:
                where_time = f"created_at >= DATE_SUB(NOW(), INTERVAL {PH} DAY)"
                date_func = "DATE(created_at)"
                json_service = "JSON_UNQUOTE(JSON_EXTRACT(event_data, '$.service'))"

            cur.execute(
                f"SELECT COUNT(*) AS total_visits FROM analytics "
                f"WHERE event_type='page_view' AND {where_time}",
                (days,),
            )
            total_visits = (cur.fetchone() or {}).get("total_visits", 0) or 0

            cur.execute(
                f"SELECT COUNT(DISTINCT session_id) AS unique_visitors FROM analytics "
                f"WHERE event_type='page_view' AND {where_time}",
                (days,),
            )
            unique_visitors = (cur.fetchone() or {}).get("unique_visitors", 0) or 0

            cur.execute(
                f"SELECT COUNT(*) AS total_bookings FROM bookings WHERE {where_time}",
                (days,),
            )
            total_bookings = (cur.fetchone() or {}).get("total_bookings", 0) or 0

            # 热门服务（基于埋点 service_view）
            cur.execute(
                f"""
                SELECT {json_service} AS service, COUNT(*) AS count
                FROM analytics
                WHERE event_type='service_view' AND {where_time}
                  AND event_data IS NOT NULL
                GROUP BY service
                ORDER BY count DESC LIMIT 8
                """,
                (days,),
            )
            popular_services = [dict(r) for r in cur.fetchall()]

            # 实际预约：按 service_type 分组（真实业务热度）
            cur.execute(
                f"""
                SELECT service_type AS service, COUNT(*) AS count
                FROM bookings
                WHERE {where_time} AND service_type IS NOT NULL AND service_type <> ''
                GROUP BY service_type
                ORDER BY count DESC LIMIT 8
                """,
                (days,),
            )
            booking_by_service = [dict(r) for r in cur.fetchall()]

            # 实际预约：按 category 分组
            cur.execute(
                f"""
                SELECT category, COUNT(*) AS count
                FROM bookings
                WHERE {where_time} AND category IS NOT NULL AND category <> ''
                GROUP BY category
                """,
                (days,),
            )
            booking_by_category = [dict(r) for r in cur.fetchall()]

            # 实际预约：按 source 分组（哪个营销渠道有效）
            cur.execute(
                f"""
                SELECT source, COUNT(*) AS count
                FROM bookings
                WHERE {where_time}
                GROUP BY source
                """,
                (days,),
            )
            booking_by_source = [dict(r) for r in cur.fetchall()]

            # 实际预约：按 status 分组
            cur.execute(
                f"""
                SELECT status, COUNT(*) AS count
                FROM bookings
                WHERE {where_time}
                GROUP BY status
                """,
                (days,),
            )
            booking_by_status = [dict(r) for r in cur.fetchall()]

            cur.execute(
                f"""
                SELECT {date_func} AS date, COUNT(*) AS visits
                FROM analytics
                WHERE event_type='page_view' AND {where_time}
                GROUP BY {date_func}
                ORDER BY date
                """,
                (days,),
            )
            daily_visits = []
            for r in cur.fetchall():
                item = dict(r)
                if item.get("date") and not isinstance(item["date"], str):
                    item["date"] = str(item["date"])
                daily_visits.append(item)

            # ===== 收藏统计 =====
            if PH == "?":
                json_service_id = "json_extract(event_data, '$.service_id')"
                json_service_name = "json_extract(event_data, '$.service')"
            else:
                json_service_id = "JSON_UNQUOTE(JSON_EXTRACT(event_data, '$.service_id'))"
                json_service_name = "JSON_UNQUOTE(JSON_EXTRACT(event_data, '$.service'))"

            # 收藏新增 / 取消总数
            cur.execute(
                f"SELECT COUNT(*) AS c FROM analytics "
                f"WHERE event_type='favorite_add' AND {where_time}",
                (days,),
            )
            fav_add_total = (cur.fetchone() or {}).get("c", 0) or 0

            cur.execute(
                f"SELECT COUNT(*) AS c FROM analytics "
                f"WHERE event_type='favorite_remove' AND {where_time}",
                (days,),
            )
            fav_remove_total = (cur.fetchone() or {}).get("c", 0) or 0

            # 净收藏数 = add - remove（不小于 0）
            total_favorites = max(0, fav_add_total - fav_remove_total)

            # 收藏独立用户数（去重 session_id）
            cur.execute(
                f"SELECT COUNT(DISTINCT session_id) AS c FROM analytics "
                f"WHERE event_type='favorite_add' AND {where_time}",
                (days,),
            )
            unique_favorite_users = (cur.fetchone() or {}).get("c", 0) or 0

            # 项目收藏热度 TOP（按 service_id 净值聚合：add - remove）
            cur.execute(
                f"""
                SELECT
                    {json_service_id}   AS service_id,
                    {json_service_name} AS service,
                    SUM(CASE WHEN event_type='favorite_add' THEN 1 ELSE 0 END) AS add_count,
                    SUM(CASE WHEN event_type='favorite_remove' THEN 1 ELSE 0 END) AS remove_count
                FROM analytics
                WHERE event_type IN ('favorite_add','favorite_remove')
                  AND {where_time}
                  AND event_data IS NOT NULL
                GROUP BY {json_service_id}, {json_service_name}
                """,
                (days,),
            )
            popular_favorites: List[Dict[str, Any]] = []
            for r in cur.fetchall():
                row = dict(r)
                add_c = int(row.get("add_count") or 0)
                rm_c = int(row.get("remove_count") or 0)
                net = max(0, add_c - rm_c)
                if net <= 0:
                    continue
                popular_favorites.append({
                    "service_id": row.get("service_id"),
                    "service": row.get("service") or row.get("service_id") or "未知",
                    "count": net,
                    "add_count": add_c,
                    "remove_count": rm_c,
                })
            popular_favorites.sort(key=lambda x: x["count"], reverse=True)
            popular_favorites = popular_favorites[:10]

            # 收藏每日趋势（add 的新增数）
            cur.execute(
                f"""
                SELECT {date_func} AS date, COUNT(*) AS count
                FROM analytics
                WHERE event_type='favorite_add' AND {where_time}
                GROUP BY {date_func}
                ORDER BY date
                """,
                (days,),
            )
            daily_favorites: List[Dict[str, Any]] = []
            for r in cur.fetchall():
                item = dict(r)
                if item.get("date") and not isinstance(item["date"], str):
                    item["date"] = str(item["date"])
                daily_favorites.append(item)
    except Exception:
        logger.exception("统计查询失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")

    conversion_rate = (total_bookings / total_visits * 100) if total_visits else 0
    return {
        "code": 0,
        "message": "查询成功",
        "data": {
            "total_visits": total_visits,
            "unique_visitors": unique_visitors,
            "total_bookings": total_bookings,
            "conversion_rate": round(conversion_rate, 2),
            "total_favorites": total_favorites,
            "favorite_add_total": fav_add_total,
            "favorite_remove_total": fav_remove_total,
            "unique_favorite_users": unique_favorite_users,
            "popular_services": popular_services,
            "popular_favorites": popular_favorites,
            "booking_by_service": booking_by_service,
            "booking_by_category": booking_by_category,
            "booking_by_source": booking_by_source,
            "booking_by_status": booking_by_status,
            "daily_visits": daily_visits,
            "daily_favorites": daily_favorites,
        },
    }


# ============================================================
# 优惠活动管理（CRUD）
# ============================================================
def _ensure_offers_or_500():
    """每次请求前确保表已存在；老库容错"""
    try:
        ensure_offers_table_and_seed()
    except Exception:
        logger.exception("offers 表自愈失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")


# -------- 公开：客户端拉取已上架优惠活动 --------
@app.get("/api/offers")
async def public_offers():
    _ensure_offers_or_500()
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT id, offer_key, name, icon, theme, price, original_price, price_suffix, "
                "       features, btn_text, source, is_active, sort_order, updated_at "
                "FROM offers WHERE is_active = 1 "
                "ORDER BY sort_order ASC, id ASC"
            )
            rows = [_offer_row(dict(r)) for r in cur.fetchall()]
    except HTTPException:
        raise
    except Exception:
        logger.exception("获取优惠活动列表失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "data": rows}


# -------- 管理员：列表 --------
@app.get("/api/admin/offers")
async def admin_list_offers(_: str = Depends(require_admin)):
    _ensure_offers_or_500()
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT id, offer_key, name, icon, theme, price, original_price, price_suffix, "
                "       features, btn_text, source, is_active, sort_order, created_at, updated_at "
                "FROM offers ORDER BY sort_order ASC, id ASC"
            )
            rows = [_offer_row(dict(r)) for r in cur.fetchall()]
    except HTTPException:
        raise
    except Exception:
        logger.exception("查询优惠活动失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "data": rows}


# -------- 管理员：单条详情 --------
@app.get("/api/admin/offers/{offer_id}")
async def admin_get_offer(
    offer_id: int = FPath(..., ge=1),
    _: str = Depends(require_admin),
):
    _ensure_offers_or_500()
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                f"SELECT id, offer_key, name, icon, theme, price, original_price, price_suffix, "
                f"       features, btn_text, source, is_active, sort_order, created_at, updated_at "
                f"FROM offers WHERE id = {PH}", (offer_id,),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="优惠活动不存在")
    except HTTPException:
        raise
    except Exception:
        logger.exception("获取优惠活动详情失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "data": _offer_row(dict(row))}


# -------- 管理员：新增 --------
@app.post("/api/admin/offers")
async def admin_create_offer(payload: OfferCreate, _: str = Depends(require_perm("offer:write"))):
    _ensure_offers_or_500()
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(f"SELECT id FROM offers WHERE offer_key = {PH}", (payload.offer_key,))
            if cur.fetchone():
                raise HTTPException(status_code=409, detail=f"offer_key 已存在：{payload.offer_key}")
            cur.execute(
                f"INSERT INTO offers "
                f"(offer_key, name, icon, theme, price, original_price, price_suffix, "
                f" features, btn_text, source, is_active, sort_order) "
                f"VALUES ({PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH})",
                (
                    payload.offer_key, payload.name.strip(), payload.icon.strip() or "fa-gift",
                    payload.theme, payload.price.strip(), payload.original_price.strip(),
                    payload.price_suffix.strip(),
                    json.dumps(payload.features, ensure_ascii=False),
                    payload.btn_text.strip() or "立即预约",
                    payload.source, 1 if payload.is_active else 0, payload.sort_order,
                ),
            )
            new_id = cur.lastrowid
    except HTTPException:
        raise
    except Exception:
        logger.exception("新增优惠活动失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "message": "新增成功", "data": {"id": new_id, "offer_key": payload.offer_key}}


# -------- 管理员：更新 --------
@app.put("/api/admin/offers/{offer_id}")
async def admin_update_offer(
    offer_id: int = FPath(..., ge=1),
    payload: OfferUpdate = ...,
    _: str = Depends(require_perm("offer:write")),
):
    _ensure_offers_or_500()
    data = payload.model_dump(exclude_unset=True)
    fields: List[str] = []
    values: List[Any] = []
    field_map = {
        "name": "name", "icon": "icon", "theme": "theme",
        "price": "price", "original_price": "original_price", "price_suffix": "price_suffix",
        "btn_text": "btn_text", "source": "source", "sort_order": "sort_order",
    }
    for k, col in field_map.items():
        if k in data:
            v = data[k]
            if isinstance(v, str):
                v = v.strip()
            fields.append(f"{col} = {PH}")
            values.append(v)
    if "features" in data and data["features"] is not None:
        fields.append(f"features = {PH}")
        values.append(json.dumps(data["features"], ensure_ascii=False))
    if "is_active" in data and data["is_active"] is not None:
        fields.append(f"is_active = {PH}")
        values.append(1 if data["is_active"] else 0)
    if not fields:
        raise HTTPException(status_code=400, detail="没有要更新的字段")

    if PH == "?":
        fields.append("updated_at = datetime('now','localtime')")

    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(f"SELECT id FROM offers WHERE id = {PH}", (offer_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="优惠活动不存在")
            values.append(offer_id)
            cur.execute(
                f"UPDATE offers SET {', '.join(fields)} WHERE id = {PH}",
                tuple(values),
            )
    except HTTPException:
        raise
    except Exception:
        logger.exception("更新优惠活动失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "message": "更新成功", "data": {"id": offer_id}}


# -------- 管理员：删除 --------
@app.delete("/api/admin/offers/{offer_id}")
async def admin_delete_offer(
    offer_id: int = FPath(..., ge=1),
    _: str = Depends(require_perm("offer:write")),
):
    _ensure_offers_or_500()
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(f"SELECT id FROM offers WHERE id = {PH}", (offer_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="优惠活动不存在")
            cur.execute(f"DELETE FROM offers WHERE id = {PH}", (offer_id,))
    except HTTPException:
        raise
    except Exception:
        logger.exception("删除优惠活动失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "message": "删除成功"}


# ============== 健康检查 ==============
@app.get("/api/health")
async def health_check():
    try:
        with get_db_connection() as conn:
            conn.cursor().execute("SELECT 1")
        return {"status": "healthy", "database": "connected"}
    except Exception:
        logger.exception("健康检查失败")
        return JSONResponse(
            status_code=503,
            content={"status": "unhealthy", "database": "disconnected"},
        )


# ============================================================
# 环境展示模块（图片 + 文案 同步管理）
# ============================================================
ALLOWED_ENV_SIZES = {"small", "medium", "large", "tall", "wide"}


class EnvironmentItemCreate(BaseModel):
    image: str = Field(..., min_length=1, max_length=500)
    title: str = Field("", max_length=80)
    description: str = Field("", max_length=300)
    alt: str = Field("", max_length=200)
    size: str = Field("medium", max_length=20)
    is_active: bool = True
    sort_order: int = Field(100, ge=0, le=9999)
    duration_ms: int = Field(0, ge=0, le=60000)  # 0 表示用全局；1~60000ms

    @field_validator("size")
    @classmethod
    def check_size(cls, v: str) -> str:
        v = (v or "medium").strip().lower()
        if v not in ALLOWED_ENV_SIZES:
            raise ValueError(f"size 必须是 {sorted(ALLOWED_ENV_SIZES)} 之一")
        return v


class EnvironmentItemUpdate(BaseModel):
    image: Optional[str] = Field(None, min_length=1, max_length=500)
    title: Optional[str] = Field(None, max_length=80)
    description: Optional[str] = Field(None, max_length=300)
    alt: Optional[str] = Field(None, max_length=200)
    size: Optional[str] = Field(None, max_length=20)
    is_active: Optional[bool] = None
    sort_order: Optional[int] = Field(None, ge=0, le=9999)
    duration_ms: Optional[int] = Field(None, ge=0, le=60000)

    @field_validator("size")
    @classmethod
    def check_size(cls, v: Optional[str]) -> Optional[str]:
        if v in (None, ""):
            return None
        v = v.strip().lower()
        if v not in ALLOWED_ENV_SIZES:
            raise ValueError(f"size 必须是 {sorted(ALLOWED_ENV_SIZES)} 之一")
        return v


def _env_row(row: Dict[str, Any]) -> Dict[str, Any]:
    row["is_active"] = bool(row.get("is_active"))
    # duration_ms：兜底为 0（表示用全局），并强转 int
    try:
        row["duration_ms"] = int(row.get("duration_ms") or 0)
    except Exception:
        row["duration_ms"] = 0
    for k in ("created_at", "updated_at"):
        if row.get(k) and not isinstance(row[k], str):
            row[k] = str(row[k])
    return row


# 全局轮播停留时间（settings 中的 env_autoplay_ms，单位 ms），兜底默认值
DEFAULT_ENV_AUTOPLAY_MS = 4500
# 合法范围：500ms ~ 60000ms（半秒到 1 分钟）
ENV_AUTOPLAY_MIN_MS = 500
ENV_AUTOPLAY_MAX_MS = 60000


def _env_meta_settings() -> Dict[str, Any]:
    """读取 settings 表中 env_eyebrow / env_title / env_subtitle / env_autoplay_ms。"""
    keys = ("env_eyebrow", "env_title", "env_subtitle", "env_autoplay_ms")
    out: Dict[str, Any] = {k: "" for k in keys}
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            kc = _key_col()
            placeholders = ",".join([PH] * len(keys))
            cur.execute(
                f"SELECT {kc} AS key, value FROM settings WHERE {kc} IN ({placeholders})",
                tuple(keys),
            )
            for r in cur.fetchall():
                d = dict(r)
                k = d.get("key")
                if k in out:
                    out[k] = d.get("value") or ""
    except Exception:
        logger.exception("读取环境模块文案失败（已使用兜底）")
    # 兜底默认值（在 settings 缺失时仍能正常显示）
    if not out["env_eyebrow"]:
        out["env_eyebrow"] = "ENVIRONMENT"
    if not out["env_title"]:
        out["env_title"] = "静谧雅致 · 沉浸空间"
    if not out["env_subtitle"]:
        out["env_subtitle"] = "每一处细节都为您的身心松弛而设计"
    # autoplay_ms：转 int 并 clamp 到合法区间
    try:
        ms = int(out.get("env_autoplay_ms") or DEFAULT_ENV_AUTOPLAY_MS)
    except Exception:
        ms = DEFAULT_ENV_AUTOPLAY_MS
    out["env_autoplay_ms"] = max(ENV_AUTOPLAY_MIN_MS, min(ENV_AUTOPLAY_MAX_MS, ms))
    return out


# -------- 公开：客户端拉取上架的环境图片 + 文案 --------
@app.get("/api/environments")
async def public_environments():
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT id, image, title, description, alt, size, is_active, sort_order, duration_ms "
                "FROM environment_items WHERE is_active = 1 "
                "ORDER BY sort_order ASC, id ASC"
            )
            items = [_env_row(dict(r)) for r in cur.fetchall()]
    except Exception:
        logger.exception("获取环境列表失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "data": {"items": items, "meta": _env_meta_settings()}}


# -------- 管理员：环境列表 --------
@app.get("/api/admin/environments")
async def admin_list_environments(_: str = Depends(require_admin)):
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT id, image, title, description, alt, size, is_active, sort_order, duration_ms, "
                "       created_at, updated_at "
                "FROM environment_items "
                "ORDER BY sort_order ASC, id ASC"
            )
            items = [_env_row(dict(r)) for r in cur.fetchall()]
    except Exception:
        logger.exception("查询环境列表失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "data": {"items": items, "meta": _env_meta_settings()}}


# -------- 管理员：新增 --------
@app.post("/api/admin/environments")
async def admin_create_environment(
    payload: EnvironmentItemCreate,
    _: str = Depends(require_perm("environment:write")),
):
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                f"INSERT INTO environment_items "
                f"(image, title, description, alt, size, is_active, sort_order, duration_ms) "
                f"VALUES ({PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH})",
                (
                    payload.image.strip(), payload.title.strip(),
                    payload.description.strip(), payload.alt.strip(),
                    payload.size, 1 if payload.is_active else 0,
                    payload.sort_order,
                    int(payload.duration_ms or 0),
                ),
            )
            new_id = cur.lastrowid
    except Exception:
        logger.exception("新增环境图片失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "message": "新增成功", "data": {"id": new_id}}


# -------- 管理员：批量更新文案（标题/副标题/小字） --------
# 注意：此路由必须声明在 PUT /api/admin/environments/{env_id} 之前，
# 否则 FastAPI 会优先匹配 {env_id} 动态段，导致 "meta/text" 被解析失败 → 404。
class EnvironmentMetaUpdate(BaseModel):
    eyebrow: Optional[str] = Field(None, max_length=60)
    title: Optional[str] = Field(None, max_length=80)
    subtitle: Optional[str] = Field(None, max_length=200)


@app.put("/api/admin/environments/meta/text")
async def admin_update_environment_meta(
    payload: EnvironmentMetaUpdate,
    _: str = Depends(require_perm("environment:write")),
):
    """更新环境模块顶部文案（写入 settings 表 env_eyebrow / env_title / env_subtitle）。"""
    mapping = {
        "eyebrow": "env_eyebrow",
        "title": "env_title",
        "subtitle": "env_subtitle",
    }
    data = payload.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(status_code=400, detail="没有要更新的字段")

    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            kc = _key_col()
            for k, col_key in mapping.items():
                if k not in data or data[k] is None:
                    continue
                value = (data[k] or "").strip()
                cur.execute(f"SELECT {kc} AS key FROM settings WHERE {kc} = {PH}", (col_key,))
                if cur.fetchone():
                    if PH == "?":
                        cur.execute(
                            f"UPDATE settings SET value = {PH}, "
                            f"updated_at = datetime('now','localtime') WHERE {kc} = {PH}",
                            (value, col_key),
                        )
                    else:
                        cur.execute(
                            f"UPDATE settings SET value = {PH} WHERE {kc} = {PH}",
                            (value, col_key),
                        )
                else:
                    label_map = {
                        "env_eyebrow":  "环境-小标题（英文）",
                        "env_title":    "环境-主标题",
                        "env_subtitle": "环境-副标题",
                    }
                    sort_map = {"env_eyebrow": 110, "env_title": 120, "env_subtitle": 130}
                    cur.execute(
                        f"INSERT INTO settings ({kc}, value, label, type, icon, builtin, sort_order) "
                        f"VALUES ({PH}, {PH}, {PH}, {PH}, {PH}, 1, {PH})",
                        (col_key, value, label_map[col_key], "text",
                         "fa-feather", sort_map[col_key]),
                    )
    except Exception:
        logger.exception("更新环境文案失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "message": "更新成功", "data": _env_meta_settings()}


# -------- 管理员：设置全局轮播停留时间 --------
# 注意：此路由必须在 PUT /api/admin/environments/{env_id} 之前声明
class EnvironmentAutoplayUpdate(BaseModel):
    autoplay_ms: int = Field(..., ge=ENV_AUTOPLAY_MIN_MS, le=ENV_AUTOPLAY_MAX_MS)


@app.put("/api/admin/environments/meta/autoplay")
async def admin_update_environment_autoplay(
    payload: EnvironmentAutoplayUpdate,
    _: str = Depends(require_perm("environment:write")),
):
    """设置环境轮播全局默认停留时间（写入 settings 表 env_autoplay_ms）。"""
    value = str(int(payload.autoplay_ms))
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            kc = _key_col()
            cur.execute(
                f"SELECT {kc} AS key FROM settings WHERE {kc} = {PH}",
                ("env_autoplay_ms",),
            )
            if cur.fetchone():
                if PH == "?":
                    cur.execute(
                        f"UPDATE settings SET value = {PH}, "
                        f"updated_at = datetime('now','localtime') WHERE {kc} = {PH}",
                        (value, "env_autoplay_ms"),
                    )
                else:
                    cur.execute(
                        f"UPDATE settings SET value = {PH} WHERE {kc} = {PH}",
                        (value, "env_autoplay_ms"),
                    )
            else:
                cur.execute(
                    f"INSERT INTO settings ({kc}, value, label, type, icon, builtin, sort_order) "
                    f"VALUES ({PH}, {PH}, {PH}, {PH}, {PH}, 1, {PH})",
                    ("env_autoplay_ms", value, "环境-默认轮播停留时间(ms)",
                     "text", "far fa-clock", 140),
                )
    except Exception:
        logger.exception("更新环境全局停留时间失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "message": "更新成功", "data": {"autoplay_ms": int(value)}}


# -------- 管理员：批量设置图片停留时间 --------
class EnvironmentBatchDuration(BaseModel):
    duration_ms: int = Field(..., ge=0, le=60000)  # 0 表示恢复为"用全局"
    ids: Optional[List[int]] = None  # 不传或空 → 应用到所有图片


@app.put("/api/admin/environments/batch/duration")
async def admin_batch_update_environment_duration(
    payload: EnvironmentBatchDuration,
    _: str = Depends(require_perm("environment:write")),
):
    """批量设置图片停留时间。
    - duration_ms = 0：表示该图片使用全局默认值（清除独立设置）
    - duration_ms > 0：该图片使用指定的独立停留时间（必须 ≥ 500ms）
    - ids 为空：应用到所有图片；非空：仅应用到指定 ID
    """
    ms = int(payload.duration_ms)
    # 0 是合法的（=用全局）；>0 时必须 ≥ 500ms 防止过快切换
    if 0 < ms < ENV_AUTOPLAY_MIN_MS:
        raise HTTPException(
            status_code=400,
            detail=f"独立停留时间必须 ≥ {ENV_AUTOPLAY_MIN_MS}ms 或为 0（用全局）",
        )
    ids = payload.ids or []
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            if ids:
                # 仅对指定 ID 列表更新
                placeholders = ",".join([PH] * len(ids))
                if PH == "?":
                    cur.execute(
                        f"UPDATE environment_items SET duration_ms = {PH}, "
                        f"updated_at = datetime('now','localtime') "
                        f"WHERE id IN ({placeholders})",
                        (ms, *ids),
                    )
                else:
                    cur.execute(
                        f"UPDATE environment_items SET duration_ms = {PH} "
                        f"WHERE id IN ({placeholders})",
                        (ms, *ids),
                    )
            else:
                # 应用到所有
                if PH == "?":
                    cur.execute(
                        f"UPDATE environment_items SET duration_ms = {PH}, "
                        f"updated_at = datetime('now','localtime')",
                        (ms,),
                    )
                else:
                    cur.execute(
                        f"UPDATE environment_items SET duration_ms = {PH}",
                        (ms,),
                    )
            affected = cur.rowcount or 0
    except Exception:
        logger.exception("批量更新环境图片停留时间失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {
        "code": 0,
        "message": "更新成功",
        "data": {"affected": affected, "duration_ms": ms},
    }


# -------- 管理员：更新 --------
@app.put("/api/admin/environments/{env_id}")
async def admin_update_environment(
    env_id: int = FPath(..., ge=1),
    payload: EnvironmentItemUpdate = ...,
    _: str = Depends(require_perm("environment:write")),
):
    fields: List[str] = []
    values: List[Any] = []
    data = payload.model_dump(exclude_unset=True)
    field_map = {
        "image": "image", "title": "title", "description": "description",
        "alt": "alt", "size": "size", "sort_order": "sort_order",
        "duration_ms": "duration_ms",
    }
    for k, col in field_map.items():
        if k in data and data[k] is not None:
            v = data[k]
            if isinstance(v, str):
                v = v.strip()
            fields.append(f"{col} = {PH}"); values.append(v)
    if "is_active" in data and data["is_active"] is not None:
        fields.append(f"is_active = {PH}"); values.append(1 if data["is_active"] else 0)
    if not fields:
        raise HTTPException(status_code=400, detail="没有要更新的字段")

    if PH == "?":
        fields.append("updated_at = datetime('now','localtime')")

    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(f"SELECT id FROM environment_items WHERE id = {PH}", (env_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="记录不存在")
            values.append(env_id)
            cur.execute(
                f"UPDATE environment_items SET {', '.join(fields)} WHERE id = {PH}",
                tuple(values),
            )
    except HTTPException:
        raise
    except Exception:
        logger.exception("更新环境图片失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "message": "更新成功", "data": {"id": env_id}}


# -------- 管理员：删除 --------
@app.delete("/api/admin/environments/{env_id}")
async def admin_delete_environment(
    env_id: int = FPath(..., ge=1),
    _: str = Depends(require_perm("environment:write")),
):
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(f"SELECT id FROM environment_items WHERE id = {PH}", (env_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="记录不存在")
            cur.execute(f"DELETE FROM environment_items WHERE id = {PH}", (env_id,))
    except HTTPException:
        raise
    except Exception:
        logger.exception("删除环境图片失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "message": "删除成功"}


# ============================================================
# 医生管理（CRUD）
# ============================================================
DOCTOR_NAME_RE = re.compile(r"^[\u4e00-\u9fa5A-Za-z0-9·\-_\s]{1,30}$")


class DoctorCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=30)
    title: str = Field("", max_length=80)
    avatar: str = Field("", max_length=500)
    bio: str = Field("", max_length=500)
    is_active: bool = True
    sort_order: int = Field(100, ge=0, le=9999)

    @field_validator("name")
    @classmethod
    def check_name(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("姓名不能为空")
        if not DOCTOR_NAME_RE.match(v):
            raise ValueError("姓名只能包含中英文/数字/·-_/空格，1-30 位")
        return v


class DoctorUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=30)
    title: Optional[str] = Field(None, max_length=80)
    avatar: Optional[str] = Field(None, max_length=500)
    bio: Optional[str] = Field(None, max_length=500)
    is_active: Optional[bool] = None
    sort_order: Optional[int] = Field(None, ge=0, le=9999)

    @field_validator("name")
    @classmethod
    def check_name(cls, v: Optional[str]) -> Optional[str]:
        if v in (None, ""):
            return None
        v = v.strip()
        if not DOCTOR_NAME_RE.match(v):
            raise ValueError("姓名只能包含中英文/数字/·-_/空格，1-30 位")
        return v


# -------- 公开：客户端可拉取已上架医生（用于服务详情/团队介绍展示） --------
@app.get("/api/doctors")
async def public_doctors():
    try:
        items = fetch_doctors(active_only=True)
    except Exception:
        logger.exception("获取医生列表失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "data": items}


# -------- 管理员：列表 --------
@app.get("/api/admin/doctors")
async def admin_list_doctors(_: str = Depends(require_admin)):
    try:
        items = fetch_doctors(active_only=False)
    except Exception:
        logger.exception("查询医生列表失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "data": items}


# -------- 管理员：新增 --------
@app.post("/api/admin/doctors")
async def admin_create_doctor(payload: DoctorCreate, _: str = Depends(require_perm("doctor:write"))):
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(f"SELECT id FROM doctors WHERE name = {PH}", (payload.name,))
            if cur.fetchone():
                raise HTTPException(status_code=409, detail=f"医生姓名已存在：{payload.name}")
            cur.execute(
                f"INSERT INTO doctors (name, title, avatar, bio, is_active, sort_order) "
                f"VALUES ({PH}, {PH}, {PH}, {PH}, {PH}, {PH})",
                (
                    payload.name, payload.title.strip(), payload.avatar.strip(),
                    payload.bio.strip(), 1 if payload.is_active else 0,
                    payload.sort_order,
                ),
            )
            new_id = cur.lastrowid
    except HTTPException:
        raise
    except Exception:
        logger.exception("新增医生失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "message": "新增成功", "data": {"id": new_id, "name": payload.name}}


# -------- 管理员：更新 --------
@app.put("/api/admin/doctors/{doctor_id}")
async def admin_update_doctor(
    doctor_id: int = FPath(..., ge=1),
    payload: DoctorUpdate = ...,
    _: str = Depends(require_perm("doctor:write")),
):
    fields: List[str] = []
    values: List[Any] = []
    data = payload.model_dump(exclude_unset=True)
    field_map = {
        "name": "name", "title": "title", "avatar": "avatar",
        "bio": "bio", "sort_order": "sort_order",
    }
    for k, col in field_map.items():
        if k in data and data[k] is not None:
            v = data[k]
            if isinstance(v, str):
                v = v.strip()
            fields.append(f"{col} = {PH}"); values.append(v)
    if "is_active" in data and data["is_active"] is not None:
        fields.append(f"is_active = {PH}"); values.append(1 if data["is_active"] else 0)
    if not fields:
        raise HTTPException(status_code=400, detail="没有要更新的字段")

    if PH == "?":
        fields.append("updated_at = datetime('now','localtime')")

    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(f"SELECT id, name FROM doctors WHERE id = {PH}", (doctor_id,))
            current = cur.fetchone()
            if not current:
                raise HTTPException(status_code=404, detail="医生不存在")
            current = dict(current)
            old_name = current.get("name")
            new_name = data.get("name")
            # 改名时检查冲突
            if new_name and new_name != old_name:
                cur.execute(
                    f"SELECT id FROM doctors WHERE name = {PH} AND id <> {PH}",
                    (new_name, doctor_id),
                )
                if cur.fetchone():
                    raise HTTPException(status_code=409, detail=f"医生姓名已存在：{new_name}")

            values.append(doctor_id)
            cur.execute(
                f"UPDATE doctors SET {', '.join(fields)} WHERE id = {PH}",
                tuple(values),
            )
            # 改名：同步更新 bookings 中已绑定该医生的记录，避免历史预约断链
            if new_name and new_name != old_name:
                cur.execute(
                    f"UPDATE bookings SET doctor = {PH} WHERE doctor = {PH}",
                    (new_name, old_name),
                )
    except HTTPException:
        raise
    except Exception:
        logger.exception("更新医生失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "message": "更新成功", "data": {"id": doctor_id}}


# -------- 管理员：删除 --------
@app.delete("/api/admin/doctors/{doctor_id}")
async def admin_delete_doctor(
    doctor_id: int = FPath(..., ge=1),
    force: int = Query(0, ge=0, le=1),
    _: str = Depends(require_perm("doctor:write")),
):
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(f"SELECT id, name FROM doctors WHERE id = {PH}", (doctor_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="医生不存在")
            doctor_name = dict(row).get("name")
            # 引用计数：仍被预约绑定时拒绝（除非 force=1，强制删除时同步置空）
            cur.execute(
                f"SELECT COUNT(*) AS c FROM bookings WHERE doctor = {PH}",
                (doctor_name,),
            )
            ref = (cur.fetchone() or {}).get("c", 0) or 0
            if ref and not force:
                raise HTTPException(
                    status_code=400,
                    detail=f"该医生仍被 {ref} 条预约绑定，请改派或删除时附带 force=1（将清空预约的医生字段）",
                )
            if ref and force:
                cur.execute(
                    f"UPDATE bookings SET doctor = NULL WHERE doctor = {PH}",
                    (doctor_name,),
                )
            cur.execute(f"DELETE FROM doctors WHERE id = {PH}", (doctor_id,))
    except HTTPException:
        raise
    except Exception:
        logger.exception("删除医生失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "message": "删除成功"}


# ============================================================
# 人员权限管理（admin_users / admin_roles）+ 修改密码
# ============================================================
class _UserCreate(BaseModel):
    username: str = Field(..., min_length=3, max_length=32)
    password: str = Field(..., min_length=8, max_length=100)
    role_key: str = Field(..., min_length=1, max_length=40)
    display_name: Optional[str] = Field("", max_length=80)
    is_active: bool = True


class _UserUpdate(BaseModel):
    role_key: Optional[str] = Field(None, max_length=40)
    display_name: Optional[str] = Field(None, max_length=80)
    is_active: Optional[bool] = None
    new_password: Optional[str] = Field(None, max_length=100)


class _RoleCreate(BaseModel):
    role_key: str = Field(..., min_length=2, max_length=31)
    name: str = Field(..., min_length=1, max_length=60)
    level: int = Field(10, ge=1, le=99)
    permissions: List[str] = Field(default_factory=list)
    description: Optional[str] = Field("", max_length=255)


class _RoleUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=60)
    level: Optional[int] = Field(None, ge=1, le=99)
    permissions: Optional[List[str]] = None
    description: Optional[str] = Field(None, max_length=255)


class _ChangePassword(BaseModel):
    old_password: str = Field(..., min_length=1, max_length=100)
    new_password: str = Field(..., min_length=8, max_length=100)
    confirm_password: str = Field(..., min_length=8, max_length=100)


def _require_user_manage(actor: str) -> None:
    """需要 user:manage 或 super_admin 权限。"""
    if not users_mod.has_permission(actor, "user:manage"):
        raise HTTPException(status_code=403, detail="您无权管理人员/角色")


# -- 元数据 --
@app.get("/api/admin/auth/meta")
async def admin_auth_meta(_: str = Depends(require_admin)):
    """权限管理面板的元数据：模块、动作、内置角色 key。"""
    return {"code": 0, "data": users_mod.get_meta()}


# -- 角色 CRUD --
@app.get("/api/admin/roles")
async def admin_list_roles(user: str = Depends(require_admin)):
    _require_user_manage(user)
    try:
        return {"code": 0, "data": users_mod.list_roles()}
    except Exception:
        logger.exception("查询角色失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")


@app.post("/api/admin/roles")
async def admin_create_role(payload: _RoleCreate, request: Request,
                            user: str = Depends(require_admin)):
    _require_user_manage(user)
    try:
        role = users_mod.create_role(
            role_key=payload.role_key,
            name=payload.name,
            level=payload.level,
            permissions=payload.permissions,
            description=payload.description or "",
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        logger.exception("创建角色失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")

    audit_log(
        actor=user, action="create", resource="role",
        resource_id=role["role_key"],
        summary=f"新增角色 {role['name']}（{role['role_key']}）",
        after={"role_key": role["role_key"], "name": role["name"],
               "level": role["level"], "permissions": role["permissions"]},
        request=request,
    )
    return {"code": 0, "message": "创建成功", "data": role}


@app.put("/api/admin/roles/{role_key}")
async def admin_update_role(role_key: str, payload: _RoleUpdate, request: Request,
                            user: str = Depends(require_admin)):
    _require_user_manage(user)
    before = users_mod.get_role(role_key)
    if not before:
        raise HTTPException(status_code=404, detail="角色不存在")
    try:
        role = users_mod.update_role(
            role_key,
            name=payload.name,
            level=payload.level,
            permissions=payload.permissions,
            description=payload.description,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        logger.exception("更新角色失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")

    audit_log(
        actor=user, action="update", resource="role",
        resource_id=role_key,
        summary=f"更新角色 {role['name']}",
        before={"name": before["name"], "level": before["level"],
                "permissions": before["permissions"]},
        after={"name": role["name"], "level": role["level"],
               "permissions": role["permissions"]},
        request=request,
    )
    return {"code": 0, "message": "更新成功", "data": role}


@app.delete("/api/admin/roles/{role_key}")
async def admin_delete_role(role_key: str, request: Request,
                            user: str = Depends(require_admin)):
    _require_user_manage(user)
    before = users_mod.get_role(role_key)
    if not before:
        raise HTTPException(status_code=404, detail="角色不存在")
    try:
        users_mod.delete_role(role_key)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        logger.exception("删除角色失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")

    audit_log(
        actor=user, action="delete", resource="role",
        resource_id=role_key,
        summary=f"删除角色 {before['name']}",
        before={"name": before["name"], "level": before["level"]},
        request=request,
    )
    return {"code": 0, "message": "删除成功"}


# -- 用户 CRUD --
@app.get("/api/admin/users")
async def admin_list_users(user: str = Depends(require_admin)):
    _require_user_manage(user)
    try:
        return {"code": 0, "data": users_mod.list_users()}
    except Exception:
        logger.exception("查询用户失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")


@app.post("/api/admin/users")
async def admin_create_user(payload: _UserCreate, request: Request,
                            user: str = Depends(require_admin)):
    _require_user_manage(user)
    try:
        u = users_mod.create_user(
            username=payload.username,
            password=payload.password,
            role_key=payload.role_key,
            display_name=payload.display_name or "",
            is_active=payload.is_active,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        logger.exception("创建用户失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")

    audit_log(
        actor=user, action="create", resource="user",
        resource_id=u["username"],
        summary=f"新增用户 {u['username']}（角色：{u['role_key']}）",
        after={"username": u["username"], "role_key": u["role_key"],
               "is_active": u["is_active"]},
        request=request,
    )
    return {"code": 0, "message": "创建成功", "data": u}


@app.put("/api/admin/users/{username}")
async def admin_update_user(username: str, payload: _UserUpdate, request: Request,
                            user: str = Depends(require_admin)):
    _require_user_manage(user)
    before = users_mod.get_user_public(username)
    if not before:
        raise HTTPException(status_code=404, detail="用户不存在")
    # 不允许通过该接口修改自己的角色（防止意外越权降级），改密码请走 /change-password
    if username == user and payload.role_key and payload.role_key != before["role_key"]:
        raise HTTPException(status_code=400, detail="不能修改自己的角色")
    try:
        u = users_mod.update_user(
            username,
            role_key=payload.role_key,
            display_name=payload.display_name,
            is_active=payload.is_active,
            new_password=payload.new_password,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        logger.exception("更新用户失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")

    summary = f"更新用户 {username}"
    if payload.new_password:
        summary += "（含密码重置）"
    audit_log(
        actor=user, action="update", resource="user",
        resource_id=username,
        summary=summary,
        before={"role_key": before["role_key"], "is_active": before["is_active"],
                "display_name": before.get("display_name", "")},
        after={"role_key": u["role_key"], "is_active": u["is_active"],
               "display_name": u.get("display_name", "")},
        request=request,
    )
    return {"code": 0, "message": "更新成功", "data": u}


@app.delete("/api/admin/users/{username}")
async def admin_delete_user(username: str, request: Request,
                            user: str = Depends(require_admin)):
    _require_user_manage(user)
    before = users_mod.get_user_public(username)
    if not before:
        raise HTTPException(status_code=404, detail="用户不存在")
    try:
        users_mod.delete_user(username, current_username=user)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        logger.exception("删除用户失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")

    audit_log(
        actor=user, action="delete", resource="user",
        resource_id=username,
        summary=f"删除用户 {username}",
        before={"username": before["username"], "role_key": before["role_key"]},
        request=request,
    )
    return {"code": 0, "message": "删除成功"}


# -- 修改自己的密码（任何登录用户均可调用） --
@app.post("/api/admin/change-password")
async def admin_change_password(payload: _ChangePassword, request: Request,
                                user: str = Depends(require_admin)):
    if payload.new_password != payload.confirm_password:
        raise HTTPException(status_code=400, detail="两次输入的新密码不一致")
    if payload.old_password == payload.new_password:
        raise HTTPException(status_code=400, detail="新密码不能与原密码相同")

    # 防暴力：与登录复用 IP 锁
    ip = _client_ip(request) or "unknown"
    locked, remain = login_guard.is_locked(ip)
    if locked:
        raise HTTPException(
            status_code=429,
            detail=f"操作过于频繁，请 {remain} 秒后再试",
            headers={"Retry-After": str(remain)},
        )

    try:
        users_mod.change_own_password(
            username=user,
            old_password=payload.old_password,
            new_password=payload.new_password,
            env_verifier=verify_admin_password,
        )
    except ValueError as e:
        # 原密码错也走失败计数
        if "原密码" in str(e):
            login_guard.record_fail(ip)
        audit_log(
            actor=user, action="update", resource="admin",
            resource_id=user,
            summary=f"修改密码失败：{e}",
            request=request,
        )
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        logger.exception("修改密码失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")

    audit_log(
        actor=user, action="update", resource="admin",
        resource_id=user,
        summary=f"管理员 {user} 修改了自己的密码",
        request=request,
    )
    return {"code": 0, "message": "密码已更新，请妥善保管"}


# ------------------------------------------------------------------
# 管理员：审计日志查询
# ------------------------------------------------------------------
@app.get("/api/admin/audit-logs")
async def admin_audit_logs(
    actor: Optional[str] = Query(None, max_length=80),
    action: Optional[str] = Query(None, max_length=40),
    resource: Optional[str] = Query(None, max_length=40),
    resource_id: Optional[str] = Query(None, max_length=64),
    start: Optional[str] = Query(None, max_length=32, description="起始时间 YYYY-MM-DD HH:MM:SS"),
    end: Optional[str] = Query(None, max_length=32, description="结束时间 YYYY-MM-DD HH:MM:SS"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _: str = Depends(require_admin),
):
    # 校验白名单
    if action and action not in ALLOWED_FILTER_ACTIONS:
        raise HTTPException(status_code=400, detail=f"无效的 action: {action}")
    if resource and resource not in ALLOWED_FILTER_RESOURCES:
        raise HTTPException(status_code=400, detail=f"无效的 resource: {resource}")
    try:
        result = list_audit_logs(
            actor=actor, action=action, resource=resource, resource_id=resource_id,
            start=start, end=end, limit=limit, offset=offset,
        )
    except Exception:
        logger.exception("查询审计日志失败")
        raise HTTPException(status_code=500, detail="服务异常，请稍后重试")
    return {"code": 0, "data": result}


# ------------------------------------------------------------------
# 管理员：审计日志一键 CSV 导出
# ------------------------------------------------------------------
# 单次导出最多多少条（防止一次拖垮服务）
AUDIT_EXPORT_MAX = 50000
# CSV 公式注入防护：以下字符开头视为 Excel 公式
_CSV_DANGEROUS_PREFIX = ("=", "+", "-", "@", "\t", "\r")


def _csv_safe(v: Any) -> str:
    """对每个 CSV 字段做公式注入转义。

    - None  → ''
    - 非字符串原样 str()
    - 以 = / + / - / @ / \\t / \\r 开头的字符串前置单引号 ' 阻止公式执行
    """
    if v is None:
        return ""
    s = v if isinstance(v, str) else str(v)
    if s and s[0] in _CSV_DANGEROUS_PREFIX:
        s = "'" + s
    return s


@app.get("/api/admin/audit-logs/export.csv")
async def admin_audit_logs_export(
    actor: Optional[str] = Query(None, max_length=80),
    action: Optional[str] = Query(None, max_length=40),
    resource: Optional[str] = Query(None, max_length=40),
    resource_id: Optional[str] = Query(None, max_length=64),
    start: Optional[str] = Query(None, max_length=32),
    end: Optional[str] = Query(None, max_length=32),
    user: str = Depends(require_perm("audit:read")),
):
    """按筛选条件导出审计日志为 CSV（UTF-8 BOM，Excel 直接打开不乱码）。

    - 复用 list_audit_logs() 分页拉取，每批 500 条，最多 AUDIT_EXPORT_MAX
    - 字段防公式注入；diff 字段序列化为 JSON 单元格
    - 自身写一条 audit 记录，标记本次导出
    """
    # 校验白名单
    if action and action not in ALLOWED_FILTER_ACTIONS:
        raise HTTPException(status_code=400, detail=f"无效的 action: {action}")
    if resource and resource not in ALLOWED_FILTER_RESOURCES:
        raise HTTPException(status_code=400, detail=f"无效的 resource: {resource}")

    BATCH = 500
    headers = ["id", "created_at", "actor", "action", "resource", "resource_id",
               "summary", "ip", "user_agent", "diff_json"]

    buf = io.StringIO()
    # UTF-8 BOM 让 Excel 中文不乱码
    buf.write("\ufeff")
    writer = csv.writer(buf, dialect="excel", quoting=csv.QUOTE_MINIMAL)
    writer.writerow(headers)

    total_written = 0
    offset = 0
    try:
        while total_written < AUDIT_EXPORT_MAX:
            page = list_audit_logs(
                actor=actor, action=action, resource=resource, resource_id=resource_id,
                start=start, end=end, limit=BATCH, offset=offset,
            )
            items = page.get("items") or []
            if not items:
                break
            for r in items:
                diff_str = ""
                if r.get("diff") is not None:
                    try:
                        diff_str = json.dumps(r["diff"], ensure_ascii=False)
                    except Exception:
                        diff_str = ""
                writer.writerow([
                    _csv_safe(r.get("id")),
                    _csv_safe(r.get("created_at")),
                    _csv_safe(r.get("actor")),
                    _csv_safe(r.get("action")),
                    _csv_safe(r.get("resource")),
                    _csv_safe(r.get("resource_id")),
                    _csv_safe(r.get("summary")),
                    _csv_safe(r.get("ip")),
                    _csv_safe(r.get("user_agent")),
                    _csv_safe(diff_str),
                ])
            total_written += len(items)
            offset += len(items)
            # 提前结束：本批未拉满 BATCH，说明已是最后一页
            if len(items) < BATCH:
                break
    except HTTPException:
        raise
    except Exception:
        logger.exception("审计日志导出失败")
        raise HTTPException(status_code=500, detail="导出失败")

    csv_bytes = buf.getvalue().encode("utf-8")
    fname = f"audit_logs_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"

    # 给本次导出本身留一条审计
    audit_log(
        actor=user, action="update", resource="admin",
        resource_id="audit_export",
        summary=f"导出审计日志 {total_written} 条 (筛选: actor={actor or '-'}, "
                f"resource={resource or '-'}, action={action or '-'})",
    )

    return Response(
        content=csv_bytes,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"',
            "Cache-Control": "no-store",
            "X-Audit-Export-Count": str(total_written),
        },
    )


# ------------------------------------------------------------------
# SEO 路由：robots.txt / sitemap.xml / manifest.webmanifest
# 顶层路由（不带 /static 前缀），让搜索引擎能直接抓到
# ------------------------------------------------------------------
@app.get("/robots.txt", include_in_schema=False)
async def serve_robots():
    p = Path(__file__).parent / "static" / "robots.txt"
    if p.exists():
        return Response(content=p.read_text(encoding="utf-8"), media_type="text/plain; charset=utf-8")
    return Response(content="User-agent: *\nAllow: /\n", media_type="text/plain")


@app.get("/sitemap.xml", include_in_schema=False)
async def serve_sitemap():
    p = Path(__file__).parent / "static" / "sitemap.xml"
    if p.exists():
        return Response(content=p.read_text(encoding="utf-8"), media_type="application/xml; charset=utf-8")
    raise HTTPException(status_code=404, detail="sitemap not found")


@app.get("/manifest.webmanifest", include_in_schema=False)
async def serve_manifest():
    p = Path(__file__).parent / "static" / "manifest.webmanifest"
    if p.exists():
        return Response(content=p.read_text(encoding="utf-8"), media_type="application/manifest+json; charset=utf-8")
    raise HTTPException(status_code=404, detail="manifest not found")


# ------------------------------------------------------------------
# 静态文件挂载
# ------------------------------------------------------------------
STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
