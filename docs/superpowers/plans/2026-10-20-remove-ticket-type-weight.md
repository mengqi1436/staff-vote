# 去掉人员类别权重、随机码改 12 位数字、按人员类别分别统计

- 日期：2026-10-20
- 分支：`feat/ticket-type-weight-removal`
- 基线：`b95a41d`
- 状态：方案待评审（未改动任何代码）
- 调研方式：cbm 代码图谱 + 4 个并行只读调研（api-model / scoring-stats / web-admin / impact-tests）+ context7 官方文档核对

---

## 0. 官方文档核对后的修订（相对上一版）

1. **修正唯一冲突的识别方式**：本项目 Prisma 7 用 `P2002` + `meta.target`；`sqlState === '23505'` 是 Prisma 8 的写法，方案同时兼容但以 v7 为准。
2. **补全迁移工作流**：官方 `migrate dev --create-only`（审查 SQL）与 `migrate deploy`（生产只应用）的分工；明确本项目「手写 SQL」的偏差与三条自保证（编号、已应用不可改、先 drift 再 deploy）。
3. **补全 NOT VALID 的真实语义**：跳过全表扫描，但只跳过**存量行**的初始校验；后续 INSERT/UPDATE 仍强制执行。旧码迁移后能登录却不能核销/作废（23514），因此清空必须在 `db:deploy` 后、服务对外可用前完成。`VALIDATE CONSTRAINT` 只取 `SHARE UPDATE EXCLUSIVE` 锁。
4. **补全并发语义**：`ON CONFLICT DO NOTHING` 在 Read Committed 下可能因并发未可见事务跳过插入，因此必须校验返回行数并补生成。
5. **补全 Excel 文本格式**：ExcelJS 写字符串 + `numFmt='@'`，并加读回断言；12 位码列宽 14 → 16。
6. **新增碰撞概率表**：10^12 空间下 10 万级发码已需依赖补生成。

---

## 1. 需求与已确认决策

| 项 | 结论 | 来源 |
|---|---|---|
| 权重 | 系统内不再出现 `weightPercent`、不再有「启用合计 = 100%」校验、不再有加权合并 | 用户确认 |
| 票的差异 | 只体现在**发码数量**：按人员类别分别指定数量，**一码一票** | 用户确认（选项 A） |
| 随机码格式 | **纯数字 0-9、固定 12 位**，允许前导零 | 用户确认 |
| 随机码唯一性 | **跨评议场次全局唯一** | 用户确认 |
| 旧 8 位码 | **不兼容，清空重发** | 用户确认 |
| 统计口径 | **不同人员类别分别统计，不做跨类别合并** | 用户确认 + scoring-stats 推荐 |

术语沿用仓库现状：代码与界面统一叫「人员类别」（`commit 17a05df` 已完成改名），方案中的「票种」「票别」均指同一概念，不再新增术语。

### 1.1 已锁定的口径细节

1. **类别内**：同一人员类别在某格的多张答卷取均分；某张表缺某格按 0 分计入（弃权口径，`scoring.ts:14-18` 刻意保留）。
2. **类别间**：不合并、不加权、不排名。每个人员类别独立出一组结果；排名只在同一人员类别内有效。
3. **未收到某类别的部门**：该类别整行不出现（沿用「没发这种票 ≠ 弃权」的既有语义）。
4. **项点间**：仍按各自满分归一化到百分制后等权平均（`scoring.ts:20-22` 保留，与权重无关）。
5. **类别内综合得分**：统一为「各格归一化分等权平均」，与结果页一致；统计页不再使用原始分等权平均（`sampleStats.ts:230` 的 `column.average` 口径差异一并收口）。
6. **ABC 汇总行**：删除。它存在的唯一理由是加权合并（`sampleStats.ts:12-13`），去掉权重后没有独立定义。

> 若业务后续仍要一个「可上报的单一总分」，必须在两种口径里显式选一个并命名，不能默认：全票合并（每张答卷等权，隐含按发码数量加权）或类别等权（隐藏权重）。**本方案默认不产出跨类别总分。**

---

## 2. 现状定位（cbm 查询结果）

### 2.1 「评议管理 → 人员类别权重」在哪里

