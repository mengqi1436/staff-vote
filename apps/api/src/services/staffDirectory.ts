/**
 * 全局人员目录。
 *
 * 与场次内 `employees` 副本的分工：
 *   - 本表是人员数据的**唯一真源**，由外部系统定期 POST 同步（工号幂等）；
 *   - 场次副本只在「选人 / 指派」时按需落一条，承载这一场次的打印与统计口径。
 *
 * 同步一律不硬删：名单外的人置 `enabled = false`。硬删会让已绑定的
 * `vote_columns.employee_id` 触发 SET NULL，静默抹掉表头上的姓名。
 */
import { prisma } from '../db.js';
import { ApiError } from '../middleware/errorHandler.js';

/** 审计明细：只用 JSONB 能直接存的基本类型。 */
type AuditDetail = Record<string, string | number | boolean | null>;

async function writeAudit(action: string, detail: AuditDetail): Promise<void> {
  await prisma.auditLog.create({ data: { action, detail } });
}

export interface StaffEntryDto {
  id: string;
  employeeNo: string;
  name: string;
  gender: string | null;
  age: number | null;
  title: string | null;
  orgDepartmentId: string | null;
  orgDepartmentName: string | null;
  enabled: boolean;
}

const STAFF_INCLUDE = { orgDepartment: { select: { name: true } } } as const;

function toDto(row: {
  id: string;
  employeeNo: string;
  name: string;
  gender: string | null;
  age: number | null;
  title: string | null;
  orgDepartmentId: string | null;
  enabled: boolean;
  orgDepartment: { name: string } | null;
}): StaffEntryDto {
  return {
    id: row.id,
    employeeNo: row.employeeNo,
    name: row.name,
    gender: row.gender,
    age: row.age,
    title: row.title,
    orgDepartmentId: row.orgDepartmentId,
    orgDepartmentName: row.orgDepartment?.name ?? null,
    enabled: row.enabled,
  };
}

export interface StaffListQuery {
  /** 姓名 / 工号 / 部门名的模糊匹配，供选人下拉的全局搜索。 */
  q?: string;
  orgDepartmentId?: string;
  enabledOnly?: boolean;
  limit?: number;
}

/**
 * 列表与全局搜索。
 *
 * 搜索同时匹配姓名、工号、部门名：现场按「部门 + 姓名」找人，
 * 只匹配姓名会让同名的人无法区分，只匹配部门又找不到具体人。
 */
export async function listStaffDirectory(query: StaffListQuery = {}): Promise<StaffEntryDto[]> {
  const q = query.q?.trim();
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);

  const rows = await prisma.staffDirectoryEntry.findMany({
    where: {
      orgDepartmentId: query.orgDepartmentId,
      enabled: query.enabledOnly === false ? undefined : true,
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' as const } },
              { employeeNo: { contains: q, mode: 'insensitive' as const } },
              { orgDepartment: { is: { name: { contains: q, mode: 'insensitive' as const } } } },
            ],
          }
        : {}),
    },
    include: STAFF_INCLUDE,
    orderBy: [{ orgDepartmentId: 'asc' }, { employeeNo: 'asc' }],
    take: limit,
  });
  return rows.map(toDto);
}

export async function getStaffEntry(id: string): Promise<StaffEntryDto> {
  const row = await prisma.staffDirectoryEntry.findUnique({ where: { id }, include: STAFF_INCLUDE });
  if (!row) throw ApiError.notFound('人员不存在');
  return toDto(row);
}

export interface StaffCreateInput {
  employeeNo: string;
  name: string;
  gender?: string | null;
  age?: number | null;
  title?: string | null;
  orgDepartmentId?: string | null;
}

export async function createStaffEntry(input: StaffCreateInput, operator: string): Promise<StaffEntryDto> {
  const employeeNo = input.employeeNo.trim();
  const name = input.name.trim();
  if (await prisma.staffDirectoryEntry.findUnique({ where: { employeeNo } })) {
    throw ApiError.conflict(`工号 ${employeeNo} 已存在`);
  }
  const created = await prisma.staffDirectoryEntry.create({
    data: {
      employeeNo,
      name,
      gender: input.gender ?? null,
      age: input.age ?? null,
      title: input.title ?? null,
      orgDepartmentId: input.orgDepartmentId ?? null,
    },
    include: STAFF_INCLUDE,
  });
  await writeAudit('staff_directory.create', { employeeNo, name, operator });
  return toDto(created);
}

export async function updateStaffEntry(
  id: string,
  patch: {
    name?: string;
    gender?: string | null;
    age?: number | null;
    title?: string | null;
    orgDepartmentId?: string | null;
    enabled?: boolean;
  },
  operator: string,
): Promise<StaffEntryDto> {
  const current = await prisma.staffDirectoryEntry.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('人员不存在');

  const updated = await prisma.staffDirectoryEntry.update({
    where: { id },
    data: {
      name: patch.name?.trim(),
      gender: patch.gender,
      age: patch.age,
      title: patch.title,
      orgDepartmentId: patch.orgDepartmentId,
      enabled: patch.enabled,
    },
    include: STAFF_INCLUDE,
  });
  await writeAudit('staff_directory.update', { employeeNo: current.employeeNo, operator });
  return toDto(updated);
}

export async function disableStaffEntry(id: string, operator: string): Promise<void> {
  const current = await prisma.staffDirectoryEntry.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('人员不存在');
  await prisma.staffDirectoryEntry.update({ where: { id }, data: { enabled: false } });
  await writeAudit('staff_directory.delete', { employeeNo: current.employeeNo, operator });
}

