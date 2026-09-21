# 职工素质投票系统（staff-vote）设计基线

- 日期：2026-09-19
- 状态：已批准，实施中
- 交付形态：前后端分离（Express API + React 前端），PostgreSQL 17，Linux + Nginx 部署

## 1. 背景与目标

为单位职工素质评议提供一套可落地的打分系统：

- **投票入口**：职工凭后台发放的票种随机码登录，选择部门，在一张类 Excel 的表单上按素质项点给该部门职工逐格打分，匿名提交。
- **后台管理**：管理员配置部门、职工、项点（每个部门一套列）、票种与权重、批量发放随机码，实时查看票种发放与使用情况，控制投票开放时间窗，并在投票结束后生成汇总结果。
- **匿名性**：评分数据与随机码之间不存在任何可反推的个人关联。

## 2. 成功标准

1. `pnpm -r typecheck`、`pnpm -r test` 全绿。
2. `pnpm --filter @staff-vote/api build`、`pnpm --filter @staff-vote/web build` 产出可部署产物。
3. 端到端通过：初始化管理员 → 配置部门/职工/项点 → 生成随机码 → 凭码登录 → 取到动态表格 → 提交打分 → 码被核销 → 后台统计到票 → 导出 Excel 与打印页。
4. 非开放时段提交被拒（403 + 「当前未开放投票」）。
5. 同一随机码二次提交被拒，评分表与随机码之间无可反推的身份关联。
6. 非整数、越界分数被后端拒绝。
7. `prisma migrate diff` 校验实际库与 `schema.prisma` 无漂移，退出码 0。

## 3. 官方文档依据与关键设计更正

实施前核对了 Prisma、PostgreSQL、Ant Design、OWASP 官方文档，据此更正了三处设计：

| 原设计 | 官方事实 | 更正 |
|---|---|---|
| 主键用自增整数 | Prisma v7 Schema Reference：`id String @id @default(uuid(7))` 生成 UUID v7 | 全部主键改 UUIDv7 |
| `datasource.url` 写在 `schema.prisma` | Prisma 7.0.0 发布说明：`datasource.url` 与 `datasource.shadowDatabaseUrl` 均已迁至配置文件；`prisma.config.ts` 对迁移与内省成为必填；PrismaClient 必须传 driver adapter；generator provider 由 `prisma-client-js` 改为 `prisma-client` | 新建 `prisma.config.ts`；新增 `@prisma/adapter-pg`；迁移工作流改为手写 SQL + `migrate deploy`，绕开 shadow 库 |
| 自写内存限流 | Express 生产安全实践：Helmet 安全响应头 + express-rate-limit | 引入 `helmet` 与 `express-rate-limit`，并配 `trust proxy` 以在 Nginx 反代后取真实 IP |

时间事实：**PostgreSQL 17 没有内置 `uuidv7()`**（PG 18 才引入），因此 UUIDv7 由 Prisma 客户端生成，数据库列不设 `DEFAULT`，保证 schema 与库之间零漂移。

## 4. 已确认的决策

| 议题 | 决策 |
|---|---|
| 打分表结构 | 行 = 被评职工，列 = 素质项点，单元格填分数 |
| 投票范围 | 一码只能评一个部门，提交后作废 |
| 票种含义 | 占比 = 计分权重百分比，直接加权求和 |
| 发码方式 | 管理员设定各票种数量，系统批量生成并可导出 |
| 码的使用 | 一码一票，提交即作废，不可修改 |
| 分数精度 | 仅整数，不得小数 |
| 后端框架 | Express 5 |
| 数据库 | PostgreSQL 17.11（开发库 `staff`，测试库 `staff_test`） |
| 生产库 | 留空占位，部署时填写 |
| 主键 | 统一 UUID v7 |
| 管理员口令 | scrypt 单向哈希 |
| AES-128 | 预留给将来的敏感字段，本期不存加密数据 |
| SQL 交付 | 手写 SQL 脚本，按 PostgreSQL 官方最佳实践 |
| 结果产物 | 汇总页 + Excel 导出 + 可打印打分表 |
| 职工名单 | 有外部接口可对接，本期不对接 |
| 项点分值 | 每项 min/max 单独设置 |

