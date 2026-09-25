# 职工素质评议系统（staff-vote）

职工素质项点打分系统。职工凭后台发放的**票种随机码**匿名登录投票入口，选择部门后在一张与 `docs/参考表.xlsx` 同形的表单上按素质项点打分；管理员在后台配置打分表结构（问卷类型、表头文案、被评列、项点与描述）、发放随机码、控制投票开放时间，并实时查看发码与投票进度、导出结果。

- **匿名性**：评分表与随机码物理隔断，无法从任何一张评分反推投票人
- **动态表单**：行 = 评价项点（含描述），列 = 被评列（主任、党支部书记、车间得分…），全部由后台配置
- **两种问卷**：个人问卷（多列被评职务）与车间问卷（单列「得分」），按部门选择
- **票种加权**：A/B/C 等票种按占比（权重百分比）加权求和，缺少某票种时按实际有票的票种归一化
- **弃权计 0**：弃权、不填的格子按 0 分计入（参考表填写说明口径）
- **一码一票**：提交即核销，不可修改（依赖数据库原子更新，并发安全）

## 技术栈

| 层 | 选型 |
|---|---|
| 后端 | Node.js 24 · Express 5 · TypeScript 7 |
| 数据 | PostgreSQL 17 · Prisma 7（`@prisma/adapter-pg` driver adapter） |
| 前端 | React 19 · Vite 8 · Ant Design 6 · react-router 8 |
| 校验 | zod 4 |
| 安全 | helmet · express-rate-limit · scrypt 口令哈希 · httpOnly Cookie 会话 |
| 测试 | vitest · supertest · Testing Library |

## 快速开始（开发环境）

```bash
pnpm install

# 配置环境变量（数据库连接串、密钥、初始管理员）
cp apps/api/.env.example apps/api/.env
# 编辑 apps/api/.env 填入 DATABASE_URL 与 JWT_SECRET

# 建库（超级用户执行 sql/00_roles_and_databases.sql），然后：
pnpm db:generate
pnpm db:deploy      # 应用迁移
pnpm db:seed        # 初始管理员 + 默认票种 A/B/C（权重 50/30/20）+ 设置项

# 启动（开两个终端；VS Code 用户可直接用「全栈：后端 + 前端」调试配置一键拉起）
pnpm dev:api        # 后端 http://127.0.0.1:3000
pnpm dev:web        # 前端 http://localhost:5173（已配 /api 代理到后端）
```

前端监听所有地址，`localhost`、`127.0.0.1`、局域网 IP 都可访问；
手机连同一局域网即可打开投票入口检查移动端布局。

- 投票入口：<http://127.0.0.1:5173/>
- 后台管理：<http://127.0.0.1:5173/admin>

## 目录结构

```
staff-vote/
├─ apps/api/                 后端
│  ├─ prisma/schema.prisma   数据模型（唯一真源）
│  ├─ prisma/migrations/     手写迁移 SQL（表结构唯一真源）
│  ├─ src/lib/               code 随机码 · scoring 计分 · password 口令哈希
│  │                         crypto 敏感字段 AES-128 预留 · settings · token · rateLimit
│  ├─ src/middleware/        错误处理 · 管理端鉴权
│  ├─ src/routes/            vote（投票）· admin（后台）
│  └─ test/                  单元 + 接口 + 端到端测试
├─ apps/web/                 前端
│  ├─ src/pages/vote/        投票入口三页 + 参考表同形打分表
│  ├─ src/pages/admin/       后台十一页（含「问卷配置」）
│  └─ src/lib/api.ts         接口客户端（契约冻结）
├─ deploy/                   nginx.conf · systemd 单元 · 部署手册
├─ sql/                      建库脚本与 SQL 说明
└─ docs/
   ├─ 参考表.xlsx            打分表的版式基准（个人问卷 / 车间问卷两张）
   └─ superpowers/specs/     设计基线文档
```

## 设计要点

### 数据库

- 全部主键为 **UUID v7**（`@default(uuid(7))`）。选 v7 而非 v4：它是时间有序的，B-tree 索引插入更顺序，页分裂更少。
  PostgreSQL 17 未内置 `uuidv7()`（PG 18 才引入），因此 UUID 由 Prisma 客户端生成，**数据库列不设 DEFAULT**，以保证 schema 与库零漂移。
- 时间列一律 `timestamptz`。Prisma 默认映射成不带时区的 `timestamp(3)`，本项目显式用 `@db.Timestamptz(3)` 覆盖 —— 不带时区的时间在跨时区与夏令时场景下有歧义。
- 表名与列名统一 snake_case，让 DBA 直接阅读迁移 SQL 无认知负担。

### 口令与加密

- **管理员口令用 scrypt 单向哈希**，参数取自 OWASP 推荐值（N=16384, r=8, p=1, keylen=64, salt 16 字节），比对用 `timingSafeEqual`。
  不用 AES 或 SHA 系列：可逆加密意味着拿到密钥就能还原原始口令，而口令常被跨系统复用。依据：
  OWASP 密码存储备忘单 *"Passwords should be securely hashed ... rather than encrypted or stored in plaintext."*
