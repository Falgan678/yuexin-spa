"""
人员权限管理模块
============================================================
- 表 admin_users  ：管理员账号（用户名 / bcrypt 密码哈希 / 角色 / 启用状态）
- 表 admin_roles  ：角色（角色 key / 名称 / 权限级别 / 权限列表 JSON / 是否内置）
- 提供：
    * 启动期建表 + 种入 4 个内置角色（super_admin / admin / editor / viewer）
    * 内置 ENV 管理员（config.ADMIN_USERNAME）自动落库为 super_admin
    * 用户 CRUD、修改密码、登录认证、权限校验依赖
- 安全：
    * 密码统一 bcrypt 哈希存储，校验走 bcrypt.checkpw（常量时间）
    * 100% 参数化 SQL，资源/动作白名单
    * 审计：调用方在路由里继续用 audit_log 记录（保持现有审计风格）

权限模型（资源 × 动作）：
    资源（modules）：booking / service / offer / doctor / environment /
                    category / tag / setting / analytics / audit / user / role
    动作（actions）：read / write / delete / manage
        - read    ：读取列表 / 详情
        - write   ：创建 / 编辑（不含删除）
        - delete  ：删除
        - manage  ：用户/角色管理（最高权限）

权限级别（level）：1~100，越大权限越高，仅作展示与默认权限继承的提示。
"""
from __future__ import annotations

import json
import logging
import re
import secrets as _secrets
from typing import Any, Dict, List, Optional

from db import PH, get_db_connection

logger = logging.getLogger("yuexin.users")

# ------------------------------------------------------------------
# 常量：模块 / 动作 / 内置角色（白名单，全部使用集合避免拼接）
# ------------------------------------------------------------------
ALLOWED_MODULES: List[str] = [
    "booking", "service", "offer", "doctor", "environment",
    "category", "tag", "setting", "analytics", "audit",
    "user", "role",
]
ALLOWED_ACTIONS: List[str] = ["read", "write", "delete", "manage"]

USERNAME_RE = re.compile(r"^[A-Za-z0-9_\-\.]{3,32}$")

# 4 个内置角色：key 不可改、不可删
BUILTIN_ROLE_SUPER = "super_admin"
BUILTIN_ROLE_ADMIN = "admin"
BUILTIN_ROLE_EDITOR = "editor"
BUILTIN_ROLE_VIEWER = "viewer"

BUILTIN_ROLES: List[Dict[str, Any]] = [
    {
        "role_key": BUILTIN_ROLE_SUPER,
        "name": "超级管理员",
        "level": 100,
        "permissions": [f"{m}:{a}" for m in ALLOWED_MODULES for a in ALLOWED_ACTIONS],
        "description": "拥有全部权限（含人员与角色管理），不可删除。",
    },
    {
        "role_key": BUILTIN_ROLE_ADMIN,
        "name": "管理员",
        "level": 80,
        "permissions": [
            f"{m}:{a}"
            for m in ["booking", "service", "offer", "doctor", "environment",
                     "category", "tag", "setting", "analytics", "audit"]
            for a in ["read", "write", "delete"]
        ],
        "description": "可管理业务数据（不含人员/角色）。",
    },
    {
        "role_key": BUILTIN_ROLE_EDITOR,
        "name": "运营编辑",
        "level": 50,
        "permissions": [
            f"{m}:{a}"
            for m in ["booking", "service", "offer", "doctor", "environment",
                     "category", "tag", "setting"]
            for a in ["read", "write"]
        ] + ["analytics:read"],
        "description": "可读写业务数据，但不可删除；可查看统计。",
    },
    {
        "role_key": BUILTIN_ROLE_VIEWER,
        "name": "只读访客",
        "level": 10,
        "permissions": [f"{m}:read" for m in [
            "booking", "service", "offer", "doctor", "environment",
            "category", "tag", "setting", "analytics",
        ]],
        "description": "仅可查看业务数据。",
    },
]

