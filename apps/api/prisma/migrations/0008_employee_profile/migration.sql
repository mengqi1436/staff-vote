-- 职工信息字段重构：仅保留「姓名、性别、年龄、职称」四个信息字段。
-- 工号（employee_no）是为对接人事系统预留的，从未真正启用，随本次一并移除；
-- DROP COLUMN 会连带删除其唯一索引 employees_employee_no_key。
ALTER TABLE "employees" ADD COLUMN "gender" TEXT;
ALTER TABLE "employees" ADD COLUMN "age" INTEGER;
ALTER TABLE "employees" ADD COLUMN "title" TEXT;
ALTER TABLE "employees" DROP COLUMN "employee_no";

COMMENT ON COLUMN "employees"."gender" IS '性别：男/女，可空';
COMMENT ON COLUMN "employees"."age" IS '年龄，可空';
COMMENT ON COLUMN "employees"."title" IS '职称，可空';
