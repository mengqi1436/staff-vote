-- 随机码绑定评议部门：发码时批次级指定目标部门，持码人只能评议绑定部门。
-- 可空外键：NULL = 不限定（存量码与不发指定部门的批次保持「万能码」语义）。
-- ON DELETE RESTRICT（不要 SetNull）：部门删除时 SetNull 会把受限码静默退回万能码，
-- 等于放宽权限；删除部门前须先作废/解绑相关码。
ALTER TABLE "ticket_batches" ADD COLUMN "department_id" TEXT REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tickets" ADD COLUMN "department_id" TEXT REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "ticket_batches_department_id_idx" ON "ticket_batches"("department_id");
CREATE INDEX "tickets_department_id_idx" ON "tickets"("department_id");

COMMENT ON COLUMN "ticket_batches"."department_id" IS '评议部门绑定；NULL=不限定（可评全部部门）；删除部门前须先作废/解绑（Restrict）';
COMMENT ON COLUMN "tickets"."department_id" IS '评议部门绑定；NULL=不限定（可评全部部门）；删除部门前须先作废/解绑（Restrict）';