# 内置 super_admin 永远拥有的全部权限（兜底用）
SUPER_ADMIN_PERMS = {f"{m}:{a}" for m in ALLOWED_MODULES for a in ALLOWED_ACTIONS}


# ------------------------------------------------------------------
# 密码哈希
# ------------------------------------------------------------------
def _hash_password(plain: str) -> str:
    import bcrypt
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def _verify_password(plain: str, hashed: str) -> bool:
    if not plain or not hashed:
        return False
    try:
        import bcrypt
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        logger.exception("bcrypt 校验异常")
        return False


def validate_password_strength(pwd: str) -> Optional[str]:
    """返回错误信息字符串；通过则返回 None。

    规则：长度 ≥ 8；至少包含两类字符（字母 / 数字 / 符号）。
    """
    if not pwd or len(pwd) < 8:
        return "密码长度至少 8 位"
    if len(pwd) > 100:
        return "密码长度不能超过 100 位"
    has_letter = any(c.isalpha() for c in pwd)
    has_digit = any(c.isdigit() for c in pwd)
    has_symbol = any(not c.isalnum() for c in pwd)
    if sum([has_letter, has_digit, has_symbol]) < 2:
        return "密码须至少包含字母、数字、符号中的两类"
    return None


# ------------------------------------------------------------------
# 建表 / 种子
# ------------------------------------------------------------------
def _ddl_sqlite() -> List[str]:
    return [
        """
        CREATE TABLE IF NOT EXISTS admin_roles (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            role_key     TEXT    NOT NULL UNIQUE,
            name         TEXT    NOT NULL,
            level        INTEGER NOT NULL DEFAULT 10,
            permissions  TEXT    NOT NULL DEFAULT '[]',
            description  TEXT    NOT NULL DEFAULT '',
            builtin      INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
            updated_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_roles_level ON admin_roles(level)",
        """
        CREATE TABLE IF NOT EXISTS admin_users (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            username       TEXT    NOT NULL UNIQUE,
            password_hash  TEXT    NOT NULL DEFAULT '',
            display_name   TEXT    NOT NULL DEFAULT '',
            role_key       TEXT    NOT NULL DEFAULT 'viewer',
            is_active      INTEGER NOT NULL DEFAULT 1,
            is_builtin     INTEGER NOT NULL DEFAULT 0,
            last_login_at  TEXT,
            created_at     TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
            updated_at     TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_users_role   ON admin_users(role_key)",
        "CREATE INDEX IF NOT EXISTS idx_users_active ON admin_users(is_active)",
    ]


def _ddl_mysql() -> List[str]:
    return [
        """
        CREATE TABLE IF NOT EXISTS admin_roles (
            id           BIGINT       NOT NULL AUTO_INCREMENT,
            role_key     VARCHAR(40)  NOT NULL,
            name         VARCHAR(60)  NOT NULL,
            level        INT          NOT NULL DEFAULT 10,
            permissions  TEXT         NOT NULL,
            description  VARCHAR(255) NOT NULL DEFAULT '',
            builtin      TINYINT      NOT NULL DEFAULT 0,
            created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uk_role_key (role_key),
            KEY idx_level (level)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """,
        """
        CREATE TABLE IF NOT EXISTS admin_users (
            id             BIGINT       NOT NULL AUTO_INCREMENT,
            username       VARCHAR(50)  NOT NULL,
            password_hash  VARCHAR(120) NOT NULL DEFAULT '',
            display_name   VARCHAR(80)  NOT NULL DEFAULT '',
            role_key       VARCHAR(40)  NOT NULL DEFAULT 'viewer',
            is_active      TINYINT      NOT NULL DEFAULT 1,
            is_builtin     TINYINT      NOT NULL DEFAULT 0,
            last_login_at  DATETIME     NULL,
            created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uk_username (username),
            KEY idx_role   (role_key),
            KEY idx_active (is_active)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """,
    ]


def ensure_users_tables_and_seed(env_admin_username: str) -> None:
    """启动期调用：建表 + 种入内置角色 + 把 ENV admin 写入 admin_users。"""
    ddl = _ddl_sqlite() if PH == "?" else _ddl_mysql()
    with get_db_connection() as conn:
        cur = conn.cursor()
        for sql in ddl:
            cur.execute(sql)

    # 种入 / 对齐内置角色（每次启动都对齐 name/level/permissions/description，确保版本变更生效）
    with get_db_connection() as conn:
        cur = conn.cursor()
        for r in BUILTIN_ROLES:
            cur.execute(
                f"SELECT id FROM admin_roles WHERE role_key = {PH}", (r["role_key"],)
            )
            existing = cur.fetchone()
            perms_json = json.dumps(r["permissions"], ensure_ascii=False)
            if existing:
                cur.execute(
                    f"UPDATE admin_roles "
                    f"SET name = {PH}, level = {PH}, permissions = {PH}, "
                    f"    description = {PH}, builtin = 1 "
                    f"WHERE role_key = {PH}",
                    (r["name"], r["level"], perms_json, r["description"], r["role_key"]),
                )
            else:
                cur.execute(
                    f"INSERT INTO admin_roles "
                    f"(role_key, name, level, permissions, description, builtin) "
                    f"VALUES ({PH}, {PH}, {PH}, {PH}, {PH}, 1)",
                    (r["role_key"], r["name"], r["level"], perms_json, r["description"]),
                )

    # 把 ENV admin 落库为 super_admin（不存储密码哈希，密码由 ENV 走 verify_admin_password）
    if env_admin_username:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                f"SELECT id, password_hash FROM admin_users WHERE username = {PH}",
                (env_admin_username,),
            )
            row = cur.fetchone()
            if not row:
                cur.execute(
                    f"INSERT INTO admin_users "
                    f"(username, password_hash, display_name, role_key, is_active, is_builtin) "
                    f"VALUES ({PH}, '', {PH}, {PH}, 1, 1)",
                    (env_admin_username, "系统超管", BUILTIN_ROLE_SUPER),
                )
                logger.info("初始化 ENV 管理员 %s 至 admin_users", env_admin_username)
            else:
                # 始终保证内置 super_admin 角色 + 启用状态 + builtin 标记
                cur.execute(
                    f"UPDATE admin_users "
                    f"SET role_key = {PH}, is_active = 1, is_builtin = 1 "
                    f"WHERE username = {PH}",
                    (BUILTIN_ROLE_SUPER, env_admin_username),
                )


