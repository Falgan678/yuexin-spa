"""
操作审计日志模块
============================================================
- 单独的 audit_logs 表，记录管理员关键操作的：操作人、动作、资源类型/ID、变更前后、IP/UA、时间
- 支持 SQLite 与 MySQL（通过 db.py 的 PH/get_db_connection）
- 自动建表（启动时由 ensure_audit_table() 调用）
- 提供 audit_log() 辅助函数：在路由内一行调用即可落库（异常捕获，绝不阻塞主流程）
- 提供 list_audit_logs() / count_audit_logs() 给后台查询接口使用

存储字段（紧凑、可索引）：
    actor       管理员用户名
    action      操作动作: create/update/delete/login/...
    resource    资源类型: booking/service/offer/...
    resource_id 资源 id（字符串，统一兼容 int/str）
    summary     人类可读的简短描述（120 字内）
    diff_json   关键字段 before/after 的 JSON（最多 4KB）
    ip          客户端 IP（最长 64）
    user_agent  浏览器 UA（最长 500）
    created_at  时间
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from db import PH, get_db_connection

logger = logging.getLogger("yuexin.audit")

MAX_DIFF_LEN = 4000     # 防止单条审计过大撑爆库
MAX_SUMMARY_LEN = 120


# ------------------------------------------------------------------
# 建表 / 索引
# ------------------------------------------------------------------
def _ddl_sqlite() -> List[str]:
    return [
        """
        CREATE TABLE IF NOT EXISTS audit_logs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            actor       TEXT    NOT NULL DEFAULT '',
            action      TEXT    NOT NULL,
            resource    TEXT    NOT NULL,
            resource_id TEXT    NOT NULL DEFAULT '',
            summary     TEXT    NOT NULL DEFAULT '',
            diff_json   TEXT,
            ip          TEXT    NOT NULL DEFAULT '',
            user_agent  TEXT    NOT NULL DEFAULT '',
            created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_audit_actor      ON audit_logs(actor)",
        "CREATE INDEX IF NOT EXISTS idx_audit_resource   ON audit_logs(resource, resource_id)",
        "CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at)",
    ]


def _ddl_mysql() -> List[str]:
    return [
        """
        CREATE TABLE IF NOT EXISTS audit_logs (
            id          BIGINT       NOT NULL AUTO_INCREMENT,
            actor       VARCHAR(80)  NOT NULL DEFAULT '',
            action      VARCHAR(40)  NOT NULL,
            resource    VARCHAR(40)  NOT NULL,
            resource_id VARCHAR(64)  NOT NULL DEFAULT '',
            summary     VARCHAR(255) NOT NULL DEFAULT '',
            diff_json   TEXT,
            ip          VARCHAR(64)  NOT NULL DEFAULT '',
            user_agent  VARCHAR(500) NOT NULL DEFAULT '',
            created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_actor       (actor),
            KEY idx_resource    (resource, resource_id),
            KEY idx_created_at  (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """,
    ]


def ensure_audit_table() -> None:
    """启动期调用，确保 audit_logs 表存在。"""
    ddl = _ddl_sqlite() if PH == "?" else _ddl_mysql()
    with get_db_connection() as conn:
        cur = conn.cursor()
        for sql in ddl:
            cur.execute(sql)


# ------------------------------------------------------------------
# 写入审计
# ------------------------------------------------------------------
def _safe_json(obj: Any) -> Optional[str]:
    if obj is None:
        return None
    try:
        s = json.dumps(obj, ensure_ascii=False, default=str)
        if len(s) > MAX_DIFF_LEN:
            s = s[:MAX_DIFF_LEN] + "...<truncated>"
        return s
    except Exception:
        return None