## 5. 环境事实

| 项 | 值 |
|---|---|
| 开发机 | Windows，`192.168.1.10` |
| 数据库服务器 | `192.168.1.11:5432`，PostgreSQL 17.11 (Ubuntu)，UTF8，SSL on |
| 认证 | `pg_hba` 第 133 行 `host all all 192.168.1.0/24 scram-sha-256` |
| 库属性 | `staff` / `staff_test`：UTF8，`zh_CN.UTF-8`，owner = staff |
| pgcrypto | 1.3，已验证 `staff` 可自建（trusted extension） |
| 共用实例 | 该实例另有 `gycwd`、`gycwd_config` 等他业务库，本项目严格不触碰 |
| 工具链 | Node 24.19.0、pnpm 11.20.0、git 2.55 |

**安全纪律**：数据库口令只写入本机 `.env`（已在 `.gitignore`），不进入任何受版本控制的文件。应用连接串只用 `staff` 账号，不使用 `postgres` 超级用户。

## 6. 密码与加密方案

**管理员口令用 scrypt 单向哈希，不用 AES。** 依据：

- OWASP 密码存储备忘单：*"Passwords should be securely hashed using modern, adaptive hashing algorithms (e.g., Argon2id, bcrypt, or PBKDF2), rather than encrypted or stored in plaintext."*
- OWASP 加密存储备忘单：*"Passwords should not be stored using reversible encryption - secure password hashing algorithms should be used instead."*
- PostgreSQL 17 官方文档对 pgcrypto 列加密的警告：*"decrypted data and decryption keys remain temporarily present on the server during processing, making them vulnerable to interception by users with full server access."*

参数取自 OWASP 推荐值：

```
salt   = randomBytes(16)                      # ≥16 字节
N = 16384, r = 8, p = 1, keylen = 64
比对   = crypto.timingSafeEqual               # 恒定时间，防时序侧信道
存储   = "scrypt$16384$8$1$<salt-hex>$<hash-hex>"
```

**AES-128 预留**（本期不落任何加密数据，只铺通路）：

- 初始化 SQL 中 `CREATE EXTENSION IF NOT EXISTS pgcrypto`
- `.env` 预留 `SENSITIVE_FIELD_KEY`
- `apps/api/src/lib/crypto.ts` 提供 `encryptField()` / `decryptField()`，底层 `pgp_sym_encrypt`，显式指定 `cipher-algo=aes128`（官方默认值即 aes128，显式写死以防默认值将来变动）
- 代码注释明确标注：**此函数不得用于口令**，并附 OWASP 依据

## 7. 数据库准备（已完成）

```sql
CREATE ROLE staff WITH LOGIN PASSWORD '<见本机 .env>';

CREATE DATABASE staff WITH OWNER = staff
  ENCODING = 'UTF8' LC_COLLATE = 'zh_CN.UTF-8' LC_CTYPE = 'zh_CN.UTF-8' TEMPLATE = template0;

CREATE DATABASE staff_test WITH OWNER = staff
  ENCODING = 'UTF8' LC_COLLATE = 'zh_CN.UTF-8' LC_CTYPE = 'zh_CN.UTF-8' TEMPLATE = template0;

-- 第二个测试库：两个后端开发任务并行时需要各自独立的库，
-- 否则两边同时重建 schema 会互相破坏。
CREATE DATABASE staff_test_admin WITH OWNER = staff
  ENCODING = 'UTF8' LC_COLLATE = 'zh_CN.UTF-8' LC_CTYPE = 'zh_CN.UTF-8' TEMPLATE = template0;
```