# ------------------------------------------------------------------
# 行规范化
# ------------------------------------------------------------------
def _role_row(row: Dict[str, Any]) -> Dict[str, Any]:
    perms = row.get("permissions") or "[]"
    try:
        perms_list = json.loads(perms) if isinstance(perms, str) else perms
        if not isinstance(perms_list, list):
            perms_list = []
    except Exception:
        perms_list = []
    return {
        "id": row.get("id"),
        "role_key": row.get("role_key"),
        "name": row.get("name"),
        "level": int(row.get("level") or 0),
        "permissions": perms_list,
        "description": row.get("description") or "",
        "builtin": bool(row.get("builtin")),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


def _user_row(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": row.get("id"),
        "username": row.get("username"),
        "display_name": row.get("display_name") or "",
        "role_key": row.get("role_key") or BUILTIN_ROLE_VIEWER,
        "is_active": bool(row.get("is_active")),
        "is_builtin": bool(row.get("is_builtin")),
        "has_password": bool(row.get("password_hash")),
        "last_login_at": row.get("last_login_at"),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


# ------------------------------------------------------------------
# 角色 CRUD
# ------------------------------------------------------------------
def list_roles() -> List[Dict[str, Any]]:
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT id, role_key, name, level, permissions, description, "
            "       builtin, created_at, updated_at "
            "FROM admin_roles ORDER BY level DESC, id ASC"
        )
        return [_role_row(dict(r)) for r in cur.fetchall()]


def get_role(role_key: str) -> Optional[Dict[str, Any]]:
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            f"SELECT id, role_key, name, level, permissions, description, "
            f"       builtin, created_at, updated_at "
            f"FROM admin_roles WHERE role_key = {PH}",
            (role_key,),
        )
        r = cur.fetchone()
        return _role_row(dict(r)) if r else None