| 层 | 位置 | 作用 |
|---|---|---|
| 数据模型 | `apps/api/prisma/schema.prisma:313-334` | `TicketType.weightPercent`，`@@unique([sessionId, code])` |
| 建表 SQL | `apps/api/prisma/migrations/0001_init/migration.sql:97,245-246` | `weight_percent INTEGER NOT NULL` + 注释 |
| 写入校验 | `apps/api/src/services/admin.ts:438-446`、`:574-603`、`:683-686`、`:724-732` | 合计必须 100 / 不得超过 100 |
| 向导聚合 | `apps/api/src/services/admin.ts:852-990` | `applyTicketPlan` + `422 WEIGHT_SUM` |
| 计分 | `apps/api/src/lib/scoring.ts:150-178` | 加权求和 + 按有票类别归一化 |
| 统计/结果/导出 | `stats.ts:23,181`、`results.ts:48-53,70,136,236-252`、`sampleStats.ts:187`、`xlsx.ts:206-207,282-296` | DTO 与「权重百分比」列 |
| 前端页面 | `apps/web/src/pages/admin/TicketTypes.tsx`（权重分配卡片 347-398、表格列 210-216、弹窗 459-469） | 「人员类别与权重」页 |
| 前端向导 | `apps/web/src/pages/admin/SessionCreateWizard.tsx:135-136,247-263,439-453` | 第 3 步权重列与合计闸门 |
| 页签 | `apps/web/src/pages/admin/SessionWorkspace.tsx:186` | 「人员类别权重」 |

### 2.2 随机码现状

- 生成：`apps/api/src/lib/code.ts:12-28`，32 字符集（剔除 O/0/I/1）× 8 位 ≈ 1.1e12。
- 唯一：`tickets.code` **已是全局** `@unique`（`schema.prisma:363`，索引 `migration.sql:181`），跨场次重复会被数据库拒绝。
- 发码：`admin.ts:815-835`、`:955-968` 用 `createMany` 插入后比对 `inserted.count`；**没有冲突重试**，P2002 会整事务回滚并被 `errorHandler.ts:93-94` 兜底成 500。
- 登录：`routes/vote.ts:109-111` 只做 `normalizeCode`，**不校验长度与字符集**——这意味着「旧码不兼容」不会自动成立，必须靠清空数据落地（见 §6.3）。

---

## 3. 目标设计

### 3.1 数据模型

```prisma
/// 人员类别（A / B / C …）。只决定发码数量，不参与计分加权。
model TicketType {
  id            String   @id @default(uuid(7))
  sessionId     String   @map("session_id")
  code          String
  name          String
  sortOrder     Int      @default(0) @map("sort_order")
  enabled       Boolean  @default(true)
  createdAt     DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt     DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)

  @@unique([sessionId, code])
  @@index([sessionId])
  @@map("ticket_types")
}
```

删除字段清单：`weightPercent`（Prisma 模型、DTO、zod schema、审计 detail、前端 `api.ts`）。
`Ticket.code` 保持 `@unique`，不新增 `@@unique([sessionId, code])`——需求是跨场次全局唯一，现有约束正好覆盖。

### 3.2 随机码生成与冲突处理

```ts
// apps/api/src/lib/code.ts
export const CODE_LENGTH = 12;
const CODE_MAX = 1_000_000_000_000; // 10^12

export function generateCode(): string {
  // crypto.randomInt 无模偏差；10^12 < 2^48 ≈ 2.81e14，在允许范围内
  return String(randomInt(0, CODE_MAX)).padStart(12, '0');
}

export function normalizeCode(input: string): string {
  // 保留「去空白/连字符」的抄录容错；纯数字下 toUpperCase 可留可删
  return input.replace(/[\s-]/g, '');
}
```

- **前导零必须 `padStart(12, '0')`**：不补则约 10% 的码短于 12 位。
- 码空间 10^12，与旧方案 32^8 ≈ 1.1e12 同量级，熵不下降；登录限流 `voteLoginLimiter` 保持。
- 批量发码改为「可重试插入」，不再依赖「碰撞就整批 500」：

```ts
// apps/api/src/services/admin.ts（发码事务内）
let inserted = 0;
for (let round = 0; round < 3; round += 1) {
  const codes = generateUniqueCodes(count - inserted);
  const result = await tx.ticket.createMany({
    data: codes.map((code) => ({ code, ... })),
    skipDuplicates: true, // PostgreSQL: ON CONFLICT DO NOTHING
  });
  inserted += result.count;
  if (inserted === count) break;
}
if (inserted !== count) throw new Error('随机码生成冲突，请重试');
```

