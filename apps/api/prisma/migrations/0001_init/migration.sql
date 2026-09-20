-- =============================================================================
-- 0001_init —— 职工素质投票系统初始表结构
-- =============================================================================
-- 本文件是表结构的【唯一真源】。理由见 sql/README.md：两份 SQL 并存必然漂移。
--
-- 底稿由 `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`
-- 生成，随后按 PostgreSQL 官方建议加工：事务包裹、扩展、注释、权限显式化。
-- 表/列/索引/外键的定义与 prisma/schema.prisma 严格等价，`pnpm db:drift` 可验证。
--
-- 应用方式（二选一，效果相同）：
--   pnpm exec prisma migrate deploy                    # 推荐
--   psql -v ON_ERROR_STOP=1 -f 0001_init/migration.sql  # DBA 手工执行，之后需 migrate resolve
--
-- 修改表结构请【新增迁移】，不要改动本文件。
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 扩展
-- -----------------------------------------------------------------------------
-- pgcrypto：为将来的敏感字段（手机号、身份证号等需要还原显示的数据）预留
-- 可逆加密能力。PostgreSQL 官方文档中 pgp_sym_encrypt 的默认 cipher-algo 即
-- aes128。
--
-- 明确警告：口令【绝不】使用本扩展。OWASP 密码存储备忘单要求口令使用
-- Argon2id / bcrypt / PBKDF2 等单向慢哈希；可逆加密意味着拿到密钥即可还原
-- 原始口令。本项目口令一律走 scrypt（见 src/lib/password.ts）。
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- 枚举
-- -----------------------------------------------------------------------------
CREATE TYPE "ticket_status" AS ENUM ('unused', 'used', 'revoked');

-- -----------------------------------------------------------------------------
-- 表结构
-- -----------------------------------------------------------------------------
-- 说明：所有主键为 TEXT 且【无 DEFAULT】。UUID v7 由 Prisma 客户端生成
-- （PostgreSQL 17 尚无内置 uuidv7()，PG 18 才引入），不设数据库默认值可保证
-- schema 与库之间零漂移。所有时间列为 TIMESTAMPTZ(3)，不做 timestamp 无时区存储。

CREATE SCHEMA IF NOT EXISTS "public";

CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "employees" (
    "id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "employee_no" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "criteria" (
    "id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "min_score" INTEGER NOT NULL DEFAULT 0,
    "max_score" INTEGER NOT NULL DEFAULT 100,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "criteria_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ticket_types" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "weight_percent" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ticket_types_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ticket_batches" (
    "id" TEXT NOT NULL,
    "ticket_type_id" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "operator" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tickets" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "ticket_type_id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "status" "ticket_status" NOT NULL DEFAULT 'unused',
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "score_sheets" (
    "id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "ticket_type_id" TEXT NOT NULL,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "score_sheets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "score_items" (
    "id" TEXT NOT NULL,
    "sheet_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "criterion_id" TEXT NOT NULL,
    "score" INTEGER NOT NULL,

    CONSTRAINT "score_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- -----------------------------------------------------------------------------
-- 索引
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX "admin_users_username_key" ON "admin_users"("username");

CREATE UNIQUE INDEX "departments_name_key" ON "departments"("name");

CREATE UNIQUE INDEX "employees_employee_no_key" ON "employees"("employee_no");

CREATE INDEX "employees_department_id_idx" ON "employees"("department_id");

CREATE INDEX "criteria_department_id_idx" ON "criteria"("department_id");

CREATE UNIQUE INDEX "ticket_types_code_key" ON "ticket_types"("code");

CREATE INDEX "ticket_batches_ticket_type_id_idx" ON "ticket_batches"("ticket_type_id");

CREATE UNIQUE INDEX "tickets_code_key" ON "tickets"("code");

CREATE INDEX "tickets_status_idx" ON "tickets"("status");

CREATE INDEX "tickets_batch_id_idx" ON "tickets"("batch_id");

CREATE INDEX "tickets_ticket_type_id_idx" ON "tickets"("ticket_type_id");

CREATE INDEX "score_sheets_department_id_idx" ON "score_sheets"("department_id");

CREATE INDEX "score_sheets_ticket_type_id_idx" ON "score_sheets"("ticket_type_id");

CREATE INDEX "score_items_employee_id_criterion_id_idx" ON "score_items"("employee_id", "criterion_id");

CREATE INDEX "score_items_criterion_id_idx" ON "score_items"("criterion_id");

CREATE UNIQUE INDEX "score_items_sheet_id_employee_id_criterion_id_key" ON "score_items"("sheet_id", "employee_id", "criterion_id");

CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- -----------------------------------------------------------------------------
-- 外键
-- -----------------------------------------------------------------------------
-- 评分相关的外键一律 RESTRICT：已被评过的职工 / 项点 / 部门不可物理删除，
-- 后台「删除」实现为软删除（enabled = false），保证历史评分始终可读。
-- 唯一的例外是 score_items → score_sheets 用 CASCADE：打分表删除时其单元格随之清理。
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "criteria" ADD CONSTRAINT "criteria_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ticket_batches" ADD CONSTRAINT "ticket_batches_ticket_type_id_fkey" FOREIGN KEY ("ticket_type_id") REFERENCES "ticket_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tickets" ADD CONSTRAINT "tickets_ticket_type_id_fkey" FOREIGN KEY ("ticket_type_id") REFERENCES "ticket_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tickets" ADD CONSTRAINT "tickets_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "ticket_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "score_sheets" ADD CONSTRAINT "score_sheets_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "score_sheets" ADD CONSTRAINT "score_sheets_ticket_type_id_fkey" FOREIGN KEY ("ticket_type_id") REFERENCES "ticket_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "score_items" ADD CONSTRAINT "score_items_sheet_id_fkey" FOREIGN KEY ("sheet_id") REFERENCES "score_sheets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "score_items" ADD CONSTRAINT "score_items_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "score_items" ADD CONSTRAINT "score_items_criterion_id_fkey" FOREIGN KEY ("criterion_id") REFERENCES "criteria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- 注释：让 DBA 与后来者无需读应用代码即可理解每一列
-- -----------------------------------------------------------------------------
COMMENT ON TABLE "admin_users" IS '后台管理员账号';
COMMENT ON COLUMN "admin_users"."password_hash" IS 'scrypt 格式串 scrypt$N$r$p$salt$hash。单向哈希，不可逆；绝不存明文或 AES 加密值';
COMMENT ON COLUMN "admin_users"."username" IS '登录名，全局唯一';

COMMENT ON TABLE "departments" IS '部门。打分表按部门取一套项点列';
COMMENT ON COLUMN "departments"."enabled" IS '软删除标记：已产生评分的部门不可物理删除';

COMMENT ON TABLE "employees" IS '被评职工，即打分表的「行」';
COMMENT ON COLUMN "employees"."employee_no" IS '外部唯一标识，为将来对接人事系统预留（按此列 upsert）';
COMMENT ON COLUMN "employees"."sort_order" IS '打分表中的行顺序';

COMMENT ON TABLE "criteria" IS '素质项点，即打分表的「列」。每个部门一套';
COMMENT ON COLUMN "criteria"."min_score" IS '该项允许的最低分（含），整数';
COMMENT ON COLUMN "criteria"."max_score" IS '该项允许的最高分（含），整数';

COMMENT ON TABLE "ticket_types" IS '票种（A/B/C…）。weight_percent 即占比，用于最终加权求和';
COMMENT ON COLUMN "ticket_types"."weight_percent" IS '计分权重百分比；启用票种合计必须为 100，由服务层校验';

COMMENT ON TABLE "ticket_batches" IS '一次批量发码的批次，供后台按批次追踪发放情况';
COMMENT ON COLUMN "ticket_batches"."operator" IS '发码操作的管理员用户名';

COMMENT ON TABLE "tickets" IS '随机码。只记状态，不记录投向，与评分数据物理隔断';
COMMENT ON COLUMN "tickets"."code" IS '随机码明文，全局唯一。字符集剔除易混字符（无 O/0/I/1）';
COMMENT ON COLUMN "tickets"."status" IS 'unused 未使用；used 已核销；revoked 管理员作废';
COMMENT ON COLUMN "tickets"."used_at" IS '核销时间。故意不记录投向，因此无法从码反推评分';

COMMENT ON TABLE "score_sheets" IS '一张提交的打分表。匿名：不含 ticket_id、IP、UA';
COMMENT ON COLUMN "score_sheets"."ticket_type_id" IS '票种类别（A/B/C），加权求和所必需的最小信息；不指向具体随机码';
COMMENT ON COLUMN "score_sheets"."submitted_at" IS '提交时间';

COMMENT ON TABLE "score_items" IS '打分单元格：某张表对某职工在某项点上的分数';
COMMENT ON COLUMN "score_items"."score" IS '整数分值，区间由所属项点的 min_score / max_score 决定';

COMMENT ON TABLE "settings" IS '全局设置键值对：投票总开关、开放起止时间、系统标题';
COMMENT ON COLUMN "settings"."value" IS '字符串值，按 key 约定解析（时间用 ISO 8601）';

COMMENT ON TABLE "audit_logs" IS '管理动作留痕：发码、改权重、改开放时间';
COMMENT ON COLUMN "audit_logs"."detail" IS '动作明细，JSONB';

-- -----------------------------------------------------------------------------
-- 权限显式化
-- -----------------------------------------------------------------------------
-- PostgreSQL 15 起 public schema 已默认不再给 PUBLIC 授予 CREATE 权限。
-- 这里显式再写一次，把「应用账号才有建表权」这一意图固化在迁移里，
-- 使其不依赖创建数据库时所用的 template 版本。
-- 只回收 CREATE，保留 USAGE，避免影响将来可能新增的只读账号。
REVOKE CREATE ON SCHEMA "public" FROM PUBLIC;

COMMIT;