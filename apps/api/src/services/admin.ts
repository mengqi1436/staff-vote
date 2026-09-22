/**
 * 管理端业务逻辑。
 *
 * 路由层只做「取参 → 调服务 → 回响应」，规则集中在这里，便于测试与复用。
 *
 * 约定：
 *   - 删除一律软删除（enabled = false），历史评分始终可读（设计文档第 15 节）。
 *   - 发码、改权重、改开放时间等管理动作写 AuditLog 留痕。
 *   - 时间字段回传 ISO 8601 字符串，前端不再猜格式。
 */
import { prisma } from '../db.js';
import { generateUniqueCodes } from '../lib/code.js';
import { DEFAULT_SETTINGS, SETTING_KEYS } from '../lib/settings.js';
import { ApiError } from '../middleware/errorHandler.js';
import type { SessionStatus, TicketStatus } from '../generated/prisma/enums.js';

// -----------------------------------------------------------------------------
// 传输对象（与 apps/web/src/lib/api.ts 的类型一一对应）
// -----------------------------------------------------------------------------

/** Prisma 生成枚举的别名：单一真源，避免手写字面量与 schema.prisma 漂移。 */
export type TicketStatusValue = TicketStatus;
export type SessionStatusValue = SessionStatus;

/** 迁移写入的默认场次（存量数据的归属），src 侧需要引用同一字面量。 */
export const DEFAULT_SESSION_ID = '00000000-0000-7000-8000-000000000001';

/** 场次状态的合法流转表。ended 是终态；voting ⇄ paused 互通。 */
const SESSION_TRANSITIONS: Record<SessionStatusValue, SessionStatusValue[]> = {
  draft: ['voting'],
  voting: ['paused', 'ended'],
  paused: ['voting', 'ended'],
  ended: [],
};