实施中额外确认：`pgcrypto` 是 PostgreSQL 13+ 的 trusted extension，`staff` 作为库 owner 可自行
`CREATE EXTENSION`，无需超级用户介入（已在目标实例上验证通过，版本 1.3）。

刻意不做：不给 `staff` 授予 `CREATEDB`。共用实例上开发账号不应具备随意建库能力；本方案的迁移工作流不需要 shadow 库，因此不需要该权限。

## 8. SQL 脚本交付物

**单一真源原则**：表结构 DDL 只存在一份，即迁移文件 `apps/api/prisma/migrations/0001_init/migration.sql`。不复制出第二份 `schema.sql`，因为双份 SQL 必然漂移，是运维事故的常见来源。

```
apps/api/prisma/migrations/0001_init/migration.sql   # 唯一真源：完整表结构 DDL
sql/00_roles_and_databases.sql                       # 建角色与库，超级用户执行，不进迁移
sql/README.md                                        # 应用方式与漂移校验命令
```

`migration.sql` 编写规范：

| 要点 | 做法 |
|---|---|
| 事务包裹 | `BEGIN;` … `COMMIT;`，DDL 出错整体回滚 |
| 幂等 | `IF NOT EXISTS` |
| 扩展 | 显式 `CREATE EXTENSION IF NOT EXISTS pgcrypto;` |
| 主键 | `uuid PRIMARY KEY`，无 DEFAULT，注释说明由应用生成 UUIDv7 |
| 约束命名 | **保留 Prisma 默认命名**（`<表>_pkey` / `_key` / `_fkey` / `_idx`）。它本身就是显式的、带表名前缀的，已满足「便于 ALTER 与排障」的目标；为此在 schema 里堆几十个 `map` 参数属于无收益的复杂度 |
| 索引 | 外键列、`tickets.status`、`tickets.batch_id`、`score_sheets.department_id`、`score_items(employee_id, criterion_id)` |
| 注释 | 每张表与每个非自明列都有 `COMMENT ON` |
| 时间列 | 一律 `timestamptz` |
| 权限 | `REVOKE CREATE ON SCHEMA public FROM PUBLIC`（刻意保留 USAGE），把「只有应用账号能在 public 建对象」这一意图固化在迁移里，不依赖建库时所用 template 的默认行为 |

一致性校验：

```bash
pnpm --filter @staff-vote/api db:drift
```

## 9. 技术栈与版本

| 层 | 选型 | 版本 |
|---|---|---|
| 后端 | Express | 5.2.1 |
| 安全头 | helmet | 8.3.0 |
| 限流 | express-rate-limit | 8.7.0 |
| ORM | prisma / @prisma/client | 7.10.0 |
| PG 适配 | @prisma/adapter-pg / pg | 7.10.0 / 8.23.0 |
| 校验 | zod | 4.6.5 |
| 令牌 | jsonwebtoken | 9.0.3 |
| 口令哈希 | Node 内置 `crypto.scrypt` | 标准库 |
| Excel | exceljs | 4.4.0 |
| 配置 | dotenv | 18.0.1 |
| 语言 | TypeScript | 7.0.2 |
| 前端 | React / Vite / react-router | 19.3.0 / 8.3.0 / 8.4.0 |
| 组件库 | antd / @ant-design/icons | 6.6.4 / 6.3.4 |
| 测试 | vitest / supertest / jsdom / Testing Library | 5.0.1 / 7.2.2 / 30.1.0 / 16.3.3 |

### 9.1 Prisma 7 写法（与 v6 不同，勿用旧写法）

```ts
// apps/api/prisma.config.ts —— v7 中迁移与内省必填
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
});
```

```prisma
generator client {
  provider = "prisma-client"          // v7 起不再是 prisma-client-js
  output   = "../src/generated/prisma"
}

model Department {
  id String @id @default(uuid(7))     // UUIDv7：时间有序，B-tree 插入更顺序
}
```

