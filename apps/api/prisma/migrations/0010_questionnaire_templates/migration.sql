-- 0010：问卷模板化改造
-- 1) 场次级两套问卷模板（个人 / 车间）：附件号 + 标题 + 填写说明，脱离部门；
-- 2) 项点模板化：criteria.department_id 改可空，新增 template_type，
--    模板项点 = department_id IS NULL AND template_type 非空（每场次每类型一套）；
-- 3) 场次打分范围 score_scope：person 仅个人问卷 / both 两张问卷都打；
-- 4) 车间问卷无被评列：score_items.vote_column_id 改可空。

-- ---------------------------------------------------------------- 1) 模板表
CREATE TABLE "session_questionnaire_templates" (
    "session_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "header_note" TEXT NOT NULL DEFAULT '附件1-1',
    "title" TEXT NOT NULL DEFAULT '',
    "footer_note" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "session_questionnaire_templates_pkey" PRIMARY KEY ("session_id", "type")
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'session_questionnaire_templates_session_id_fkey'
    ) THEN
        ALTER TABLE "session_questionnaire_templates"
            ADD CONSTRAINT "session_questionnaire_templates_session_id_fkey"
            FOREIGN KEY ("session_id") REFERENCES "vote_sessions"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ------------------------------------------------- 2) 部门三件套迁移到模板表
-- 每场次每类型取 sort_order 最小的部门作为取样来源（同类型部门三件套应一致）。
INSERT INTO "session_questionnaire_templates" ("session_id", "type", "header_note", "title", "footer_note", "created_at", "updated_at")
SELECT DISTINCT ON ("session_id", "questionnaire_type")
       "session_id", "questionnaire_type", "header_note", "title", "footer_note", now(), now()
FROM "departments"
ORDER BY "session_id", "questionnaire_type", "sort_order";

-- ------------------------------------------------------------- 3) 项点模板化
ALTER TABLE "criteria" ADD COLUMN "template_type" TEXT;
ALTER TABLE "criteria" ALTER COLUMN "department_id" DROP NOT NULL;
CREATE INDEX "criteria_session_id_template_type_idx" ON "criteria"("session_id", "template_type");

-- 模板项点种子：从每场次每类型的代表部门整行复制启用项点，
-- department_id 置空 + template_type 归类；存量部门项点原样保留（历史 score_items 外键）。
INSERT INTO "criteria" ("id", "session_id", "department_id", "template_type", "name", "description", "min_score", "max_score", "sort_order", "enabled", "created_at", "updated_at")
SELECT gen_random_uuid()::text,
       "d"."session_id", NULL, "d"."questionnaire_type",
       "c"."name", "c"."description", "c"."min_score", "c"."max_score", "c"."sort_order", true, now(), now()
FROM (
    SELECT DISTINCT ON ("session_id", "questionnaire_type")
           "session_id", "questionnaire_type", "id" AS "dept_id"
    FROM "departments"
    ORDER BY "session_id", "questionnaire_type", "sort_order"
) AS "d"
JOIN "criteria" AS "c" ON "c"."department_id" = "d"."dept_id" AND "c"."enabled";

-- 部门表三件套列退役（真源已迁至 session_questionnaire_templates）
ALTER TABLE "departments" DROP COLUMN "header_note";
ALTER TABLE "departments" DROP COLUMN "title";
ALTER TABLE "departments" DROP COLUMN "footer_note";

-- ----------------------------------------------------------- 4) 场次打分范围
ALTER TABLE "vote_sessions" ADD COLUMN "score_scope" TEXT NOT NULL DEFAULT 'person';

-- ------------------------------------------------------- 5) 车间得分无被评列
ALTER TABLE "score_items" ALTER COLUMN "vote_column_id" DROP NOT NULL;