export interface VoteSessionDto {
  id: string;
  name: string;
  status: SessionStatusValue;
  startAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export async function listSessions(): Promise<{ sessions: VoteSessionDto[] }> {
  const rows = await prisma.voteSession.findMany({
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return {
    sessions: rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      startAt: toIso(row.startAt),
      endedAt: toIso(row.endedAt),
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/**
 * 解析管理端请求的场次。
 *
 * 显式指定 → 校验存在；未指定 → 库里恰有一场时自动取那一场，
 * 零场或多场时 400 SESSION_REQUIRED（前端必须明确选择场次）。
 *
 * @param explicit 请求携带的场次 ID（查询参数或 body 字段），可空
 * @returns 场次 ID
 */
export async function resolveSessionId(explicit?: string): Promise<string> {
  if (explicit) {
    const found = await prisma.voteSession.findUnique({
      where: { id: explicit },
      select: { id: true },
    });
    if (!found) throw ApiError.badRequest('场次不存在', 'SESSION_NOT_FOUND');
    return found.id;
  }
  const count = await prisma.voteSession.count();
  if (count === 1) {
    const only = await prisma.voteSession.findFirstOrThrow({ select: { id: true } });
    return only.id;
  }
  throw ApiError.badRequest('当前存在多个场次，请指定 sessionId', 'SESSION_REQUIRED');
}

export async function createSession(
  input: { name: string },
  operator: string,
): Promise<VoteSessionDto> {
  const name = input.name.trim();
  const existing = await prisma.voteSession.findUnique({ where: { name } });
  if (existing) throw ApiError.conflict(`场次「${name}」已存在`, 'SESSION_EXISTS');

  const created = await prisma.voteSession.create({ data: { name } });
  await writeAudit('session.create', { name, operator });
  return {
    id: created.id,
    name: created.name,
    status: created.status,
    startAt: toIso(created.startAt),
    endedAt: toIso(created.endedAt),
    createdAt: created.createdAt.toISOString(),
  };
}

/**
 * 场次状态机流转：draft→start→voting；voting⇄pause；voting|paused→end→ended。
 * ended 终态不可逆。首次 start 写 startAt（恢复不覆盖），end 写 endedAt。
 */
export async function transitionSession(
  id: string,
  action: 'start' | 'pause' | 'end',
  operator: string,
): Promise<VoteSessionDto> {
  const current = await prisma.voteSession.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('场次不存在');

  const nextStatus: SessionStatusValue =
    action === 'start' ? 'voting' : action === 'pause' ? 'paused' : 'ended';
  if (!SESSION_TRANSITIONS[current.status].includes(nextStatus)) {
    throw ApiError.conflict(
      `场次当前状态为 ${current.status}，不能执行 ${action}`,
      'INVALID_SESSION_TRANSITION',
    );
  }

  const updated = await prisma.voteSession.update({
    where: { id },
    data: {
      status: nextStatus,
      // 首次 start 才写 startAt；paused→voting 的恢复不覆盖首次开始时间。
      startAt: action === 'start' && !current.startAt ? new Date() : undefined,
      endedAt: action === 'end' ? new Date() : undefined,
    },
  });
  await writeAudit(`session.${action}`, { name: current.name, operator });
  return {
    id: updated.id,
    name: updated.name,
    status: updated.status,
    startAt: toIso(updated.startAt),
    endedAt: toIso(updated.endedAt),
    createdAt: updated.createdAt.toISOString(),
  };
}

export interface TicketTypeDto {
  id: string;
  code: string;
  name: string;
  weightPercent: number;
  sortOrder: number;
  enabled: boolean;
  /** 以下三项目前仅在列表接口返回 */
  issuedCount?: number;
  usedCount?: number;
  unusedCount?: number;
}

/**
 * 问卷类型（与 docs/参考表.xlsx 的两张表一一对应）。
 *   person   —— 个人问卷：行 = 项点，列 = 多个被评职务（主任、党支部书记…）
 *   workshop —— 车间问卷：行 = 项点，只有一列「得分」
 * 存字符串而不是数据库 enum：将来多一种问卷形态不该要求写迁移。
 */
export const QUESTIONNAIRE_TYPES: readonly string[] = ['person', 'workshop'];

export interface DepartmentDto {
  id: string;
  name: string;
  sortOrder: number;
  enabled: boolean;
  /** 问卷类型：person = 个人问卷（多列被评职务），workshop = 车间问卷（单列得分） */
  questionnaireType: string;
  /** 表头左上角的附件号，如「附件1-1」 */
  headerNote: string;
  /** 打分表标题 */
  title: string;
  /** 表尾填写说明 */
  footerNote: string;
}

/** 被评列：打分表的「列」，与职工名单分离（参考表的主任/副书记/得分等）。 */
export interface VoteColumnDto {
  id: string;
  departmentId: string;
  name: string;
  /** 该职务列对应的具体被评人（表头第二行的姓名），未选人为 null。 */
  employeeId: string | null;
  employeeName: string | null;
  sortOrder: number;
  enabled: boolean;
}

export interface EmployeeDto {
  id: string;
  departmentId: string;
  name: string;
  employeeNo: string | null;
  sortOrder: number;
  enabled: boolean;
}

export interface CriterionDto {
  id: string;
  departmentId: string;
  name: string;
  /** 项点描述，显示在打分表项点名称下方 */
  description: string | null;
  minScore: number;
  maxScore: number;
  sortOrder: number;
  enabled: boolean;
}

export interface TicketDto {
  id: string;
  code: string;
  status: TicketStatusValue;
  usedAt: string | null;
  createdAt: string;
  batchId: string;
  ticketType: { id: string; code: string; name: string };
}

export interface TicketBatchDto {
  id: string;
  count: number;
  operator: string;
  createdAt: string;
  ticketType: { id: string; code: string; name: string };
}

export interface SettingsDto {
  'vote.open': string;
  'vote.startAt': string;
  'vote.endAt': string;
  'system.title': string;
}

/** 随机码状态的中文名，导出与界面统一用这一份。 */
export const TICKET_STATUS_LABELS: Record<TicketStatusValue, string> = {
  unused: '未使用',
  used: '已核销',
  revoked: '已作废',
};

/** 审计明细：只用 JSONB 能直接存的基本类型。 */
type AuditDetail = Record<string, string | number | boolean | null>;

async function writeAudit(action: string, detail: AuditDetail): Promise<void> {
  await prisma.auditLog.create({ data: { action, detail } });
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

// -----------------------------------------------------------------------------
// 票种与权重
// -----------------------------------------------------------------------------

/**
 * 权重合计校验。
 *
 * 规则：写入后启用票种合计【不得超过 100】。
 *   - 合计不变或变小（降权、停用、新建 0 权重）→ 通过：降权是重分配的合法过渡步骤；
 *   - 升权但合计仍 ≤100 → 通过：「先降腾空间、再分多步补齐」是重新分配权重的唯一通路，
 *     中间步（如 90→95）若被拒，任何含两个以上升权项的重分配都无法完成 ——
 *     只有最后一步恰好落在 100；
 *   - 写入后合计 >100 → 409 并给出差额。
 *
 * 为什么允许合计 ≠100 的中间状态：计分不依赖「合计恰好 100」——
 * lib/scoring.ts 按实际有票票种的权重合计归一化，合计 90 或 95 都不会污染结果。
 * 合计=100 是配置完整性要求，由前端「权重分配」表单强制（≠100 时禁止保存），
 * 后端只守上限这条硬边界。
 *
 * @param after 写入后启用票种权重合计
 * @param before 写入前启用票种权重合计
 * @returns 通过返回 null；否则返回给管理员看的差额说明
 */
function weightSumViolation(after: number, before: number): string | null {
  if (after <= before || after <= 100) return null;

  const diff = 100 - after;
  return `启用票种权重合计为 ${after}%，不得超过 100%（差额 ${diff}）`;
}

async function enabledWeightTotal(sessionId: string): Promise<number> {
  const rows = await prisma.ticketType.findMany({ where: { enabled: true, sessionId } });
  return rows.reduce((sum, row) => sum + row.weightPercent, 0);
}

function toTicketTypeDto(row: {
  id: string;
  code: string;
  name: string;
  weightPercent: number;
  sortOrder: number;
  enabled: boolean;
}): TicketTypeDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    weightPercent: row.weightPercent,
    sortOrder: row.sortOrder,
    enabled: row.enabled,
  };
}

/** 票种列表，附带各票种的发放/使用/作废计数（后台首屏与票种页都用它）。 */
export async function listTicketTypes(sessionId?: string): Promise<TicketTypeDto[]> {
  const [types, grouped] = await Promise.all([
    prisma.ticketType.findMany({
      where: { sessionId },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    }),
    prisma.ticket.groupBy({ by: ['ticketTypeId', 'status'], _count: { _all: true } }),
  ]);

  const counts = new Map<string, { issued: number; used: number; unused: number }>();
  for (const row of grouped) {
    const entry = counts.get(row.ticketTypeId) ?? { issued: 0, used: 0, unused: 0 };
    entry.issued += row._count._all;
    if (row.status === 'used') entry.used += row._count._all;
    else if (row.status === 'unused') entry.unused += row._count._all;
    counts.set(row.ticketTypeId, entry);
  }

  return types.map((type) => {
    const count = counts.get(type.id) ?? { issued: 0, used: 0, unused: 0 };
    return {
      ...toTicketTypeDto(type),
      issuedCount: count.issued,
      usedCount: count.used,
      unusedCount: count.unused,
    };
  });
}

export interface TicketTypeCreateInput {
  sessionId?: string;
  code: string;
  name: string;
  weightPercent: number;
  sortOrder?: number;
  enabled?: boolean;
}

export interface TicketTypePatchInput {
  code?: string;
  name?: string;
  weightPercent?: number;
  sortOrder?: number;
  enabled?: boolean;
}

export async function createTicketType(
  input: TicketTypeCreateInput,
  operator: string,
): Promise<TicketTypeDto> {
  const sessionId = await resolveSessionId(input.sessionId);
  const code = input.code.trim();
  const existing = await prisma.ticketType.findUnique({ where: { code } });
  if (existing) throw ApiError.conflict(`票种编码 ${code} 已存在`, 'TICKET_TYPE_EXISTS');

  const enabled = input.enabled ?? true;
  const before = await enabledWeightTotal(sessionId);
  const after = before + (enabled ? input.weightPercent : 0);
  const violation = weightSumViolation(after, before);
  if (violation) throw ApiError.conflict(violation, 'WEIGHT_SUM_INVALID');

  const created = await prisma.ticketType.create({
    data: {
      sessionId,
      code,
      name: input.name.trim(),
      weightPercent: input.weightPercent,
      sortOrder: input.sortOrder ?? 0,
      enabled,
    },
  });
  await writeAudit('ticket_type.create', {
    code,
    weightPercent: input.weightPercent,
    enabled,
    operator,
  });
  return toTicketTypeDto(created);
}

export async function updateTicketType(
  id: string,
  patch: TicketTypePatchInput,
  operator: string,
): Promise<TicketTypeDto> {
  const current = await prisma.ticketType.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('票种不存在');

  if (patch.code !== undefined && patch.code.trim() !== current.code) {
    const code = patch.code.trim();
    const conflict = await prisma.ticketType.findUnique({ where: { code } });
    if (conflict) throw ApiError.conflict(`票种编码 ${code} 已存在`, 'TICKET_TYPE_EXISTS');
  }

  if (patch.weightPercent !== undefined || patch.enabled !== undefined) {
    const before = await enabledWeightTotal(current.sessionId);
    const nextWeight = patch.weightPercent ?? current.weightPercent;
    const nextEnabled = patch.enabled ?? current.enabled;
    const after =
      before - (current.enabled ? current.weightPercent : 0) + (nextEnabled ? nextWeight : 0);
    const violation = weightSumViolation(after, before);
    if (violation) throw ApiError.conflict(violation, 'WEIGHT_SUM_INVALID');
  }

  const updated = await prisma.ticketType.update({
    where: { id },
    data: {
      code: patch.code?.trim(),
      name: patch.name?.trim(),
      weightPercent: patch.weightPercent,
      sortOrder: patch.sortOrder,
      enabled: patch.enabled,
    },
  });
  if (patch.weightPercent !== undefined || patch.enabled !== undefined) {
    await writeAudit('ticket_type.update', {
      code: updated.code,
      weightPercent: updated.weightPercent,
      enabled: updated.enabled,
      operator,
    });
  }
  return toTicketTypeDto(updated);
}

/** 停用票种。软删除：已有随机码与评分表保持可读。 */
export async function disableTicketType(id: string, operator: string): Promise<void> {
  const current = await prisma.ticketType.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('票种不存在');

  await prisma.ticketType.update({ where: { id }, data: { enabled: false } });
  await writeAudit('ticket_type.disable', { code: current.code, operator });
}

// -----------------------------------------------------------------------------
// 发码与随机码
// -----------------------------------------------------------------------------

export interface GenerateTicketsResult {
  batchId: string;
  count: number;
  codes: string[];
}

/** 发码时的领码人指定：employeeIds 按顺序对应生成的随机码（发放留痕）。 */
export interface TicketAssignmentInput {
  ticketTypeId: string;
  employeeIds: string[];
}

/**
 * 批量发码。
 *
 * 批次与随机码在同一事务里写入：批次记录了发放数量，若两者不一致会留下
 * 无法对账的孤儿批次。写码时用批次数量与插入行数比对兜底。
 *
 * @param ticketTypeId 票种；必须属于解析出的场次
 * @param count 发码数量
 * @param operator 操作者用户名
 * @param options.sessionId 场次（可空 → 单场自动 / 多场 400 SESSION_REQUIRED）
 * @param options.assignments 可选的领码人指定：按序写入 assigneeId（发放留痕，
 *        票仍不记名——评分数据不含票据标识）。职工必须属于同一场次。
 */
export async function generateTickets(
  ticketTypeId: string,
  count: number,
  operator: string,
  options: { sessionId?: string; assignments?: TicketAssignmentInput[] } = {},
): Promise<GenerateTicketsResult> {
  const sessionId = await resolveSessionId(options.sessionId);
  const ticketType = await prisma.ticketType.findUnique({ where: { id: ticketTypeId } });
  if (!ticketType) throw ApiError.notFound('票种不存在');
  if (ticketType.sessionId !== sessionId) {
    throw ApiError.badRequest('票种不属于该场次', 'SESSION_MISMATCH');
  }
  if (!ticketType.enabled) throw ApiError.conflict('票种已停用，不能继续发码', 'TICKET_TYPE_DISABLED');

  // 领码人按 assignments 顺序平铺，与生成的码一一对应。
  let assigneeIds: string[] = [];
  if (options.assignments && options.assignments.length > 0) {
    for (const assignment of options.assignments) {
      if (assignment.ticketTypeId !== ticketTypeId) {
        throw ApiError.badRequest('assignments 中的票种与发码票种不一致', 'SESSION_MISMATCH');
      }
      assigneeIds = assigneeIds.concat(assignment.employeeIds);
    }
    if (assigneeIds.length !== count) {
      throw ApiError.badRequest(
        `领码人数量（${assigneeIds.length}）与发码数量（${count}）不一致`,
        'ASSIGNMENT_COUNT_MISMATCH',
      );
    }
    const employees = await prisma.employee.findMany({
      where: { id: { in: assigneeIds } },
      select: { id: true, sessionId: true },
    });
    const employeeById = new Map(employees.map((row) => [row.id, row]));
    for (const employeeId of assigneeIds) {
      const employee = employeeById.get(employeeId);
      if (!employee) throw ApiError.badRequest('领码人不存在', 'ASSIGNEE_NOT_FOUND');
      if (employee.sessionId !== sessionId) {
        throw ApiError.badRequest('领码人必须属于同一场次', 'SESSION_MISMATCH');
      }
    }
  }

  const codes = generateUniqueCodes(count);

  const result = await prisma.$transaction(async (tx) => {
    const batch = await tx.ticketBatch.create({
      data: { ticketTypeId, sessionId, count: codes.length, operator },
    });
    const inserted = await tx.ticket.createMany({
      data: codes.map((code, index) => ({
        code,
        ticketTypeId,
        batchId: batch.id,
        sessionId,
        assigneeId: assigneeIds[index] ?? null,
      })),
    });
    if (inserted.count !== codes.length) {
      // 随机码理论上不会撞库；真撞上就整体回滚，不留下数量对不上的批次。
      throw new Error(`随机码生成冲突：期望 ${codes.length} 条，实际写入 ${inserted.count} 条`);
    }
    return { batchId: batch.id, count: inserted.count };
  });

  await writeAudit('ticket.generate', {
    ticketTypeId,
    code: ticketType.code,
    count: result.count,
    batchId: result.batchId,
    assigned: assigneeIds.length,
    operator,
  });
  return { batchId: result.batchId, count: result.count, codes };
}

export interface TicketListQuery {
  page: number;
  pageSize: number;
  status?: TicketStatusValue;
  ticketTypeId?: string;
  sessionId?: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

function toTicketDto(row: {
  id: string;
  code: string;
  status: TicketStatusValue;
  usedAt: Date | null;
  createdAt: Date;
  batchId: string;
  ticketType: { id: string; code: string; name: string };
}): TicketDto {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    usedAt: toIso(row.usedAt),
    createdAt: row.createdAt.toISOString(),
    batchId: row.batchId,
    ticketType: row.ticketType,
  };
}

/** 随机码分页列表。 */
export async function listTickets(query: TicketListQuery): Promise<Paged<TicketDto>> {
  const where = {
    status: query.status,
    ticketTypeId: query.ticketTypeId,
    sessionId: query.sessionId,
  };
  const [items, total] = await Promise.all([
    prisma.ticket.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: { ticketType: { select: { id: true, code: true, name: true } } },
    }),
    prisma.ticket.count({ where }),
  ]);

  return {
    items: items.map(toTicketDto),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export interface TicketExportFilter {
  status?: TicketStatusValue;
  ticketTypeId?: string;
  sessionId?: string;
}

/**
 * 取待导出的随机码。
 *
 * `ponytail:` 一次性把结果读进内存（上限 5 万行）。发码量级是千级，够用；
 * 若将来单次导出超过这个量级，改成流式写 exceljs 的 WorkbookWriter。
 */
export async function listTicketsForExport(filter: TicketExportFilter) {
  return prisma.ticket.findMany({
    where: {
      status: filter.status,
      ticketTypeId: filter.ticketTypeId,
      sessionId: filter.sessionId,
    },
    orderBy: [{ createdAt: 'asc' }, { code: 'asc' }],
    take: 50_000,
    include: { ticketType: { select: { code: true, name: true } } },
  });
}

/**
 * 作废随机码。只有未使用的码可以作废。
 *
 * 用 `updateMany` 带状态条件做原子更新，避免两次并发作废都通过前置检查。
 */
export async function revokeTicket(id: string, operator: string): Promise<TicketDto> {
  const updated = await prisma.ticket.updateMany({
    where: { id, status: 'unused' },
    data: { status: 'revoked' },
  });

  if (updated.count === 0) {
    const current = await prisma.ticket.findUnique({ where: { id } });
    if (!current) throw ApiError.notFound('随机码不存在');
    if (current.status === 'used') {
      throw ApiError.conflict('该票据已核销，不能作废', 'TICKET_ALREADY_USED');
    }
    throw ApiError.conflict('该票据已作废', 'TICKET_ALREADY_REVOKED');
  }

  const ticket = await prisma.ticket.findUniqueOrThrow({
    where: { id },
    include: { ticketType: { select: { id: true, code: true, name: true } } },
  });
  await writeAudit('ticket.revoke', { code: ticket.code, operator });
  return toTicketDto(ticket);
}

export interface RevokeTicketsBulkInput {
  /** 只作废该票种的码；不传表示全部票种 */
  ticketTypeId?: string;
}

/**
 * 一键作废未使用的随机码。
 *
 * 一条 `updateMany` 带 `status = 'unused'` 条件即原子完成：与并发核销天然互斥 ——
 * 已被核销的码在语句执行时不再匹配，不会被改回 revoked（作废已核销的码会凭空
 * 毁掉一张有效票）。因此这里不做「先查再改」，也不返回被跳过的数量。
 *
 * 不存在的票种 id 不报 404：那只是「没有匹配的码」，返回 0 即可，
 * 前端拿到 0 也不会做任何危险动作。
 *
 * @param input 作废范围；`ticketTypeId` 不传即全部票种
 * @param operator 操作者用户名，写入 AuditLog
 * @returns 实际作废数量
 */
export async function revokeTicketsBulk(
  input: RevokeTicketsBulkInput,
  operator: string,
): Promise<{ revoked: number }> {
  const updated = await prisma.ticket.updateMany({
    where: { status: 'unused', ticketTypeId: input.ticketTypeId },
    data: { status: 'revoked' },
  });

  await writeAudit('ticket.revoke_bulk', {
    scope: input.ticketTypeId ? 'ticketType' : 'all',
    ticketTypeId: input.ticketTypeId ?? null,
    count: updated.count,
    operator,
  });

  return { revoked: updated.count };
}

/** 发码批次列表（倒序，管理端看最近发放）。 */
export async function listTicketBatches(sessionId?: string): Promise<TicketBatchDto[]> {
  const batches = await prisma.ticketBatch.findMany({
    where: { sessionId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 500,
    include: { ticketType: { select: { id: true, code: true, name: true } } },
  });
  return batches.map((batch) => ({
    id: batch.id,
    count: batch.count,
    operator: batch.operator,
    createdAt: batch.createdAt.toISOString(),
    ticketType: batch.ticketType,
  }));
}

// -----------------------------------------------------------------------------
// 部门
// -----------------------------------------------------------------------------

export async function listDepartments(sessionId?: string): Promise<DepartmentDto[]> {
  const rows = await prisma.department.findMany({
    where: { sessionId },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
    enabled: row.enabled,
    questionnaireType: row.questionnaireType,
    headerNote: row.headerNote,
    title: row.title,
    footerNote: row.footerNote,
  }));
}

export async function createDepartment(
  input: { sessionId?: string; name: string; sortOrder?: number },
  operator: string,
): Promise<DepartmentDto> {
  const sessionId = await resolveSessionId(input.sessionId);
  const name = input.name.trim();
  // 部门名称在场次内唯一：不同场次可以有同名部门。
  if (await prisma.department.findFirst({ where: { sessionId, name } })) {
    throw ApiError.conflict(`部门「${name}」已存在`, 'DEPARTMENT_EXISTS');
  }
  const created = await prisma.department.create({
    data: { sessionId, name, sortOrder: input.sortOrder ?? 0 },
  });
  await writeAudit('department.create', { name, operator });
  return {
    id: created.id,
    name: created.name,
    sortOrder: created.sortOrder,
    enabled: created.enabled,
    questionnaireType: created.questionnaireType,
    headerNote: created.headerNote,
    title: created.title,
    footerNote: created.footerNote,
  };
}

/**
 * 改部门。除名称/排序/启停外，还包括问卷表头配置（问卷类型、附件号、标题、填写说明）——
 * 参考表的抬头与表尾说明都由这里配置，后台「问卷配置」页用的就是这几个字段。
 */
export async function updateDepartment(
  id: string,
  patch: {
    name?: string;
    sortOrder?: number;
    enabled?: boolean;
    questionnaireType?: string;
    headerNote?: string;
    title?: string;
    footerNote?: string;
  },
  operator: string,
): Promise<DepartmentDto> {
  const current = await prisma.department.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('部门不存在');

  const name = patch.name?.trim();
  if (name && name !== current.name) {
    const conflict = await prisma.department.findFirst({
      where: { sessionId: current.sessionId, name, id: { not: id } },
    });
    if (conflict) throw ApiError.conflict(`部门「${name}」已存在`, 'DEPARTMENT_EXISTS');
  }
  if (patch.questionnaireType !== undefined && !QUESTIONNAIRE_TYPES.includes(patch.questionnaireType)) {
    throw ApiError.badRequest('问卷类型只能是「个人问卷」或「车间问卷」', 'QUESTIONNAIRE_TYPE_INVALID');
  }

  const updated = await prisma.department.update({
    where: { id },
    data: {
      name,
      sortOrder: patch.sortOrder,
      enabled: patch.enabled,
      questionnaireType: patch.questionnaireType,
      headerNote: patch.headerNote,
      title: patch.title,
      footerNote: patch.footerNote,
    },
  });
  await writeAudit('department.update', { name: updated.name, operator });
  return {
    id: updated.id,
    name: updated.name,
    sortOrder: updated.sortOrder,
    enabled: updated.enabled,
    questionnaireType: updated.questionnaireType,
    headerNote: updated.headerNote,
    title: updated.title,
    footerNote: updated.footerNote,
  };
}

/**
 * 删除部门 —— 软删除。
 *
 * 部门一旦产生过评分，物理删除会连带毁掉历史成绩（外键也是 RESTRICT），
 * 所以删除语义统一是 enabled = false：从投票与列表中消失，历史数据仍可导出。
 */
export async function disableDepartment(id: string, operator: string): Promise<void> {
  const current = await prisma.department.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('部门不存在');
  await prisma.department.update({ where: { id }, data: { enabled: false } });
  await writeAudit('department.disable', { name: current.name, operator });
}

// -----------------------------------------------------------------------------
// 职工
// -----------------------------------------------------------------------------

export async function listEmployees(
  departmentId?: string,
  sessionId?: string,
): Promise<EmployeeDto[]> {
  const rows = await prisma.employee.findMany({
    where: { departmentId, sessionId },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  return rows.map((row) => ({
    id: row.id,
    departmentId: row.departmentId,
    name: row.name,
    employeeNo: row.employeeNo,
    sortOrder: row.sortOrder,
    enabled: row.enabled,
  }));
}

export interface EmployeeCreateInput {
  departmentId: string;
  /** 可选：显式指定场次时必须与部门所属场次一致，否则 400。 */
  sessionId?: string;
  name: string;
  employeeNo?: string | null;
  sortOrder?: number;
}

/** 空串统一成 null：`employee_no` 有唯一索引，多个空串会互相冲突。 */
function normalizeEmployeeNo(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function assertEmployeeNoAvailable(employeeNo: string, excludeId?: string): Promise<void> {
  const conflict = await prisma.employee.findFirst({ where: { employeeNo } });
  if (conflict && conflict.id !== excludeId) {
    throw ApiError.conflict(`工号 ${employeeNo} 已被「${conflict.name}」占用`, 'EMPLOYEE_NO_EXISTS');
  }
}

export async function createEmployee(
  input: EmployeeCreateInput,
  operator: string,
): Promise<EmployeeDto> {
  const department = await prisma.department.findUnique({ where: { id: input.departmentId } });
  if (!department) throw ApiError.badRequest('部门不存在');
  // 职工归属场次 = 部门所属场次；显式传 sessionId 时校验一致，防止配错。
  if (input.sessionId !== undefined && input.sessionId !== department.sessionId) {
    throw ApiError.badRequest('部门不属于该场次', 'SESSION_MISMATCH');
  }

  const employeeNo = normalizeEmployeeNo(input.employeeNo);
  if (employeeNo) await assertEmployeeNoAvailable(employeeNo);

  const created = await prisma.employee.create({
    data: {
      departmentId: input.departmentId,
      sessionId: department.sessionId,
      name: input.name.trim(),
      employeeNo,
      sortOrder: input.sortOrder ?? 0,
    },
  });
  await writeAudit('employee.create', { name: created.name, department: department.name, operator });
  return {
    id: created.id,
    departmentId: created.departmentId,
    name: created.name,
    employeeNo: created.employeeNo,
    sortOrder: created.sortOrder,
    enabled: created.enabled,
  };
}

export async function updateEmployee(
  id: string,
  patch: {
    departmentId?: string;
    name?: string;
    employeeNo?: string | null;
    sortOrder?: number;
    enabled?: boolean;
  },
  operator: string,
): Promise<EmployeeDto> {
  const current = await prisma.employee.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('职工不存在');

  // 跨部门移动时场次跟随新部门（同一批次导入的名单可能跨场次调整归属）。
  let nextSessionId: string | undefined;
  if (patch.departmentId && patch.departmentId !== current.departmentId) {
    const department = await prisma.department.findUnique({ where: { id: patch.departmentId } });
    if (!department) throw ApiError.badRequest('部门不存在');
    nextSessionId = department.sessionId;
  }

  let employeeNo: string | null | undefined;
  if (patch.employeeNo !== undefined) {
    employeeNo = normalizeEmployeeNo(patch.employeeNo);
    if (employeeNo) await assertEmployeeNoAvailable(employeeNo, id);
  }

  const updated = await prisma.employee.update({
    where: { id },
    data: {
      departmentId: patch.departmentId,
      sessionId: nextSessionId,
      name: patch.name?.trim(),
      employeeNo,
      sortOrder: patch.sortOrder,
      enabled: patch.enabled,
    },
  });
  await writeAudit('employee.update', { name: updated.name, operator });
  return {
    id: updated.id,
    departmentId: updated.departmentId,
    name: updated.name,
    employeeNo: updated.employeeNo,
    sortOrder: updated.sortOrder,
    enabled: updated.enabled,
  };
}

/** 删除职工 —— 软删除，已提交的评分项仍指向该职工，历史报表不掉行。 */
export async function disableEmployee(id: string, operator: string): Promise<void> {
  const current = await prisma.employee.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('职工不存在');
  await prisma.employee.update({ where: { id }, data: { enabled: false } });
  await writeAudit('employee.disable', { name: current.name, operator });
}

// -----------------------------------------------------------------------------
// 职工名单导入
// -----------------------------------------------------------------------------

export interface ImportEmployeesResult {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  departmentsCreated: number;
  errors: Array<{ row: number; message: string }>;
}

/**
 * 导入职工名单。
 *
 * 按「部门名 + 工号」upsert：有工号的行以工号为唯一键（跨部门调动也能正确更新），
 * 没工号的行按「部门 + 姓名」匹配。部门不存在时按名称自动创建，避免管理员为了
 * 导入一份名单先手工建十几个部门。
 *
 * 单行失败只计入 errors 并继续，不整批回滚 —— 一份上千行的名单里有一行脏数据，
 * 让管理员自己改那一行比重传整份文件现实。
 */
export async function importEmployees(
  rows: Array<{ rowNumber: number; departmentName: string; name: string; employeeNo: string | null }>,
  operator: string,
  sessionId?: string,
): Promise<ImportEmployeesResult> {
  const targetSessionId = await resolveSessionId(sessionId);
  const result: ImportEmployeesResult = {
    total: rows.length,
    created: 0,
    updated: 0,
    skipped: 0,
    departmentsCreated: 0,
    errors: [],
  };
  const departmentCache = new Map<string, string>();

  for (const row of rows) {
    try {
      if (!row.departmentName && !row.name) {
        result.skipped += 1;
        continue;
      }
      if (!row.departmentName || !row.name) {
        result.errors.push({ row: row.rowNumber, message: '部门与姓名不能为空' });
        continue;
      }

      let departmentId = departmentCache.get(row.departmentName);
      if (!departmentId) {
        const existing = await prisma.department.findFirst({
          where: { sessionId: targetSessionId, name: row.departmentName },
        });
        if (existing) {
          departmentId = existing.id;
        } else {
          const created = await prisma.department.create({
            data: { sessionId: targetSessionId, name: row.departmentName },
          });
          departmentId = created.id;
          result.departmentsCreated += 1;
        }
        departmentCache.set(row.departmentName, departmentId);
      }

      if (row.employeeNo) {
        const existing = await prisma.employee.findFirst({ where: { employeeNo: row.employeeNo } });
        if (existing) {
          await prisma.employee.update({
            where: { id: existing.id },
            data: { name: row.name, departmentId, sessionId: targetSessionId },
          });
          result.updated += 1;
        } else {
          await prisma.employee.create({
            data: { departmentId, sessionId: targetSessionId, name: row.name, employeeNo: row.employeeNo },
          });
          result.created += 1;
        }
        continue;
      }

      const sameName = await prisma.employee.findFirst({
        where: { departmentId, name: row.name },
      });
      if (sameName) {
        result.updated += 1;
      } else {
        await prisma.employee.create({ data: { departmentId, sessionId: targetSessionId, name: row.name } });
        result.created += 1;
      }
    } catch (error) {
      result.errors.push({
        row: row.rowNumber,
        message: error instanceof Error ? error.message : '导入失败',
      });
    }
  }

  await writeAudit('employee.import', {
    total: result.total,
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
    operator,
  });
  return result;
}

// -----------------------------------------------------------------------------
// 项点
// -----------------------------------------------------------------------------

/** 描述留空即 null：空串与「没有描述」在打分表上要渲染成同一种结果。 */
function normalizeDescription(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const text = value.trim();
  return text === '' ? null : text;
}

export async function listCriteria(
  departmentId?: string,
  sessionId?: string,
): Promise<CriterionDto[]> {
  const rows = await prisma.criterion.findMany({
    where: { departmentId, sessionId },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  return rows.map((row) => ({
    id: row.id,
    departmentId: row.departmentId,
    name: row.name,
    description: row.description,
    minScore: row.minScore,
    maxScore: row.maxScore,
    sortOrder: row.sortOrder,
    enabled: row.enabled,
  }));
}

export interface CriterionCreateInput {
  departmentId: string;
  /** 可选：显式指定场次时必须与部门所属场次一致，否则 400。 */
  sessionId?: string;
  name: string;
  description?: string | null;
  minScore: number;
  maxScore: number;
  sortOrder?: number;
}

export async function createCriterion(
  input: CriterionCreateInput,
  operator: string,
): Promise<CriterionDto> {
  if (input.maxScore <= input.minScore) {
    throw ApiError.badRequest('最高分必须大于最低分', 'CRITERION_RANGE_INVALID');
  }

  const department = await prisma.department.findUnique({ where: { id: input.departmentId } });
  if (!department) throw ApiError.badRequest('部门不存在');
  if (input.sessionId !== undefined && input.sessionId !== department.sessionId) {
    throw ApiError.badRequest('部门不属于该场次', 'SESSION_MISMATCH');
  }

  const created = await prisma.criterion.create({
    data: {
      departmentId: input.departmentId,
      sessionId: department.sessionId,
      name: input.name.trim(),
      description: normalizeDescription(input.description),
      minScore: input.minScore,
      maxScore: input.maxScore,
      sortOrder: input.sortOrder ?? 0,
    },
  });
  await writeAudit('criterion.create', { name: created.name, department: department.name, operator });
  return {
    id: created.id,
    departmentId: created.departmentId,
    name: created.name,
    description: created.description,
    minScore: created.minScore,
    maxScore: created.maxScore,
    sortOrder: created.sortOrder,
    enabled: created.enabled,
  };
}

export async function updateCriterion(
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    minScore?: number;
    maxScore?: number;
    sortOrder?: number;
    enabled?: boolean;
  },
  operator: string,
): Promise<CriterionDto> {
  const current = await prisma.criterion.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('项点不存在');

  // 只改 min 或只改 max 都可能把区间改反，因此按「合并后的结果」校验。
  const minScore = patch.minScore ?? current.minScore;
  const maxScore = patch.maxScore ?? current.maxScore;
  if (maxScore <= minScore) {
    throw ApiError.badRequest('最高分必须大于最低分', 'CRITERION_RANGE_INVALID');
  }

  const updated = await prisma.criterion.update({
    where: { id },
    data: {
      name: patch.name?.trim(),
      description:
        patch.description === undefined ? undefined : normalizeDescription(patch.description),
      minScore: patch.minScore,
      maxScore: patch.maxScore,
      sortOrder: patch.sortOrder,
      enabled: patch.enabled,
    },
  });
  await writeAudit('criterion.update', { name: updated.name, operator });
  return {
    id: updated.id,
    departmentId: updated.departmentId,
    name: updated.name,
    description: updated.description,
    minScore: updated.minScore,
    maxScore: updated.maxScore,
    sortOrder: updated.sortOrder,
    enabled: updated.enabled,
  };
}

/** 删除项点 —— 软删除，历史评分里的该项仍可读。 */
export async function disableCriterion(id: string, operator: string): Promise<void> {
  const current = await prisma.criterion.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('项点不存在');
  await prisma.criterion.update({ where: { id }, data: { enabled: false } });
  await writeAudit('criterion.disable', { name: current.name, operator });
}

// -----------------------------------------------------------------------------
// 被评列（打分表的列）
// -----------------------------------------------------------------------------

export async function listVoteColumns(
  departmentId?: string,
  sessionId?: string,
): Promise<VoteColumnDto[]> {
  const rows = await prisma.voteColumn.findMany({
    where: { departmentId, sessionId },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { employee: { select: { name: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    departmentId: row.departmentId,
    name: row.name,
    employeeId: row.employeeId,
    employeeName: row.employee?.name ?? null,
    sortOrder: row.sortOrder,
    enabled: row.enabled,
  }));
}

export interface VoteColumnCreateInput {
  departmentId: string;
  /** 可选：显式指定场次时必须与部门所属场次一致，否则 400。 */
  sessionId?: string;
  name: string;
  /** 该职务列的具体被评人（可选）。 */
  employeeId?: string | null;
  sortOrder?: number;
}

/**
 * 校验被评人：必须存在且属于该列所在部门。
 *
 * 表头第二行选的是「本车间的某职工」，跨部门选人属于配错数据，
 * 在这里拦下而不是让问卷打印出别车间的名字。
 */
async function resolveEmployeeId(
  employeeId: string | null | undefined,
  departmentId: string,
): Promise<string | null> {
  if (employeeId === null || employeeId === undefined) return employeeId ?? null;
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw ApiError.badRequest('被评人不存在');
  if (employee.departmentId !== departmentId) throw ApiError.badRequest('被评人必须属于该部门');
  return employee.id;
}

/**
 * 新增被评列。
 *
 * 刻意不做重名校验：参考表的个人问卷里「副主任」就出现了两次（两个副主任岗位），
 * 后台必须能原样照抄那张表。列名是否重复由组织者决定，系统不替他改需求。
 */
export async function createVoteColumn(
  input: VoteColumnCreateInput,
  operator: string,
): Promise<VoteColumnDto> {
  const name = input.name.trim();
  const department = await prisma.department.findUnique({ where: { id: input.departmentId } });
  if (!department) throw ApiError.badRequest('部门不存在');
  if (input.sessionId !== undefined && input.sessionId !== department.sessionId) {
    throw ApiError.badRequest('部门不属于该场次', 'SESSION_MISMATCH');
  }
  const employeeId = await resolveEmployeeId(input.employeeId, input.departmentId);

  const created = await prisma.voteColumn.create({
    data: {
      departmentId: input.departmentId,
      sessionId: department.sessionId,
      name,
      employeeId,
      sortOrder: input.sortOrder ?? 0,
    },
    include: { employee: { select: { name: true } } },
  });
  await writeAudit('vote_column.create', { name, department: department.name, operator });
  return {
    id: created.id,
    departmentId: created.departmentId,
    name: created.name,
    employeeId: created.employeeId,
    employeeName: created.employee?.name ?? null,
    sortOrder: created.sortOrder,
    enabled: created.enabled,
  };
}

export async function updateVoteColumn(
  id: string,
  patch: { name?: string; employeeId?: string | null; sortOrder?: number; enabled?: boolean },
  operator: string,
): Promise<VoteColumnDto> {
  const current = await prisma.voteColumn.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('被评列不存在');
  const employeeId =
    patch.employeeId === undefined
      ? undefined
      : await resolveEmployeeId(patch.employeeId, current.departmentId);

  const updated = await prisma.voteColumn.update({
    where: { id },
    data: {
      name: patch.name?.trim(),
      employeeId,
      sortOrder: patch.sortOrder,
      enabled: patch.enabled,
    },
    include: { employee: { select: { name: true } } },
  });
  await writeAudit('vote_column.update', { name: updated.name, operator });
  return {
    id: updated.id,
    departmentId: updated.departmentId,
    name: updated.name,
    employeeId: updated.employeeId,
    employeeName: updated.employee?.name ?? null,
    sortOrder: updated.sortOrder,
    enabled: updated.enabled,
  };
}

/** 删除被评列 —— 软删除，历史评分里的该列仍可读。 */
export async function disableVoteColumn(id: string, operator: string): Promise<void> {
  const current = await prisma.voteColumn.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('被评列不存在');
  await prisma.voteColumn.update({ where: { id }, data: { enabled: false } });
  await writeAudit('vote_column.disable', { name: current.name, operator });
}

// -----------------------------------------------------------------------------
// 设置
// -----------------------------------------------------------------------------

const DEFAULT_SETTING_MAP = new Map(DEFAULT_SETTINGS.map((item) => [item.key, item.value]));

/** 四个设置项的键名元组：用元组而不是 Object.values，键名才能收敛成字面量联合类型。 */
const SETTINGS_KEY_LIST = [
  SETTING_KEYS.voteOpen,
  SETTING_KEYS.voteStartAt,
  SETTING_KEYS.voteEndAt,
  SETTING_KEYS.systemTitle,
] as const;

function settingValue(map: Map<string, string>, key: string): string {
  return map.get(key) ?? DEFAULT_SETTING_MAP.get(key) ?? '';
}

/**
 * 读取全部设置。
 *
 * 库里缺行时回落到默认值：设置项由 seed 写入，但测试库或新部署可能还没跑 seed，
 * 此时返回「投票关闭」比返回 undefined 让前端崩掉要好。
 */
export async function getSettings(): Promise<SettingsDto> {
  const rows = await prisma.setting.findMany();
  const map = new Map(rows.map((row) => [row.key, row.value]));
  return {
    [SETTING_KEYS.voteOpen]: settingValue(map, SETTING_KEYS.voteOpen),
    [SETTING_KEYS.voteStartAt]: settingValue(map, SETTING_KEYS.voteStartAt),
    [SETTING_KEYS.voteEndAt]: settingValue(map, SETTING_KEYS.voteEndAt),
    [SETTING_KEYS.systemTitle]: settingValue(map, SETTING_KEYS.systemTitle),
  };
}

export type SettingsPatchInput = Partial<SettingsDto>;

export async function updateSettings(
  patch: SettingsPatchInput,
  operator: string,
): Promise<SettingsDto> {
  const current = await getSettings();
  const merged: SettingsDto = { ...current };
  const changed: Array<keyof SettingsDto> = [];

  for (const key of SETTINGS_KEY_LIST) {
    const value = patch[key];
    if (value === undefined) continue;
    merged[key] = value;
    changed.push(key);
  }

  // 两侧都设了时间却把顺序写反，会让投票永远无法开放，这是最容易犯的配置错。
  // 只在本次确实改了时间时才校验，避免库里已有历史脏数据时连改标题都被拒。
  const touchesWindow =
    patch[SETTING_KEYS.voteStartAt] !== undefined || patch[SETTING_KEYS.voteEndAt] !== undefined;
  if (touchesWindow && merged[SETTING_KEYS.voteStartAt] && merged[SETTING_KEYS.voteEndAt]) {
    const start = new Date(merged[SETTING_KEYS.voteStartAt]);
    const end = new Date(merged[SETTING_KEYS.voteEndAt]);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && start >= end) {
      throw ApiError.badRequest('开放起始时间必须早于结束时间', 'VOTE_WINDOW_INVALID');
    }
  }

  if (changed.length > 0) {
    await prisma.$transaction(
      changed.map((key) =>
        prisma.setting.upsert({
          where: { key },
          update: { value: merged[key] },
          create: { key, value: merged[key] },
        }),
      ),
    );
    await writeAudit('settings.update', { changed: changed.join(','), operator });
  }

  return merged;
}