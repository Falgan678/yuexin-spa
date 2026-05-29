# 悦心养生馆 · 服务器部署操作手册

> 本目录提供「服务器买好就能跑」的全套脚本。备案前先用 IP 跑测试，备案下来一行命令切 HTTPS。

---

## 一、上传项目到服务器

### 方式 A：SCP 直接传（推荐，最快）

> 在 **Windows 本机 PowerShell** 中（项目根目录下）执行：

```powershell
# 第一次：把整个 zip 上传
scp .\yuexin-deploy.zip root@<服务器公网IP>:/tmp/

# 然后 SSH 进服务器解压
ssh root@<服务器公网IP>
mkdir -p /opt/yuexin
cd /opt/yuexin
apt-get update && apt-get install -y unzip
unzip -o /tmp/yuexin-deploy.zip -d /opt/yuexin
```

### 方式 B：服务器上 git clone（如已托管到工蜂/GitHub）

```bash
ssh root@<服务器公网IP>
mkdir -p /opt/yuexin && cd /opt/yuexin
git clone <你的仓库地址> .
```

---

## 二、一键部署（在服务器上执行）

```bash
cd /opt/yuexin
bash deploy/install.sh
```

脚本会：

1. 装 Docker + Nginx + ufw（防火墙）
2. 用容器生成 `SESSION_SECRET`（48 位随机）
3. 让你输入 **管理员密码**（≥8 位）→ 用 bcrypt 生成哈希，**明文绝不入库**
4. 让你输入 **域名/IP**（备案前先填服务器公网 IP 也行）
5. 生成 `/opt/yuexin/.env`（权限 600，仅 root 可读）
6. 构建镜像 + 启动容器（绑定到 127.0.0.1:8000，仅内部）
7. 配 Nginx 反向代理（80 端口对外）
8. 防火墙仅放行 22/80/443

部署成功后，浏览器访问：

- 前台：`http://<你的公网 IP>/`
- 后台：`http://<你的公网 IP>/static/admin.html`（用刚刚设置的密码登录）

---

## 三、备案下来后切 HTTPS

域名 A 记录指到服务器 IP，确保 `http://<你的域名>/` 已能访问，然后：

```bash
bash /opt/yuexin/deploy/enable_https.sh yuexinys.com
```

> 把 `yuexinys.com` 换成你的真实域名。
> 脚本会用 Let's Encrypt 自动签发 + 配置 80→443 跳转 + 写入续期任务。

完成后访问：`https://yuexinys.com/` ✅

---

## 四、常用运维命令

| 操作 | 命令 |
|---|---|
| 看容器状态 | `docker ps \| grep yuexin` |
| 看实时日志 | `docker logs -f yuexin` |
| 看 Nginx 日志 | `tail -f /var/log/nginx/yuexin.access.log` |
| 重启应用 | `docker restart yuexin` |
| 更新代码（小改动） | `cd /opt/yuexin && git pull && docker build -t yuexin-spa . && docker rm -f yuexin && bash deploy/install.sh` |
| 备份 SQLite 数据 | `cp /opt/yuexin/yuexin.db /backups/yuexin-$(date +%F).db` |
| 进容器 shell | `docker exec -it yuexin bash` |
| 改管理员密码 | 编辑 `/opt/yuexin/.env` 的 `ADMIN_PASSWORD_HASH`，再 `docker restart yuexin` |

---

## 五、备案期间临时访问的 3 种方式

国内云厂商**默认在备案前不让 80/443 端口绑定域名**，但允许：

1. **直接用 IP 访问**：`http://<公网 IP>/`（chrome 浏览器会有不安全提示，但能用）
2. **8000 等高位端口访问**：把 Nginx 监听改成 `8888` 之类高位端口，绕过 80 限制
   ```nginx
   listen 8888;
   ```
   访问：`http://<公网 IP>:8888/`
3. **用 hosts 假装本机解析**：在自己电脑 `C:\Windows\System32\drivers\etc\hosts` 加一行：
   ```
   <服务器IP>  yuexinys.com
   ```
   就能本地用域名访问，但只对自己生效，**真备案才能给客户用**。

---

## 六、出问题怎么办

### ❌ 容器启动失败

```bash
docker logs yuexin
```

最常见原因：`.env` 里 `SESSION_SECRET` < 32 位 / `ADMIN_PASSWORD` 用了弱密码 → 看 `[FATAL]` 提示。

### ❌ 浏览器打不开

```bash
# 1. 容器是否健康
curl http://127.0.0.1:8000/api/health

# 2. Nginx 是否正常
systemctl status nginx
nginx -t

# 3. 防火墙是否放行 80
ufw status

# 4. 云厂商安全组是否放行 80（在腾讯云控制台 → 服务器 → 防火墙）
```

### ❌ 上传图片失败

确认 `/data/yuexin/uploads` 目录存在且可写：

```bash
ls -ld /data/yuexin/uploads
chown -R 1000:1000 /data/yuexin/uploads
```

---

## 七、完整流程时间线

```
今天             ┃ 买服务器 → scp 上传 → bash install.sh   →  IP 能访问 ✅
今天             ┃ 提交 ICP 备案
3-12 天后        ┃ 备案审核中（用 IP 给自己内部测试）
备案下来          ┃ 域名解析 → bash enable_https.sh → HTTPS 上线 ✅
```

祝上线顺利！
