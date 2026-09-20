/**
 * RBAC 业务逻辑：权限目录、角色、管理员账号。
 *
 * 路由层只做「取参 → 调服务 → 回响应」，规则集中在这里，便于测试与复用。
 *
 * 本文件承载系统的几条安全不变式，改动前先读完这一段：
 *   1. 不能停用、删除、或把自己降级成没有 `admins.manage` 的角色；
 *   2. 系统必须至少保留一个「已启用且拥有 admins.manage」的账号 ——
 *      破坏它的后果不是一次操作失败，而是【再也没人能管理权限】，只能改库才能恢复。
 *      账号启停与角色权限是两个入口，两边都要拦；
 *   3. 口令至少 8 位（与 env.ADMIN_PASSWORD 同口径），用户名与角色代码唯一；
 *   4. 所有写操作落 AuditLog（动作 + 操作者 + 对象）。
 */
import { prisma } from '../db.js';
import { hashPassword } from '../lib/password.js';
import { PERMISSION_CATALOG } from '../lib/permissions.js';
import { ApiError } from '../middleware/errorHandler.js';

/** 管理权限码：系统里唯一一个「能改变权限本身」的权限，锁死判定围绕它。 */
export const MANAGE_PERMISSION = 'admins.manage';

/** 口令最小长度，与 env.ADMIN_PASSWORD 的校验一致。 */
export const MIN_PASSWORD_LENGTH = 8;

// -----------------------------------------------------------------------------
// 传输对象（与 apps/web/src/lib/api.ts 的类型一一对应）
// -----------------------------------------------------------------------------

export interface PermissionDto {
  code: string;
  name: string;
  groupName: string;
  sortOrder: number;
}

export interface RoleDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  /** 内置角色不可删除 */
  builtin: boolean;
  permissions: string[];
  /** 正在使用该角色的账号数，用于删除前提示 */
  adminCount: number;
}

export interface AdminUserDto {
  id: string;
  username: string;
  roleId: string | null;
  roleName: string | null;
  enabled: boolean;
  createdAt: string;
}

/** 审计明细：只用 JSONB 能直接存的基本类型。 */
type AuditDetail = Record<string, string | number | boolean | null>;

async function writeAudit(action: string, detail: AuditDetail): Promise<void> {
  await prisma.auditLog.create({ data: { action, detail } });
}

/** 权限码在目录里的位置，用于让权限集合按目录顺序稳定输出。 */
const CATALOG_ORDER = new Map(PERMISSION_CATALOG.map((item, index) => [item.code, index]));

function sortPermissionCodes(codes: string[]): string[] {
  return [...codes].sort(
    (a, b) =>
      (CATALOG_ORDER.get(a) ?? Number.MAX_SAFE_INTEGER) -
      (CATALOG_ORDER.get(b) ?? Number.MAX_SAFE_INTEGER),
  );
}

/** 描述统一归一：空串与纯空白都存 null，避免库里出现两种「空」。 */
function normalizeDescription(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// -----------------------------------------------------------------------------
// 权限目录
// -----------------------------------------------------------------------------

/**
 * 权限目录。
 *
 * 直接由 `lib/permissions.ts` 输出，而不是读库里的 permissions 表：
 * 那份表只是为了让角色授权能走外键的副本，真源在代码里。
 * 读库会在「新部署还没跑 seed」「测试库只跑了迁移」时返回空目录，
 * 前端勾选框跟着变空，看起来像权限丢了 —— 用真源就没有这个状态。
 */
export function listPermissions(): PermissionDto[] {
  return [...PERMISSION_CATALOG]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((item) => ({
      code: item.code,
      name: item.name,
      groupName: item.groupName,
      sortOrder: item.sortOrder,
    }));
}

/**
 * 权限码 → 权限行 id。
 *
 * 缺行时按目录幂等补齐（与 seed 同一套定义）：授权依赖权限行的外键，
 * 库里少一行会让角色「看起来授权成功、实际一个权限都没有」。
 *
 * @param codes 权限码，允许重复
 * @returns 去重后的权限行 id，与传入顺序一致
 */
async function permissionIdsByCode(codes: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const code of [...new Set(codes)]) {
    const seed = PERMISSION_CATALOG.find((item) => item.code === code);
    if (!seed) throw ApiError.badRequest(`未知权限码：${code}`, 'UNKNOWN_PERMISSION');

    const row = await prisma.permission.upsert({ where: { code }, update: {}, create: seed });
    ids.push(row.id);
  }
  return ids;
}