- **AES-128 能力已预留**但本期不落任何加密字段：数据库启用 `pgcrypto`，`src/lib/crypto.ts` 提供 `encryptField` / `decryptField`（`pgp_sym_encrypt`，官方默认 cipher 即 aes128），密钥走 `SENSITIVE_FIELD_KEY`。
  适用于将来需要**还原显示**的数据（手机号、身份证号），**绝不用于口令**。

### 计分口径

```
某被评列在某项点 d 的得分 = Σ_t(该票种在 d 上的均分 × 票种权重%) / Σ_t(票种权重%)
                          t 遍历在该单元格上实际有票的票种
某项归一化分 = (得分 − 该项 min) / (该项 max − 该项 min) × 100
综合得分     = 各项归一化分的等权平均
```

三种「没有数据」被刻意区别对待：

1. **某票种一张表都没有** —— 那是没发这种票，整票种不参与，不按 0 权重计入；
2. **某张表缺某一格**（弃权、不填）—— 按参考表口径**计 0 分**参与该格平均；
3. **某项点在本部门一张票都没有** —— 该项不参与综合分。

第 1、3 条是为了不让缺失的数据被当成 0 分；第 2 条是参考表明确要求的口径，与前者不矛盾：票没发出去 ≠ 投票人弃权。
各项满分不同（一项 100、一项 20）时，原始分不能直接相加，否则低分制项点会被淹没。

导出与打印同时给出综合得分与各项原始分，不做黑箱。

### 匿名边界

`score_sheets` 表**不含**随机码、IP、User-Agent，只有部门 + 票种类别 + 提交时间。
票种类别是加权求和所必需的最小信息。代价是系统无法自动排除「给自己打分」—— 这是匿名投票的固有取舍。

### 权限与角色

**角色 → 权限，账号 → 角色。没有分配角色的账号权限为空，等价只读。**

- 权限目录的**唯一真源**是 `apps/api/src/lib/permissions.ts`（8 个权限码，按评议准备 / 发票与票种 / 评议执行 / 系统管理分组）。
  数据库 `permissions` 表是它的副本，由 `pnpm db:seed` 按 code 幂等同步 —— **新增权限码不需要写迁移**，改这个文件再跑 seed 即可。
- 内置角色三个：超级管理员（8 项）、评议管理员（7 项，不含账号管理）、只读查看（0 项）。
  内置角色不可删除；首次创建时按代码授予默认权限，之后管理员在后台改过的权限**不会被 seed 覆盖**。
- 分工必须记牢：**前端隐藏按钮只是体验层，后端 `requirePermission(code)` 才是防线**。
  写操作逐个挂中间件（读操作不挂，无写权限的角色天然只读），直接调接口一样会被 403 拦下。
- **防锁死**：系统必须始终保留至少一个「已启用且拥有 `admins.manage`」的账号，
  停用/删除/降级最后一个这样的账号会被 409 拒绝 —— 否则没人能再管理权限。
- 账号被停用或删除后，其**尚未过期的会话令牌立即失效**（鉴权每次请求查库，不是把权限写进令牌）。
- 管理入口：后台「系统管理 → 账号与权限」(`/admin/admins`)，两个页签分别管账号与角色权限。

新增一个危险操作时三处一起改：后端挂 `requirePermission`、前端用 `useAuth().can()` 门控、权限码加进目录并重跑 seed。

## 验收

```bash
pnpm -r typecheck        # 零错误
pnpm -r test             # 全绿（单元 + 接口 + 端到端）
pnpm -r build            # 两个应用都能构建
pnpm db:drift            # 退出码 0：实际库与 schema.prisma 无漂移
```

> 后端测试跑在 `TEST_DATABASE_URL` 指向的独立测试库上，**不会污染开发库**。
> 该库默认不创建；要跑测试时，在 `sql/00_roles_and_databases.sql` 里取消 `staff_test`
> 的注释建库，并执行一次 `prisma migrate deploy`。
> 未设置 `TEST_DATABASE_URL` 时：接口套件（vote / admin / permission-gate / rbac / revoke-bulk）
> 会**跳过并打印提示**，单元套件（scoring / code / password）照常全绿；
> 而端到端套件（`test/e2e.test.ts`）会**直接失败并报「缺少 TEST_DATABASE_URL」** ——
> 这是有意的：它在导入 src 之前就要拦下，否则会连上开发库并清空业务表。
> 因此没有测试库时 `pnpm -r test` 预期为「部分跳过 + 端到端失败」，这是环境状态而不是代码缺陷。

## 部署

见 [deploy/README.md](deploy/README.md)：建系统用户、建库、迁移、构建、Nginx、systemd、升级与备份。
## Gate test

本行由 no-mistakes gate 链路测试添加，验证 acp:dsh agent 全流水线。
