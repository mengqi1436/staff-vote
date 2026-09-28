-- =============================================================================
-- 0007_session_create_wizard —— 新建场次向导：全局部门字典 + 按码定位答卷
-- =============================================================================
-- 背景：场次创建从「只填名称」升级为向导三步（基本信息 → 问卷 → 票别分配）。
-- 本次迁移：
--   1. 新表 org_departments：全局部门字典，跨场次复用；场次创建时按所选字典部门
--      自动在场内 departments 插入一条同名部门（questionnaire_type 默认 person）；
--   2. vote_sessions 增加 org_department_id 关联字典部门（可空：迁移前的存量
--      场次没有字典来源）。应用层在字典部门被场次引用时拒绝删除（409），
--      数据库层用 RESTRICT 兜底；
--   3. 新表 sheet_ticket_map：随机码 ↔ 答卷的受控映射（一码至多一张答卷，
--      一张答卷至多属于一个码，故 ticket_id 主键、sheet_id 唯一）。
--      仅 results.export 权限的导出路径读取；评分与统计链路不使用本表，
--      score_sheets 保持不含票据标识，匿名边界不变。
--
-- 应用方式：pnpm exec prisma migrate deploy
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 全局部门字典
-- -----------------------------------------------------------------------------
CREATE TABLE "org_departments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "org_departments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "org_departments_name_key" ON "org_departments"("name");

COMMENT ON TABLE "org_departments" IS '全局部门字典：跨场次复用的部门名单，建场次时按名生成场内部门';

-- -----------------------------------------------------------------------------
-- 场次关联字典部门
-- -----------------------------------------------------------------------------
ALTER TABLE "vote_sessions" ADD COLUMN "org_department_id" TEXT;
CREATE INDEX "vote_sessions_org_department_id_idx" ON "vote_sessions"("org_department_id");
ALTER TABLE "vote_sessions" ADD CONSTRAINT "vote_sessions_org_department_id_fkey" FOREIGN KEY ("org_department_id") REFERENCES "org_departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMENT ON COLUMN "vote_sessions"."org_department_id" IS '所属全局部门（字典），空=历史场次无字典来源';

-- -----------------------------------------------------------------------------
-- 随机码与答卷的受控映射（导出专用）
-- -----------------------------------------------------------------------------
CREATE TABLE "sheet_ticket_map" (
    "ticket_id" TEXT NOT NULL,
    "sheet_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "sheet_ticket_map_pkey" PRIMARY KEY ("ticket_id")
);

CREATE UNIQUE INDEX "sheet_ticket_map_sheet_id_key" ON "sheet_ticket_map"("sheet_id");
CREATE INDEX "sheet_ticket_map_session_id_idx" ON "sheet_ticket_map"("session_id");

ALTER TABLE "sheet_ticket_map" ADD CONSTRAINT "sheet_ticket_map_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sheet_ticket_map" ADD CONSTRAINT "sheet_ticket_map_sheet_id_fkey" FOREIGN KEY ("sheet_id") REFERENCES "score_sheets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sheet_ticket_map" ADD CONSTRAINT "sheet_ticket_map_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "vote_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMENT ON TABLE "sheet_ticket_map" IS '随机码与答卷的受控映射：仅 results.export 的导出路径读取，评分与统计链路不使用';

COMMIT;
