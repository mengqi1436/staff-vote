-- =============================================================================
-- 0002_rbac —— 管理员角色与权限
-- =============================================================================
-- 本文件是表结构【唯一真源】的一部分（理由见 sql/README.md）。
-- 底稿由 `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
-- 生成，随后按 PostgreSQL 官方建议加工：事务包裹、注释。
-- 表/列/索引/外键的定义与 prisma/schema.prisma 严格等价，`pnpm db:drift` 可验证。
--
-- 背景：权限目录的内容由 seed 按 src/lib/permissions.ts 幂等同步到 permissions 表，
-- 新增权限码不需要写迁移；本迁移只负责表结构。
--
-- 应用方式：pnpm exec prisma migrate deploy
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 表结构
-- -----------------------------------------------------------------------------
-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN     "enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "role_id" TEXT;

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "group_name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_roles" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "admin_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "admin_roles_code_key" ON "admin_roles"("code");

-- AddForeignKey
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "admin_roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "admin_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- -----------------------------------------------------------------------------
-- 注释
-- -----------------------------------------------------------------------------
COMMENT ON TABLE "permissions" IS '权限目录。内容由 seed 按 lib/permissions.ts 同步，表存权威副本供角色外键引用';
COMMENT ON COLUMN "permissions"."code" IS '权限码，如 tickets.revoke。代码与数据库以此对齐';
COMMENT ON COLUMN "permissions"."name" IS '权限中文名，后台勾选框直接显示';
COMMENT ON COLUMN "permissions"."group_name" IS '权限分组，后台按组展示';
COMMENT ON COLUMN "permissions"."sort_order" IS '组内排序';

COMMENT ON TABLE "admin_roles" IS '角色。builtin=true 的内置角色不允许删除';
COMMENT ON COLUMN "admin_roles"."code" IS '角色码，如 super_admin。全局唯一';
COMMENT ON COLUMN "admin_roles"."builtin" IS '内置角色标记，防止把系统改到无法自行恢复';

COMMENT ON TABLE "role_permissions" IS '角色-权限关联。删除角色或权限时级联清理';

COMMENT ON COLUMN "admin_users"."role_id" IS '所属角色。为空表示未分配角色，等价于只读';
COMMENT ON COLUMN "admin_users"."enabled" IS '停用后无法登录，且未过期会话令牌立即失效';

COMMIT;