def _normalize_perms(perms: List[str]) -> List[str]:
    """白名单过滤 + 去重 + 排序。"""
    out = set()
    for p in perms or []:
        if not isinstance(p, str) or ":" not in p:
            continue
        m, a = p.split(":", 1)
        if m in ALLOWED_MODULES and a in ALLOWED_ACTIONS:
            out.add(f"{m}:{a}")
    return sorted(out)


def create_role(role_key: str, name: str, level: int,
                permissions: List[str], description: str = "") -> Dict[str, Any]:
    role_key = (role_key or "").strip()
    if not re.match(r"^[a-z][a-z0-9_]{1,30}$", role_key):
        raise ValueError("角色 key 格式无效（小写字母开头，字母数字下划线，2-31 位）")
    if get_role(role_key):
        raise ValueError(f"角色 key 已存在：{role_key}")
    name = (name or "").strip()
    if not name or len(name) > 60:
        raise ValueError("角色名称为必填，且不超过 60 字")
    level = max(1, min(int(level or 10), 99))   # 99 上限：100 留给 super_admin
    perms_json = json.dumps(_normalize_perms(permissions), ensure_ascii=False)
    description = (description or "").strip()[:255]

    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            f"INSERT INTO admin_roles "
            f"(role_key, name, level, permissions, description, builtin) "
            f"VALUES ({PH}, {PH}, {PH}, {PH}, {PH}, 0)",
            (role_key, name, level, perms_json, description),
        )
    return get_role(role_key)  # type: ignore[return-value]


def update_role(role_key: str, *, name: Optional[str] = None,
                level: Optional[int] = None,
                permissions: Optional[List[str]] = None,
                description: Optional[str] = None) -> Dict[str, Any]:
    cur_role = get_role(role_key)
    if not cur_role:
        raise ValueError(f"角色不存在：{role_key}")
    # 内置 super_admin 的权限不允许修改（始终全权限）；其他内置角色允许调整名称/描述
    is_super = role_key == BUILTIN_ROLE_SUPER

    fields: List[str] = []
    args: List[Any] = []
    if name is not None:
        n = name.strip()
        if not n or len(n) > 60:
            raise ValueError("角色名称为必填，且不超过 60 字")
        fields.append(f"name = {PH}"); args.append(n)
    if level is not None and not is_super:
        lv = max(1, min(int(level), 99))
        fields.append(f"level = {PH}"); args.append(lv)
    if permissions is not None and not is_super:
        perms_json = json.dumps(_normalize_perms(permissions), ensure_ascii=False)
        fields.append(f"permissions = {PH}"); args.append(perms_json)
    if description is not None:
        fields.append(f"description = {PH}"); args.append(description.strip()[:255])

    if not fields:
        return cur_role

    args.append(role_key)
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            f"UPDATE admin_roles SET {', '.join(fields)} WHERE role_key = {PH}",
            tuple(args),
        )
    return get_role(role_key)  # type: ignore[return-value]


def delete_role(role_key: str) -> None:
    role = get_role(role_key)
    if not role:
        raise ValueError(f"角色不存在：{role_key}")
    if role["builtin"]:
        raise ValueError("内置角色不可删除")
    # 仍被使用的角色不允许删除
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            f"SELECT COUNT(*) AS c FROM admin_users WHERE role_key = {PH}",
            (role_key,),
        )
        c = (cur.fetchone() or {}).get("c") or 0
        if c > 0:
            raise ValueError(f"该角色仍被 {c} 个用户使用，请先调整后再删除")
        cur.execute(f"DELETE FROM admin_roles WHERE role_key = {PH}", (role_key,))


# ------------------------------------------------------------------
# 用户 CRUD
# ------------------------------------------------------------------
def list_users() -> List[Dict[str, Any]]:
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT id, username, password_hash, display_name, role_key, "
            "       is_active, is_builtin, last_login_at, created_at, updated_at "
            "FROM admin_users ORDER BY id ASC"
        )
        return [_user_row(dict(r)) for r in cur.fetchall()]