```ts
new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) })
```

实施中确认的三点（与 v6 的差异，均已落地）：

1. `@default(uuid(7))` 生成的主键在数据库中为 `TEXT NOT NULL`，**不产生 DEFAULT 子句**。这与设计一致（UUIDv7 由客户端生成），也让 schema 与库零漂移。
2. `migrate diff` 的子命令在 v7 已改名：`--to-schema-datamodel` → `--to-schema`，`--from-schema-datasource` → `--from-config-datasource`。项目脚本 `db:drift` 用的是新语法。
3. Prisma 默认把 `DateTime` 映射为 `timestamp(3)`（**不带时区**）。本项目所有时间字段显式加 `@db.Timestamptz(3)`，迁移 SQL 中落地为 `TIMESTAMPTZ(3)`。

### 9.2 对原始技术选型的两处偏离

1. **不引入 Tailwind**，改用 Ant Design 单一样式系统 + 少量 CSS 变量。Tailwind 的 preflight 会与 antd 的 cssinjs 互相覆盖，两套样式系统并存是后续最难定位的一类 bug。antd v6 原生支持 React 19，不再需要 `@ant-design/v5-patch-for-react-19`；主题用 `ConfigProvider` 的 token 与按组件 `components` 覆盖；v6 新增的 `zeroRuntime` 列为可选优化，默认不开。
2. **投票打分表不用 antd `Table`**，改原生 `<table>` + 受控输入 + 键盘导航。粘性表头与粘性姓名列是「像 Excel」的核心手感，原生实现更短更稳。

## 10. 仓库结构

```
staff-vote/
├─ package.json / pnpm-workspace.yaml / .env / .env.example / .gitignore / README.md
├─ docs/superpowers/specs/2026-09-19-staff-vote-design.md
├─ sql/{00_roles_and_databases.sql,README.md}
├─ apps/api/
│  ├─ prisma.config.ts
│  ├─ prisma/{schema.prisma,migrations/0001_init/migration.sql,seed.ts}
│  ├─ src/
│  │  ├─ index.ts / env.ts / db.ts
│  │  ├─ generated/prisma/            # prisma-client 输出目录（已 gitignore）
│  │  ├─ lib/{code.ts,scoring.ts,password.ts,crypto.ts,token.ts,xlsx.ts}
│  │  ├─ middleware/{adminAuth.ts,errorHandler.ts}
│  │  ├─ services/{vote.ts,admin.ts,stats.ts,results.ts}
│  │  └─ routes/{vote.ts,admin/index.ts,admin/*.ts}
│  └─ test/{scoring,code,password,vote,admin,e2e}.test.ts
├─ apps/web/
│  ├─ src/{main.tsx,App.tsx,theme.ts,lib/{api.ts,usePolling.ts}}
│  ├─ src/pages/vote/{Gate,Sheet,Done}.tsx
│  ├─ src/pages/admin/{Login,Dashboard,TicketTypes,Tickets,Departments,Employees,Criteria,Settings,Results,PrintSheet}.tsx
│  ├─ src/components/vote/ScoreTable.tsx
│  └─ index.html / vite.config.ts
└─ deploy/{nginx.conf,staff-vote-api.service,README.md}
```

## 11. 数据模型

全部主键 `String @id @default(uuid(7))`。