def _build_diff(before: Optional[Dict[str, Any]],
                after: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """只保留 before/after 中有差异的字段，敏感字段（password 等）剔除。"""
    SENSITIVE = {"password", "pwd", "token", "secret"}
    if before is None and after is None:
        return None
    if before is None:
        return {"before": None, "after": {k: v for k, v in (after or {}).items() if k not in SENSITIVE}}
    if after is None:
        return {"before": {k: v for k, v in (before or {}).items() if k not in SENSITIVE}, "after": None}

    diff_before, diff_after = {}, {}
    keys = set(before.keys()) | set(after.keys())
    for k in keys:
        if k in SENSITIVE:
            continue
        bv = before.get(k)
        av = after.get(k)
        if bv != av:
            diff_before[k] = bv
            diff_after[k] = av
    if not diff_before and not diff_after:
        return None
    return {"before": diff_before, "after": diff_after}


def audit_log(
    actor: str,
    action: str,
    resource: str,
    resource_id: Any = "",
    summary: str = "",
    before: Optional[Dict[str, Any]] = None,
    after: Optional[Dict[str, Any]] = None,
    request: Any = None,
) -> None:
    """
    写入一条审计记录。任何异常都不会向上抛，确保不影响业务主流程。

    参数说明：
        actor       管理员用户名（require_admin 返回值）
        action      'create' / 'update' / 'delete' / 'login' / 'login_failed' / ...
        resource    'booking' / 'service' / 'offer' / 'doctor' / 'environment' / 'category' / 'tag' / 'setting' / 'admin'
        resource_id 资源 id（int/str 都可，会强转 str）
        summary     人类可读说明（120 字内）
        before/after 对象快照，自动 diff 后只保留差异
        request     FastAPI Request，可选，用于自动抓 IP/UA
    """
    try:
        ip, ua = "", ""
        if request is not None:
            try:
                ip = (request.client.host if request.client else "")[:64]
            except Exception:
                ip = ""
            try:
                ua = (request.headers.get("user-agent") or "")[:500]
            except Exception:
                ua = ""

        diff_obj = _build_diff(before, after) if (before is not None or after is not None) else None
        diff_json = _safe_json(diff_obj)
        s = (summary or "")[:MAX_SUMMARY_LEN]
        rid = "" if resource_id is None else str(resource_id)[:64]

        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                f"""
                INSERT INTO audit_logs
                    (actor, action, resource, resource_id, summary,
                     diff_json, ip, user_agent)
                VALUES ({PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH})
                """,
                (
                    (actor or "")[:80], action[:40], resource[:40], rid,
                    s, diff_json, ip, ua,
                ),
            )
    except Exception:
        # 审计自身失败绝不能影响业务
        logger.exception("写入审计日志失败 actor=%s action=%s res=%s/%s",
                         actor, action, resource, resource_id)


# ------------------------------------------------------------------
# 查询（管理后台用）
# ------------------------------------------------------------------
ALLOWED_FILTER_RESOURCES = {
    "booking", "service", "offer", "doctor", "environment",
    "category", "tag", "setting", "admin",
    "user", "role",
}
ALLOWED_FILTER_ACTIONS = {
    "create", "update", "delete", "login", "login_failed",
    "status_update", "note_update", "batch_update",
}


def list_audit_logs(
    *, actor: Optional[str] = None,
    action: Optional[str] = None,
    resource: Optional[str] = None,
    resource_id: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> Dict[str, Any]:
    """分页查询审计日志。所有筛选都走白名单/参数化，零拼接风险。"""
    where: List[str] = []
    args: List[Any] = []

    if actor:
        where.append(f"actor = {PH}"); args.append(actor[:80])
    if action and action in ALLOWED_FILTER_ACTIONS:
        where.append(f"action = {PH}"); args.append(action)
    if resource and resource in ALLOWED_FILTER_RESOURCES:
        where.append(f"resource = {PH}"); args.append(resource)
    if resource_id:
        where.append(f"resource_id = {PH}"); args.append(str(resource_id)[:64])
    if start:
        where.append(f"created_at >= {PH}"); args.append(start)
    if end:
        where.append(f"created_at <= {PH}"); args.append(end)

    sql_where = ("WHERE " + " AND ".join(where)) if where else ""

    # 边界保护
    limit = max(1, min(int(limit or 50), 200))
    offset = max(0, int(offset or 0))

    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute(f"SELECT COUNT(*) AS c FROM audit_logs {sql_where}", tuple(args))
        total = (dict(cur.fetchone() or {}).get("c") or 0)

        cur.execute(
            f"""
            SELECT id, actor, action, resource, resource_id, summary,
                   diff_json, ip, user_agent, created_at
            FROM audit_logs
            {sql_where}
            ORDER BY id DESC
            LIMIT {PH} OFFSET {PH}
            """,
            tuple(args) + (limit, offset),
        )
        rows = []
        for r in cur.fetchall():
            d = dict(r)
            # 解析 diff_json 给前端直接用
            if d.get("diff_json"):
                try:
                    d["diff"] = json.loads(d["diff_json"])
                except Exception:
                    d["diff"] = None
            else:
                d["diff"] = None
            d.pop("diff_json", None)
            rows.append(d)
    return {"total": total, "items": rows, "limit": limit, "offset": offset}