def get_user_by_username(username: str) -> Optional[Dict[str, Any]]:
    """返回原始字典（含 password_hash），仅供内部使用。"""
    if not username:
        return None
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            f"SELECT id, username, password_hash, display_name, role_key, "
            f"       is_active, is_builtin, last_login_at, created_at, updated_at "
            f"FROM admin_users WHERE username = {PH}",
            (username,),
        )
        r = cur.fetchone()
        return dict(r) if r else None


def get_user_public(username: str) -> Optional[Dict[str, Any]]:
    r = get_user_by_username(username)
    return _user_row(r) if r else None


def create_user(username: str, password: str, role_key: str,
                display_name: str = "", is_active: bool = True) -> Dict[str, Any]:
    username = (username or "").strip()
    if not USERNAME_RE.match(username):
        raise ValueError("用户名格式无效（字母/数字/下划线/-/.，3-32 位）")
    if get_user_by_username(username):
        raise ValueError(f"用户名已存在：{username}")
    err = validate_password_strength(password)
    if err:
        raise ValueError(err)
    if not get_role(role_key):
        raise ValueError(f"角色不存在：{role_key}")
    pwd_hash = _hash_password(password)
    display_name = (display_name or "").strip()[:80]

    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            f"INSERT INTO admin_users "
            f"(username, password_hash, display_name, role_key, is_active, is_builtin) "
            f"VALUES ({PH}, {PH}, {PH}, {PH}, {PH}, 0)",
            (username, pwd_hash, display_name, role_key, 1 if is_active else 0),
        )
    return get_user_public(username)  # type: ignore[return-value]


def update_user(username: str, *, role_key: Optional[str] = None,
                display_name: Optional[str] = None,
                is_active: Optional[bool] = None,
                new_password: Optional[str] = None) -> Dict[str, Any]:
    user = get_user_by_username(username)
    if not user:
        raise ValueError(f"用户不存在：{username}")

    fields: List[str] = []
    args: List[Any] = []
    if role_key is not None:
        if not get_role(role_key):
            raise ValueError(f"角色不存在：{role_key}")
        # 内置 super_admin 用户角色不可降级
        if user.get("is_builtin") and role_key != BUILTIN_ROLE_SUPER:
            raise ValueError("内置超级管理员的角色不可修改")
        fields.append(f"role_key = {PH}"); args.append(role_key)
    if display_name is not None:
        fields.append(f"display_name = {PH}"); args.append(display_name.strip()[:80])
    if is_active is not None:
        # 内置 super_admin 不可禁用
        if user.get("is_builtin") and not is_active:
            raise ValueError("内置超级管理员不可被禁用")
        fields.append(f"is_active = {PH}"); args.append(1 if is_active else 0)
    if new_password is not None and new_password != "":
        err = validate_password_strength(new_password)
        if err:
            raise ValueError(err)
        fields.append(f"password_hash = {PH}"); args.append(_hash_password(new_password))

    if not fields:
        return _user_row(user)

    args.append(username)
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            f"UPDATE admin_users SET {', '.join(fields)} WHERE username = {PH}",
            tuple(args),
        )
    return get_user_public(username)  # type: ignore[return-value]


def delete_user(username: str, current_username: str) -> None:
    user = get_user_by_username(username)
    if not user:
        raise ValueError(f"用户不存在：{username}")
    if user.get("is_builtin"):
        raise ValueError("内置超级管理员不可删除")
    if username == current_username:
        raise ValueError("不能删除自己")
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute(f"DELETE FROM admin_users WHERE username = {PH}", (username,))


def touch_last_login(username: str) -> None:
    """登录成功时调用。任何异常静默。"""
    if not username:
        return
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            if PH == "?":
                cur.execute(
                    f"UPDATE admin_users SET last_login_at = datetime('now','localtime') "
                    f"WHERE username = {PH}",
                    (username,),
                )
            else:
                cur.execute(
                    f"UPDATE admin_users SET last_login_at = NOW() WHERE username = {PH}",
                    (username,),
                )
    except Exception:
        logger.exception("更新 last_login_at 失败")


