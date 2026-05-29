# 悦心养生馆 - 本地开发指南

## 一、目录速览

```
.
├── main.py              # FastAPI 应用入口
├── db.py                # 数据库抽象层（SQLite / MySQL 二选一）
├── init_db.py           # 数据库初始化脚本
├── requirements.txt
├── .env.example         # 环境变量示例（拷贝为 .env 后按需修改）
├── static/              # 前端
│   ├── index.html       # 客户端 H5 页面
│   ├── admin.html       # 管理后台
│   ├── main.js / admin.js
│   ├── style.css / admin-style.css
│   └── modules/         # menu/scroll/booking/navigation/analytics
└── yuexin.db            # （运行后自动生成的 SQLite 文件）
```

## 二、首次运行（3 步）

> 默认使用 **SQLite**，无需安装数据库，开箱即用。

### 1) 安装依赖
```powershell
pip install -r requirements.txt
```

### 2) 初始化数据库（含示例数据）
```powershell
python init_db.py --with-sample
```
执行后会在项目目录生成 `yuexin.db`，并写入 5 条示例预约 + 若干埋点数据。

> 如果想清空重来：`python init_db.py --reset --with-sample`

### 3) 启动服务
```powershell
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

## 三、访问地址

| 页面 | URL |
|---|---|
| 客户端 H5 | http://127.0.0.1:8000/static/index.html |
| 管理后台 | http://127.0.0.1:8000/static/admin.html |
| API 文档 | http://127.0.0.1:8000/docs |
| 健康检查 | http://127.0.0.1:8000/api/health |

## 四、切换到 MySQL（可选）

如果以后想换成 MySQL，只需在项目目录创建 `.env` 文件：

```ini
DB_BACKEND=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=你的密码
DB_NAME=yuexin
```

然后依次：
```powershell
# Windows PowerShell 加载 .env（或直接在系统设置环境变量）
Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*([^#][^=]*)=(.*)$') { $env:($matches[1].Trim()) = $matches[2].Trim() }
}
python init_db.py --with-sample
uvicorn main:app --reload
```

## 五、常见问题

**Q: 启动时报"数据库连接失败"？**  
A: 先执行 `python init_db.py --with-sample` 建表。

**Q: 预约提交报"预约时间必须晚于当前时间"？**  
A: 弹窗里选的预约时间必须是当前之后的时间。

**Q: 管理后台看不到示例数据？**  
A: 默认筛选条件是"最近 7 天"，把日期范围切到"全部"再刷新。

**Q: 想看数据库里的真实数据？**  
A: 推荐 [DB Browser for SQLite](https://sqlitebrowser.org/) 直接打开 `yuexin.db`。

## 六、本次改动的重点修复

- ✅ 数据库改为可切换 SQLite/MySQL，本地默认 SQLite 零依赖
- ✅ 时区比较 bug 修复（之前 aware vs naive 会 500）
- ✅ SQL LIKE 通配符转义
- ✅ 异常脱敏：内部错误不再泄露到前端
- ✅ 输入校验：服务类型/医生/状态白名单 + 长度限制
- ✅ 管理后台默认加载真实预约列表（修复死代码）
- ✅ 后台所有渲染改用 DOM API，杜绝 XSS
- ✅ CSV 导出加公式注入防护
- ✅ 日志规范化（替代 print）
- ✅ 移除硬编码的数据库账号密码

## 七、本次改动新增的能力

### 1) 客户端骨架屏 + 错误兜底 Toast
- 新增 static/modules/skeleton.js + static/skeleton.css：弱网环境首屏不再白屏
- 新增 static/modules/toast.js：统一 Toast 单例，支持 success/error/warning/info/loading
- 新增 static/modules/http.js：统一 fetch 客户端，支持指数退避重试 + 12s 超时 + 401 自动清 token
- `booking.js` 已切换到新 http 客户端，5xx / 网络异常时给出明确语义提示

### 2) 后台操作审计
- 新增 `audit.py` 模块、`audit_logs` 表（启动期自动建表）
- 关键写操作（登录、预约状态/备注/编辑、服务 CRUD）自动落审计
- 新增 API：GET /api/admin/audit-logs（支持 actor/action/resource/时间多维筛选 + 分页）
- 新增独立查询页：/static/audit.html

### 3) SEO / PWA
- `index.html` 头部补充：description / keywords / OG / Twitter Card / JSON-LD / 多尺寸 favicon
- 新增 `manifest.webmanifest`、`robots.txt`、`sitemap.xml`
- 后端新增 `/robots.txt` / `/sitemap.xml` / `/manifest.webmanifest` 顶层路由

### 4) 自动化测试
- 新增 `tests/` 目录、`conftest.py` + 5 个测试文件、共 32 用例
- `requirements-dev.txt` 额外测试依赖

运行测试：
```powershell
pip install -r requirements-dev.txt
pytest
```

预期输出：`32 passed`

## 八、第二批增强（admin 集成 / CSV 导出 / CI）

### 1) 后台顶部导航集成审计入口
- `admin.html` 顶部新增 **审计** 按钮，一键跳转 `static/audit.html`
- 与现有"刷新 / 首页 / 退出"并列，零侵入现有 admin SPA 流程

### 2) 审计日志一键 CSV 导出
- 新增 API：`GET /api/admin/audit-logs/export.csv`（鉴权 + 白名单筛选）
- UTF-8 BOM，Excel 双击直接打开，中文不乱码
- **公式注入防护**：以 `= / + / - / @ / \t / \r` 开头的字段自动前置 `'`
- 单次最多导出 `50000` 条，分批拉取避免内存爆掉
- 导出动作自身写一条审计（`resource=admin, resource_id=audit_export`）
- 前端 `audit.html` 已加 **导出 CSV** 按钮，文件名带时间戳
- 新增 4 个测试用例覆盖 `导出鉴权 / 表头 / 过滤 / 公式注入防御`

### 3) GitHub Actions CI
- `.github/workflows/ci.yml`：
  - **pytest 矩阵**：Python 3.10 / 3.11 / 3.12 三版本并行跑
  - **lint job**：pyflakes 强制 + ruff 渐进 + manifest/sitemap 格式校验
  - 失败时自动上传 `.pytest_cache`、`uvicorn.log.err` 作为 artifact

预期 CI 状态：`✓ pytest (3.10/3.11/3.12)` + `✓ lint`

## 九、最终安全加固（一次性合入 P0/P1/P2）

### 启动安全断言（`config.py`）
- 默认弱密码（`yuexin123/admin/123456`...）和默认密钥（`< 32 位`）会**直接 sys.exit(1)**
- 支持 `ADMIN_PASSWORD_HASH`（bcrypt）；明文必须 ≥ 8 位
- 仅本地开发可临时设 `YUEXIN_ALLOW_DEFAULT_SECRETS=1` 跳过

### CORS 收敛 + 安全 HTTP 头
- `ALLOWED_ORIGINS` 环境变量精确白名单
- 全局注入 `X-Content-Type-Options / X-Frame-Options / Referrer-Policy / Permissions-Policy`
- `/static/uploads/` 强制 `Content-Disposition: inline` + nosniff，防当图床滥用

### Token 仅 Authorization Header
- 生产关闭 query 兜底；调试时可 `ALLOW_TOKEN_QUERY=1`
- Bearer 缺失立即 401

### 应用层限流（滑动窗口）
| 接口 | 阈值 |
|---|---|
| `POST /api/admin/login` | 5/min |
| `POST /api/bookings`    | 10/min |
| `POST /api/analytics`   | 60/min |
| `GET  /api/admin/audit-logs/export.csv` | 3/min |
- 触发返回 `429 + Retry-After`
- 多 worker / Nginx 已限流时可设 `RATE_LIMIT_ENABLED=false`

### 登录失败锁定
- 同 IP 连续 `LOGIN_FAIL_THRESHOLD`(默认 10) 次失败 → 锁定 `LOGIN_FAIL_LOCK_MINUTES`(默认 15) 分钟
- 锁定期内即使密码正确也返回 `429 Retry-After`

### 预约 (phone, datetime) 唯一约束
- 启动期自动建唯一索引 `uk_bookings_phone_dt`（兼容已有重复数据降级为普通索引）
- 重复提交返回 `409`，前端友好提示

### 埋点白名单
- `event_type` 白名单 + 正则 `^[a-z0-9_]+$`，未知事件统一兜底为 `other`
- `page_url` / `referrer` 仅接受 http(s) 或相对路径

### 数据库改进
- SQLite 启用 `WAL` 模式 + `busy_timeout=5000` + 10s 连接超时
- 解决高并发 `database is locked`

### 容器化升级（`Dockerfile`）
- 基底升级到 `python:3.12-slim`
- 非 root 用户 `yuexin` 运行
- `gunicorn -k UvicornWorker -w 2`
- `HEALTHCHECK` 30s/次 + `tini` 信号转发
- 自动安装 `bcrypt` 与 `gunicorn`

### 其他细节
- `static/admin.html` 移除"默认账号 admin/yuexin123"提示文案
- `index.html` 预约表单加 `autocomplete=name/tel` + `inputmode=numeric`，移动端键盘体验更好
- 新增 `.env.example`（含 bcrypt 哈希生成命令）

### 测试覆盖（46/46 ✓）
- 新增 `tests/test_security_hardening.py`，10 个用例：
  - CORS 拒绝/放行
  - Token query 拒绝 + Header 放行
  - 安全头注入
  - 重复预约 409
  - 登录失败锁定 + 解锁
  - 配置启动断言
  - 埋点白名单

---

## 十、🚀 生产上线 SOP（上线前请逐项核对）

### 1) 准备生产 `.env`
```bash
cp .env.production.example .env
# 用下列命令分别生成 SESSION_SECRET 和 ADMIN_PASSWORD_HASH 后填入
python -c "import secrets;print(secrets.token_urlsafe(48))"
python -c "import bcrypt;print(bcrypt.hashpw(b'<你的强密码>', bcrypt.gensalt()).decode())"
# 编辑 .env，按注释填好：
#   ADMIN_PASSWORD_HASH / SESSION_SECRET
#   ALLOWED_ORIGINS（真实域名，不含 localhost）
#   DB_BACKEND=mysql + DB_HOST/USER/PASSWORD/NAME
#   TRUST_PROXY_HEADERS=true（部署在 Nginx/网关后）
```

### 2) 数据库初始化（生产强烈建议 MySQL）
```bash
# 先在 MySQL 创建库与账号，再：
python init_db.py
```

### 3) Docker 一键部署
```bash
docker build -t yuexin-spa .
docker run -d --name yuexin \
  --env-file .env \
  -p 8000:8000 \
  -v /data/yuexin/uploads:/app/static/uploads \
  --restart unless-stopped \
  yuexin-spa
docker logs -f yuexin
```

### 4) Nginx 反向代理（推荐配置片段）
```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    # HSTS
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # 静态资源直接由 nginx 出（也可以仍走 FastAPI）
    location /static/ {
        proxy_pass http://127.0.0.1:8000;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    # 接口限流（与应用层互补）
    limit_req_zone $binary_remote_addr zone=api:10m rate=20r/s;
    location /api/ {
        limit_req zone=api burst=40 nodelay;
        proxy_pass         http://127.0.0.1:8000;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

### 5) 上线冒烟检查清单
- [ ] `curl https://your-domain/api/health` 返回 `{"status":"ok"}`
- [ ] `curl -X POST https://your-domain/api/admin/login -d '{"username":"admin","password":"<新密码>"}' -H 'Content-Type: application/json'`
- [ ] 浏览器 F12 检查首页 Console 无 error，所有请求 200/304
- [ ] 后台 `/static/admin.html` 登录后能拉到服务/优惠/医生/环境列表
- [ ] 手机号在客户端能正常提交预约 → 后台立即看到
- [ ] `curl -I https://your-domain/` 包含安全头：HSTS / X-Content-Type-Options / Referrer-Policy
- [ ] 上传一张合法 jpg ✅；上传一个改后缀的 .php ❌（应 400）
- [ ] 用 `.env` 设错（如把 `SESSION_SECRET` 删掉）→ 容器启动失败（守护机制生效）

### 6) 数据保留（自动）
- `.env` 中：
  - `ANALYTICS_RETENTION_DAYS=90`（埋点保留 90 天）
  - `AUDIT_RETENTION_DAYS=180`（审计保留 180 天）
- 应用启动时清理一次，之后每 24 小时自动清理。
- 如需手动清理：`python -c "from main import purge_expired_records; print(purge_expired_records())"`

### 7) 备份建议（MySQL）
```bash
# 加入 cron：每日凌晨 3 点全量备份并保留 14 天
0 3 * * *  mysqldump -uyuexin -p$DB_PASSWORD yuexin | gzip > /backups/yuexin-$(date +\%F).sql.gz
0 4 * * *  find /backups -name 'yuexin-*.sql.gz' -mtime +14 -delete
```

### 8) 已修复的上线必修项 ✅
| 编号 | 修复内容 | 文件 |
|---|---|---|
| H1 | 提供生产 .env 模板 | `.env.production.example` |
| H2 | SQLite 多 worker 启动警告 | `main.py` lifespan |
| H3 | analytics / audit_logs 自动定期清理 | `main.py` `purge_expired_records` |
| H4 | 上传图片用 Pillow 重编码（剥 EXIF / 防 polyglot） | `main.py` `upload_image` |
| H5 | 已确认前端 token 仅走 Authorization Header（无 `?token=`） | `static/admin.js` |
| M1 | 全局未捕获异常 → 5xx + request_id（不泄内部细节） | `main.py` |
