import { prisma } from '../src/db.js';
import { env } from '../src/env.js';
import { hashPassword } from '../src/lib/password.js';
import { BUILTIN_ROLES, PERMISSION_CATALOG } from '../src/lib/permissions.js';
import { DEFAULT_SETTINGS } from '../src/lib/settings.js';

/**
 * 初始化数据。可重复执行：已存在的记录跳过，不覆盖管理员已改过的配置。
 *
 * 不预置任何场次与票种：场次是管理员按评议周期自行创建的，票种归属场次、
 * 由建场向导第三步分配。系统初始化只准备「权限目录 + 内置角色 + 管理员 + 设置项」
 * 这些与业务数据无关的基础数据。
 *
 * 运行：pnpm db:seed
 */

async function seedAdmin(roleId: string | null): Promise<void> {
  const username = env.ADMIN_USERNAME;
  const password = env.ADMIN_PASSWORD;

  if (!password) {
    console.warn('[seed] 未配置 ADMIN_PASSWORD，跳过管理员初始化');
    return;
  }

  const existing = await prisma.adminUser.findUnique({ where: { username } });
  if (existing) {
    // 只补「尚未分配角色」的情况：role_id 是后加的列，老账号上是 NULL，
    // 不补就没有任何权限，系统会把自己锁死。
    if (!existing.roleId && roleId) {
      await prisma.adminUser.update({ where: { id: existing.id }, data: { roleId } });
      console.log(`[seed] 已为管理员 ${username} 补上内置角色「超级管理员」`);
    } else {
      console.log(`[seed] 管理员 ${username} 已存在，跳过（不覆盖已改的口令与角色）`);
    }
    return;
  }

  await prisma.adminUser.create({
    data: { username, passwordHash: await hashPassword(password), roleId },
  });
  console.log(`[seed] 已创建管理员 ${username}（超级管理员），请登录后立即修改口令`);
}

/**
 * 同步权限目录。
 *
 * 按 code 幂等 upsert：新增权限只需改 lib/permissions.ts 再跑 seed，不必写迁移。
 *
 * @returns 权限码 → 权限 id 的映射，供角色授权使用
 */
async function seedPermissions(): Promise<Map<string, string>> {
  const idByCode = new Map<string, string>();
  for (const item of PERMISSION_CATALOG) {
    const row = await prisma.permission.upsert({
      where: { code: item.code },
      update: { name: item.name, groupName: item.groupName, sortOrder: item.sortOrder },
      create: item,
    });
    idByCode.set(row.code, row.id);
  }
  console.log(`[seed] 权限目录就绪（${PERMISSION_CATALOG.length} 项）`);
  return idByCode;
}

/**
 * 同步内置角色。
 *
 * 首次创建时按代码授予默认权限；已存在的角色【只增不删】——
 * 权限目录随代码演进（如新增 results.export），为已存在的内置角色补授
 * 其定义集合中缺失的权限，保证新增权限码不需要手工到每个环境里勾选；
 * 管理员在后台加的权限与删掉的权限都不回滚（不做整体覆盖）。
 *
 * @param permissionIdByCode seedPermissions 返回的权限码 → id 映射
 * @returns 角色码 → 角色 id 的映射
 */
async function seedRoles(permissionIdByCode: Map<string, string>): Promise<Map<string, string>> {
  const idByCode = new Map<string, string>();

  for (const item of BUILTIN_ROLES) {
    const existing = await prisma.adminRole.findUnique({ where: { code: item.code } });
    if (existing) {
      const definedIds = item.permissions
        .map((code) => permissionIdByCode.get(code))
        .filter((permissionId): permissionId is string => Boolean(permissionId));
      const currentIds = new Set(
        (
          await prisma.rolePermission.findMany({
            where: { roleId: existing.id },
            select: { permissionId: true },
          })
        ).map((row) => row.permissionId),
      );
      const missing = definedIds.filter((permissionId) => !currentIds.has(permissionId));
      if (missing.length > 0) {
        await prisma.rolePermission.createMany({
          data: missing.map((permissionId) => ({ roleId: existing.id, permissionId })),
        });
        console.log(`[seed] 已为角色「${item.name}」补授 ${missing.length} 项新增权限`);
      } else {
        console.log(`[seed] 角色「${item.name}」已存在，权限齐备`);
      }

      idByCode.set(existing.code, existing.id);
      continue;
    }

    const row = await prisma.adminRole.create({
      data: { code: item.code, name: item.name, description: item.description, builtin: true },
    });
    const links = item.permissions
      .map((code) => permissionIdByCode.get(code))
      .filter((permissionId): permissionId is string => Boolean(permissionId))
      .map((permissionId) => ({ roleId: row.id, permissionId }));
    if (links.length > 0) await prisma.rolePermission.createMany({ data: links });

    idByCode.set(row.code, row.id);
    console.log(`[seed] 已创建角色「${item.name}」（${links.length} 项权限）`);
  }

  return idByCode;
}

async function seedSettings(): Promise<void> {
  for (const item of DEFAULT_SETTINGS) {
    await prisma.setting.upsert({
      where: { key: item.key },
      update: {}, // 已存在则不覆盖：管理员改过的值必须保留
      create: item,
    });
  }
  console.log(`[seed] 设置项就绪（${DEFAULT_SETTINGS.length} 项）`);
}

async function main(): Promise<void> {
  const permissionIdByCode = await seedPermissions();
  const roleIdByCode = await seedRoles(permissionIdByCode);
  await seedAdmin(roleIdByCode.get('super_admin') ?? null);
  await seedSettings();
}

main()
  .catch((error: unknown) => {
    console.error('[seed] 失败:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });