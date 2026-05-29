"""
数据库初始化脚本
- 自动创建 bookings、analytics 表与必要索引
- 自动迁移：旧表缺失字段时 ALTER TABLE ADD COLUMN
- 兼容 SQLite 与 MySQL
- 支持 --with-sample 选项插入示例数据，方便本地预览

用法：
    python init_db.py                # 仅建表+迁移
    python init_db.py --with-sample  # 建表 + 插入示例数据
    python init_db.py --reset        # 删表重建（慎用）
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta

from db import PH, get_backend, get_db_connection, get_db_info

# ------------------------------------------------------------------
# DDL：根据后端选择正确的语法
# ------------------------------------------------------------------
def get_ddl() -> list[str]:
    """主表与基础索引（不含新列 category/source 的索引，避免迁移前就引用）"""
    backend = get_backend()
    if backend == "sqlite":
        return [
            """
            CREATE TABLE IF NOT EXISTS bookings (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                name         TEXT    NOT NULL,
                phone        TEXT    NOT NULL,
                datetime     TEXT    NOT NULL,
                note         TEXT,
                service_type TEXT,
                category     TEXT,
                source       TEXT    NOT NULL DEFAULT 'normal',
                doctor       TEXT,
                status       TEXT    NOT NULL DEFAULT 'pending',
                created_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
            )
            """,
            "CREATE INDEX IF NOT EXISTS idx_bookings_phone      ON bookings(phone)",
            "CREATE INDEX IF NOT EXISTS idx_bookings_created_at ON bookings(created_at)",
            "CREATE INDEX IF NOT EXISTS idx_bookings_status     ON bookings(status)",
            """
            CREATE TABLE IF NOT EXISTS analytics (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type  TEXT NOT NULL,
                event_data  TEXT,
                user_agent  TEXT,
                ip_address  TEXT,
                page_url    TEXT,
                referrer    TEXT,
                session_id  TEXT,
                created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            )
            """,
            "CREATE INDEX IF NOT EXISTS idx_analytics_event_created ON analytics(event_type, created_at)",
            "CREATE INDEX IF NOT EXISTS idx_analytics_session       ON analytics(session_id)",
            """
            CREATE TABLE IF NOT EXISTS settings (
                key         TEXT    PRIMARY KEY,
                value       TEXT    NOT NULL DEFAULT '',
                label       TEXT    NOT NULL DEFAULT '',
                type        TEXT    NOT NULL DEFAULT 'text',
                icon        TEXT    NOT NULL DEFAULT 'fa-circle-info',
                builtin     INTEGER NOT NULL DEFAULT 0,
                sort_order  INTEGER NOT NULL DEFAULT 100,
                updated_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS services (
                id              TEXT    PRIMARY KEY,
                name            TEXT    NOT NULL,
                subtitle        TEXT    NOT NULL DEFAULT '',
                category        TEXT    NOT NULL DEFAULT '',
                image           TEXT    NOT NULL DEFAULT '',
                duration        INTEGER NOT NULL DEFAULT 60,
                price           INTEGER NOT NULL DEFAULT 0,
                original_price  INTEGER NOT NULL DEFAULT 0,
                popularity      INTEGER NOT NULL DEFAULT 50,
                tags            TEXT    NOT NULL DEFAULT '[]',
                effects         TEXT    NOT NULL DEFAULT '[]',
                suitable_for    TEXT    NOT NULL DEFAULT '',
                description     TEXT    NOT NULL DEFAULT '',
                contact_phone   TEXT    NOT NULL DEFAULT '',
                is_active       INTEGER NOT NULL DEFAULT 1,
                sort_order      INTEGER NOT NULL DEFAULT 100,
                created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
                updated_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
            )
            """,
            "CREATE INDEX IF NOT EXISTS idx_services_category  ON services(category)",
            "CREATE INDEX IF NOT EXISTS idx_services_active    ON services(is_active)",
            "CREATE INDEX IF NOT EXISTS idx_services_sort      ON services(sort_order)",
            # 分类/标签权威表：单一数据源，跨端共享
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
            "CREATE INDEX IF NOT EXISTS idx_service_categories_sort ON service_categories(sort_order)",
            "CREATE INDEX IF NOT EXISTS idx_service_tags_sort       ON service_tags(sort_order)",
            # 优惠活动表
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
            # 环境展示图片表
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
            """,
            "CREATE INDEX IF NOT EXISTS idx_env_active ON environment_items(is_active)",
            "CREATE INDEX IF NOT EXISTS idx_env_sort   ON environment_items(sort_order)",
            # 医生表
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
            """,
            "CREATE INDEX IF NOT EXISTS idx_doctors_active ON doctors(is_active)",
            "CREATE INDEX IF NOT EXISTS idx_doctors_sort   ON doctors(sort_order)",
        ]
    # MySQL
    return [
        """
        CREATE TABLE IF NOT EXISTS bookings (
            id           BIGINT       NOT NULL AUTO_INCREMENT,
            name         VARCHAR(100) NOT NULL,
            phone        VARCHAR(20)  NOT NULL,
            datetime     DATETIME     NOT NULL,
            note         VARCHAR(500),
            service_type VARCHAR(100),
            category     VARCHAR(50),
            source       VARCHAR(40)  NOT NULL DEFAULT 'normal',
            doctor       VARCHAR(100),
            status       VARCHAR(20)  NOT NULL DEFAULT 'pending',
            created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_phone      (phone),
            KEY idx_created_at (created_at),
            KEY idx_status     (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """,
        """
        CREATE TABLE IF NOT EXISTS analytics (
            id         BIGINT       NOT NULL AUTO_INCREMENT,
            event_type VARCHAR(50)  NOT NULL,
            event_data TEXT,
            user_agent VARCHAR(500),
            ip_address VARCHAR(64),
            page_url   VARCHAR(500),
            referrer   VARCHAR(500),
            session_id VARCHAR(100),
            created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_event_created (event_type, created_at),
            KEY idx_session       (session_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """,
        """
        CREATE TABLE IF NOT EXISTS settings (
            `key`      VARCHAR(80)  NOT NULL,
            value      VARCHAR(500) NOT NULL DEFAULT '',
            label      VARCHAR(80)  NOT NULL DEFAULT '',
            type       VARCHAR(20)  NOT NULL DEFAULT 'text',
            icon       VARCHAR(40)  NOT NULL DEFAULT 'fa-circle-info',
            builtin    TINYINT      NOT NULL DEFAULT 0,
            sort_order INT          NOT NULL DEFAULT 100,
            updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`key`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """,
        """
        CREATE TABLE IF NOT EXISTS services (
            id              VARCHAR(40)  NOT NULL,
            name            VARCHAR(80)  NOT NULL,
            subtitle        VARCHAR(120) NOT NULL DEFAULT '',
            category        VARCHAR(20)  NOT NULL DEFAULT '',
            image           VARCHAR(500) NOT NULL DEFAULT '',
            duration        INT          NOT NULL DEFAULT 60,
            price           INT          NOT NULL DEFAULT 0,
            original_price  INT          NOT NULL DEFAULT 0,
            popularity      INT          NOT NULL DEFAULT 50,
            tags            VARCHAR(200) NOT NULL DEFAULT '[]',
            effects         VARCHAR(500) NOT NULL DEFAULT '[]',
            suitable_for    VARCHAR(120) NOT NULL DEFAULT '',
            description     TEXT,
            contact_phone   VARCHAR(40)  NOT NULL DEFAULT '',
            is_active       TINYINT      NOT NULL DEFAULT 1,
            sort_order      INT          NOT NULL DEFAULT 100,
            created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_category (category),
            KEY idx_active   (is_active),
            KEY idx_sort     (sort_order)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """,
        # 分类/标签权威表
        """
        CREATE TABLE IF NOT EXISTS service_categories (
            id          VARCHAR(40)  NOT NULL,
            name        VARCHAR(60)  NOT NULL,
            icon        VARCHAR(40)  NOT NULL DEFAULT 'fa-spa',
            builtin     TINYINT      NOT NULL DEFAULT 0,
            sort_order  INT          NOT NULL DEFAULT 100,
            created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_sort (sort_order)
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
            PRIMARY KEY (id),
            KEY idx_sort (sort_order)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """,
        # 优惠活动表
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
        # 环境展示图片表
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
        """,
        # 医生表
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
        """,
    ]


def get_post_migration_ddl() -> list[str]:
    """迁移完成后再创建依赖新列的索引"""
    backend = get_backend()
    if backend == "sqlite":
        return [
            "CREATE INDEX IF NOT EXISTS idx_bookings_category ON bookings(category)",
            "CREATE INDEX IF NOT EXISTS idx_bookings_source   ON bookings(source)",
        ]
    return [
        "CREATE INDEX IF NOT EXISTS idx_bookings_category ON bookings(category)",
        "CREATE INDEX IF NOT EXISTS idx_bookings_source   ON bookings(source)",
    ]


# ------------------------------------------------------------------
# 联系我们 · 默认配置项（仅在 settings 表为空时种入）
# ------------------------------------------------------------------
DEFAULT_SETTINGS = [
    # key, value, label, type, icon, builtin, sort_order
    ("contact_phone",   "400-888-8888",         "预约电话", "phone",  "fa-phone-alt",        1, 10),
    ("contact_address", "深圳市南山区科技园南区", "门店地址", "text",   "fa-map-marker-alt",   1, 20),
    ("contact_hours",   "10:00 - 22:00",        "营业时间", "text",   "far fa-clock",        1, 30),
    ("contact_wechat",  "Ethan_GanSYU3068690",  "微信咨询", "wechat", "fab fa-weixin",       1, 40),
    # 环境模块文案（与环境图片同步管理）
    ("env_eyebrow",     "ENVIRONMENT",                "环境-小标题（英文）", "text", "fa-feather", 1, 110),
    ("env_title",       "静谧雅致 · 沉浸空间",        "环境-主标题",         "text", "fa-feather", 1, 120),
    ("env_subtitle",    "每一处细节都为您的身心松弛而设计", "环境-副标题",     "text", "fa-feather", 1, 130),
    ("env_autoplay_ms", "4500",                       "环境-默认轮播停留时间(ms)", "text", "far fa-clock", 1, 140),
]


def seed_default_settings() -> None:
    """如 settings 表为空则种入默认值；已有值则跳过。"""
    backend = get_backend()
    key_col = "key" if backend == "sqlite" else "`key`"
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) AS c FROM settings")
        if (cur.fetchone() or {}).get("c", 0) > 0:
            print("[skip] settings 已存在，跳过默认值种入")
            return
        cur.executemany(
            f"INSERT INTO settings ({key_col}, value, label, type, icon, builtin, sort_order) "
            f"VALUES ({PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH})",
            DEFAULT_SETTINGS,
        )
        print(f"[ok]   写入 {len(DEFAULT_SETTINGS)} 条默认联系方式配置")


def seed_default_services_stub() -> None:
    """占位：真正的实现见下方（早先的删除/编辑误删恢复用）"""
    pass


# ------------------------------------------------------------------
# 分类 / 标签 · 默认种子（与 static/data/services.js 对齐，且作为权威源）
# ------------------------------------------------------------------
DEFAULT_CATEGORIES = [
    # id, name, icon, builtin, sort_order
    ("chinese", "中式调理", "fa-yin-yang",     1, 10),
    ("thai",    "泰式 SPA", "fa-leaf",         1, 20),
    ("aroma",   "芳疗护理", "fa-pump-soap",    1, 30),
    ("foot",    "足疗保健", "fa-shoe-prints",  1, 40),
]

DEFAULT_TAGS = [
    # id, label, color, builtin, sort_order
    ("hot",       "热门",     "bg-rose-500",    1, 10),
    ("new",       "新品",     "bg-emerald-500", 1, 20),
    ("female",    "女士专享", "bg-pink-500",    1, 30),
    ("couple",    "情侣套餐", "bg-violet-500",  1, 40),
    ("recommend", "主推",     "bg-amber-500",   1, 50),
]


def seed_default_categories_and_tags() -> None:
    """种入内置分类与标签；已存在的内置项做名称/图标/颜色对齐（不动 sort_order）。"""
    with get_db_connection() as conn:
        cur = conn.cursor()
        # 分类
        for cid, name, icon, builtin, sort_order in DEFAULT_CATEGORIES:
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
        # 标签
        for tid, label, color, builtin, sort_order in DEFAULT_TAGS:
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
        print(f"[ok]   分类/标签内置项已对齐（{len(DEFAULT_CATEGORIES)} 类、{len(DEFAULT_TAGS)} 签）")


# ------------------------------------------------------------------
# 服务项目 · 默认种子（16 项，与 static/data/services.js 对齐）
# ------------------------------------------------------------------
import json as _json

DEFAULT_SERVICES = [
    # (id, name, subtitle, category, image, duration, price, original_price, popularity, tags, effects, suitable_for, description, sort_order)
    ("s-cn-1", "经络推拿", "传统手法 · 疏通经络", "chinese",
     "assets/images/service-cn-meridian.jpg",
     60, 198, 268, 95, ["hot", "recommend"],
     ["疏通经络", "缓解肌肉疲劳", "改善血液循环"],
     "久坐人群、肩颈僵硬",
     "采用传统中医推拿手法，以揉、按、滚、点为主，配合穴位刺激，深度疏通经络，缓解长期久坐带来的肩颈与腰背不适。",
     10),
    ("s-cn-2", "刮痧拔罐", "祛湿排毒 · 行气活血", "chinese",
     "assets/images/service-cn-cupping.jpg",
     45, 158, 218, 78, ["recommend"],
     ["祛湿排寒", "行气活血", "舒缓疲劳"],
     "湿气重、易疲劳人群",
     "采用纯铜砭板与玻璃火罐，沿膀胱经走罐刮痧，帮助代谢体内湿浊，激活背部阳气。",
     20),
    ("s-cn-3", "艾灸调理", "温阳散寒 · 滋补元气", "chinese",
     "assets/images/service-cn-herbal.jpg",
     60, 188, 258, 82, ["female"],
     ["温阳散寒", "调理宫寒", "提升免疫"],
     "宫寒、手脚冰凉、体虚",
     "选用三年陈艾绒，依据经络辨证选穴，借灸火之力深透经络，温补阳气，特别适合体虚、宫寒女性。",
     30),
    ("s-cn-4", "小儿推拿", "绿色调理 · 增强体质", "chinese",
     "assets/images/service-cn-child.jpg",
     30, 128, 168, 65, ["new"],
     ["增强免疫", "健脾开胃", "改善睡眠"],
     "3-12 岁儿童",
     "由国家认证小儿推拿师施术，全程无针无药，针对儿童积食、感冒、咳嗽、睡眠不佳等常见问题进行温和调理。",
     40),
    ("s-th-1", "泰式古法", "异域风情 · 深度放松", "thai",
     "assets/images/service-thai-classic.jpg",
     90, 268, 358, 91, ["hot"],
     ["深度放松", "柔韧筋骨", "释放压力"],
     "久坐、运动量少人群",
     "由泰国本土资深技师施术，融合按压、拉伸与瑜伽手法，全身经络深度梳理，一次相当于做了三小时瑜伽。",
     50),
    ("s-th-2", "皇家泰式 SPA", "尊享体验 · 全程一对一", "thai",
     "assets/images/service-thai-royal.jpg",
     120, 588, 798, 88, ["recommend", "couple"],
     ["全身放松", "改善睡眠", "尊享体验"],
     "高品质追求者",
     "120 分钟皇家级享受，含足浴、全身按摩、香薰头疗与花瓣浴，一对一资深技师全程服务。",
     60),
    ("s-th-3", "热石能量按摩", "玄武岩 · 深层热疗", "thai",
     "assets/images/service-thai-hotstone.jpg",
     75, 328, 458, 76, ["new"],
     ["温通经络", "深层放松", "改善循环"],
     "寒性体质、肌肉紧张",
     "采用 55°C 玄武岩热石沿经络滑行，热力深透肌理，对寒性体质与运动后僵硬尤其有效。",
     70),
    ("s-th-4", "四手联弹按摩", "双人技师 · 极致享受", "thai",
     "assets/images/service-thai-fourhands.jpg",
     90, 488, 668, 70, ["couple", "new"],
     ["左右同步", "极致放松", "尊享体验"],
     "追求极致体验",
     "两位训练有素的技师左右同步施术，节奏如音乐般和谐，是一次远超预期的感官旅程。",
     80),
    ("s-ar-1", "精油全身 SPA", "芳香疗法 · 身心愉悦", "aroma",
     "assets/images/service-aroma-fullbody.jpg",
     90, 328, 458, 93, ["hot", "female"],
     ["舒缓身心", "美容养颜", "改善睡眠"],
     "压力大、皮肤干燥",
     "选用法国 Decléor 进口纯天然单方精油，根据当下身体状态调香，配合芳疗师专业手法，让身心同时回到平衡。",
     90),
    ("s-ar-2", "香薰背部护理", "深层清洁 · 焕亮肤质", "aroma",
     "assets/images/service-aroma-back.jpg",
     60, 268, 358, 80, ["female"],
     ["清洁毛孔", "改善背痘", "焕亮肤质"],
     "背部痤疮、肤色暗沉",
     "深层去角质 + 蒸汽舒缓 + 精油按摩 + 海藻面膜，让后背重回光洁。",
     100),
    ("s-ar-3", "淋巴排毒按摩", "雕塑身形 · 加速代谢", "aroma",
     "assets/images/service-aroma-lymph.jpg",
     75, 358, 488, 85, ["female", "recommend"],
     ["消除水肿", "雕塑身形", "加速代谢"],
     "水肿、代谢慢",
     "专业淋巴引流手法 + 葡萄柚迷迭香精油，针对腿部、腹部、手臂水肿进行精准引流。",
     110),
    ("s-ar-4", "面部芳疗护理", "法式手法 · 抗衰养肤", "aroma",
     "assets/images/service-aroma-facial.jpg",
     60, 298, 398, 79, ["female", "new"],
     ["提拉紧致", "改善暗沉", "深层补水"],
     "初老肌、暗沉肌",
     "采用法式手雕脸部按摩手法，配合玫瑰、橙花、乳香精油，唤醒肌肤紧致与光泽。",
     120),
    ("s-ft-1", "中式足底按摩", "反射疗法 · 养生保健", "foot",
     "assets/images/service-foot-reflexology.jpg",
     45, 99, 158, 90, ["hot"],
     ["调理脏腑", "促进代谢", "增强免疫"],
     "所有人群",
     "基于中医反射学，刺激足底 60+ 反射区，配合中药足浴，性价比之选。",
     130),
    ("s-ft-2", "中药养生足浴", "十二经络 · 由足入身", "foot",
     "assets/images/service-foot-herbalbath.jpg",
     60, 138, 198, 75, ["recommend"],
     ["驱寒祛湿", "助眠安神", "舒缓疲劳"],
     "失眠、足部冰凉",
     "使用艾叶、生姜、藏红花等 12 味中药包，65°C 恒温足浴 30 分钟 + 30 分钟足底点按。",
     140),
    ("s-ft-3", "肩颈头部调理", "深度放松 · 缓解头痛", "foot",
     "assets/images/service-foot-shoulder.jpg",
     30, 88, 128, 86, ["hot"],
     ["缓解头痛", "改善失眠", "放松肩颈"],
     "电脑族、头痛人群",
     "专为长时间面对屏幕的人设计，针对斜方肌、肩胛提肌进行深度松解，30 分钟立刻轻松。",
     150),
    ("s-ft-4", "印度头部 SPA", "香薰头疗 · 重塑发质", "foot",
     "assets/images/service-foot-headspa.jpg",
     60, 188, 268, 72, ["new", "female"],
     ["改善脱发", "舒缓头皮", "安神助眠"],
     "脱发、用脑过度",
     "印度阿育吠陀传统头部按摩，配合椰子油与迷迭香精油，深度疏通头皮气血。",
     160),
]


def seed_default_services() -> None:
    """如 services 表为空则种入默认 16 个项目；已有值则跳过。"""
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) AS c FROM services")
        if (cur.fetchone() or {}).get("c", 0) > 0:
            print("[skip] services 已存在，跳过默认服务种入")
            return
        rows = []
        for s in DEFAULT_SERVICES:
            (sid, name, subtitle, category, image, duration, price, original_price,
             popularity, tags, effects, suitable_for, description, sort_order) = s
            rows.append((
                sid, name, subtitle, category, image,
                duration, price, original_price, popularity,
                _json.dumps(tags, ensure_ascii=False),
                _json.dumps(effects, ensure_ascii=False),
                suitable_for, description, "", 1, sort_order,
            ))
        cur.executemany(
            f"INSERT INTO services "
            f"(id, name, subtitle, category, image, duration, price, original_price, "
            f" popularity, tags, effects, suitable_for, description, contact_phone, is_active, sort_order) "
            f"VALUES ({PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, "
            f"        {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH})",
            rows,
        )
        print(f"[ok]   写入 {len(rows)} 个服务项目")


def get_drop_sql() -> list[str]:
    return [
        "DROP TABLE IF EXISTS bookings",
        "DROP TABLE IF EXISTS analytics",
        "DROP TABLE IF EXISTS settings",
        "DROP TABLE IF EXISTS services",
        "DROP TABLE IF EXISTS service_categories",
        "DROP TABLE IF EXISTS service_tags",
        "DROP TABLE IF EXISTS offers",
        "DROP TABLE IF EXISTS environment_items",
        "DROP TABLE IF EXISTS doctors",
    ]


# ------------------------------------------------------------------
# 环境展示 · 默认种子
# ------------------------------------------------------------------
DEFAULT_ENVIRONMENT_ITEMS = [
    # image, title, description, alt, size, sort_order
    ("assets/images/environment-bright-room.jpg",
     "明亮护理空间",
     "采光通透 · 大面积留白带来开阔与从容，每一寸光影都为身心舒展而设计。",
     "明亮洁净的养生护理空间", "large", 10),
    ("assets/images/environment-warm-room.jpg",
     "温润疗愈室",
     "原木与艾草交织的香气，木质纹理与暖光环绕，让您一进门即沉浸在山林间的宁静。",
     "温润木质疗愈护理室", "medium", 20),
    ("assets/images/service-aroma-fullbody.jpg",
     "私人芳疗包房",
     "独立精油调香区 · 每一次呼吸都是植物精灵的低语，唤醒身心深处的轻盈。",
     "私人芳疗包房", "tall", 30),
    ("assets/images/service-thai-royal.jpg",
     "皇家泰式 SPA 套间",
     "120 ㎡ 双人套间 · 花瓣浴、足浴、按摩床一应俱全，尊享 1V1 资深技师全程服务。",
     "皇家泰式 SPA 套间", "wide", 40),
    ("assets/images/service-foot-herbalbath.jpg",
     "中药养生足浴区",
     "12 味中药 · 65℃ 恒温足浴，让寒湿从足底缓缓散去，由足入身。",
     "中药养生足浴区", "medium", 50),
    ("assets/images/service-cn-herbal.jpg",
     "艾灸调理室",
     "三年陈艾 · 经络辨证选穴，借灸火之力深透经络，温补阳气。",
     "艾灸调理室", "medium", 60),
]


def seed_default_environment_items() -> None:
    """如 environment_items 表为空则种入默认 6 张环境图；已有值则跳过。"""
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) AS c FROM environment_items")
        if (cur.fetchone() or {}).get("c", 0) > 0:
            print("[skip] environment_items 已存在，跳过默认种入")
            return
        rows = []
        for image, title, desc, alt, size, sort_order in DEFAULT_ENVIRONMENT_ITEMS:
            rows.append((image, title, desc, alt, size, 1, sort_order))
        cur.executemany(
            f"INSERT INTO environment_items "
            f"(image, title, description, alt, size, is_active, sort_order) "
            f"VALUES ({PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH})",
            rows,
        )
        print(f"[ok]   写入 {len(rows)} 张默认环境图片")


# ------------------------------------------------------------------
# 医生 · 默认种子（与原 ALLOWED_DOCTORS 列表保持一致）
# ------------------------------------------------------------------
DEFAULT_DOCTORS = [
    # name, title, avatar, bio, sort_order
    ("李医生", "中医推拿主治医师", "", "10 年中医推拿经验，擅长经络调理、肩颈腰背放松。", 10),
    ("王医生", "泰式 SPA 资深技师", "", "泰国本土认证，皇家泰式 SPA 与古法按摩专家。",  20),
    ("张医生", "高级芳疗师",       "", "法国 Decléor 认证芳疗师，专注精油 SPA 与面部护理。", 30),
    ("刘医生", "足疗保健师",       "", "中医反射学执业 8 年，擅长足底反射区调理。",         40),
    ("陈医生", "艾灸调理师",       "", "国家高级中医康复理疗师，擅长艾灸宫寒调理。",         50),
]


def seed_default_doctors() -> None:
    """如 doctors 表为空则种入默认 5 位医生；已有值则跳过。"""
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) AS c FROM doctors")
        if (cur.fetchone() or {}).get("c", 0) > 0:
            print("[skip] doctors 已存在，跳过默认种入")
            return
        rows = []
        for name, title, avatar, bio, sort_order in DEFAULT_DOCTORS:
            rows.append((name, title, avatar, bio, 1, sort_order))
        cur.executemany(
            f"INSERT INTO doctors (name, title, avatar, bio, is_active, sort_order) "
            f"VALUES ({PH}, {PH}, {PH}, {PH}, {PH}, {PH})",
            rows,
        )
        print(f"[ok]   写入 {len(rows)} 位默认医生")


# ------------------------------------------------------------------
# 优惠活动 · 默认种子（与首页 #offers 内容一一对应）
# ------------------------------------------------------------------
DEFAULT_OFFERS = [
    # offer_key, name, icon, theme, price, original_price, price_suffix, features, btn_text, source, sort_order
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


def seed_default_offers() -> None:
    """如 offers 表为空则种入默认 3 条优惠活动；已有值则跳过。"""
    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) AS c FROM offers")
        if (cur.fetchone() or {}).get("c", 0) > 0:
            print("[skip] offers 已存在，跳过默认优惠种入")
            return
        rows = []
        for o in DEFAULT_OFFERS:
            (okey, name, icon, theme, price, orig, suffix,
             features, btn_text, source, sort_order) = o
            rows.append((
                okey, name, icon, theme, price, orig, suffix,
                _json.dumps(features, ensure_ascii=False),
                btn_text, source, 1, sort_order,
            ))
        cur.executemany(
            f"INSERT INTO offers "
            f"(offer_key, name, icon, theme, price, original_price, price_suffix, "
            f" features, btn_text, source, is_active, sort_order) "
            f"VALUES ({PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH})",
            rows,
        )
        print(f"[ok]   写入 {len(rows)} 条默认优惠活动")


# ------------------------------------------------------------------
# 平滑迁移：检查并添加缺失字段（保留旧数据）
# ------------------------------------------------------------------
def migrate_schema() -> None:
    """检测 bookings 表是否有 category / source 列，没有则 ALTER 添加。"""
    backend = get_backend()
    with get_db_connection() as conn:
        cur = conn.cursor()
        # 拿到现有列
        if backend == "sqlite":
            cur.execute("PRAGMA table_info(bookings)")
            cols = {row["name"] for row in cur.fetchall()}
            if not cols:
                return  # 表还不存在，由 DDL 创建
            if "category" not in cols:
                cur.execute("ALTER TABLE bookings ADD COLUMN category TEXT")
                print("[ok]   迁移：bookings 新增 category 列")
            if "source" not in cols:
                cur.execute("ALTER TABLE bookings ADD COLUMN source TEXT NOT NULL DEFAULT 'normal'")
                print("[ok]   迁移：bookings 新增 source 列")
        else:
            cur.execute("""
                SELECT COLUMN_NAME FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bookings'
            """)
            cols = {row["COLUMN_NAME"] for row in cur.fetchall()}
            if not cols:
                return
            if "category" not in cols:
                cur.execute("ALTER TABLE bookings ADD COLUMN category VARCHAR(50)")
                print("[ok]   迁移：bookings 新增 category 列")
            if "source" not in cols:
                cur.execute("ALTER TABLE bookings ADD COLUMN source VARCHAR(40) NOT NULL DEFAULT 'normal'")
                print("[ok]   迁移：bookings 新增 source 列")


# ------------------------------------------------------------------
# 示例数据
# ------------------------------------------------------------------
def insert_sample_data() -> None:
    now = datetime.now()
    bookings_sample = [
        # name, phone, datetime, note, service_type, category, source, doctor, status
        ("张三", "13800138000", (now + timedelta(days=1, hours=2)).strftime("%Y-%m-%d %H:%M:%S"),
         "首次到店，希望安排资深技师", "经络推拿", "chinese", "new_customer", "李医生", "confirmed"),
        ("李四", "13800138001", (now + timedelta(days=2)).strftime("%Y-%m-%d %H:%M:%S"),
         "颈椎不适", "泰式古法", "thai", "normal", "王医生", "pending"),
        ("王五", "13800138002", (now + timedelta(days=3, hours=4)).strftime("%Y-%m-%d %H:%M:%S"),
         "纪念日双人 SPA", "皇家泰式 SPA", "thai", "couple_package", "张医生", "pending"),
        ("赵六", "13800138003", (now - timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S"),
         "已完成消费", "中式足底按摩", "foot", "normal", "刘医生", "completed"),
        ("孙七", "13800138004", (now + timedelta(hours=5)).strftime("%Y-%m-%d %H:%M:%S"),
         "改约时间", "精油全身 SPA", "aroma", "member", "陈医生", "rescheduled"),
    ]
    analytics_sample = [
        ("page_view", '{"title":"悦心养生馆"}', "session_demo_1"),
        ("page_view", '{"title":"悦心养生馆"}', "session_demo_2"),
        ("service_view", '{"service":"经络推拿"}', "session_demo_1"),
        ("service_view", '{"service":"精油全身 SPA"}', "session_demo_1"),
        ("service_view", '{"service":"经络推拿"}', "session_demo_2"),
        ("booking_click", '{"service":"经络推拿"}', "session_demo_1"),
    ]

    with get_db_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) AS c FROM bookings")
        if (cur.fetchone() or {}).get("c", 0) > 0:
            print("[skip] bookings 已存在数据，跳过示例 bookings 写入")
        else:
            cur.executemany(
                f"INSERT INTO bookings (name, phone, datetime, note, service_type, category, source, doctor, status) "
                f"VALUES ({PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH}, {PH})",
                bookings_sample,
            )
            print(f"[ok]   写入 {len(bookings_sample)} 条示例预约")

        cur.execute("SELECT COUNT(*) AS c FROM analytics")
        if (cur.fetchone() or {}).get("c", 0) > 0:
            print("[skip] analytics 已存在数据，跳过示例 analytics 写入")
        else:
            cur.executemany(
                f"INSERT INTO analytics (event_type, event_data, session_id) "
                f"VALUES ({PH}, {PH}, {PH})",
                analytics_sample,
            )
            print(f"[ok]   写入 {len(analytics_sample)} 条示例统计")


# ------------------------------------------------------------------
# 主流程
# ------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(description="初始化悦心养生馆数据库")
    parser.add_argument("--with-sample", action="store_true", help="同时插入示例数据")
    parser.add_argument("--reset", action="store_true", help="先删表再建（会清空数据）")
    args = parser.parse_args()

    print(f"[db]   使用数据库：{get_db_info()}")

    with get_db_connection() as conn:
        cur = conn.cursor()
        if args.reset:
            for sql in get_drop_sql():
                cur.execute(sql)
            print("[ok]   已删除旧表")
        for sql in get_ddl():
            cur.execute(sql)
        print("[ok]   建表完成")

    # 平滑迁移已存在的旧表
    migrate_schema()

    # 迁移完成后才能建依赖新列的索引
    with get_db_connection() as conn:
        cur = conn.cursor()
        for sql in get_post_migration_ddl():
            cur.execute(sql)

    # 种入默认联系方式（仅当为空时）
    seed_default_settings()
    # 种入/对齐内置分类与标签（每次运行都会保证内置项名称/图标/颜色一致）
    seed_default_categories_and_tags()
    # 种入默认服务项目（仅当为空时）
    seed_default_services()
    # 种入默认优惠活动（仅当为空时）
    seed_default_offers()
    # 种入默认环境图片（仅当为空时）
    seed_default_environment_items()
    # 种入默认医生（仅当为空时）
    seed_default_doctors()

    if args.with_sample:
        insert_sample_data()

    print("[done] 数据库初始化完成")


if __name__ == "__main__":
    main()