// -----------------------------------------------------------------------------
// 安全不变式
// -----------------------------------------------------------------------------

/** 「系统锁死」的统一拒绝文案与错误码。 */
function lastManagerError(): ApiError {
  return ApiError.conflict(
    '系统必须至少保留一个已启用、且拥有「管理管理员账号与角色权限」权限的账号，' +
      '否则将无人能再管理权限',
    'LAST_MANAGER',
  );
}

/**
 * 全库「已启用且角色含 admins.manage」的账号 id。
 *
 * 这是锁死判定的观察口径：停用、删除、改角色、改角色权限四条路径
 * 都要拿它算「操作之后还剩几个」。
 *
 * ponytail: 守卫检查与写入之间存在 TOCTOU 窗口 —— 两个并发请求可能都看到
 * 「对方还在」而同时停用最后两个管理账号。管理员个位数的内部系统不值得为此
 * 上 SERIALIZABLE 事务或咨询锁；万一发生，直接改库恢复一个账号的
 * enabled/role_id 即可解锁（这也是 lastManagerError 文案里写明后果的原因）。
 */
async function manageCapableAdminIds(): Promise<Set<string>> {
  const rows = await prisma.adminUser.findMany({
    where: {
      enabled: true,
      role: { permissions: { some: { permission: { code: MANAGE_PERMISSION } } } },
    },
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}

async function roleHasManage(roleId: string | null): Promise<boolean> {
  if (!roleId) return false;
  const count = await prisma.rolePermission.count({
    where: { roleId, permission: { code: MANAGE_PERMISSION } },
  });
  return count > 0;
}

/**
 * 守卫：某角色失去 admins.manage 之后，系统里必须还有别的管理账号。
 *
 * 「不能停用最后一个管理账号」管的是账号侧，这里管的是授权侧 ——
 * 只拦一侧的话，另一侧照样能把系统改成谁都没有管理权限。
 *
 * @param roleId 即将失去 admins.manage 的角色
 */
async function assertAnotherManagerRemains(roleId: string): Promise<void> {
  const capable = await manageCapableAdminIds();
  const affected = await prisma.adminUser.findMany({
    where: { roleId, enabled: true },
    select: { id: true },
  });
  const affectedIds = new Set(affected.map((row) => row.id));
  const remaining = [...capable].filter((adminId) => !affectedIds.has(adminId));
  if (remaining.length === 0) throw lastManagerError();
}

async function assertRoleExists(roleId: string): Promise<void> {
  if (!(await prisma.adminRole.findUnique({ where: { id: roleId } }))) {
    throw ApiError.badRequest('角色不存在', 'ROLE_NOT_FOUND');
  }
}

// -----------------------------------------------------------------------------
// 角色
// -----------------------------------------------------------------------------

function toRoleDto(row: {
  id: string;
  code: string;
  name: string;
  description: string | null;
  builtin: boolean;
  permissions: Array<{ permission: { code: string } }>;
  _count: { admins: number };
}): RoleDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    builtin: row.builtin,
    permissions: sortPermissionCodes(row.permissions.map((link) => link.permission.code)),
    adminCount: row._count.admins,
  };
}

export async function listRoles(): Promise<RoleDto[]> {
  const rows = await prisma.adminRole.findMany({
    include: {
      permissions: { include: { permission: { select: { code: true } } } },
      _count: { select: { admins: true } },
    },
    // 内置角色由 seed 最早创建，按创建时间排就自然排在最前
    orderBy: [{ createdAt: 'asc' }, { code: 'asc' }],
  });
  return rows.map(toRoleDto);
}

export interface RoleCreateInput {
  code: string;
  name: string;
  description?: string | null;
  permissions: string[];
}

