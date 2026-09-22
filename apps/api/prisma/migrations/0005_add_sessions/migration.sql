-- =============================================================================
-- 0005_add_sessions —— 多场次支持：vote_sessions 表 + 各业务表挂 session_id
-- =============================================================================
-- 背景：系统从「全局单场」升级为「多场次」。每个场次（如内设机构、安顺车站…）
--   拥有独立的部门/项点/被评列/职工/票种/随机码/评分数据，同库保留历史。
-- 本次迁移：
--   1. 新增 session_status 枚举与 vote_sessions 表；
--   2. 先插入一条默认场次（固定字面量 uuid —— 仓库约定 uuid 由 Prisma 客户端
--      生成、数据库列无 DEFAULT，迁移里只能用字面量），存量数据全部归属它；
--      该行迁移后保留，不删除；
--   3. 八张业务表 ADD COLUMN session_id（先可空）→ 回填默认场次 → SET NOT NULL
--      → 建索引与外键（Restrict）；
--   4. departments 的唯一约束从全局 name 换成 (session_id, name) 场次内唯一；
--   5. tickets 增加 assignee_id（领码人，发放留痕；职工删除时 SetNull）。
--
-- 应用方式：pnpm exec prisma migrate deploy
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 场次表
-- -----------------------------------------------------------------------------
CREATE TYPE "session_status" AS ENUM ('draft', 'voting', 'paused', 'ended');

CREATE TABLE "vote_sessions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "session_status" NOT NULL DEFAULT 'draft',
    "start_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vote_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vote_sessions_name_key" ON "vote_sessions"("name");

-- 默认场次：迁移前的全部存量数据归属它。id 用固定字面量（与 src 里的
-- DEFAULT_SESSION_ID 常量一致），迁移结束不删除该行。
INSERT INTO "vote_sessions" ("id", "name", "status", "created_at")
VALUES ('00000000-0000-7000-8000-000000000001', '默认场次', 'draft', CURRENT_TIMESTAMP);

-- -----------------------------------------------------------------------------
-- 业务表挂 session_id：加列（可空）→ 回填 → NOT NULL → 索引 → 外键
-- -----------------------------------------------------------------------------

-- departments
ALTER TABLE "departments" ADD COLUMN "session_id" TEXT;
UPDATE "departments" SET "session_id" = '00000000-0000-7000-8000-000000000001';
ALTER TABLE "departments" ALTER COLUMN "session_id" SET NOT NULL;
CREATE INDEX "departments_session_id_idx" ON "departments"("session_id");
ALTER TABLE "departments" ADD CONSTRAINT "departments_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "vote_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 部门名称唯一性从「全局」收窄为「场次内」
DROP INDEX "departments_name_key";
CREATE UNIQUE INDEX "departments_session_id_name_key" ON "departments"("session_id", "name");

-- criteria
ALTER TABLE "criteria" ADD COLUMN "session_id" TEXT;
UPDATE "criteria" SET "session_id" = '00000000-0000-7000-8000-000000000001';
ALTER TABLE "criteria" ALTER COLUMN "session_id" SET NOT NULL;
CREATE INDEX "criteria_session_id_idx" ON "criteria"("session_id");
ALTER TABLE "criteria" ADD CONSTRAINT "criteria_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "vote_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- vote_columns
ALTER TABLE "vote_columns" ADD COLUMN "session_id" TEXT;
UPDATE "vote_columns" SET "session_id" = '00000000-0000-7000-8000-000000000001';
ALTER TABLE "vote_columns" ALTER COLUMN "session_id" SET NOT NULL;
CREATE INDEX "vote_columns_session_id_idx" ON "vote_columns"("session_id");
ALTER TABLE "vote_columns" ADD CONSTRAINT "vote_columns_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "vote_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- employees
ALTER TABLE "employees" ADD COLUMN "session_id" TEXT;
UPDATE "employees" SET "session_id" = '00000000-0000-7000-8000-000000000001';
ALTER TABLE "employees" ALTER COLUMN "session_id" SET NOT NULL;
CREATE INDEX "employees_session_id_idx" ON "employees"("session_id");
ALTER TABLE "employees" ADD CONSTRAINT "employees_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "vote_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ticket_types
ALTER TABLE "ticket_types" ADD COLUMN "session_id" TEXT;
UPDATE "ticket_types" SET "session_id" = '00000000-0000-7000-8000-000000000001';
ALTER TABLE "ticket_types" ALTER COLUMN "session_id" SET NOT NULL;
CREATE INDEX "ticket_types_session_id_idx" ON "ticket_types"("session_id");
ALTER TABLE "ticket_types" ADD CONSTRAINT "ticket_types_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "vote_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ticket_batches
ALTER TABLE "ticket_batches" ADD COLUMN "session_id" TEXT;
UPDATE "ticket_batches" SET "session_id" = '00000000-0000-7000-8000-000000000001';
ALTER TABLE "ticket_batches" ALTER COLUMN "session_id" SET NOT NULL;
CREATE INDEX "ticket_batches_session_id_idx" ON "ticket_batches"("session_id");
ALTER TABLE "ticket_batches" ADD CONSTRAINT "ticket_batches_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "vote_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- tickets
ALTER TABLE "tickets" ADD COLUMN "session_id" TEXT;
UPDATE "tickets" SET "session_id" = '00000000-0000-7000-8000-000000000001';
ALTER TABLE "tickets" ALTER COLUMN "session_id" SET NOT NULL;
CREATE INDEX "tickets_session_id_idx" ON "tickets"("session_id");
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "vote_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- score_sheets
ALTER TABLE "score_sheets" ADD COLUMN "session_id" TEXT;
UPDATE "score_sheets" SET "session_id" = '00000000-0000-7000-8000-000000000001';
ALTER TABLE "score_sheets" ALTER COLUMN "session_id" SET NOT NULL;
CREATE INDEX "score_sheets_session_id_idx" ON "score_sheets"("session_id");
ALTER TABLE "score_sheets" ADD CONSTRAINT "score_sheets_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "vote_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- 发放留痕：tickets.assignee_id（领码人）
-- -----------------------------------------------------------------------------
ALTER TABLE "tickets" ADD COLUMN "assignee_id" TEXT;
CREATE INDEX "tickets_assignee_id_idx" ON "tickets"("assignee_id");
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- 注释
-- -----------------------------------------------------------------------------
COMMENT ON TABLE "vote_sessions" IS '投票场次：各场次配置/票码/数据隔离，同库保留历史';
COMMENT ON COLUMN "tickets"."assignee_id" IS '领码人（发放留痕），职工删除时置空';

COMMIT;