| 模型 | 关键字段 | 约束 |
|---|---|---|
| `AdminUser` | username, passwordHash | 口令为 scrypt 格式串 |
| `Department` | name, sortOrder, enabled | 唯一名 |
| `Employee` | departmentId, name, employeeNo?, sortOrder, enabled | 打分表的行；`employeeNo` 唯一，为接口对接预留 |
| `Criterion` | departmentId, name, minScore, maxScore, sortOrder, enabled | 打分表的列，默认 0/100，整数 |
| `TicketType` | code, name, weightPercent, sortOrder, enabled | 保存时校验启用票种权重合计 = 100 |
| `Ticket` | code(唯一), ticketTypeId, batchId, status, usedAt | 只记状态，不记投向 |
| `TicketBatch` | ticketTypeId, count, createdAt, operator | 发放批次 |
| `ScoreSheet` | departmentId, ticketTypeId, submittedAt | 无 ticketId、无 IP、无 UA |
| `ScoreItem` | sheetId, employeeId, criterionId, score(Int) | 唯一 (sheetId, employeeId, criterionId) |
| `Setting` | key(PK), value | 投票总开关、起止时间、系统标题 |
| `AuditLog` | action, detail(Json), createdAt | 发码、改权重、改开放时间留痕 |

## 12. API 契约

### 12.1 投票（无需登录）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/vote/status` | `{open, message, startAt, endAt}`，未开放时 `message="当前未开放投票"` |
| POST | `/api/vote/session` | 体 `{code}`；校验存在、未使用、投票开放；返回短期 JWT（携带 `ticketId` 供提交时原子核销、`ticketTypeId` 供加权，**不含码明文**）与部门列表 |
| GET | `/api/vote/sheet?departmentId=` | 该部门项点列（含 min/max）与职工行 |
| POST | `/api/vote/submit` | 体 `{departmentId, items[{employeeId, criterionId, score}]}`，`Authorization: Bearer <vote token>` |

### 12.2 管理端（`/api/admin` 前缀，除 login 外均需 httpOnly cookie）

| 分组 | 端点 |
|---|---|
| 认证 | `POST /login`、`POST /logout`、`GET /me` |
| 票种 | `GET/POST/PATCH/DELETE /ticket-types` |
| 发码 | `POST /tickets/generate`、`GET /tickets`、`GET /tickets/export`、`POST /tickets/:id/revoke` |
| 批次 | `GET /ticket-batches` |
| 部门 | `GET/POST/PATCH/DELETE /departments` |
| 职工 | `GET/POST/PATCH/DELETE /employees`、`POST /employees/import`（xlsx/csv） |
| 项点 | `GET/POST/PATCH/DELETE /criteria` |
| 设置 | `GET/PUT /settings` |
| 统计 | `GET /stats/overview` |
| 结果 | `GET /results?departmentId=`、`GET /results/export.xlsx` |

统一错误体 `{error:{code,message}}`，zod 失败返回 400 与字段明细。

## 13. 计分口径

### 13.1 票种加权

```
某被评列在某项点 d 的最终得分 =
  Σ_t(该票种在 d 上的均分 × 票种权重%) / Σ_t(票种权重%)
  t 遍历该部门在 d 上实际有票的票种
```

对实际收到票的票种归一化。否则某部门未收到 A 票会让那 50% 权重按 0 计入，把全体分数整体压低，而现实中无法保证每部门各票种都有票。

**弃权、不填视为 0 分**（参考表填写说明的口径）：某票种在本部门只要有已提交的表，该票种在本部门的每一格都参与平均 —— 某张表缺某一格即按 0 分计入分母；该票种一张表都没有时整票种跳过（那是没发这种票，不是弃权）。

### 13.2 项点间汇总

各项满分可能不同，原始分不能直接相加。采用：

```
某项归一化分 = (该项得分 − 该项 min) / (该项 max − 该项 min) × 100
综合得分     = Σ(各项归一化分) / 项点数        # 各项等权
排名         = 按综合得分降序，同分并列
```

各项 min/max 全相同时，综合得分即等权算术平均。导出与打印同时给出综合得分与各项原始分，不做黑箱。

### 13.3 不记名的物理边界

`ScoreSheet` 不存随机码、IP、UA。投票 JWT 携带 `ticketId`（提交时用于原子核销）与 `ticketTypeId`（用于加权），但**评分表本身不写入 ticketId**，因此令牌与评分表之间不存在可关联的字段。

系统能按票种加权，但无法得知任何一张表由谁投出，因此也无法自动排除自评。

