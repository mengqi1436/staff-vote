import { prisma } from '../src/db.js';
import { env } from '../src/env.js';
import { hashPassword } from '../src/lib/password.js';
import { BUILTIN_ROLES, PERMISSION_CATALOG } from '../src/lib/permissions.js';
import { DEFAULT_SETTINGS } from '../src/lib/settings.js';

/**
 * 初始化数据。可重复执行：已存在的记录跳过，不覆盖管理员已改过的配置。
 *
 * 运行：pnpm db:seed
 */

interface TicketTypeSeed {
  code: string;
  name: string;
  weightPercent: number;
  sortOrder: number;
}

/**
 * 默认票种。权重合计 100，满足服务层校验。
 * 名称给出默认语义，管理员可在后台按本单位习惯修改。
 */
const DEFAULT_TICKET_TYPES: TicketTypeSeed[] = [
  { code: 'A', name: 'A 票（领导评议）', weightPercent: 50, sortOrder: 0 },
  { code: 'B', name: 'B 票（部门互评）', weightPercent: 30, sortOrder: 1 },
  { code: 'C', name: 'C 票（职工评议）', weightPercent: 20, sortOrder: 2 },
];

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
 * 首次创建时按代码授予默认权限；已存在的角色【不覆盖】其权限集合 ——
 * 管理员在后台改过的角色必须保留，这与本文件既有的 seed 约定一致。
 *
 * @param permissionIdByCode seedPermissions 返回的权限码 → id 映射
 * @returns 角色码 → 角色 id 的映射
 */
async function seedRoles(permissionIdByCode: Map<string, string>): Promise<Map<string, string>> {
  const idByCode = new Map<string, string>();

  for (const item of BUILTIN_ROLES) {
    const existing = await prisma.adminRole.findUnique({ where: { code: item.code } });
    if (existing) {
      idByCode.set(existing.code, existing.id);
      console.log(`[seed] 角色「${item.name}」已存在，保留其现有权限`);
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

/** 迁移写入的默认场次 ID：存量数据与 seed 票种都归属它（与 0005 迁移一致）。 */
const DEFAULT_SESSION_ID = '00000000-0000-7000-8000-000000000001';

/**
 * 确保默认场次存在（迁移已建则跳过），返回其 ID。
 * 多场次时代码不在这里建新场次——那是管理员的操作。
 */
async function ensureDefaultSession(): Promise<string> {
  const existing = await prisma.voteSession.findUnique({ where: { id: DEFAULT_SESSION_ID } });
  if (existing) return existing.id;
  const created = await prisma.voteSession.create({ data: { id: DEFAULT_SESSION_ID, name: '默认场次' } });
  console.log('[seed] 已创建默认场次');
  return created.id;
}

async function seedTicketTypes(sessionId: string): Promise<void> {
  for (const item of DEFAULT_TICKET_TYPES) {
    const existing = await prisma.ticketType.findUnique({ where: { code: item.code } });
    if (existing) {
      console.log(`[seed] 票种 ${item.code} 已存在，跳过`);
      continue;
    }
    await prisma.ticketType.create({ data: { ...item, sessionId } });
    console.log(`[seed] 已创建票种 ${item.code}（权重 ${item.weightPercent}%）`);
  }
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
  const sessionId = await ensureDefaultSession();
  const permissionIdByCode = await seedPermissions();
  const roleIdByCode = await seedRoles(permissionIdByCode);
  await seedAdmin(roleIdByCode.get('super_admin') ?? null);
  await seedTicketTypes(sessionId);
  await seedSettings();

  const weights = await prisma.ticketType.findMany({
    where: { enabled: true },
    orderBy: { sortOrder: 'asc' },
  });
  const total = weights.reduce((sum, t) => sum + t.weightPercent, 0);
  console.log(
    `[seed] 启用票种权重合计：${total}%` + (total === 100 ? '（校验通过）' : ' ⚠ 必须为 100%，请在后台调整'),
  );
}

main()
  .catch((error: unknown) => {
    console.error('[seed] 失败:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });