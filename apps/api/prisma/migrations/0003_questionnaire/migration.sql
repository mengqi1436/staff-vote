-- =============================================================================
-- 0003_questionnaire —— 打分表与参考表对齐：问卷配置 + 被评列
-- =============================================================================
-- 本文件是表结构【唯一真源】的一部分（理由见 sql/README.md）。
-- 底稿由 `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
-- 生成，随后按 PostgreSQL 官方建议加工：事务包裹、注释。
-- 表/列/索引/外键的定义与 prisma/schema.prisma 严格等价，`pnpm db:drift` 可验证。
--
-- 背景（docs/参考表.xlsx）：
--   参考表是「行 = 评价项点，列 = 被评对象」的问卷，而不是「行 = 职工，列 = 项点」。
--   因此本次迁移做三件事：
--     1. departments 增加问卷表头配置（问卷类型 / 附件号 / 标题 / 填写说明）；
--     2. criteria 增加项点描述（参考表项点名称下方那段长文字）；
--     3. 新增 vote_columns（被评列，如「主任」「党支部书记」「得分」），
--        并把 score_items 的评分维度从 employee_id 换成 vote_column_id。
--
-- 注意：score_items 的 vote_column_id 为 NOT NULL 且无默认值，
--   若目标库已有评分数据，本迁移会失败（这是有意的：宁可失败也不默默丢分）。
--   此时须先导出并迁移历史评分，或在确认无历史数据后再执行。
--   本项目管理库与开发库的 score_sheets / score_items 均为 0 行，可直接应用。
--
-- 应用方式：pnpm exec prisma migrate deploy
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 表结构
-- -----------------------------------------------------------------------------
-- DropForeignKey
ALTER TABLE "score_items" DROP CONSTRAINT "score_items_employee_id_fkey";

-- DropIndex
DROP INDEX "score_items_employee_id_criterion_id_idx";

-- DropIndex
DROP INDEX "score_items_sheet_id_employee_id_criterion_id_key";

-- AlterTable：项点描述
ALTER TABLE "criteria" ADD COLUMN     "description" TEXT;

-- AlterTable：部门级问卷表头配置
ALTER TABLE "departments" ADD COLUMN     "footer_note" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "header_note" TEXT NOT NULL DEFAULT '附件1-1',
ADD COLUMN     "questionnaire_type" TEXT NOT NULL DEFAULT 'person',
ADD COLUMN     "title" TEXT NOT NULL DEFAULT '';

-- AlterTable：评分维度由「职工」改为「被评列」
ALTER TABLE "score_items" DROP COLUMN "employee_id",
ADD COLUMN     "vote_column_id" TEXT NOT NULL;

-- CreateTable：被评列
CREATE TABLE "vote_columns" (
    "id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vote_columns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vote_columns_department_id_idx" ON "vote_columns"("department_id");

-- CreateIndex
CREATE INDEX "score_items_vote_column_id_criterion_id_idx" ON "score_items"("vote_column_id", "criterion_id");

-- CreateIndex
CREATE UNIQUE INDEX "score_items_sheet_id_vote_column_id_criterion_id_key" ON "score_items"("sheet_id", "vote_column_id", "criterion_id");

-- AddForeignKey
ALTER TABLE "vote_columns" ADD CONSTRAINT "vote_columns_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "score_items" ADD CONSTRAINT "score_items_vote_column_id_fkey" FOREIGN KEY ("vote_column_id") REFERENCES "vote_columns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- -----------------------------------------------------------------------------
-- 注释
-- -----------------------------------------------------------------------------
COMMENT ON TABLE "vote_columns" IS '被评列，即打分表的「列」：个人问卷为各被评职务，车间问卷只有一列「得分」';
COMMENT ON COLUMN "vote_columns"."name" IS '列名，直接显示在打分表表头';
COMMENT ON COLUMN "vote_columns"."sort_order" IS '列顺序，数字小的在左边';
COMMENT ON COLUMN "vote_columns"."enabled" IS '停用后不进入打分表，历史评分保留';

COMMENT ON COLUMN "departments"."questionnaire_type" IS '问卷类型：person=个人问卷（多列被评职务），workshop=车间问卷（单列得分）';
COMMENT ON COLUMN "departments"."header_note" IS '表头左上角附件号，如「附件1-1」';
COMMENT ON COLUMN "departments"."title" IS '打分表标题，如「xx车间负责人评价问卷」';
COMMENT ON COLUMN "departments"."footer_note" IS '表尾填写说明（参考表里合并整行的说明文字）';

COMMENT ON COLUMN "criteria"."description" IS '项点描述，显示在打分表项点名称下方';
COMMENT ON COLUMN "criteria"."name" IS '项点名称，即打分表的行标题';

COMMENT ON COLUMN "score_items"."vote_column_id" IS '被评列。取代原先的 employee_id：打分对象是职务/车间，不是具体职工';
COMMENT ON COLUMN "employees"."name" IS '职工姓名。参考表口径下不参与打分，保留给后台名单管理';

COMMIT;