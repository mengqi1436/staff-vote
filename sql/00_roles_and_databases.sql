-- =============================================================================
-- 职工素质投票系统 —— 角色与数据库初始化
-- =============================================================================
-- 执行者：PostgreSQL 超级用户
-- 说明  ：本文件创建角色与数据库，属于环境准备，不进入 Prisma 迁移历史。
-- 目标  ：192.168.1.11:5432  PostgreSQL 17.11 (Ubuntu)
--
-- 幂等性：PostgreSQL 的 CREATE ROLE / CREATE DATABASE 没有 IF NOT EXISTS，
--         重复执行会报 "already exists"。需要重跑时请先手动清理。
--
-- 安全约定：
--   1. staff 是本项目专用账号，只连接 staff 库（以及可选的测试库）。
--   2. 刻意不授予 CREATEDB —— 本方案的迁移工作流（手写 SQL + prisma migrate
--      deploy）不需要 shadow database，因此开发账号不应具备随意建库的能力。
--   3. 应用连接串绝不使用 postgres 超级用户。
--   4. 该实例上还有 gycwd 等其他业务库，本脚本不触碰它们。
-- =============================================================================

-- 1) 专用账号
--    口令在执行时替换为实际值；真实口令只写入本机 .env（已 gitignore），
--    不要提交到版本库。
CREATE ROLE staff WITH LOGIN PASSWORD 'CHANGE_ME';

-- 2) 主库：排序规则与既有业务库保持一致，避免中文排序行为不一致
CREATE DATABASE staff WITH
  OWNER      = staff
  ENCODING   = 'UTF8'
  LC_COLLATE = 'zh_CN.UTF-8'
  LC_CTYPE   = 'zh_CN.UTF-8'
  TEMPLATE   = template0;

-- 3) 集成测试库（可选，默认注释掉）。
--    只有要跑 `pnpm -r test` 时才需要，生产环境不必创建。
--    需要时取消注释、执行，然后应用一次表结构：
--      cd apps/api
--      DATABASE_URL="postgresql://staff:<口令>@<主机>:5432/staff_test" pnpm exec prisma migrate deploy
--    三个接口测试文件共用这一个库；vitest 已关闭文件级并行
--    （见 apps/api/vitest.config.ts），所以不会互相清数据。
--
-- CREATE DATABASE staff_test WITH
--   OWNER      = staff
--   ENCODING   = 'UTF8'
--   LC_COLLATE = 'zh_CN.UTF-8'
--   LC_CTYPE   = 'zh_CN.UTF-8'
--   TEMPLATE   = template0;

-- 4) 校验：确认编码、排序规则与属主
SELECT datname,
       pg_encoding_to_char(encoding) AS encoding,
       datcollate                    AS collate,
       pg_get_userbyid(datdba)       AS owner
FROM pg_database
WHERE datname = 'staff'
ORDER BY datname;