-- 0014：全局人员目录
-- 1) 新增 staff_directory：外部系统定期推送的人员真源，工号唯一、挂全局部门字典；
-- 2) employees 增 employee_no：由目录带入的场次副本记工号，作为同场次幂等键
--    （唯一索引在同场次内生效；手工新增/Excel 导入的历史行为没有工号，保持 NULL，
--     PostgreSQL 唯一索引允许多个 NULL，不会与存量数据冲突）。

CREATE TABLE "staff_directory" (
    "id" TEXT NOT NULL,
    "employee_no" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gender" TEXT,
    "age" INTEGER,
    "title" TEXT,
    "org_department_id" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "staff_directory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "staff_directory_employee_no_key" ON "staff_directory"("employee_no");
CREATE INDEX "staff_directory_org_department_id_idx" ON "staff_directory"("org_department_id");
CREATE INDEX "staff_directory_name_idx" ON "staff_directory"("name");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'staff_directory_org_department_id_fkey'
    ) THEN
        ALTER TABLE "staff_directory"
            ADD CONSTRAINT "staff_directory_org_department_id_fkey"
            FOREIGN KEY ("org_department_id") REFERENCES "org_departments"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

ALTER TABLE "employees" ADD COLUMN "employee_no" TEXT;
CREATE UNIQUE INDEX "employees_session_id_employee_no_key" ON "employees"("session_id", "employee_no");