export async function createRole(input: RoleCreateInput, operator: string): Promise<RoleDto> {
  const code = input.code.trim();
  if (await prisma.adminRole.findUnique({ where: { code } })) {
    throw ApiError.conflict(`角色代码 ${code} 已存在`, 'ROLE_CODE_EXISTS');
  }
  // 先解析权限再建角色：未知权限码直接 400，不留下一个没有权限的空角色
  const permissionIds = await permissionIdsByCode(input.permissions);

  const created = await prisma.$transaction(async (tx) => {
    const role = await tx.adminRole.create({
      data: { code, name: input.name.trim(), description: normalizeDescription(input.description) },
    });
    if (permissionIds.length > 0) {
      await tx.rolePermission.createMany({
        data: permissionIds.map((permissionId) => ({ roleId: role.id, permissionId })),
      });
    }
    return tx.adminRole.findUniqueOrThrow({
      where: { id: role.id },
      include: {
        permissions: { include: { permission: { select: { code: true } } } },
        _count: { select: { admins: true } },
      },
    });
  });

  await writeAudit('role.create', {
    code: created.code,
    name: created.name,
    permissions: sortPermissionCodes(created.permissions.map((link) => link.permission.code)).join(','),
    operator,
  });
  return toRoleDto(created);
}

export interface RolePatchInput {
  name?: string;
  description?: string | null;
  permissions?: string[];
}

export async function updateRole(
  id: string,
  patch: RolePatchInput,
  operator: string,
): Promise<RoleDto> {
  const current = await prisma.adminRole.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('角色不存在');

  // 角色代码刻意不在 patch 里：它是权限判定与审计记录里的锚点，改名会让历史记录失去指代
  const permissionCodes = patch.permissions === undefined ? undefined : [...new Set(patch.permissions)];
  if (permissionCodes && !permissionCodes.includes(MANAGE_PERMISSION)) {
    await assertAnotherManagerRemains(id);
  }
  const permissionIds = permissionCodes ? await permissionIdsByCode(permissionCodes) : undefined;

  const updated = await prisma.$transaction(async (tx) => {
    await tx.adminRole.update({
      where: { id },
      data: {
        name: patch.name?.trim(),
        description: normalizeDescription(patch.description),
      },
    });
    if (permissionIds) {
      // 整组替换而非增量合并：前端勾选框提交的就是完整集合
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      if (permissionIds.length > 0) {
        await tx.rolePermission.createMany({
          data: permissionIds.map((permissionId) => ({ roleId: id, permissionId })),
        });
      }
    }
    return tx.adminRole.findUniqueOrThrow({
      where: { id },
      include: {
        permissions: { include: { permission: { select: { code: true } } } },
        _count: { select: { admins: true } },
      },
    });
  });

  await writeAudit('role.update', {
    code: updated.code,
    name: updated.name,
    permissions: sortPermissionCodes(updated.permissions.map((link) => link.permission.code)).join(','),
    operator,
  });
  return toRoleDto(updated);
}

export async function removeRole(id: string, operator: string): Promise<void> {
  const current = await prisma.adminRole.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('角色不存在');

  // 内置角色是「改坏了还能改回来」的保底：删掉它，系统可能再也恢复不了默认权限
  if (current.builtin) {
    throw ApiError.conflict('内置角色不可删除，可修改它的名称与权限', 'ROLE_BUILTIN');
  }

  const used = await prisma.adminUser.count({ where: { roleId: id } });
  if (used > 0) {
    throw ApiError.conflict(`该角色仍被 ${used} 个账号使用，请先为这些账号改派角色`, 'ROLE_IN_USE');
  }

  await prisma.adminRole.delete({ where: { id } });
  await writeAudit('role.delete', { code: current.code, name: current.name, operator });
}

// -----------------------------------------------------------------------------
// 管理员账号
// -----------------------------------------------------------------------------

