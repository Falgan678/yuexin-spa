# 🌿 悦心养生馆 · 全栈个人项目

> 一个**生产级**的中式养生馆官网与管理系统 — 从需求设计、UI 实现、后端架构、安全加固到 Docker 容器化部署的**完整闭环**作品。

![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.111+-009688?logo=fastapi&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-3-003B57?logo=sqlite&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)
![Tests](https://img.shields.io/badge/tests-51%20passed-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## 📌 在线演示

| 入口 | 链接 | 说明 |
|---|---|---|
| 🌐 **客户首页** | http://119.91.112.109:8888/ | 看服务、看优惠、提交预约 |
| 🛠️ **管理后台** | http://119.91.112.109:8888/static/admin.html | 完整 CRUD + 数据统计 |

> 演示账号：`admin` / `Yuexin@2026spa!`（或只读账号 `demo` / `Demo@2026`）

---

## 🎯 核心亮点

- 🌈 **64 条 RESTful API** + 完整 RBAC（4 内置角色 × 12 业务模块 × 4 动作权限矩阵）
- 🔐 **生产级安全加固**：bcrypt 密码 / HMAC-SHA256 Token / 滑动窗口限流 / 登录失败 IP 锁定 / SQL 100% 参数化
- 📁 **文件上传防护**：扩展名白名单 + 魔数校验 + **Pillow 重编码**（剥离 EXIF、阻断 polyglot 注入）
- 📜 **完整操作审计**：before/after diff 自动脱敏 / CSV 导出含公式注入防护 / 表自动清理
- 🐳 **一键部署**：Dockerfile 多阶段（tini + 非 root + healthcheck），`bash deploy/install.sh` 全自动上线
- 🧪 **51 个 pytest 用例 100% 通过** + GitHub Actions CI 矩阵（Python 3.10/3.11/3.12）

---

## 🛠️ 技术栈

| 层级 | 选型 |
|---|---|
| 后端 | Python 3.12 / **FastAPI** / Pydantic v2 / Uvicorn + Gunicorn |
| 数据库 | **SQLite**（开箱即用）/ MySQL（生产可切，无代码修改） |
| 前端 | 原生 **JavaScript ES Modules** / TailwindCSS（CDN）/ Font Awesome |
| 安全 | bcrypt / HMAC-SHA256 / **Pillow**（图片重编码）/ 自研 RBAC |
| 部署 | **Docker** + Nginx + Ubuntu 22.04 + Let's Encrypt（HTTPS 一键开启）|
| 工程化 | pytest / GitHub Actions / dataclass 化业务常量 |

---

## 🚀 5 分钟本地启动

### 方式 ① — Windows 一键启动（推荐新手）

双击运行：

```
start.bat
```

> 脚本会自动：装依赖 → 建数据库 → 启动服务 → 自动打开浏览器

### 方式 ② — Linux / macOS 一键启动

```bash
bash start.sh
```

### 方式 ③ — 手动 3 步（任何系统）

```bash
# 1. 装依赖（约 30 秒）
pip install -r requirements.txt

# 2. 初始化数据库（含 16 个服务 / 6 张环境图 / 3 条优惠 / 5 位医生 默认种子数据）
python init_db.py --with-sample

# 3. 启动
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

启动成功后浏览器打开：

- 客户首页：<http://127.0.0.1:8000/>
- 管理后台：<http://127.0.0.1:8000/static/admin.html>（默认账号 `admin` / `yuexin123`）

> ⚠️ 第一次启动会自动用默认弱密码（仅本地）。**生产部署前**请按 `.env.production.example` 配置真实密码。

### 方式 ④ — Docker 一键启动

```bash
docker build -t yuexin .
docker run -d -p 8000:8000 -e YUEXIN_ALLOW_DEFAULT_SECRETS=1 yuexin
```

---

## 📂 项目结构

```
悦心养生馆/
├── main.py                    # FastAPI 应用入口（64 条 API + 中间件 + 异常处理）
├── config.py                  # 配置加载 + 启动期安全断言
├── db.py                      # 数据库抽象（SQLite / MySQL 双后端）
├── init_db.py                 # 建表 + 平滑迁移 + 默认种子数据
├── audit.py                   # 操作审计模块（before/after diff）
├── users.py                   # RBAC 用户/角色 CRUD + 权限校验
│
├── static/                    # 前端静态资源
│   ├── index.html             # 客户首页
│   ├── admin.html             # 管理后台
│   ├── admin.js / main.js     # 前端逻辑
│   ├── style.css / admin-style.css
│   ├── modules/               # 业务模块（http/toast/services/offers/...）
│   ├── assets/                # 图片素材
│   ├── uploads/               # 用户上传的图片（运行时生成，挂载卷）
│   ├── robots.txt
│   ├── sitemap.xml
│   └── manifest.webmanifest
│
├── tests/                     # 测试套件（51 用例）
│   ├── conftest.py
│   ├── test_auth.py
│   ├── test_bookings.py
│   ├── test_audit.py
│   ├── test_seo.py
│   ├── test_security.py
│   ├── test_security_hardening.py
│   └── test_release_hardening.py
│
├── deploy/                    # 部署脚本（生产用）
│   ├── install.sh             # 一键部署主脚本
│   ├── enable_https.sh        # HTTPS 一键开启
│   ├── nginx_http.conf        # Nginx 反向代理模板
│   └── README.md              # 部署操作手册
│
├── 运营手册.md                # 给非技术人员的运营操作指南
├── README.md                  # 本文件（项目首页）
├── README_LOCAL.md            # 本地开发详细文档（含历次变更记录）
├── Dockerfile                 # 生产镜像（tini + 非 root + healthcheck）
├── .env.example               # 本地开发环境变量模板
├── .env.production.example    # 生产环境变量模板（必填项注释完整）
├── .dockerignore
├── .gitignore
├── requirements.txt           # 生产依赖
├── requirements-dev.txt       # 测试依赖
├── pytest.ini
├── start.bat                  # Windows 一键启动
└── start.sh                   # Linux/macOS 一键启动
```

---

## 🗄️ 数据模型（12 张表）

| 表 | 用途 |
|---|---|
| `bookings` | 客户预约记录（带状态机：pending → confirmed → completed） |
| `services` | 服务项目（16 个默认 SKU） |
| `service_categories` / `service_tags` | 分类/标签权威表（跨端共享） |
| `offers` | 优惠活动 |
| `doctors` | 医生/技师档案 |
| `environment_items` | 门店环境展示图 |
| `settings` | 联系方式 / 营业时间 / 微信号 等可配项 |
| `analytics` | 客户端埋点（页面访问、服务点击）|
| `audit_logs` | 管理员操作审计 |
| `admin_users` / `admin_roles` | RBAC 用户与角色 |

> 启动期自动建表、平滑迁移、种入种子数据；任何缺失字段都会自动 `ALTER TABLE ADD COLUMN`，不丢历史数据。

---

## 🧪 跑测试

```bash
pip install -r requirements-dev.txt
pytest
```

预期：`51 passed`，覆盖鉴权、审计、SEO、安全、文件上传、数据保留等关键路径。

---

## 🌐 部署到生产

完整生产部署流程见：[`deploy/README.md`](deploy/README.md)

**TL;DR**：

```bash
# 1. 在服务器上准备 .env（从 .env.production.example 复制并填好真实值）
cp .env.production.example .env
# 编辑 .env：填入 SESSION_SECRET / ADMIN_PASSWORD_HASH / ALLOWED_ORIGINS / DB_*

# 2. 一键部署
bash deploy/install.sh

# 3. 备案下来后开启 HTTPS
bash deploy/enable_https.sh your-domain.com
```

---

## 🔒 安全设计要点

| 维度 | 实现 |
|---|---|
| **SQL 注入** | 100% 参数化查询；动态字段走白名单常量 |
| **XSS** | 前端所有用户内容 `textContent` / `escapeHtml()` 处理 |
| **CSRF** | Token 仅经 `Authorization: Bearer` 头传递，禁用 query 兜底 |
| **会话** | HMAC-SHA256 签名 / TTL 8h / `compare_digest` 常量时间比较 |
| **暴力破解** | 同 IP 登录失败 10 次锁 15 分钟；登录/上传/导出 4 类限流 |
| **文件上传** | 扩展名白名单 + 魔数校验 + **Pillow 重新编码** |
| **数据保留** | 启动期 + 每日定时清理：埋点 90 天、审计 180 天 |
| **生产强校验** | `SESSION_SECRET` ≥ 32 位 / 密码非默认弱口令 / ALLOWED_ORIGINS 不含 localhost — 不通过直接 `sys.exit(1)` |

---

## 📈 待办与未来计划

- [ ] 切换到 MySQL 后端跑压测（当前 SQLite 已开 WAL）
- [ ] 接入企业微信通知（新预约推送到群）
- [ ] 客户端会员系统（积分、卡券）
- [ ] 小程序版本

---

## 📄 许可证

MIT — 自由使用、修改、商用。

---

## 🙋 关于作者

本项目由 **甘发龙** 独立设计与开发，作为全栈能力综合演示。


> ⭐ 如果这个项目对你有帮助，欢迎 Star！
