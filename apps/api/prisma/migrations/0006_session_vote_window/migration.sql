-- =============================================================================
-- 0006_session_vote_window —— 开放时间窗下沉到场次，全局投票开关退役
-- =============================================================================
-- 背景：「什么时候能投票」从全局设置（settings 键 vote.open / vote.startAt /
--   vote.endAt）下沉到每个场次，各场次独立控制开放窗口。
-- 本次迁移：
--   1. vote_sessions 增加 opens_at / closes_at（可空 TIMESTAMPTZ(3)）：
--      opens_at 空 = 不限制开始，closes_at 空 = 长期开放；
--   2. ticket_types 的票种编码唯一性从「全局 code」收窄为「场次内 (session_id, code)」，
--      不同场次可以各自有 A/B/C 票种；
--   3. settings 删除键 vote.open / vote.startAt / vote.endAt（system.title 保留）。
--      存量多场次的数据里各场次票种 code 本就全局唯一，收窄为场次内唯一不产生冲突。
--
-- 应用方式：pnpm exec prisma migrate deploy
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 场次开放时间窗
-- -----------------------------------------------------------------------------
ALTER TABLE "vote_sessions" ADD COLUMN "opens_at" TIMESTAMPTZ(3);
ALTER TABLE "vote_sessions" ADD COLUMN "closes_at" TIMESTAMPTZ(3);

-- -----------------------------------------------------------------------------
-- 票种编码唯一性收窄为场次内
-- -----------------------------------------------------------------------------
DROP INDEX "ticket_types_code_key";
CREATE UNIQUE INDEX "ticket_types_session_id_code_key" ON "ticket_types"("session_id", "code");

-- -----------------------------------------------------------------------------
-- 全局投票开关与时间窗退役
-- -----------------------------------------------------------------------------
DELETE FROM "settings" WHERE "key" IN ('vote.open', 'vote.startAt', 'vote.endAt');

-- -----------------------------------------------------------------------------
-- 注释
-- -----------------------------------------------------------------------------
COMMENT ON COLUMN "vote_sessions"."opens_at" IS '开放开始时间，空=不限制开始';
COMMENT ON COLUMN "vote_sessions"."closes_at" IS '开放结束时间，空=长期开放';

COMMIT;
