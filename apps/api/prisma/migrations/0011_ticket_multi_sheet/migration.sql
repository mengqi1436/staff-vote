-- 一码多表（score_scope=both：个人 + 车间两张答卷）：主键从单列 ticket_id
-- 改为复合 (ticket_id, sheet_id)；sheet_id 的唯一约束保留（一表至多一码）。
ALTER TABLE "sheet_ticket_map" DROP CONSTRAINT "sheet_ticket_map_pkey";
ALTER TABLE "sheet_ticket_map" ADD PRIMARY KEY ("ticket_id", "sheet_id");