# ------------------------------------------------------------------
# 鉴权 + 权限
# ------------------------------------------------------------------
def authenticate_db_user(username: str, password: str) -> Optional[Dict[str, Any]]:
    """数据库账号校验：返回 _user_row 字典；失败返回 None。"""
    if not username or not password:
        return None
    user = get_user_by_username(username)
    if not user or not user.get("is_active"):
        return None
    if not user.get("password_hash"):
        # ENV super_admin 用户：密码由调用方走 verify_admin_password
        return None
    if _verify_password(password, user["password_hash"]):
        return _user_row(user)
    return None


def get_permissions_for(username: str) -> List[str]:
    """返回该用户拥有的权限列表（如 ['booking:read', ...]）。"""
    user = get_user_by_username(username)
    if not user or not user.get("is_active"):
        return []
    if user.get("role_key") == BUILTIN_ROLE_SUPER:
        return sorted(SUPER_ADMIN_PERMS)
    role = get_role(user["role_key"])
    if not role:
        return []
    return list(role["permissions"])


def has_permission(username: str, perm: str) -> bool:
    """perm 形如 'booking:read'。super_admin 永远 True。"""
    user = get_user_by_username(username)
    if not user or not user.get("is_active"):
        return False
    if user.get("role_key") == BUILTIN_ROLE_SUPER:
        return True
    perms = get_permissions_for(username)
    return perm in perms


def get_meta() -> Dict[str, Any]:
    """前端权限面板用的元数据。"""
    return {
        "modules": [
            {"id": "booking",     "name": "预约管理"},
            {"id": "service",     "name": "服务项目"},
            {"id": "offer",       "name": "优惠活动"},
            {"id": "doctor",      "name": "医生管理"},
            {"id": "environment", "name": "环境展示"},
            {"id": "category",    "name": "分类管理"},
            {"id": "tag",         "name": "标签管理"},
            {"id": "setting",     "name": "联系方式"},
            {"id": "analytics",   "name": "数据统计"},
            {"id": "audit",       "name": "操作审计"},
            {"id": "user",        "name": "人员管理"},
            {"id": "role",        "name": "角色权限"},
        ],
        "actions": [
            {"id": "read",   "name": "查看"},
            {"id": "write",  "name": "新增/编辑"},
            {"id": "delete", "name": "删除"},
            {"id": "manage", "name": "管理"},
        ],
        "builtin_roles": [r["role_key"] for r in BUILTIN_ROLES],
    }


# ------------------------------------------------------------------
# 修改密码（自助）
# ------------------------------------------------------------------
def change_own_password(username: str, old_password: str, new_password: str,
                        env_verifier=None) -> None:
    """
    修改自身密码：
    - 数据库账号：用 bcrypt 校验旧密码，校验通过后更新 password_hash
    - ENV super_admin（password_hash 为空）：旧密码走外部传入的 env_verifier 校验，
      校验通过后会把新密码哈希落库到 admin_users，覆盖 ENV 密码（之后登录优先匹配 DB）
    """
    if old_password == new_password:
        raise ValueError("新密码不能与原密码相同")
    err = validate_password_strength(new_password)
    if err:
        raise ValueError(err)
    user = get_user_by_username(username)
    if not user or not user.get("is_active"):
        raise ValueError("账号不存在或已被禁用")

    if user.get("password_hash"):
        if not _verify_password(old_password, user["password_hash"]):
            raise ValueError("原密码不正确")
    else:
        # ENV 账号：交给外部校验器（main.verify_admin_password）
        if env_verifier is None or not env_verifier(old_password):
            raise ValueError("原密码不正确")

    new_hash = _hash_password(new_password)
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            f"UPDATE admin_users SET password_hash = {PH} WHERE username = {PH}",
            (new_hash, username),
        )