## 14. 前端页面与关键交互

**投票入口 `/`**：随机码输入（兼容 `?code=` 扫码带参）→ 选部门 → 打分表 → 提交成功。非开放时段由 `/api/vote/status` 渲染「当前未开放投票」遮罩，后端接口同时拒绝，前端提示只是提示不是防线。

**打分表 `/vote/sheet`**：与 `docs/参考表.xlsx` 同形 —— 行 = 评价项点（序号 + 名称 + 描述），列 = 被评列（主任/党支部书记/得分…），表头含附件号与表标题，表尾是填写说明。原生表格；数值输入按该项 min/max 设 `min`/`max`/`step=1`；Tab 原生顺序连续录入，方向键/Enter 网格移动；非整数、越界、未填项标红并在提交前汇总提示。

**后台 `/admin`**：概览 5 秒轮询展示各票种发放/已用/剩余与部门提交进度；票种页改权重与一键生成；职工页 Excel/CSV 导入与手工维护（名单不参与打分）；**问卷配置页**（`/admin/questionnaire`）配问卷类型、附件号、表标题、填写说明与被评列；项点页按部门配名称、描述与 min/max；设置页配总开关与起止时间；结果页按部门筛选、排名与三件套导出。

**视觉**：`ConfigProvider` 定制主题 token，中文界面，dayjs 中文 locale。按 `design-taste-frontend` 的适用范围，其规则只作用于投票入口外壳与登录页，后台数据密集页走受控数据 UI 路线。本机无图像生成工具且内部系统无配图需求，不做图片资产。

## 15. 边界情况与失败模式

| 场景 | 处理 |
|---|---|
| 非开放时段提交 | 403 + 「当前未开放投票」 |
| 同一码并发提交 | 原子 `UPDATE ... WHERE code=? AND status='unused'`，影响行数为 0 即拒绝 |
| 已使用的码再次登录 | 401「该票据已使用」 |
| 暴力猜码 | 8 位随机码（字符集剔除 O/0/I/1）+ express-rate-limit 按 IP 限流，`trust proxy` 已配 |
| 分数为小数或越界 | zod `int()` + 逐项 min/max 校验，拒绝并指明行 |
| items 与部门不匹配 | 校验 voteColumnId/criterionId 均属该 departmentId，防越权写 |
| 部门无所配被评列或无项点 | 投票页空白态说明，不报错；提交空 items 直接拒绝 |
| 权重合计不为 100 | 保存票种时拒绝并提示差额 |
| 某部门某票种零票 | 整票种不参与（归一化自动排除），结果页标注实际参与计算的票种 |
| 某张表缺某一格 | 按 0 分计入该格平均（参考表口径：弃权、不填视为 0 分） |
| 删除被引用的数据 | 软删除（`enabled=false`），已提交数据保持可读 |
| 时区 | 服务器 `TZ=Asia/Shanghai`，列一律 `timestamptz`，前端按本地时区显示 |

## 16. 测试策略

- **单元**：`scoring.test.ts`（单票种/多票种/缺票种归一化/min 非 0/满分不一致/零票）、`code.test.ts`（字符集与唯一性）、`password.test.ts`（正确口令通过、错口令拒绝、盐唯一、`timingSafeEqual` 路径）。
- **接口**：`vote.test.ts`（状态、登录核销、重复提交、越权部门、小数与越界分数、非开放时段）、`admin.test.ts`（鉴权、权重合计校验、CRUD、导入）。
- **端到端**：`e2e.test.ts` 用 supertest 串完整链路，断言统计与导出产物（Excel 可解析且含预期行）。
- **前端**：vitest + jsdom + Testing Library 覆盖打分表键盘导航、非整数与越界标红、关闭态渲染。
- **一致性**：`db:drift` 漂移校验进验收脚本。
- **反过度工程**：完成后按 `ponytail-review` 只读审查，只列可删项。