- **错误识别分版本**（官方文档明确的分界）：
  - 本项目 Prisma **7.10.0**：唯一冲突抛 `PrismaClientKnownRequestError`，判 `error.code === 'P2002'`，冲突字段在 `error.meta.target`；
  - Prisma **8** 起取消 `P2002`/`P2025`，数据库错误改带 `sqlState`，唯一冲突判 `error.sqlState === '23505'`。
  - 方案按 v7 实现，同时在 catch 里兼容 `sqlState`，便于日后升级。
- **`ON CONFLICT DO NOTHING` 不等于「跳过的一定是碰撞」**：PostgreSQL 文档说明在 Read Committed 下，插入可能因**并发未可见事务**而跳过。因此必须用返回的 `count` 校验并补生成（上面的循环正是为此），不能把「跳过了」当成「码重复」。
- 同一事务内重试是安全的（`ON CONFLICT DO NOTHING` 不会让事务进入 aborted 状态）；**不要** catch `P2002` 后在已中止的事务里继续执行（会报 `25P02`）。
- 可选加固：`tickets.code` 加 `CHECK (code ~ '^[0-9]{12}$') NOT VALID`。它只跳过存量行的初始校验，后续 INSERT/UPDATE 仍强制执行——旧码能登录，但核销/作废会被 CHECK 拒绝（23514），所以清空必须排在迁移之后、服务对外之前。

**码空间与碰撞概率**（10^12，生日问题 `1 - exp(-n²/2N)`）：

| 单次发码量 | 至少一次碰撞的概率 |
|---|---|
| 1,000 | ≈ 5×10⁻⁷ |
| 10,000 | ≈ 5×10⁻⁵ |
| 100,000 | ≈ 5×10⁻³ |
| 1,000,000 | ≈ 0.39 |

结论：常规场次（千级）碰撞概率可忽略，但**十万级以上必须依赖补生成**；`Set` 去重只解决同一批内重复，跨批/跨场由 `tickets.code` 全局唯一索引兜底。

### 3.3 发码与登录

- 发码接口形状**不用改**：`POST /api/admin/tickets/generate` 已是 `{ ticketTypeId, count, sessionId?, departmentId? }`（`routes/admin/tickets.ts:61-67`），`count` 语义已满足「按人员类别分别指定数量」。
- 向导 `PUT /sessions/:id/ticket-plan` 去掉 `weightPercent`，保留 `code/name/count`；补一条 `types.length === 0 → 422`，避免空数组把全部类别软停用。
- 登录链路**不加格式校验**：保持「无效码与已用码同一种拒绝」的防枚举语义；旧码失效由清空数据保证。
- 投票响应去掉 `ticketType.weightPercent`（`vote.ts:207-214`）；前端本来也没有展示，只删契约字段。

### 3.4 统计与导出

| 输出 | 改法 |
|---|---|
| `scoring.ts` | 删 `ScoringTicketType` / `weightByTicketType` / 加权求和；`perTicketType` 升为唯一口径，补 `normalizedScore` 与类别内 `comprehensiveScore` |
| `results.ts` | 删权重取数与传参；行增加 `ticketTypeId/code` 维度，排名改为**类别内排名**；补 `scoredKeys` 过滤（照搬 `sampleStats.ts:207-216`），消除「该类别没评的列输出 0 行」 |
| `sampleStats.ts` | 删 ABC 汇总行与 `SUMMARY_*`；只保留类别行；同一类别多个部门/车间时分组排名 |
| `xlsx.ts` 综合排名 | 增加「人员类别」列并分组，排名改为类别内；不保留任何加权/归一化合并列 |
| `xlsx.ts` 各项明细 | 增加「人员类别」列；删「参与票种」列（一行已属一个类别）；新增「票数」列 |
| `xlsx.ts` 参与人员类别说明 | 删「权重百分比」列；保留「是否参与计分」 |
| `xlsx.ts` 人员类别单项/合计明细 | 升为主表；补「票数」列 |
| `stats.ts` | 删 `weightPercent`；发放/使用计数逻辑不变 |
| 打印 `PrintSheet.tsx` | 口径注改为「按人员类别分别统计；同一类别多张表取均分；未收到该类别的部门不参与；项点按满分归一化后等权平均」，删「权重 X%」 |

