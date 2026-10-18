-- =============================================================================
-- 0013_drop_empty_default_session —— 全新库不再预置「默认场次」
-- =============================================================================
-- 背景：0005 建场次表时为了给存量单场数据找归属，插入了一条固定 ID 的
--   「默认场次」。多场次之后，场次由管理员按评议周期自行创建，系统不该自带
--   一个空场次（它会让「当前场次」选择器多出一项，也容易被误当成正式场次）。
--
-- 策略：只在默认场次【完全没有子记录】时删除——即 0005 刚插入、seed 尚未
--   往里放任何配置的全新库。已经配置过部门 / 职工 / 项点 / 票种 / 随机码的
--   历史库保持原样：那些是企业真实配置，不能因为“不想要默认场次”被静默清掉。
--   历史库里若确实要删，用后台「场次管理 → 删除」在界面上确认删除。
-- =============================================================================

DELETE FROM "vote_sessions" AS s
WHERE s."id" = '00000000-0000-7000-8000-000000000001'
  AND NOT EXISTS (SELECT 1 FROM "departments" AS x WHERE x."session_id" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "criteria" AS x WHERE x."session_id" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "vote_columns" AS x WHERE x."session_id" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "employees" AS x WHERE x."session_id" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "ticket_types" AS x WHERE x."session_id" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "ticket_batches" AS x WHERE x."session_id" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "tickets" AS x WHERE x."session_id" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "score_sheets" AS x WHERE x."session_id" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "sheet_ticket_map" AS x WHERE x."session_id" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "session_questionnaire_templates" AS x WHERE x."session_id" = s."id");