测试库隔离：接口测试跑在 `staff_test`，每轮重建 schema，不污染 `staff`。

## 17. 部署产物

`deploy/nginx.conf`（静态托管 `apps/web/dist`、`/api` 反代 `127.0.0.1:3000`、上传体积上限、`X-Forwarded-For` 透传以配合 `trust proxy`）、`deploy/staff-vote-api.service`（systemd，含 `TZ=Asia/Shanghai` 与 `EnvironmentFile`）、`deploy/README.md`（装 PG、执行 `sql/00_roles_and_databases.sql`、`.env`、`prisma migrate deploy`、`seed`、两包构建、启服务、Nginx reload）、`.env.example`。

生产库本期留空：部署文档说明生产 `.env` 的 `DATABASE_URL` 由使用者填写。

## 18. 执行编排

Lead 亲自做地基与最终集成，四个 teammate 并行开发，零写作用域重叠。

**阶段 0（Lead）**：数据库准备、设计文档、workspace 脚手架、`prisma.config.ts`、`schema.prisma`、手写 `migration.sql`、`sql/` 脚本、`migrate deploy`、`.env`、共享库与中间件、前端骨架。地基冻结后 API 契约即固定。

**阶段 1（并行）**

| Teammate | 独占写作用域 | 交付 |
|---|---|---|
| `api-vote` | `apps/api/src/routes/vote.ts`、`services/vote.ts`、`test/vote.test.ts` | 投票四端点 + 测试 |
| `api-admin` | `apps/api/src/routes/admin/**`、`services/{admin,stats,results}.ts`、`lib/xlsx.ts`、`test/admin.test.ts` | 后台端点、统计、导出 |
| `web-vote` | `apps/web/src/pages/vote/**`、`components/vote/**` | 投票三页 + ScoreTable |
| `web-admin` | `apps/web/src/pages/admin/**` | 后台十个页面 |

**阶段 2（并行）**：`deploy-docs`（`deploy/**`、`README.md`、`.env.example`）+ 一次性只读 subagent 做 `ponytail-review` 与正确性复核。

**阶段 3（Lead）**：合并集成、全量验收、端到端、漂移校验、核对最终 diff。

## 19. 假设与风险

**假设**

1. 开发库固定为 `192.168.1.11` 的 `staff` 库；生产库连接串本期留空。
2. 投票入口与后台同域名部署，Nginx 反代 `/api`，管理端 cookie 用 `httpOnly + SameSite=Lax`，不额外做 CSRF token。
3. 管理员初始账号由 `.env` 注入，首次 `seed` 写入。
4. 职工名单本期手工维护 + Excel/CSV 导入；将来对接外部接口时新增按 `employeeNo` upsert 的同步端点即可，无需改表结构。
5. 单 Node 进程部署，express-rate-limit 内存存储够用；多实例时换 Redis。
6. 本期不存任何需 AES 加密的字段，只铺通路，因此无密钥轮换需求。

**风险**

1. **共用实例**：`192.168.1.11` 上跑着他业务库。所有操作严格限定在 `staff` / `staff_test` 两库内，应用不使用超级用户连接串，不触碰既有库。
2. **目标服务器归属待确认**：`192.168.1.11` 很可能同时就是那台有 Node 与 Nginx 的部署机，需按该机实际布局调整 `deploy/`。
3. **Prisma 7 是最新大版本**（datasource 迁配置、强制 adapter、generator 改名），实施时以官方 v7 文档逐项核对。若 adapter 路径阻塞，回退方案是 `pg` 驱动直连 + 手写 SQL 数据访问层（SQL 已手写，回退成本低）。
4. **依赖版本较新**（TypeScript 7、Vite 8、antd 6、react-router 8、React 19.3），逐库核对 API。
5. 本轮不引入 Tailwind、不做外部接口对接、不支持小数分数、不实现任何字段的 AES 加密（仅预留）。