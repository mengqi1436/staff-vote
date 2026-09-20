/**
 * RBAC 测试夹具。
 *
 * 测试库（`staff_test`）只跑迁移、不跑 seed，所以 `permissions` 表在库里是空的；
 * 而角色授权依赖权限行的外键 —— 权限行缺失时角色拿不到任何权限，
 * 症状是「明明给了全权限的账号，写操作也全被 403」，排查成本很高。
 * 因此凡涉及权限的测试，都应先调用 {@link ensurePermissions}。
 *
 * 约定：夹具的角色 code 与账号用户名都带调用方给的 TAG 前缀，
 * 清理只删自己的数据，与同库其他测试文件并存时不会误删。
 */
import { prisma } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';
import { PERMISSION_CATALOG } from '../src/lib/permissions.js';

/**
 * 把权限目录同步进测试库（幂等）。
 *
 * @returns 权限码 → 权限 id 映射
 */
export async function ensurePermissions(): Promise<Map<string, string>> {
  const idByCode = new Map<string, string>();
  for (const item of PERMISSION_CATALOG) {
    const row = await prisma.permission.upsert({
      where: { code: item.code },
      update: { name: item.name, groupName: item.groupName, sortOrder: item.sortOrder },
      create: item,
    });
    idByCode.set(row.code, row.id);
  }
  return idByCode;
}

/**
 * 建一个角色并按权限码授权（幂等：同 code 已存在则复用并重建权限集合）。
 *
 * @param code 角色码，建议带测试文件的前缀
 * @param name 角色名
 * @param permissions 权限码；传 `[]` 即只读角色
 * @returns 角色 id
 */
export async function createRole(
  code: string,
  name: string,
  permissions: string[],
): Promise<string> {
  const permissionIdByCode = await ensurePermissions();
  const role = await prisma.adminRole.upsert({
    where: { code },
    update: { name, description: `测试夹具 ${code}` },
    create: { code, name, description: `测试夹具 ${code}` },
  });

  // 权限集合整体重建，保证与传入集合一致（重复调用不会留下上一次的残留）
  await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
  const links = permissions
    .map((permissionCode) => permissionIdByCode.get(permissionCode))
    .filter((permissionId): permissionId is string => Boolean(permissionId))
    .map((permissionId) => ({ roleId: role.id, permissionId }));
  if (links.length > 0) await prisma.rolePermission.createMany({ data: links });

  return role.id;
}

/**
 * 建一个管理员账号。
 *
 * @param username 用户名，建议带测试文件的前缀
 * @param password 明文口令
 * @param roleId 角色 id；传 `null` 即未分配角色（等价只读）
 * @returns 账号 id
 */
export async function createAdmin(
  username: string,
  password: string,
  roleId: string | null,
): Promise<string> {
  const row = await prisma.adminUser.create({
    data: { username, passwordHash: await hashPassword(password), roleId },
  });
  return row.id;
}

/**
 * 清理本前缀的夹具。
 *
 * 按前缀只删自己的数据；账号先删（其 role_id 外键是 SET NULL，不删也不影响角色删除）。
 *
 * @param tag 夹具前缀
 */
export async function cleanupRbac(tag: string): Promise<void> {
  await prisma.adminUser.deleteMany({ where: { username: { startsWith: tag } } });
  await prisma.adminRole.deleteMany({ where: { code: { startsWith: tag } } });
}