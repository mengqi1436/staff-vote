# SQL 脚本说明

本目录的 SQL 与 Prisma 迁移的关系，以及如何应用。

## 文件

| 文件 | 作用 | 执行者 | 是否进入迁移历史 |
|---|---|---|---|
| `00_roles_and_databases.sql` | 建 `staff` 角色与 `staff` / `staff_test` 两个库 | PostgreSQL 超级用户 | 否，属环境准备 |

## 表结构 DDL 在哪里

**表结构只有一份，在迁移文件里**：

```
apps/api/prisma/migrations/0001_init/migration.sql
```

这里刻意**不再复制**一份 `schema.sql`。两份 SQL 并存必然漂移，而漂移是运维事故的常见来源：DBA 照着旧的那份建库，应用却按新的那份读写，问题往往在数据写坏之后才暴露。

## 应用方式（二选一，效果相同）

**方式一：Prisma CLI（推荐）**

```bash
cd apps/api
cp ../../.env.example .env      # 首次，填入真实 DATABASE_URL
pnpm exec prisma migrate deploy
```

`migrate deploy` 只应用尚未执行的迁移，不创建 shadow database、不做漂移检查、不会提示重置数据，是生产环境的安全选择。

**方式二：psql 直接执行**

交给 DBA 手工执行或纳入既有变更流程时使用：

```bash
psql "postgresql://staff@192.168.1.11:5432/staff" \
     -v ON_ERROR_STOP=1 \
     -f apps/api/prisma/migrations/0001_init/migration.sql
```

执行后需要用 Prisma 记录该迁移已应用，否则下一步 `migrate deploy` 会重复执行：

```bash
cd apps/api
pnpm exec prisma migrate resolve --applied 0001_init
```

## 漂移校验

确认实际数据库与 `schema.prisma` 完全一致（CI 与验收都会跑）：

```bash
pnpm --filter @staff-vote/api db:drift
```

退出码 0 表示无差异。非 0 说明有人手工改过库，或者迁移文件与模型脱节。

## 编写约定

`migration.sql` 遵循以下约定（对应 PostgreSQL 官方建议）：

- DDL 整体包在 `BEGIN;` … `COMMIT;` 中，出错整体回滚
- `CREATE EXTENSION IF NOT EXISTS pgcrypto`（为将来的敏感字段加密预留，本期不落加密数据）
- 主键 `uuid` 且**不设 DEFAULT**：UUID v7 由 Prisma 客户端生成，PostgreSQL 17 无内置 `uuidv7()`（PG 18 才引入），不设默认值可保证 schema 与库零漂移
- 约束显式命名（`pk_` / `fk_` / `uq_` / `ck_`），不依赖 PostgreSQL 自动命名
- 时间列一律 `timestamptz`
- 每张表与关键列带 `COMMENT ON`，便于 DBA 与后来者理解
- `REVOKE ALL ON SCHEMA public FROM PUBLIC` 后再授权给 `staff`，把 PostgreSQL 15+ 的 public schema 收紧行为显式化