function toAdminDto(row: {
  id: string;
  username: string;
  roleId: string | null;
  enabled: boolean;
  createdAt: Date;
  role: { name: string } | null;
}): AdminUserDto {
  return {
    id: row.id,
    username: row.username,
    roleId: row.roleId,
    roleName: row.role?.name ?? null,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listAdmins(): Promise<AdminUserDto[]> {
  const rows = await prisma.adminUser.findMany({
    include: { role: { select: { name: true } } },
    orderBy: [{ createdAt: 'asc' }, { username: 'asc' }],
  });
  return rows.map(toAdminDto);
}

export interface AdminCreateInput {
  username: string;
  password: string;
  roleId?: string | null;
}

export async function createAdmin(input: AdminCreateInput, operator: string): Promise<AdminUserDto> {
  const username = input.username.trim();
  if (await prisma.adminUser.findUnique({ where: { username } })) {
    throw ApiError.conflict(`用户名 ${username} 已存在`, 'ADMIN_USERNAME_EXISTS');
  }

  const roleId = input.roleId ?? null;
  if (roleId) await assertRoleExists(roleId);

  const created = await prisma.adminUser.create({
    data: { username, passwordHash: await hashPassword(input.password), roleId },
    include: { role: { select: { name: true } } },
  });
  await writeAudit('admin.create', {
    username: created.username,
    role: created.role?.name ?? null,
    operator,
  });
  return toAdminDto(created);
}

export interface AdminPatchInput {
  roleId?: string | null;
  enabled?: boolean;
  password?: string;
}

/**
 * 改角色、启停、重置口令都走这一条路径，因此三条守卫也都在这里。
 *
 * 守卫顺序是先「系统还剩几个管理账号」再「是不是自己」：
 * 库里只剩自己时，用户看到的应当是「不能把最后一个管理账号停掉」这个真实原因，
 * 而不是「不能停用自己」—— 后者在有第二个管理账号时才是准确的原因。
 */
export async function updateAdmin(
  id: string,
  patch: AdminPatchInput,
  actorId: string,
  operator: string,
): Promise<AdminUserDto> {
  const current = await prisma.adminUser.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('账号不存在');

  const nextRoleId = patch.roleId === undefined ? current.roleId : patch.roleId;
  const nextEnabled = patch.enabled ?? current.enabled;
  if (nextRoleId) await assertRoleExists(nextRoleId);

  // 守卫一：任何会让系统一个管理账号都不剩的操作一律拒绝
  const capable = await manageCapableAdminIds();
  capable.delete(id);
  if (nextEnabled && (await roleHasManage(nextRoleId))) capable.add(id);
  if (capable.size === 0) throw lastManagerError();

  // 守卫二：不能对自己做危险操作
  if (id === actorId) {
    if (current.enabled && patch.enabled === false) {
      throw ApiError.conflict('不能停用当前登录的账号，请用其他管理账号操作', 'SELF_DISABLE_FORBIDDEN');
    }
    if (patch.roleId !== undefined && !(await roleHasManage(nextRoleId))) {
      throw ApiError.conflict(
        '不能把自己改为没有「管理管理员账号与角色权限」权限的角色，否则将无法再管理权限',
        'SELF_DEMOTE_FORBIDDEN',
      );
    }
  }

  const passwordHash = patch.password === undefined ? undefined : await hashPassword(patch.password);
  const updated = await prisma.adminUser.update({
    where: { id },
    data: { roleId: patch.roleId, enabled: patch.enabled, passwordHash },
    include: { role: { select: { name: true } } },
  });
  await writeAudit('admin.update', {
    username: updated.username,
    role: updated.role?.name ?? null,
    enabled: updated.enabled,
    passwordReset: passwordHash !== undefined,
    operator,
  });
  return toAdminDto(updated);
}

export async function removeAdmin(id: string, actorId: string, operator: string): Promise<void> {
  const current = await prisma.adminUser.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('账号不存在');

  const capable = await manageCapableAdminIds();
  if (capable.has(id) && capable.size === 1) throw lastManagerError();
  if (id === actorId) {
    throw ApiError.conflict('不能删除当前登录的账号，请用其他管理账号操作', 'SELF_DELETE_FORBIDDEN');
  }

  await prisma.adminUser.delete({ where: { id } });
  await writeAudit('admin.delete', { username: current.username, operator });
}