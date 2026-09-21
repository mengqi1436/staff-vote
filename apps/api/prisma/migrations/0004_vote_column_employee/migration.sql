-- =============================================================================
-- 0004_vote_column_employee —— 被评列关联具体被评人（「职务与姓名」的姓名）
-- =============================================================================
-- 背景：问卷表头为两行，第一行是被评职务（列名），第二行在电子版里用于
--   选择该职务对应的具体职工（打印空白表时留空）。
-- 本次迁移：vote_columns 增加 employee_id 外键，指向本部门的职工；
--   职工被删除时列保留、退回「未选人」状态（ON DELETE SET NULL）。
--
-- 应用方式：pnpm exec prisma migrate deploy
-- =============================================================================

BEGIN;

-- AlterTable：被评列关联被评人
ALTER TABLE "vote_columns" ADD COLUMN     "employee_id" TEXT;

-- CreateIndex
CREATE INDEX "vote_columns_employee_id_idx" ON "vote_columns"("employee_id");

-- AddForeignKey
ALTER TABLE "vote_columns" ADD CONSTRAINT "vote_columns_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- -----------------------------------------------------------------------------
-- 注释
-- -----------------------------------------------------------------------------
COMMENT ON COLUMN "vote_columns"."employee_id" IS '该职务列对应的具体被评人（表头第二行的姓名），可空';

COMMIT;
