-- 模板表主键改造：复合主键 (session_id, type) → 单列 id 代理主键 + (session_id, type) 唯一约束。
-- Prisma 7.10 生成器对「一半外键 + 一半普通字段」的复合主键会序列化出空 primaryKey 元数据，
-- 导致 SessionQuestionnaireTemplate 模型所有查询编译报 P2022；改单列主键绕开，业务语义不变
-- （唯一约束仍保证每场次每类型一套模板）。id 列应用层生成（uuid(7)），DB 侧无默认值。
ALTER TABLE "session_questionnaire_templates" DROP CONSTRAINT "session_questionnaire_templates_pkey";

ALTER TABLE "session_questionnaire_templates" ADD COLUMN "id" TEXT;

UPDATE "session_questionnaire_templates" SET "id" = gen_random_uuid()::text WHERE "id" IS NULL;

ALTER TABLE "session_questionnaire_templates" ALTER COLUMN "id" SET NOT NULL;

ALTER TABLE "session_questionnaire_templates"
  ADD CONSTRAINT "session_questionnaire_templates_pkey" PRIMARY KEY ("id");

ALTER TABLE "session_questionnaire_templates"
  ADD CONSTRAINT "session_questionnaire_templates_session_id_type_key" UNIQUE ("session_id", "type");