### 3.5 前端

- `TicketTypes.tsx`：删「权重分配」卡片、权重列、弹窗权重项、合计 Alert、`summarizeWeights` 调用，页名改「人员类别」。**连带修复**：`canWrite` 目前只门控权重保存按钮，删除后新增/编辑/删除会失去权限门控——迁到「新增人员类别」与行内操作（`DESIGN.md:145` 要求）。
- `SessionCreateWizard.tsx`：第 3 步只保留编码/名称/数量；提交闸门改为「至少一行且必填项完整」；删 `WEIGHT_SUM` 分支。
- `lib.ts` / `__tests__/lib.test.ts` / `__tests__/weights.test.tsx`：`summarizeWeights` 及其测试整体删除（无其他调用方）。
- `Tickets.tsx` / `PrintSheet.tsx` / `Results.tsx` / `StatsDashboard.tsx` / `SessionWorkspace.tsx`：删权重文案与列，页签改「人员类别」。
- `StatsTables.tsx`：未被任何页面引用（死代码），删类型字段后会 typecheck 失败——本次只同步删列，暂不删除文件（避免混入额外范围）。
- `Gate.tsx`：输入归一化改为 `value.replace(/\D/g, '').slice(0, 12)`；加 `inputMode="numeric"`；提示改为「12 位数字，中间的空格可照抄」；**不要**用原生 `maxLength={12}`（会在归一化前截断粘贴的带空格码）。
- 12 位码的显示与导出：
  - 发码弹窗列宽 132px（`Tickets.tsx:368`）需复核，12 位数字比 8 位宽约 50%；
  - `xlsx.ts:132`、`:450` 随机码列宽 14 → 16；`:181` 注释「码是 8 位定长」同步改；
  - ExcelJS 官方写法：`cell.value = code` 写字符串 + `cell.numFmt = '@'` 强制文本。只写字符串不设格式时，人工在 Excel 重存仍可能被转成数值而丢前导零；
  - 测试加读回断言：写 `'012345678901'` → 读回仍为 `'012345678901'`。

### 3.6 权限与文档

- `permissions.ts:32`：`ticketTypes.write` 名称「管理人员类别与权重」→「管理人员类别」，**码不变**；改后必须重跑 `pnpm db:seed`。权限码数量不变，无迁移。
- 文档同步：`README.md:7,10,11,84,106,114,125`、`docs/superpowers/specs/2026-09-19-staff-vote-design.md:12,43,244,250,259,283-291,309-343`、`apps/web/DESIGN.md:97,103,147,165,175`、`apps/web/PRODUCT.md:13,18,24,29,35,43,46,54`。

---

## 4. 官方文档依据（context7）

### 4.1 迁移