// -----------------------------------------------------------------------------
// 外部同步
// -----------------------------------------------------------------------------

export interface StaffSyncRow {
  employeeNo: string;
  name: string;
  gender?: string | null;
  age?: number | null;
  title?: string | null;
  /** 部门名称，按名称匹配全局部门列表；匹配不到则创建。 */
  department?: string | null;
}

export interface StaffSyncResult {
  total: number;
  created: number;
  updated: number;
  disabled: number;
  departmentsCreated: number;
  errors: Array<{ row: number; message: string }>;
}

/**
 * 按工号 upsert 全量 / 增量同步。
 *
 * `replace` = 本次名单视为全量：名单外的人停用（不是删除）。
 * `upsert`  = 只写名单里的人，其他人原样保留。
 *
 * 单行失败只记 errors 继续，不整批回滚——外部系统推来上千行时，
 * 一行脏数据不该让整次同步失败。
 */
export async function syncStaffDirectory(
  rows: StaffSyncRow[],
  options: { mode: 'upsert' | 'replace' },
  operator: string,
): Promise<StaffSyncResult> {
  // 空名单 + replace 会把全部人员停用，属于误调用而非业务意图，挡在入口。
  if (rows.length === 0) throw ApiError.badRequest('同步名单为空，拒绝执行');

  const result: StaffSyncResult = {
    total: rows.length,
    created: 0,
    updated: 0,
    disabled: 0,
    departmentsCreated: 0,
    errors: [],
  };
  const seen = new Set<string>();
  const departmentCache = new Map<string, string>();

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 1;
    try {
      const employeeNo = row.employeeNo?.trim();
      const name = row.name?.trim();
      if (!employeeNo || !name) {
        result.errors.push({ row: rowNumber, message: '工号与姓名不能为空' });
        continue;
      }
      seen.add(employeeNo);

      let orgDepartmentId: string | null = null;
      const departmentName = row.department?.trim();
      if (departmentName) {
        const cached = departmentCache.get(departmentName);
        if (cached) {
          orgDepartmentId = cached;
        } else {
          const existing = await prisma.orgDepartment.findUnique({ where: { name: departmentName } });
          if (existing) {
            orgDepartmentId = existing.id;
          } else {
            const created = await prisma.orgDepartment.create({ data: { name: departmentName } });
            orgDepartmentId = created.id;
            result.departmentsCreated += 1;
          }
          departmentCache.set(departmentName, orgDepartmentId);
        }
      }

      const data = {
        name,
        gender: row.gender ?? null,
        age: row.age ?? null,
        title: row.title ?? null,
        orgDepartmentId,
        enabled: true,
      };
      const existing = await prisma.staffDirectoryEntry.findUnique({ where: { employeeNo } });
      if (existing) {
        await prisma.staffDirectoryEntry.update({ where: { employeeNo }, data });
        result.updated += 1;
      } else {
        await prisma.staffDirectoryEntry.create({ data: { employeeNo, ...data } });
        result.created += 1;
      }
    } catch (error) {
      result.errors.push({
        row: rowNumber,
        message: error instanceof Error ? error.message : '同步失败',
      });
    }
  }

  if (options.mode === 'replace' && seen.size > 0) {
    const disabled = await prisma.staffDirectoryEntry.updateMany({
      where: { enabled: true, employeeNo: { notIn: [...seen] } },
      data: { enabled: false },
    });
    result.disabled = disabled.count;
  }

  await writeAudit('staff_directory.sync', {
    mode: options.mode,
    total: result.total,
    created: result.created,
    updated: result.updated,
    disabled: result.disabled,
    errors: result.errors.length,
    operator,
  });
  return result;
}

// -----------------------------------------------------------------------------
// 目录 → 场次副本
// -----------------------------------------------------------------------------

/**
 * 把目录人员带入某个场次，返回场次内 `employees.id`。
 *
 * 副本归属**列所属部门**（不是人员目录里的原部门）：打印与统计按列归集，
 * 跨部门选人时表头上的人仍落在本表这一列，不会出现「别车间的人混进本部门名单」。
 * 幂等键是 (sessionId, employeeNo)：同一场次内重复选同一人复用一个副本。
 */
export async function employeeIdFromStaff(
  staffDirectoryId: string,
  target: { departmentId: string; sessionId: string },
): Promise<string> {
  const entry = await prisma.staffDirectoryEntry.findUnique({ where: { id: staffDirectoryId } });
  if (!entry) throw ApiError.badRequest('人员目录中不存在该人员');
  if (!entry.enabled) throw ApiError.badRequest('该人员已停用，不能选入打分表');

  const existing = await prisma.employee.findUnique({
    where: { sessionId_employeeNo: { sessionId: target.sessionId, employeeNo: entry.employeeNo } },
  });
  const profile = {
    name: entry.name,
    gender: entry.gender,
    age: entry.age,
    title: entry.title,
  };

  if (existing) {
    // 人员在目录里换了部门，或资料更新：副本跟着纠正，避免打印出旧姓名。
    if (existing.departmentId !== target.departmentId || existing.name !== entry.name) {
      const updated = await prisma.employee.update({
        where: { id: existing.id },
        data: { ...profile, departmentId: target.departmentId },
      });
      return updated.id;
    }
    return existing.id;
  }

  const created = await prisma.employee.create({
    data: {
      departmentId: target.departmentId,
      sessionId: target.sessionId,
      employeeNo: entry.employeeNo,
      ...profile,
    },
  });
  return created.id;
}
