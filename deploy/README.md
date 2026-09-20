# 生产部署（Linux + Node + Nginx + PostgreSQL）

按顺序执行。命令以 Ubuntu/Debian 为例，路径约定部署根为 `/opt/staff-vote`。

## 0. 前置条件

- Linux 服务器已装 Node.js ≥ 22.19、pnpm、Nginx、PostgreSQL 15+
- 一个可用的 PostgreSQL 实例与超级用户权限（用于建库建号）

## 1. 创建系统用户与目录

采用**整个仓库原样部署**的布局：

```
/opt/staff-vote/              仓库根（pnpm workspace）
├─ apps/api/                  后端（systemd 的工作目录）
├─ apps/web/dist/             前端构建产物（Nginx 直接指向，无需拷贝）
└─ deploy/                    Nginx 与 systemd 配置模板
```

```bash
sudo useradd --system --shell /usr/sbin/nologin --home /opt/staff-vote staff-vote

# 把仓库放进来（git clone 或 rsync 皆可）
# sudo git clone <仓库地址> /opt/staff-vote

sudo chown -R staff-vote:staff-vote /opt/staff-vote
sudo -u staff-vote mkdir -p /opt/staff-vote/apps/api/logs
```

> 为什么不是只拷 `apps/api`：pnpm 依赖仓库根的 `pnpm-workspace.yaml` 与
> `pnpm-lock.yaml` 才能正确解析依赖树，拆开部署会让安装结果与开发环境不一致。

## 2. 准备数据库

用超级用户执行仓库里的脚本（先改掉其中的 `CHANGE_ME` 口令）：

```bash
psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -f sql/00_roles_and_databases.sql
```

该脚本创建：

- 角色 `staff`（**不给 CREATEDB**：迁移工作流不需要 shadow database，共享实例上不应具备随意建库的能力）
- 库 `staff`（生产库，UTF8 + `zh_CN.UTF-8`）

脚本里的集成测试库是注释状态，**生产环境不需要创建**。

**生产环境不要设置 `TEST_DATABASE_URL`**，避免误连测试库。

## 3. 部署后端

在**仓库根**安装依赖，再执行后端专属脚本：

```bash
cd /opt/staff-vote                 # 仓库根

pnpm install --prod=false          # 构建需要 devDependencies（prisma、typescript）
cp apps/api/.env.example apps/api/.env
chmod 600 apps/api/.env
vi apps/api/.env                   # 见下方「必须填写的变量」

cd apps/api                        # 以下脚本定义在 apps/api/package.json
pnpm db:generate                   # 生成 Prisma Client
pnpm db:deploy                     # 应用迁移（不创建 shadow 库、不重置数据）
pnpm db:seed                       # 初始管理员 + 默认票种 + 设置项
pnpm build                         # tsc 产出 apps/api/dist
```

> **不要执行 `pnpm prune --prod`**：后续升级时要用 `prisma migrate deploy`，
> 而 prisma CLI 在 devDependencies 里，剪掉它会让下次迁移无法执行。

`.env` 必须填写：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | 指向生产库，**不要**指向开发库 |
| `JWT_SECRET` | 至少 32 字符；生成：`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 首次 seed 写入的管理员，登录后立即修改口令 |
| `NODE_ENV` | `production`（会启用 Cookie 的 Secure 标志，故需 HTTPS） |
| `TZ` | `Asia/Shanghai` |
| `SENSITIVE_FIELD_KEY` | 仅在将来需要加密敏感字段时填写 |

> **关于库外口令**：`ADMIN_PASSWORD` 只是 seed 的输入，数据库中存的是 scrypt 单向哈希，
> 不存明文、也不存可逆加密值。详见设计文档第 6 节。

## 4. 部署前端

```bash
cd /opt/staff-vote/apps/web
pnpm build                       # 产出 apps/web/dist
```

Nginx 配置直接指向该目录（下一步），**不需要拷贝产物** ——
每次重新构建后静态文件即已更新，少一次 rsync 就少一处版本不一致的可能。

前端通过同域 `/api` 调用后端（`vite.config.ts` 里的开发代理仅用于本地开发），
生产不需要额外的 API 地址配置。

## 5. 配置 Nginx

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/staff-vote
sudo ln -sf /etc/nginx/sites-available/staff-vote /etc/nginx/sites-enabled/staff-vote
sudo nginx -t
sudo systemctl reload nginx
```

记得修改 `server_name`。若启用 HTTPS，`NODE_ENV=production` 下管理端 Cookie 带 `Secure`，
必须走 HTTPS 才能登录。

## 6. 配置 systemd

```bash
sudo cp deploy/staff-vote-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now staff-vote-api
sudo systemctl status staff-vote-api --no-pager
sudo journalctl -u staff-vote-api -f
```

## 7. 验证

```bash
# 后端存活
curl -s http://127.0.0.1:3000/api/health
# 期望：{"ok":true,"ts":"..."}

# 经 Nginx 的投票状态接口
curl -s http://<域名或IP>/api/vote/status
# 未开放时：{"open":false,"message":"当前未开放投票",...}

# 前端可访问
curl -sI http://<域名或IP>/ | head -1
```

然后在浏览器完成一次真实流程：登录后台 → 建部门与职工 → 配项点 → 发码 →
用码在投票入口提交 → 回后台看统计与导出。

## 8. 升级流程

```bash
cd /opt/staff-vote                     # 仓库根
sudo -u staff-vote git pull
sudo -u staff-vote pnpm install --prod=false

cd apps/api
sudo -u staff-vote pnpm db:generate    # schema 若变更需重新生成 Client
sudo -u staff-vote pnpm db:deploy      # 先迁移
sudo -u staff-vote pnpm build

cd ../web
sudo -u staff-vote pnpm build          # 产物由 Nginx 直接托管，无需拷贝

sudo systemctl restart staff-vote-api
```

**顺序很重要**：先迁移再重启。反过来会出现新代码读旧表结构。

回滚时注意迁移不可逆，请先备份（见下）。

## 9. 备份

```bash
# 数据库（含评分数据与随机码）
pg_dump -h 127.0.0.1 -U staff -Fc staff > /var/backups/staff-vote-$(date +%F).dump

# 恢复
pg_restore -h 127.0.0.1 -U staff -d staff --clean --if-exists /var/backups/staff-vote-2026-09-19.dump
```

建议加入 crontab 每日执行，并定期演练恢复 —— 没演练过的备份等于没有备份。

## 10. 常见问题

| 现象 | 原因 |
|---|---|
| 管理端登录后立刻跳回登录页 | `NODE_ENV=production` 时 Cookie 带 `Secure`，但站点走的是 HTTP。改走 HTTPS 或临时设 `NODE_ENV=development` 验证配置 |
| 限流把所有人算作同一个人 | Nginx 未透传 `X-Forwarded-For`，或后端未设置 `trust proxy`（本项目已在 `src/app.ts` 设为 1） |
| 时间显示差 8 小时 | 服务器未设 `TZ=Asia/Shanghai`（systemd 单元里已固定） |
| `prisma migrate deploy` 报无权限 | `staff` 不是目标库的 owner，检查建库脚本是否用 `OWNER = staff` |
| 导入职工名单报 413 | Nginx `client_max_body_size` 太小（模板已设 10m） |