| 官方结论 | 依据 | 对方案的影响 |
|---|---|---|
| `prisma migrate dev --create-only` 只生成迁移、不应用，用于**先审查/编辑 SQL**；`prisma migrate deploy` 只应用仓库中已有迁移，不生成新迁移，供生产/CI 使用 | [Prisma — Applying a migration](https://www.prisma.io/docs/orm/migrations/applying-a-migration) | 本项目按仓库约定直接手写 `prisma/migrations/0015_*/migration.sql`，仍遵循「先写、评审、再 `pnpm db:deploy`」，且**已应用的迁移不修改** |
| `ALTER TABLE ... DROP COLUMN` 自动删除依赖该列的表内索引与表约束；只有表外对象（视图、外键）才需要 `CASCADE` | [PostgreSQL 17 — ALTER TABLE](https://www.postgresql.org/docs/17/sql-altertable.html) | `0015` 不写 `CASCADE`；已核查 `weight_percent` 无索引/视图/CHECK 依赖 |
| `ADD CONSTRAINT ... NOT VALID` 跳过全表扫描、立即提交，但只跳过**存量行**的初始校验；后续 INSERT/UPDATE 仍强制执行 | [PostgreSQL 17 — ALTER TABLE](https://www.postgresql.org/docs/17/sql-altertable.html) | 12 位码 CHECK 用 `NOT VALID`；旧码迁移后能登录但核销/作废会 23514，清空须在 `db:deploy` 后、服务对外前完成 |
| 唯一索引只能建在 B-tree 上 | [PostgreSQL 17 — Unique Indexes](https://www.postgresql.org/docs/17/indexes-unique.html) | `tickets.code` 已是 B-tree 唯一索引，不再新增索引 |

### 4.2 写入与冲突

| 官方结论 | 依据 | 对方案的影响 |
|---|---|---|
| **Prisma 7** 的唯一冲突是 `PrismaClientKnownRequestError` + `code: 'P2002'`；**Prisma 8** 起取消 `P2002`/`P2025`，改由数据库错误携带 `sqlState`，唯一冲突为 `23505` | [Coming from Prisma ORM 7](https://www.prisma.io/docs/orm/coming-from-prisma-orm-7)、[Writing data](https://www.prisma.io/docs/orm/fundamentals/writing-data) | 本项目 v7 判 `P2002` + `meta.target`；catch 里同时兼容 `sqlState === '23505'`，升级无需改逻辑 |
| Prisma 7 的 `createMany({ skipDuplicates: true })` = PostgreSQL `ON CONFLICT DO NOTHING`；Prisma 8 改为 `createAll(rows, { onConflict: 'skip' })` | [ORM client 参考](https://www.prisma.io/docs/orm/reference/orm-client)、同上 | 沿用 `createMany + skipDuplicates`，不改成手写 SQL |
| `ON CONFLICT DO NOTHING` 在 Read Committed 下可能因并发未可见事务而跳过插入 | [PostgreSQL 17 — INSERT](https://www.postgresql.org/docs/17/sql-insert.html)、[事务隔离](https://www.postgresql.org/docs/17/transaction-iso.html) | 必须校验 `inserted.count` 并补生成，不能把「跳过」当作「重复」 |

### 4.3 随机码

| 官方结论 | 依据 | 对方案的影响 |
|---|---|---|
| `crypto.randomInt(min, max)` 内部拒绝采样、**无模偏差**；范围必须 `< 2^48` 且为安全整数；不传 callback 时同步返回 | [Node.js — crypto](https://github.com/nodejs/node/blob/main/doc/api/crypto.md) | `randomInt(0, 10^12)` 合法且安全；用 `padStart(12,'0')` 保前导零 |

### 4.4 输入与导出

| 官方结论 | 依据 | 对方案的影响 |
|---|---|---|
| antd `Input` 是受控组件，字符过滤应在 `onChange` 中完成；官方数字输入示例用正则过滤后再 `setState`；`maxLength` 是原生属性，会在归一化前截断 | [Ant Design — Input](https://ant.design/components/input.md) | `Gate.tsx` 用 `replace(/\D/g,'').slice(0,12)`，不设原生 `maxLength` |
| ExcelJS 单元格写字符串即文本值；用 `cell.numFmt = '@'` 指定文本数字格式 | [ExcelJS — README](https://github.com/exceljs/exceljs/blob/master/README.md)、[Style 类型](https://github.com/exceljs/exceljs/blob/master/_autodocs/types.md) | 随机码列写字符串 + `numFmt='@'`，并加读回断言 |

> **版本差异提醒**：context7 中的 Prisma 文档主体已升级到 Prisma 8 的新 ORM/迁移体系（`db migrate`、`migration plan`、`ops.json`），与本项目锁定的 **Prisma 7.10.0**（经典 `prisma migrate deploy` + `createMany`）不同。上文已逐条标注适用版本；实施时以项目版本为准，不照搬 8.x 命令。
>
> 已核对：`@prisma/client` / `prisma` / `@prisma/adapter-pg` 均为 **7.10.0**，Express 5.2.1，antd 6。

---

## 5. 迁移设计

### 5.1 `0015_drop_ticket_type_weight`

依赖核查结论：`weight_percent` **无索引、无视图、无 CHECK、无生成列、无触发器**引用（`0001_init` 索引清单与全目录 grep 均确认），因此**不写 CASCADE**——将来若有人加视图，让迁移显式失败比静默连带删除好。

```sql
BEGIN;

ALTER TABLE "ticket_types" DROP COLUMN "weight_percent";

COMMENT ON TABLE "ticket_types" IS '人员类别（A/B/C…）。只决定发码数量，不参与计分加权';

COMMIT;
```

回滚只能反向加回列且原值不可恢复：`ALTER TABLE "ticket_types" ADD COLUMN "weight_percent" INTEGER NOT NULL DEFAULT 0;`
发布要求：**迁移与新代码同版**。旧代码 + 新库会因 `SELECT weight_percent` 报 `42703`。

官方工作流对应（本项目手写 SQL 的偏差与边界）：官方推荐 `prisma migrate dev --create-only` 生成迁移 → 人工审查/编辑 SQL → 再应用；生产只跑 `prisma migrate deploy`，它**只应用、不生成**。本项目按仓库约定跳过生成步骤、直接手写 `0015`/`0016`，因此必须自己保证：
1. 迁移文件命名与目录符合 `NNNN_name/migration.sql`（现有编号到 `0014`，新迁移从 `0015` 起）；
2. 已应用的迁移绝不修改——需要修正时新增迁移；
3. 部署前先 `pnpm db:drift` 确认 schema 与数据库一致，再 `pnpm db:deploy`。

### 5.2 `0016_ticket_code_numeric_12`（可选加固）

```sql
BEGIN;

ALTER TABLE "tickets"
  ADD CONSTRAINT "tickets_code_numeric_12_check"
  CHECK ("code" ~ '^[0-9]{12}$') NOT VALID;

COMMENT ON COLUMN "tickets"."code" IS
  '随机码明文，全局唯一（跨场次不重复）；12 位纯数字 0-9，含前导零';

COMMIT;
```

已实测：两库 `pnpm db:drift`（`prisma migrate diff`）均无差异——Prisma 不跟踪 CHECK。若将来出现漂移，退路是不加 DB CHECK，由 `lib/code.ts` 单一入口 + 单测保证，数据库只保留 `@unique`。

---

## 6. 数据操作：清空重发

### 6.1 影响的表

| 表 | 后果 |
|---|---|
| `tickets` | 全部码与核销留痕消失 |
| `sheet_ticket_map` | 因 `ticket_id ON DELETE CASCADE` 被级联删除 → **历史答卷失去「按码导出」关联** |
| `ticket_batches` | `tickets.batch_id` 是 RESTRICT，**必须先删 tickets 再删 batches** |
| `score_sheets` / `score_items` | 不受影响：统计、结果、整场导出、打印照常 |
| `audit_logs` | 不清，`ticket.generate` 留痕仍在 |

### 6.2 操作顺序（维护窗口，人工执行，不进自动迁移）

```sql
BEGIN;
DELETE FROM "sheet_ticket_map";
DELETE FROM "tickets";
DELETE FROM "ticket_batches";
COMMIT;
```

执行前必须：
1. `pg_dump -Fc` 备份并做一次恢复演练（`deploy/README.md:162-172` 要求「没演练过的备份等于没有备份」）；
2. 量化影响：`SELECT status, count(*) FROM tickets GROUP BY status;`、`SELECT count(*) FROM sheet_ticket_map;`；
3. 确认没有已完成的评议还需要「按随机码导出答卷」。

若存在需要保留的历史评议：改用「只删未用码」`DELETE FROM tickets WHERE status='unused'`。未用的旧码被删掉、不会再被登录；但已用的旧码仍留在库中，后台若尝试作废它们会被 `0016` 的 CHECK 拒绝（23514）。这是本方案唯一的替代路径，需用户在执行前再次确认。

### 6.3 为什么必须清空

`routes/vote.ts:111` 只做 `normalizeCode`，不校验长度/字符集：旧 8 位码迁移后**仍能登录**。但 `0016` 的 CHECK 对后续 UPDATE 同样生效，旧码在核销（`status='used'`）与作废时会被数据库拒绝（23514，接口 500）——既不能投票、也不能作废。因此必须在 `db:deploy` 后、服务对外可用前清空；若不想承担清空代价，替代方案是放弃 DB CHECK、只在 `lib/code.ts` 单一入口保证格式。

---

## 7. 实施步骤（含并行分工）

> 前置：worktree 内没有 `node_modules`，先 `pnpm install`；接口测试需 `TEST_DATABASE_URL` 指向 `staff_test`。
> **步骤 0 必做**：先跑一次基线并记录（`pnpm -r typecheck`、`pnpm -r test`），当前仓库存在既有漂移（见 §8）。

| 阶段 | 内容 | 并行 | 验证 |
|---|---|---|---|
| 1 | `code.ts` 改 12 位数字 + `code.test.ts` 重写 | 与阶段 2 并行 | `vitest run test/code.test.ts` |
| 2 | `scoring.ts` 去权重、`perTicketType` 升主口径 + `scoring.test.ts` | 与阶段 1 并行 | `vitest run test/scoring.test.ts` |
| 3 | `schema.prisma` 删字段 + `0015` 删列迁移 +（可选）`0016` 码格式 CHECK + `pnpm db:generate` | 依赖 2 的口径确认 | `pnpm db:deploy && pnpm db:drift` |
| 4 | 后端服务/路由/DTO：`admin.ts`、`ticketTypes.ts`、`sessions.ts`、`results.ts`、`stats.ts`、`sampleStats.ts`、`vote.ts`、`xlsx.ts`、`permissions.ts` | 阶段 3 之后 | `pnpm --filter @staff-vote/api typecheck` |
| 5 | `pnpm db:seed` 同步权限名称 | 阶段 4 之后 | 输出「权限目录就绪」；抽查 `GET /api/admin/permissions` |
| 6 | 前端契约与页面：`api.ts` → `lib.ts` → `TicketTypes`/`Wizard`/`Tickets`/`PrintSheet`/`Results`/`Stats*` → `Gate` | 与阶段 4 可并行（先用契约类型） | `pnpm --filter @staff-vote/web typecheck` |
| 7 | 接口测试机械改（夹具字段）：`sessions`/`permission-gate`/`revoke-bulk`/`ticket-department`/`vote` | 阶段 4 后 | 对应 vitest 单文件 |
| 8 | 接口测试语义改：`admin`/`wizard`/`sampleStats` | 阶段 4 后 | 对应 vitest 单文件 |
| 9 | `e2e.test.ts`（会清空测试库业务表，放最后） | 阶段 8 后 | `vitest run test/e2e.test.ts` |
| 10 | 前端测试：删 `weights.test.tsx`、`lib.test.ts`；改 `pages`/`sessions`/`tickets*`/`votePages` | 阶段 6 后 | `vitest run src/pages/admin/__tests__ src/pages/vote` |
| 11 | 文档四处同步 | 语义稳定后 | 人工对照 §3.6 |
| 12 | 全量回归 | 全部 | `pnpm -r typecheck && pnpm -r test && pnpm -r build && pnpm db:drift` |
| 13 | 数据操作（备份 → 量化 → 清空 → 抽查） | 发布窗口 | `SELECT count(*), min(length(code)), max(length(code)) FROM tickets;` → `12/12` |

---

## 8. 既有漂移（不是本需求引入，但会干扰验证）

`commit 17a05df` 把测试期望改成了「人员类别」，但 `xlsx.ts` 实现仍是「票别/参与票种口径」：

| 测试期望 | 实现 |
|---|---|
| `admin.test.ts:1525` `参与人员类别说明` | `xlsx.ts:282` `参与票种口径` |
| `e2e.test.ts:485,488`、`wizard.test.ts:871` `人员类别单项明细` | `xlsx.ts:300` `票别单项明细` |
| 同上 `人员类别合计明细` | `xlsx.ts:317` `票别合计明细` |

建议本次改 `xlsx.ts` 时一并收尾（本来就要删权重列），否则改完仍红，无法区分回归与既有失败。

---

## 9. 验证清单

### 9.1 单元测试（随时可跑）

- `generateCode()` 匹配 `/^[0-9]{12}$/`；`CODE_LENGTH === 12`。
- 前导零：mock `randomInt` 返回 `0` → `'000000000000'`；返回 `12345` → `'000000012345'`。
- `normalizeCode(' 1234 5678 9012 ') === '123456789012'`，`'1234-5678-9012'` 同。
- 两次调用各 5000 个，合并集合 10000（单进程无系统性重复；跨进程由唯一索引守）。
- `scoring.test.ts`：零票类别不参与（A 零票、B 75、C 85 → 80）；「权重为 0 不参与」整条删除；多类别不再加权。

### 9.2 接口测试

| 点 | 断言 |
|---|---|
| 发码 2000 个 | 全部 `/^\d{12}$/`，DB 无重复 |
| 跨场次唯一 | 预置同码后重发，最终数量 = 请求数（自动补生成）或返回可识别错误，**不出现 500** |
| 建/改人员类别不带权重 | 200，响应不含 `weightPercent` 键 |
| 旧的 100% 校验 | 删除对应用例；`startBlockers` 不再出现「权重合计」 |
| `ticket-plan` | 不带权重按 count 发码；`types: []` → 422 |
| 登录响应 | `ticketType` 不含 `weightPercent`；12 位码可登录 |
| 导出 | 「参与人员类别说明」表头不含「权重百分比」；单项/合计明细含「票数」 |

### 9.3 统计口径断言

- 两类别票数悬殊（A 100 张均分 80、B 10 张均分 60）：**分别输出 80 与 60**，不出现 78.18 或 70 的合并值。
- 类别内多张答卷同格 → 均分。
- 某类别在该部门无票 → 该类别整行不出现。
- 排名只在同类别内（不同部门之间）。

### 9.4 导出与打印

- 12 位码写入 Excel 后读回为字符串，前导零不丢（`ticketTypeWorkbook.test.ts` 加读回断言）。
- 随机码单元格 `numFmt === '@'`（文本格式），列宽 ≥ 16；发码清单与整场导出两处都要覆盖。
- 打印口径注与实际统计一致。

### 9.5 收尾检查

```bash
grep -rIn "weightPercent\|权重\|WEIGHT_SUM" apps docs README.md --include=*.ts --include=*.tsx --include=*.prisma --include=*.md --include=*.sql
```

除历史迁移 `0001_init` 与本方案文档外应为零。

---

## 10. 风险与待确认

| # | 风险 | 证据 | 处置 |
|---|---|---|---|
| R1 | 是否还需要跨类别总分未定 | 需求只说「分别统计」 | 方案默认不产出；若要，必须在「全票合并 / 类别等权」中显式选一个并命名 |
| R2 | 「旧码不兼容」不会自动成立 | `vote.ts:111` 不校验格式 | 按 §6 清空；或加格式校验（需授权） |
| R3 | 清空 `tickets` 级联删 `sheet_ticket_map`，历史「按码导出」不可逆丢失 | `schema.prisma:435` | 执行前确认；有历史评议则改「只删未用码」 |
| R4 | 删列不可逆、原值不可恢复 | Prisma 无 down | 迁移前备份；或先发「忽略该列」的代码再删列 |
| R5 | 12 位数字在 Excel 中被人工转数值丢前导零 | `xlsx.ts:132,166-190` | 列宽 16 + 读回断言 |
| R6 | 码变长、纯数字仍有 6/9 口述歧义，与 `PRODUCT.md:29`「码要短」冲突 | 产品原则 | 需产品确认；打印排版需实测 |
| R7 | worktree 无 `node_modules`/`.env`，验证命令直接跑会失败 | 实测 | 先 `pnpm install`，准备 `TEST_DATABASE_URL` |
| R8 | 全仓库 `weightPercent` 约 100 处、权重文案约 60 处，机械替换易漏 | 影响面报告 | 收尾 grep 双清零 + typecheck 兜底 |
| R9 | `StatsTables.tsx` 是死代码，删类型后会红 | 无 import | 同步删列，不删文件 |
| R10 | `results.ts` 未过滤「该类别没评的列」，去权重后 0 行会变主表噪音 | `results.ts:205-223` vs `sampleStats.ts:207-216` | 升主口径前必须补过滤 |
| R11 | 照抄 context7 的 Prisma 8 文档会写出 v7 不存在的判断（`sqlState` 判唯一冲突、`createAll`） | 官方文档已升级到 8.x；项目锁 7.10.0 | 按 §4.2 的版本分界实现：v7 判 `P2002`，兼容读 `sqlState` |
| R12 | `ON CONFLICT DO NOTHING` 在并发下可能少插，导致发码数量不足 | PG 文档 Read Committed 说明 | 循环校验 `inserted.count` 并补生成；最终不等则整事务回滚报错 |
| R13 | 误用 `prisma migrate dev` 可能生成不想要的迁移或重置开发库 | 官方流程 `migrate dev` 用于开发、`migrate deploy` 用于生产 | 本项目只用 `migrate deploy` + 手写 SQL；`migrate dev` 不纳入脚本 |

---

## 11. 交付物

- 本方案文档
- 分支 `feat/ticket-type-weight-removal`（已完成实施：代码、迁移、测试与两库验证）
- 4 份调研结论已并入本文；原始细节可按需再展开
