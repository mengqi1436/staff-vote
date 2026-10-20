/**
 * 管理端业务逻辑。
 *
 * 路由层只做「取参 → 调服务 → 回响应」，规则集中在这里，便于测试与复用。
 *
 * 约定：
 *   - 删除一律软删除（enabled = false），历史评分始终可读（设计文档第 15 节）。
 *   - 发码、启停人员类别、改开放时间等管理动作写 AuditLog 留痕。
 *   - 时间字段回传 ISO 8601 字符串，前端不再猜格式。
 */
import { prisma } from '../db.js';
import { generateUniqueCodes } from '../lib/code.js';
import { requiredSheetTypes } from '../lib/scope.js';
import { DEFAULT_SETTINGS, SETTING_KEYS } from '../lib/settings.js';
import { ApiError } from '../middleware/errorHandler.js';
import { findTemplate, upsertTemplate } from './questionnaireTemplateStore.js';
import { employeeIdFromStaff } from './staffDirectory.js';
import type { SessionStatus, TicketStatus } from '../generated/prisma/enums.js';
import type { Prisma } from '../generated/prisma/client.js';

// -----------------------------------------------------------------------------
// 传输对象（与 apps/web/src/lib/api.ts 的类型一一对应）
// -----------------------------------------------------------------------------

/** Prisma 生成枚举的别名：单一真源，避免手写字面量与 schema.prisma 漂移。 */
export type TicketStatusValue = TicketStatus;
export type SessionStatusValue = SessionStatus;

/** 迁移写入的默认评议（存量数据的归属），src 侧需要引用同一字面量。 */
export const DEFAULT_SESSION_ID = '00000000-0000-7000-8000-000000000001';

/** 评议状态的合法流转表。ended 是终态；voting ⇄ paused 互通。 */
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
  /** 开放时间：空 = 不限制开始 / 长期开放 */
  opensAt: string | null;
  closesAt: string | null;
  /** 所属全局部门（字典）。null = 历史评议，无字典来源。 */
  orgDepartmentId: string | null;
  orgDepartmentName: string | null;
  /** 打分范围：person = 仅个人打分表；both = 个人 + 车间两张打分表都打。 */
  scoreScope: string;
  createdAt: string;
  /** draft 评议开始投票前的阻塞缺项（中文清单）；非空 = 不能开始。非 draft 恒为空。 */
  startBlockers: string[];
}

/** 评议行 → DTO 的统一出口，list/create/update/transition 四处共用。 */
async function toSessionDto(row: {
  id: string;
  name: string;
  status: SessionStatusValue;
  startAt: Date | null;
  endedAt: Date | null;
  opensAt: Date | null;
  closesAt: Date | null;
  orgDepartmentId: string | null;
  orgDepartment: { name: string } | null;
  scoreScope: string;
  createdAt: Date;
}): Promise<VoteSessionDto> {
  const dto: VoteSessionDto = {
    id: row.id,
    name: row.name,
    status: row.status,
    startAt: toIso(row.startAt),
    endedAt: toIso(row.endedAt),
    opensAt: toIso(row.opensAt),
    closesAt: toIso(row.closesAt),
    orgDepartmentId: row.orgDepartmentId,
    orgDepartmentName: row.orgDepartment?.name ?? null,
    scoreScope: row.scoreScope,
    createdAt: row.createdAt.toISOString(),
    startBlockers: [],
  };
  // draft 才有「开始投票」这个动作，也才需要阻塞清单；与 start 接口的校验同源。
  if (dto.status === 'draft') dto.startBlockers = await checkSessionCompleteness(row.id);
  return dto;
}

/** 评议查询的公共 include：带出字典部门名。 */
const SESSION_INCLUDE = { orgDepartment: { select: { name: true } } } as const;

export async function listSessions(): Promise<{ sessions: VoteSessionDto[] }> {
  const rows = await prisma.voteSession.findMany({
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: SESSION_INCLUDE,
  });
  return { sessions: await Promise.all(rows.map(toSessionDto)) };
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
    if (!found) throw ApiError.badRequest('评议不存在', 'SESSION_NOT_FOUND');
    return found.id;
  }
  const count = await prisma.voteSession.count();
  if (count === 1) {
    const only = await prisma.voteSession.findFirstOrThrow({ select: { id: true } });
    return only.id;
  }
  throw ApiError.badRequest('当前存在多个评议，请指定 sessionId', 'SESSION_REQUIRED');
}

/**
 * 新建场次（向导第一步「基本信息」的提交）。
 *
 * 一个事务内完成两件事：
 *   1. 建 vote_sessions（名称 + 字典部门 + 开放时间窗）；
 *   2. 按所选字典部门自动在场内 departments 插入一条同名部门
 *      （questionnaireType 默认 person）——向导第二步的问卷网格立即可用，
 *      管理员不必再手工建场内部门。
 *
 * 校验：
 *   - 名称重名 409 SESSION_EXISTS；
 *   - 字典部门不存在 404 ORG_DEPARTMENT_NOT_FOUND；
 *   - opensAt 与 closesAt 均非空时必须前者早于后者，违反 422 VOTE_WINDOW_INVALID
 *     （与 updateSession 同一条规则；closesAt 缺省 = 永久开放）。
 */
export async function createSession(
  input: { name: string; orgDepartmentId: string; opensAt: string; closesAt?: string | null },
  operator: string,
): Promise<VoteSessionDto> {
  const name = input.name.trim();
  const existing = await prisma.voteSession.findUnique({ where: { name } });
  if (existing) throw ApiError.conflict(`评议「${name}」已存在`, 'SESSION_EXISTS');

  const department = await prisma.orgDepartment.findUnique({
    where: { id: input.orgDepartmentId },
  });
  if (!department) throw ApiError.notFound('全局部门不存在', 'ORG_DEPARTMENT_NOT_FOUND');

  const opensAt = new Date(input.opensAt);
  const closesAt = input.closesAt == null ? null : new Date(input.closesAt);
  // 与 updateSession 相同的窗口规则：两侧都设了时间却把顺序写反，投票永远无法开放。
  if (opensAt && closesAt && opensAt.getTime() >= closesAt.getTime()) {
    throw ApiError.unprocessable('开放开始时间必须早于结束时间', 'VOTE_WINDOW_INVALID');
  }

  // 场次、场内部门、附件8 的整套问卷（抬头 + 5 项点 + 被评列）在同一事务里落地：
  // 向导第 2 步打开就是可编辑的完整问卷；任何一步失败整笔回滚，不留半套配置。
  const template = templateForDepartment(department.name);
  const created = await prisma.$transaction(async (tx) => {
    const session = await tx.voteSession.create({
      data: { name, orgDepartmentId: department.id, opensAt, closesAt },
      include: SESSION_INCLUDE,
    });
    const departmentRow = await tx.department.create({
      data: {
        sessionId: session.id,
        name: department.name,
        questionnaireType: template.questionnaireType,
      },
    });
    await seedQuestionnaireTemplate(tx, session.id, departmentRow.id, template);
    // 向导里可在「个人打分表 / 车间问卷」之间切换，附件8 也是两张表：
    // 另一套的抬头与项点一并备好（不建列——被评列只属于个人问卷版式）。
    await seedQuestionnaireTemplate(
      tx,
      session.id,
      departmentRow.id,
      template.questionnaireType === 'person'
        ? WORKSHOP_QUESTIONNAIRE_TEMPLATE
        : PERSON_QUESTIONNAIRE_TEMPLATE,
      { withVoteColumns: false },
    );
    return session;
  });

  await writeAudit('session.create', {
    name,
    orgDepartment: department.name,
    opensAt: toIso(created.opensAt),
    closesAt: toIso(created.closesAt),
    operator,
  });
  return await toSessionDto(created);
}

/**
 * 更新场次：名称与开放时间窗（PATCH 语义）。
 *
 *   - 字段缺省（undefined）= 不改；显式 null = 清空（该侧恢复不限制）；
 *   - opensAt 与 closesAt 均非空时校验 opensAt < closesAt，违反 400；
 *   - 名称沿用 createSession 的查重模式：重名 409 SESSION_EXISTS（更新时排除自身）；
 *   - ended 场次同样可改时间窗：历史场次为下一期复用窗口是正常操作。
 *
 * @param id 场次 ID
 * @param input 待更新字段
 * @param operator 操作者用户名，写入 AuditLog
 */
export async function updateSession(
  id: string,
  input: { name?: string; opensAt?: string | null; closesAt?: string | null; scoreScope?: string },
  operator: string,
): Promise<VoteSessionDto> {
  const current = await prisma.voteSession.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('评议不存在');

  const data: {
    name?: string;
    opensAt?: Date | null;
    closesAt?: Date | null;
    scoreScope?: string;
  } = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    const existing = await prisma.voteSession.findUnique({ where: { name } });
    if (existing && existing.id !== id) {
      throw ApiError.conflict(`评议「${name}」已存在`, 'SESSION_EXISTS');
    }
    data.name = name;
  }
  if (input.opensAt !== undefined) {
    data.opensAt = input.opensAt === null ? null : new Date(input.opensAt);
  }
  if (input.closesAt !== undefined) {
    data.closesAt = input.closesAt === null ? null : new Date(input.closesAt);
  }
  if (input.scoreScope !== undefined) {
    if (!['person', 'workshop', 'both'].includes(input.scoreScope)) {
      throw ApiError.badRequest(
        '打分范围只能是「负责人评价」「车间评价」或「车间+负责人评价」',
        'SCORE_SCOPE_INVALID',
      );
    }
    data.scoreScope = input.scoreScope;
  }

  const opensAt = data.opensAt !== undefined ? data.opensAt : current.opensAt;
  const closesAt = data.closesAt !== undefined ? data.closesAt : current.closesAt;
  // 两侧都设了时间却把顺序写反，会让投票永远无法开放，这是最容易犯的配置错。
  if (opensAt && closesAt && opensAt.getTime() >= closesAt.getTime()) {
    throw ApiError.badRequest('开放开始时间必须早于结束时间', 'VOTE_WINDOW_INVALID');
  }

  const updated = await prisma.voteSession.update({
    where: { id },
    data,
    include: SESSION_INCLUDE,
  });
  await writeAudit('session.update', {
    name: updated.name,
    opensAt: toIso(updated.opensAt),
    closesAt: toIso(updated.closesAt),
    operator,
  });
  return await toSessionDto(updated);
}

/**
 * 场次状态机流转：draft→start→voting；voting⇄pause；voting|paused→end→ended。
 * ended 终态不可逆。首次 start 写 startAt（恢复不覆盖），end 写 endedAt。
 *
 * draft→voting（start）前先做完整性校验：缺项时 409 SESSION_INCOMPLETE，
 * detail 为中文缺项清单（前端「继续配置」入口直接展示）。paused→voting 的恢复
 * 不再校验 —— 恢复是回到暂停前的状态，中途临时停掉一个项点不该卡死整场投票。
 */
export async function transitionSession(
  id: string,
  action: 'start' | 'pause' | 'end',
  operator: string,
): Promise<VoteSessionDto> {
  const current = await prisma.voteSession.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('评议不存在');

  const nextStatus: SessionStatusValue =
    action === 'start' ? 'voting' : action === 'pause' ? 'paused' : 'ended';
  if (!SESSION_TRANSITIONS[current.status].includes(nextStatus)) {
    throw ApiError.conflict(
      `评议当前状态为 ${current.status}，不能执行 ${action}`,
      'INVALID_SESSION_TRANSITION',
    );
  }

  if (action === 'start' && current.status === 'draft') {
    const issues = await checkSessionCompleteness(id);
    if (issues.length > 0) {
      throw new ApiError(409, 'SESSION_INCOMPLETE', '评议配置不完整，无法开始投票', issues);
    }
  }

  const updated = await prisma.voteSession.update({
    where: { id },
    data: {
      status: nextStatus,
      // 首次 start 才写 startAt；paused→voting 的恢复不覆盖首次开始时间。
      startAt: action === 'start' && !current.startAt ? new Date() : undefined,
      endedAt: action === 'end' ? new Date() : undefined,
    },
    include: SESSION_INCLUDE,
  });
  await writeAudit(`session.${action}`, { name: current.name, operator });
  return await toSessionDto(updated);
}

/**
 * 删除场次（物理删除）。
 *
 * 只在「没有答卷」时允许：答卷是历史评分，删掉无法恢复，因此一律 409 拒绝。
 * 无答卷时，场次下的部门、职工、被评列、项点、票种、批次、随机码与问卷模板
 * 都只是本案的配置，随场次一并清理，不会牵连其他场次的数据。
 * 正在投票的场次也拒绝——码已经发出去了，先暂停或结束再删。
 *
 * 外键全部是 Restrict，删除顺序必须自底向上，否则数据库直接拒绝。
 */
export async function deleteSession(id: string, operator: string): Promise<void> {
  const current = await prisma.voteSession.findUnique({
    where: { id },
    select: { name: true, status: true },
  });
  if (!current) throw ApiError.notFound('评议不存在', 'SESSION_NOT_FOUND');

  if (current.status === 'voting') {
    throw ApiError.conflict('评议正在投票，请先暂停或结束再删除', 'SESSION_VOTING');
  }

  const sheetCount = await prisma.scoreSheet.count({ where: { sessionId: id } });
  if (sheetCount > 0) {
    throw ApiError.conflict(
      `评议「${current.name}」已收到 ${sheetCount} 份答卷，不能删除（历史评分必须保留）`,
      'SESSION_HAS_SHEETS',
    );
  }

  await prisma.$transaction(async (tx) => {
    // 答卷为空时 score_items 必然为空（外键 sheet → score_sheets 级联），
    // 这里显式清一遍是为了让顺序在任何历史数据形态下都成立。
    await tx.$executeRaw`DELETE FROM "score_items" WHERE "sheet_id" IN (SELECT "id" FROM "score_sheets" WHERE "session_id" = ${id})`;
    await tx.sheetTicketMap.deleteMany({ where: { sessionId: id } });
    await tx.scoreSheet.deleteMany({ where: { sessionId: id } });
    await tx.ticket.deleteMany({ where: { sessionId: id } });
    await tx.ticketBatch.deleteMany({ where: { sessionId: id } });
    await tx.ticketType.deleteMany({ where: { sessionId: id } });
    await tx.voteColumn.deleteMany({ where: { sessionId: id } });
    await tx.criterion.deleteMany({ where: { sessionId: id } });
    await tx.employee.deleteMany({ where: { sessionId: id } });
    await tx.department.deleteMany({ where: { sessionId: id } });
    // 模板表走原生 SQL：Prisma 7.10 对该模型的 API 会生成坏 SQL（见 schema 注释）。
    // 注意主键全是 text（UUID 由应用生成，列不是 uuid 类型），参数不能加 ::uuid。
    await tx.$executeRaw`DELETE FROM "session_questionnaire_templates" WHERE "session_id" = ${id}`;
    await tx.voteSession.delete({ where: { id } });
  });

  await writeAudit('session.delete', { name: current.name, operator });
}

/**
 * 场次开始投票前的完整性校验（四类缺项，全部查出而不是查到第一个就停，
 * 管理员一次就能看到所有要补的地方）：
 *   1. 启用部门 ≥1；
 *   2. 每个启用部门的启用项点 ≥1 且启用被评列 ≥1；
 *   3. 启用票种 ≥1；
 *   4. 未使用随机码 ≥1。
 *
 * @returns 中文缺项清单；空数组 = 配置完整
 */
async function checkSessionCompleteness(sessionId: string): Promise<string[]> {
  const issues: string[] = [];

  const departments = await prisma.department.findMany({
    where: { sessionId, enabled: true },
    select: { id: true, name: true, questionnaireType: true },
  });
  if (departments.length === 0) {
    issues.push('尚未配置启用部门：至少需要一个启用部门');
  }

  // 打分范围要求的问卷类型必须有对应类型的启用部门：缺类型 = 持码人无表可填，
  // 投票入口会拿到空部门列表（只能干等到管理员补配置）。
  const session = await prisma.voteSession.findUnique({
    where: { id: sessionId },
    select: { scoreScope: true },
  });
  if (departments.length > 0) {
    for (const type of requiredSheetTypes(session?.scoreScope ?? 'person')) {
      if (!departments.some((department) => department.questionnaireType === type)) {
        issues.push(
          type === 'workshop'
            ? '打分范围含「车间评价」，但没有启用车间部门'
            : '打分范围含「负责人评价」，但没有启用负责人部门',
        );
      }
    }
  }

  for (const department of departments) {
    // 0010 起项点按「场次 + 问卷类型」在模板层共用：部门有没有项点，
    // 取决于它所属类型的模板项点是否已配置且启用。
    const criteriaCount = await prisma.criterion.count({
      where: {
        sessionId,
        departmentId: null,
        templateType: department.questionnaireType,
        enabled: true,
      },
    });
    if (criteriaCount === 0) {
      issues.push(`部门「${department.name}」尚未配置启用评议项目：至少需要一个启用评议项目`);
    }
    // 被评列只属于个人问卷（车间问卷是单一「得分」列，不需要配置）
    if (department.questionnaireType === 'person') {
      const columnCount = await prisma.voteColumn.count({
        where: { departmentId: department.id, enabled: true },
      });
      if (columnCount === 0) {
        issues.push(`部门「${department.name}」尚未配置启用被评议人列：至少需要一个启用被评议人列`);
      }
    }
  }

  // 票种差异只体现在发码数量上，没有权重，因此这里只要求「至少一个启用类别」。
  const enabledTicketTypeCount = await prisma.ticketType.count({
    where: { sessionId, enabled: true },
  });
  if (enabledTicketTypeCount === 0) {
    issues.push('尚未配置启用人员类别：至少需要一个启用人员类别');
  }

  const unusedCount = await prisma.ticket.count({ where: { sessionId, status: 'unused' } });
  if (unusedCount === 0) {
    issues.push('尚未发放随机码：至少需要一张未使用的随机码');
  }

  return issues;
}

export interface TicketTypeDto {
  id: string;
  code: string;
  name: string;
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
  /** 打分表类型：person = 个人打分表（多列被评职务），workshop = 车间打分表（单列得分） */
  questionnaireType: string;
}

/** 被评议人列：打分表的「列」，与职工名单分离（参考表的主任/副书记/得分等）。 */
export interface VoteColumnDto {
  id: string;
  departmentId: string;
  name: string;
  /** 该职务列对应的具体被评议人（表头第二行的姓名），未选人为 null。 */
  employeeId: string | null;
  employeeName: string | null;
  /** 评议副本的工号（由人员管理带入时有值，历史 Excel 导入为 null）。 */
  employeeNo: string | null;
  /** 副本对应的全局人员目录项；非人员管理带入时为 null（前端用它回显下拉选项）。 */
  staffDirectoryId: string | null;
  sortOrder: number;
  enabled: boolean;
}

export interface EmployeeDto {
  id: string;
  departmentId: string;
  name: string;
  gender: string | null;
  age: number | null;
  title: string | null;
  sortOrder: number;
  enabled: boolean;
}

export interface CriterionDto {
  id: string;
  /** 模板评议项目为 null；0010 前的存量部门评议项目指向原部门。 */
  departmentId: string | null;
  /** 模板评议项目的打分表类型（person/workshop）；部门项点为 null。 */
  templateType: string | null;
  name: string;
  /** 评议项目描述，显示在打分表评议项目名称下方 */
  description: string | null;
  minScore: number;
  maxScore: number;
  sortOrder: number;
  enabled: boolean;
}

/** 评议级打分表模板（个人 / 车间各一套：附件号 + 标题 + 填写说明）。 */
export interface QuestionnaireTemplateDto {
  sessionId: string;
  type: string;
  headerNote: string;
  title: string;
  footerNote: string;
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

export interface SettingsDto {
  'system.title': string;
}

/** 随机码状态的中文名，导出与界面统一用这一份。 */
export const TICKET_STATUS_LABELS: Record<TicketStatusValue, string> = {
  unused: '未使用',
  used: '已使用',
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
// 票种
// -----------------------------------------------------------------------------

function toTicketTypeDto(row: {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  enabled: boolean;
}): TicketTypeDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    sortOrder: row.sortOrder,
    enabled: row.enabled,
  };
}

/** 人员类别列表，附带各人员类别的发放/使用/作废计数（后台首屏与人员类别页都用它）。 */
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
  sortOrder?: number;
  enabled?: boolean;
}

export interface TicketTypePatchInput {
  code?: string;
  name?: string;
  sortOrder?: number;
  enabled?: boolean;
}

export async function createTicketType(
  input: TicketTypeCreateInput,
  operator: string,
): Promise<TicketTypeDto> {
  const sessionId = await resolveSessionId(input.sessionId);
  const code = input.code.trim();
  // 票种编码在场次内唯一：同码可用于不同场次。
  const existing = await prisma.ticketType.findUnique({
    where: { sessionId_code: { sessionId, code } },
  });
  if (existing) throw ApiError.conflict(`人员类别编码 ${code} 已存在`, 'TICKET_TYPE_EXISTS');

  const enabled = input.enabled ?? true;

  const created = await prisma.ticketType.create({
    data: {
      sessionId,
      code,
      name: input.name.trim(),
      sortOrder: input.sortOrder ?? 0,
      enabled,
    },
  });
  await writeAudit('ticket_type.create', {
    code,
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
  if (!current) throw ApiError.notFound('人员类别不存在');

  if (patch.code !== undefined && patch.code.trim() !== current.code) {
    const code = patch.code.trim();
    // 场次内查重：改名撞上同场次其他票种才冲突。
    const conflict = await prisma.ticketType.findUnique({
      where: { sessionId_code: { sessionId: current.sessionId, code } },
    });
    if (conflict) throw ApiError.conflict(`人员类别编码 ${code} 已存在`, 'TICKET_TYPE_EXISTS');
  }

  const updated = await prisma.ticketType.update({
    where: { id },
    data: {
      code: patch.code?.trim(),
      name: patch.name?.trim(),
      sortOrder: patch.sortOrder,
      enabled: patch.enabled,
    },
  });
  // 只有启停改变投票有效性，才留审计；改名/改排序不需要。
  if (patch.enabled !== undefined) {
    await writeAudit('ticket_type.update', {
      code: updated.code,
      enabled: updated.enabled,
      operator,
    });
  }
  return toTicketTypeDto(updated);
}

/** 停用人员类别。软删除：已有随机码与评分表保持可读。 */
export async function disableTicketType(id: string, operator: string): Promise<void> {
  const current = await prisma.ticketType.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('人员类别不存在');

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

/**
 * 发码写入的最大轮次。批内重复已由 `generateUniqueCodes` 去重；真实碰撞来自与存量码
 * 相撞（约 批量 × 存量 / 10^12），3 轮已是极保守上限。
 */
const CODE_INSERT_MAX_ROUNDS = 3;

/**
 * 在事务内写入 `count` 个随机码，返回实际写入行数。
 *
 * 为什么用 `skipDuplicates` 而不是默认行为：默认行为一旦撞上已存在的码就抛 P2002，
 * 整个事务进入 aborted 状态（后续语句报 25P02），只能在事务外整体回滚重试；
 * `skipDuplicates`（PostgreSQL 的 ON CONFLICT DO NOTHING）只跳过冲突行，
 * 事务仍然可用，因此可以在同一个事务里按差额补生成。它不指定冲突目标：
 * 会跳过 `tickets` 上任何唯一约束的冲突行；当前只有 code 唯一，将来新增唯一约束时
 * 行数不足会被误报为撞库，届时需要改为预查 code 或指定冲突目标。
 *
 * @returns 实际插入行数；调用方必须比对，不足即抛错让整批回滚
 */
async function insertTicketCodes(
  tx: Prisma.TransactionClient,
  base: { ticketTypeId: string; batchId: string; sessionId: string; departmentId: string | null },
  count: number,
): Promise<number> {
  let inserted = 0;
  for (let round = 0; round < CODE_INSERT_MAX_ROUNDS && inserted < count; round += 1) {
    const candidates = generateUniqueCodes(count - inserted);
    const result = await tx.ticket.createMany({
      data: candidates.map((code) => ({ code, ...base })),
      skipDuplicates: true,
    });
    inserted += result.count;
  }
  return inserted;
}

/**
 * 批量发码（单票种指定数量）。
 *
 * 批次与随机码在同一事务里写入：批次记录了发放数量，若两者不一致会留下
 * 无法对账的孤儿批次。写码时用批次数量与插入行数比对兜底（撞库由
 * `insertTicketCodes` 在事务内补生成，最多 3 轮）。
 *
 * @param ticketTypeId 票种；必须属于解析出的场次
 * @param count 发码数量
 * @param operator 操作者用户名
 * @param options.sessionId 场次（可空 → 单场自动 / 多场 400 SESSION_REQUIRED）
 * @param options.departmentId 评议部门绑定（可空 → 不限定，持码人可评全部部门）
 */
export async function generateTickets(
  ticketTypeId: string,
  count: number,
  operator: string,
  options: { sessionId?: string; departmentId?: string } = {},
): Promise<GenerateTicketsResult> {
  const sessionId = await resolveSessionId(options.sessionId);
  const ticketType = await prisma.ticketType.findUnique({ where: { id: ticketTypeId } });
  if (!ticketType) throw ApiError.notFound('人员类别不存在');
  if (ticketType.sessionId !== sessionId) {
    throw ApiError.badRequest('人员类别不属于该评议', 'SESSION_MISMATCH');
  }
  if (!ticketType.enabled) throw ApiError.conflict('人员类别已停用，不能继续发码', 'TICKET_TYPE_DISABLED');

  // 部门绑定校验：必须属于本场次且启用中。
  const departmentId = options.departmentId ?? null;
  if (departmentId) {
    const department = await prisma.department.findUnique({ where: { id: departmentId } });
    if (!department || department.sessionId !== sessionId) {
      throw ApiError.badRequest('部门不属于该评议，不能绑定发码', 'DEPARTMENT_NOT_IN_SESSION');
    }
    if (!department.enabled) {
      throw ApiError.conflict('部门已停用，不能绑定发码', 'DEPARTMENT_DISABLED');
    }
  }
  // TOCTOU 窗口（已知并接受）：此处校验通过后、事务写入前部门若被停用，
  // 这批码仍会带上该部门；后果仅是持码人在 Gate 看到空问卷（部门已停用查不出），
  // 不会越权评议其它部门，故不为此加锁。

  const result = await prisma.$transaction(async (tx) => {
    const batch = await tx.ticketBatch.create({
      data: { ticketTypeId, sessionId, departmentId, count, operator },
    });
    const inserted = await insertTicketCodes(
      tx,
      { ticketTypeId, batchId: batch.id, sessionId, departmentId },
      count,
    );
    if (inserted !== count) {
      // 补生成 3 轮仍写不满：撞库概率已被压到实际不可能，出现即说明随机源异常，整批回滚。
      throw new Error(`随机码生成冲突：期望 ${count} 条，实际写入 ${inserted} 条`);
    }
    // 明文码按批次回查：被 skipDuplicates 跳过的码绝不能出现在返回给前端的清单里。
    const rows = await tx.ticket.findMany({
      where: { batchId: batch.id },
      select: { code: true },
      orderBy: { code: 'asc' },
    });
    return { batchId: batch.id, count: inserted, codes: rows.map((row) => row.code) };
  });

  await writeAudit('ticket.generate', {
    ticketTypeId,
    code: ticketType.code,
    count: result.count,
    batchId: result.batchId,
    operator,
    departmentId,
  });
  return { batchId: result.batchId, count: result.count, codes: result.codes };
}

// -----------------------------------------------------------------------------
// 票别分配（新建场次向导第三步的聚合提交）
// -----------------------------------------------------------------------------

/** ticket-plan 的单行：编码/名称/数量。 */
export interface TicketPlanRow {
  code: string;
  name: string;
  /** ≥0；>0 自动建批次发码（这批就是该票别的发码数量），=0 只建人员类别不发码 */
  count: number;
}

export interface TicketPlanResult {
  ticketTypes: TicketTypeDto[];
  /** 本次实际发码的批次（不返回明文码，明文码只经打印/下载路径出现） */
  generated: Array<{ ticketTypeId: string; batchId: string; count: number }>;
}

/**
 * 一次性提交场次的「启用票种全集」并发码（向导第三步，也可用于整体重排）。
 *
 * 语义（与前端票别分配表一一对应）：
 *   - 本次提交的 types 数组就是该场次的启用票种全集，数组顺序即 sortOrder；
 *     现有未列入者置 enabled=false（软停用，历史数据可读）；
 *   - 逐票种按 (sessionId, code) upsert：命中则更新 name/排序，未命中则新建；
 *   - types 不能为空：空数组等效于「停用全部人员类别」，由 422 TICKET_PLAN_EMPTY 拦下；
 *   - 已产生答卷的启用票种必须仍在提交集合中：它一旦被移出（等效于改码或删除），
 *     已有答卷的票别归属就断了，409 TICKET_TYPE_HAS_SHEETS；
 *   - count > 0 的票种自动建 TicketBatch 并生成随机码（同 generateTickets 的
 *     事务写法：批次与码一起写，撞库在事务内补生成、行数比对兜底）；
 *     count = 0 只建票种不发码。
 *
 * 全部写入在同一个事务里：向导的第三步要么整批成功，要么整批回滚。
 */
export async function applyTicketPlan(
  sessionId: string,
  input: { types: TicketPlanRow[] },
  operator: string,
): Promise<TicketPlanResult> {
  const session = await prisma.voteSession.findUnique({ where: { id: sessionId } });
  if (!session) throw ApiError.notFound('评议不存在');

  // 空集合会把本场次全部人员类别软停用（等于一次误操作的批量停用），提交前就拦下。
  if (input.types.length === 0) {
    throw ApiError.unprocessable('人员类别分配不能为空：至少需要一个人员类别', 'TICKET_PLAN_EMPTY');
  }

  const codes = input.types.map((row) => row.code);

  const existing = await prisma.ticketType.findMany({ where: { sessionId } });
  const existingByCode = new Map(existing.map((row) => [row.code, row]));

  // 已产生答卷的启用人员类别必须列入本次集合：移出集合等效于改码/删除该票别。
  const hasSheets = await prisma.scoreSheet.groupBy({
    by: ['ticketTypeId'],
    where: { sessionId, ticketTypeId: { in: existing.map((row) => row.id) } },
    _count: { _all: true },
  });
  const sheetCountByTypeId = new Map(hasSheets.map((row) => [row.ticketTypeId, row._count._all]));
  for (const row of existing) {
    if (row.enabled && (sheetCountByTypeId.get(row.id) ?? 0) > 0 && !codes.includes(row.code)) {
      throw ApiError.conflict(
        `人员类别 ${row.code}（${row.name}）已有答卷，不能从人员类别集合中移除或改码`,
        'TICKET_TYPE_HAS_SHEETS',
      );
    }
  }

  const generated = await prisma.$transaction(async (tx) => {
    const batches: Array<{ ticketTypeId: string; batchId: string; count: number }> = [];

    for (const [index, row] of input.types.entries()) {
      const match = existingByCode.get(row.code);
      const ticketTypeId = match
        ? match.id
        : (
            await tx.ticketType.create({
              data: {
                sessionId,
                code: row.code,
                name: row.name,
                sortOrder: index,
              },
            })
          ).id;

      if (match) {
        await tx.ticketType.update({
          where: { id: match.id },
          data: {
            name: row.name,
            sortOrder: index,
            enabled: true,
          },
        });
      }

      if (row.count > 0) {
        // 与 generateTickets 相同的事务写法：批次与码一起写入，撞库在事务内补生成。
        // 计划提交的码不绑定部门（要按部门定点发放请到「随机码」页签发）。
        const batch = await tx.ticketBatch.create({
          data: { ticketTypeId, sessionId, count: row.count, operator },
        });
        const inserted = await insertTicketCodes(
          tx,
          { ticketTypeId, batchId: batch.id, sessionId, departmentId: null },
          row.count,
        );
        if (inserted !== row.count) {
          throw new Error(`随机码生成冲突：期望 ${row.count} 条，实际写入 ${inserted} 条`);
        }
        batches.push({ ticketTypeId, batchId: batch.id, count: inserted });
      }
    }

    // 本次集合之外的现有票种全部软停用（含原本停用的，updateMany 幂等）。
    await tx.ticketType.updateMany({
      where: { sessionId, code: { notIn: codes } },
      data: { enabled: false },
    });

    return batches;
  });

  await writeAudit('ticket_plan.apply', {
    sessionId,
    types: input.types.map((row) => `${row.code}×${row.count}`).join(','),
    operator,
  });

  return {
    ticketTypes: await listTicketTypes(sessionId),
    generated,
  };
}

export interface TicketListQuery {
  page: number;
  pageSize: number;
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

/**
 * 随机码分页列表。
 *
 * 匿名边界（设计要求第 1 条「不记名投票」）：列表固定只返回未使用的码。
 * 已使用/已作废的码不出现 —— 管理员能看到「哪些码已核销」就能反推投票进度到人，
 * 因此使用情况只以票种级聚合计数（listTicketTypes 的 usedCount/unusedCount）披露。
 */
export async function listTickets(query: TicketListQuery): Promise<Paged<TicketDto>> {
  const where = {
    status: 'unused' as const,
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
  ticketTypeId?: string;
  sessionId?: string;
}

/**
 * 取待导出的随机码。
 *
 * 匿名边界：与列表一致，导出固定只含未使用的码（发放对账材料）；
 * 已核销的码不出现在任何管理员可下载的清单里。
 *
 * `ponytail:` 一次性把结果读进内存（上限 5 万行）。发码量级是千级，够用；
 * 若将来单次导出超过这个量级，改成流式写 exceljs 的 WorkbookWriter。
 */
export async function listTicketsForExport(filter: TicketExportFilter) {
  return prisma.ticket.findMany({
    where: {
      status: 'unused' as const,
      ticketTypeId: filter.ticketTypeId,
      sessionId: filter.sessionId,
    },
    orderBy: [{ createdAt: 'asc' }, { code: 'asc' }],
    take: 50_000,
    include: { ticketType: { select: { code: true, name: true } } },
  });
}

/**
 * 按批次取码：发码结果导出（一列一票别）用。
 *
 * 不接受前端回传的码本身 —— 码是敏感材料，按批次在服务端查，请求日志里不留码。
 * 刚生成的批次全是未使用码，因此这里不按状态过滤（导出的是「这批发了什么」）。
 */
export async function listTicketsByBatches(batchIds: string[]) {
  if (batchIds.length === 0) return [];
  return prisma.ticket.findMany({
    where: { batchId: { in: batchIds } },
    orderBy: [{ ticketType: { sortOrder: 'asc' } }, { createdAt: 'asc' }, { code: 'asc' }],
    take: 50_000,
    include: { ticketType: { select: { code: true, name: true } } },
  });
}

/** 评议名：导出文件名用，管理员一眼看出是哪个评议的材料。 */
export async function findSessionName(sessionId: string): Promise<string | null> {
  const row = await prisma.voteSession.findUnique({
    where: { id: sessionId },
    select: { name: true },
  });
  return row?.name ?? null;
}

/** 批次所属评议名：导出文件名用它，管理员一眼看出是哪个评议的码。 */
export async function findSessionNameByBatches(batchIds: string[]): Promise<string | null> {
  if (batchIds.length === 0) return null;
  const row = await prisma.ticketBatch.findFirst({
    where: { id: { in: batchIds } },
    select: { sessionId: true },
  });
  return row ? findSessionName(row.sessionId) : null;
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
      throw ApiError.conflict('该票据已使用，不能作废', 'TICKET_ALREADY_USED');
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
  /** 作废限定在该评议；多评议下不带评议的一键作废一律拒绝（400） */
  sessionId: string;
  /** 只作废该人员类别的码；不传表示该评议全部人员类别 */
  ticketTypeId?: string;
}

/**
 * 一键作废某场次内未使用的随机码。
 *
 * 一条 `updateMany` 带 `status = 'unused'` 条件即原子完成：与并发核销天然互斥 ——
 * 已被核销的码在语句执行时不再匹配，不会被改回 revoked（作废已核销的码会凭空
 * 毁掉一张有效票）。因此这里不做「先查再改」，也不返回被跳过的数量。
 *
 * 作废范围必须限定在单个场次：多场次下各场次数据隔离，误作废历史场次的有效票
 * 无法挽回，因此 sessionId 必传。
 *
 * 不存在的票种 id 不报 404：那只是「没有匹配的码」，返回 0 即可，
 * 前端拿到 0 也不会做任何危险动作。
 *
 * @param input 作废范围（场次必填；`ticketTypeId` 不传即该场次全部票种）
 * @param operator 操作者用户名，写入 AuditLog
 * @returns 实际作废数量
 */
export async function revokeTicketsBulk(
  input: RevokeTicketsBulkInput,
  operator: string,
): Promise<{ revoked: number }> {
  const updated = await prisma.ticket.updateMany({
    where: {
      status: 'unused',
      sessionId: input.sessionId,
      ticketTypeId: input.ticketTypeId,
    },
    data: { status: 'revoked' },
  });

  await writeAudit('ticket.revoke_bulk', {
    scope: input.ticketTypeId ? 'ticketType' : 'session',
    sessionId: input.sessionId,
    ticketTypeId: input.ticketTypeId ?? null,
    count: updated.count,
    operator,
  });

  return { revoked: updated.count };
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
  };
}

/**
 * 改部门（名称/排序/启停/问卷类型）。
 * 0010 起问卷抬头三件套（附件号/标题/填写说明）迁至场次级模板
 * （updateQuestionnaireTemplate），部门只保留「用哪套问卷」的类型字段。
 */
export async function updateDepartment(
  id: string,
  patch: {
    name?: string;
    sortOrder?: number;
    enabled?: boolean;
    questionnaireType?: string;
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
    throw ApiError.badRequest('打分表类型只能是「个人打分表」或「车间打分表」', 'QUESTIONNAIRE_TYPE_INVALID');
  }

  const updated = await prisma.department.update({
    where: { id },
    data: {
      name,
      sortOrder: patch.sortOrder,
      enabled: patch.enabled,
      questionnaireType: patch.questionnaireType,
    },
  });
  await writeAudit('department.update', { name: updated.name, operator });
  return {
    id: updated.id,
    name: updated.name,
    sortOrder: updated.sortOrder,
    enabled: updated.enabled,
    questionnaireType: updated.questionnaireType,
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
// 全局部门字典
// -----------------------------------------------------------------------------

export interface OrgDepartmentDto {
  id: string;
  name: string;
  sortOrder: number;
  enabled: boolean;
  createdAt: string;
}

function toOrgDepartmentDto(row: {
  id: string;
  name: string;
  sortOrder: number;
  enabled: boolean;
  createdAt: Date;
}): OrgDepartmentDto {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 全局部门列表列表（登录即可读，无需写权限）。 */
export async function listOrgDepartments(): Promise<{ departments: OrgDepartmentDto[] }> {
  const rows = await prisma.orgDepartment.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  return { departments: rows.map(toOrgDepartmentDto) };
}

// -----------------------------------------------------------------------------
// 字典新增 → 未开场场次自动补部门（联动问卷下拉）
// -----------------------------------------------------------------------------

/** 附件8 表尾填写说明（两套模板共用）。 */
const QUESTIONNAIRE_FOOTER_NOTE =
  '填写说明：问卷调查采用无记名投票的方式开展，每一条评价项点满分20分，弃权、不填视为0分。';

/**
 * 附件8 的评分区间：每项满分 20 分，弃权/不填视为 0 分。
 * 表尾说明写死了「满分20分」，模板项点的 maxScore 必须同口径——
 * 否则投票端输入框会放开到 0–100，计分归一化也跟着错。
 */
const CRITERION_MIN_SCORE = 0;
const CRITERION_MAX_SCORE = 20;

/** 一套打分表模板（与附件8 的 sheet 结构一一对应）。 */
interface QuestionnaireTemplate {
  questionnaireType: 'person' | 'workshop';
  title: string;
  footerNote: string;
  criteria: Array<{ name: string; description: string }>;
  voteColumns: string[];
}

/** 个人打分表模板（附件8 sheet1）：5 评议项目 + 5 个被评职务列。 */
const PERSON_QUESTIONNAIRE_TEMPLATE: QuestionnaireTemplate = {
  questionnaireType: 'person',
  title: 'xx车间负责人评价问卷',
  footerNote: QUESTIONNAIRE_FOOTER_NOTE,
  criteria: [
    { name: '政治素质', description: '信念坚定、对党忠诚、认真贯彻落实上级党组织的指令，团结带领职工听党话、跟党走，关键时刻，经得住考验。' },
    { name: '敬业担当', description: '扎根一线埋头苦干，无私奉献，恪尽职守，不畏艰险、迎难而上、善于斗争、勇于斗争。' },
    { name: '专业能力', description: '精通线路业务知识，善于解决工作中遇到的疑难杂症，熟悉规章制度、现场实操能力强，具备扎实的故障排查、应急处置能力。' },
    { name: '工作质效', description: '善于管理，优质完成各项生产任务、确保设备运营安全和干部职工人身安全。' },
    { name: '廉洁自律', description: '严守纪律，清正廉洁，恪守职业道德底线，管理透明、办事公道。' },
  ],
  voteColumns: ['主任', '党支部书记', '党支部副书记', '副主任', '副主任'],
};

/** 车间打分表模板（附件8 sheet2）：5 评议项目，无被评职务列（单列「得分」版式）。 */
const WORKSHOP_QUESTIONNAIRE_TEMPLATE: QuestionnaireTemplate = {
  questionnaireType: 'workshop',
  title: 'xx车间评价问卷',
  footerNote: QUESTIONNAIRE_FOOTER_NOTE,
  criteria: [
    { name: '党建引领', description: '车间班子团结协作、沟通顺畅、政治生态较好，职场氛围风清气正。信念坚定、对党忠诚、及时传达学习党的理论知识，认真贯彻落实上级各项决策部署，带领党员发挥先锋模范作用。' },
    { name: '安全管理', description: '落实安全生产责任制，风险研判到位、隐患排查整治到位、安全履职效果（安全检查）、整体安全形势平稳（安全效果）。' },
    { name: '生产组织', description: '生产组织有序，计划安排合理，人员作业效率高，跨专业协同作业得当，高质量完成生产任务，验收考评闭环。' },
    { name: '队伍素质', description: '干部职工理论知识扎实、实操经验丰富、应急处理得当，团队意识强、精神风貌好、学习氛围浓。' },
    { name: '基础管理', description: '标准作业，各类台账齐全，技术资料，库房管理规范、职场环境干净整洁。' },
  ],
  voteColumns: [],
};

/** 打分表类型启发式：以「车间」结尾按车间打分表，其余按个人打分表（管理员之后仍可在打分表配置页改）。 */
function questionnaireTypeOf(name: string): 'person' | 'workshop' {
  return name.endsWith('车间') ? 'workshop' : 'person';
}

/** 按部门名取附件8 对应的那套模板。 */
function templateForDepartment(name: string): QuestionnaireTemplate {
  return questionnaireTypeOf(name) === 'workshop'
    ? WORKSHOP_QUESTIONNAIRE_TEMPLATE
    : PERSON_QUESTIONNAIRE_TEMPLATE;
}

/**
 * 给场次种入附件8 的一整套问卷：抬头三件套 + 5 个项点 + 被评列。
 *
 * 幂等：项点按名称补齐（同场次同类型已有同名项点则跳过），
 * 因此字典新增部门时对同一场次重复调用不会产生重复项点。
 * 被评列只在新建部门时创建（调用方保证 departmentId 是新部门）。
 */
async function seedQuestionnaireTemplate(
  db: Prisma.TransactionClient,
  sessionId: string,
  departmentId: string,
  template: QuestionnaireTemplate,
  options: { withVoteColumns?: boolean } = {},
): Promise<void> {
  const withVoteColumns = options.withVoteColumns ?? true;
  // headerNote 不传：保持列默认「附件1-1」，与附件8 左上角一致。
  await upsertTemplate(db, sessionId, template.questionnaireType, {
    title: template.title,
    footerNote: template.footerNote,
  });

  const existing = await db.criterion.findMany({
    where: { sessionId, templateType: template.questionnaireType },
    select: { name: true },
  });
  const existingNames = new Set(existing.map((row) => row.name));
  const missing = template.criteria.filter((item) => !existingNames.has(item.name));
  if (missing.length > 0) {
    await db.criterion.createMany({
      data: missing.map((item, index) => ({
        departmentId: null,
        sessionId,
        templateType: template.questionnaireType,
        name: item.name,
        description: item.description,
        minScore: CRITERION_MIN_SCORE,
        maxScore: CRITERION_MAX_SCORE,
        sortOrder: existingNames.size + index + 1,
      })),
    });
  }

  // workshop 是单列「得分」版式，没有被评职务列。
  // 部门已有任何被评议人列时不再补：补种只服务于「新部门 / 空配置」，不覆盖管理员改过的列。
  if (withVoteColumns && template.voteColumns.length > 0) {
    const existingColumns = await db.voteColumn.count({ where: { departmentId } });
    if (existingColumns === 0) {
      await db.voteColumn.createMany({
        data: template.voteColumns.map((name, index) => ({
          departmentId,
          sessionId,
          name,
          sortOrder: index + 1,
        })),
      });
    }
  }
}

/**
 * 把字典新部门按名复制进所有未开场（draft）的场次，并套用附件8 对应模板。
 *
 * 只动 draft 场次：voting/paused 已在投票、ended 已成历史，中途加部门会破坏
 * 投票口径。场内已有同名部门则跳过（@@unique([sessionId, name]) 兜底）。
 * 模板含标题/说明/5 项点/被评列，与问卷配置页手工配置的结果一致。
 */
async function syncOrgDepartmentToDraftSessions(
  name: string,
  sortOrder: number,
  operator: string,
): Promise<number> {
  const draftSessions = await prisma.voteSession.findMany({
    where: { status: 'draft' },
    select: { id: true },
  });
  let synced = 0;
  for (const session of draftSessions) {
    const exists = await prisma.department.findFirst({
      where: { sessionId: session.id, name },
      select: { id: true },
    });
    if (exists) continue;
    const template = templateForDepartment(name);
    const created = await prisma.department.create({
      data: {
        sessionId: session.id,
        name,
        sortOrder,
        questionnaireType: template.questionnaireType,
      },
    });
    // 抬头三件套 + 5 项点 + 被评列与「新建场次」走同一个种子函数，两处口径不会漂移。
    await seedQuestionnaireTemplate(prisma, session.id, created.id, template);
    await writeAudit('department.create', { name, operator });
    synced += 1;
  }
  return synced;
}

/**
 * 给缺问卷配置的草稿场次补种附件8 模板（幂等，可重复执行）。
 *
 * 用途：本功能上线前创建的场次只有空问卷；补种让它们与新建场次口径一致。
 * 只动 draft 场次：voting/paused/ended 的问卷已在用，补种会改变投票口径。
 *
 * @param sessionId 指定场次；缺省 = 全部草稿场次
 * @returns 实际处理过的部门数
 */
export async function backfillQuestionnaireTemplates(sessionId?: string): Promise<number> {
  const sessions = await prisma.voteSession.findMany({
    where: sessionId ? { id: sessionId } : { status: 'draft' },
    select: {
      id: true,
      departments: { select: { id: true, questionnaireType: true } },
    },
  });
  let seeded = 0;
  for (const session of sessions) {
    for (const department of session.departments) {
      const template =
        department.questionnaireType === 'workshop'
          ? WORKSHOP_QUESTIONNAIRE_TEMPLATE
          : PERSON_QUESTIONNAIRE_TEMPLATE;
      await seedQuestionnaireTemplate(prisma, session.id, department.id, template);
      // 另一套问卷的抬头与项点也补齐，保证向导切换类型后不是空表。
      await seedQuestionnaireTemplate(
        prisma,
        session.id,
        department.id,
        template.questionnaireType === 'person'
          ? WORKSHOP_QUESTIONNAIRE_TEMPLATE
          : PERSON_QUESTIONNAIRE_TEMPLATE,
        { withVoteColumns: false },
      );
      seeded += 1;
    }
  }
  return seeded;
}

export async function createOrgDepartment(
  input: { name: string; sortOrder?: number },
  operator: string,
): Promise<OrgDepartmentDto> {
  const name = input.name.trim();
  if (await prisma.orgDepartment.findUnique({ where: { name } })) {
    throw ApiError.conflict(`部门「${name}」已存在`, 'ORG_DEPARTMENT_EXISTS');
  }
  const created = await prisma.orgDepartment.create({
    data: { name, sortOrder: input.sortOrder ?? 0 },
  });
  await writeAudit('org_department.create', { name, operator });
  // 字典新增即联动：未开场场次自动补进同名场内部门（套附件8 模板），
  // 问卷下拉（数据源是场内 departments）随之出现新部门，无需再手动添加。
  await syncOrgDepartmentToDraftSessions(name, input.sortOrder ?? 0, operator);
  return toOrgDepartmentDto(created);
}

export async function updateOrgDepartment(
  id: string,
  patch: { name?: string; sortOrder?: number; enabled?: boolean },
  operator: string,
): Promise<OrgDepartmentDto> {
  const current = await prisma.orgDepartment.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('部门不存在', 'ORG_DEPARTMENT_NOT_FOUND');

  const name = patch.name?.trim();
  if (name && name !== current.name) {
    const conflict = await prisma.orgDepartment.findUnique({ where: { name } });
    if (conflict && conflict.id !== id) {
      throw ApiError.conflict(`部门「${name}」已存在`, 'ORG_DEPARTMENT_EXISTS');
    }
  }

  const updated = await prisma.orgDepartment.update({
    where: { id },
    data: { name, sortOrder: patch.sortOrder, enabled: patch.enabled },
  });
  await writeAudit('org_department.update', { name: updated.name, operator });
  return toOrgDepartmentDto(updated);
}

/**
 * 删除全局部门 —— 物理删除。
 *
 * 字典项与场内 departments 是「按名复制」关系，没有数据级联，未被任何场次
 * 引用时删除是安全的。已被场次引用（vote_sessions.org_department_id）时 409：
 * 场次对字典来源的引用不可悬空，想从新场次下拉里移除请用停用（enabled=false）。
 */
export async function deleteOrgDepartment(id: string, operator: string): Promise<void> {
  const current = await prisma.orgDepartment.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('部门不存在', 'ORG_DEPARTMENT_NOT_FOUND');

  const referenced = await prisma.voteSession.count({ where: { orgDepartmentId: id } });
  if (referenced > 0) {
    throw ApiError.conflict(
      `部门「${current.name}」已被 ${referenced} 个评议引用，不能删除；可改为停用`,
      'ORG_DEPARTMENT_IN_USE',
    );
  }

  await prisma.orgDepartment.delete({ where: { id } });
  await writeAudit('org_department.delete', { name: current.name, operator });
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
    gender: row.gender,
    age: row.age,
    title: row.title,
    sortOrder: row.sortOrder,
    enabled: row.enabled,
  }));
}

export interface EmployeeCreateInput {
  departmentId: string;
  /** 可选：显式指定评议时必须与部门所属评议一致，否则 400。 */
  sessionId?: string;
  name: string;
  gender?: string | null;
  age?: number | null;
  title?: string | null;
  sortOrder?: number;
}

export async function createEmployee(
  input: EmployeeCreateInput,
  operator: string,
): Promise<EmployeeDto> {
  const department = await prisma.department.findUnique({ where: { id: input.departmentId } });
  if (!department) throw ApiError.badRequest('部门不存在');
  // 职工归属场次 = 部门所属场次；显式传 sessionId 时校验一致，防止配错。
  if (input.sessionId !== undefined && input.sessionId !== department.sessionId) {
    throw ApiError.badRequest('部门不属于该评议', 'SESSION_MISMATCH');
  }

  const created = await prisma.employee.create({
    data: {
      departmentId: input.departmentId,
      sessionId: department.sessionId,
      name: input.name.trim(),
      gender: input.gender ?? null,
      age: input.age ?? null,
      title: input.title ?? null,
      sortOrder: input.sortOrder ?? 0,
    },
  });
  await writeAudit('employee.create', { name: created.name, department: department.name, operator });
  return {
    id: created.id,
    departmentId: created.departmentId,
    name: created.name,
    gender: created.gender,
    age: created.age,
    title: created.title,
    sortOrder: created.sortOrder,
    enabled: created.enabled,
  };
}

export async function updateEmployee(
  id: string,
  patch: {
    departmentId?: string;
    name?: string;
    gender?: string | null;
    age?: number | null;
    title?: string | null;
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

  const updated = await prisma.employee.update({
    where: { id },
    data: {
      departmentId: patch.departmentId,
      sessionId: nextSessionId,
      name: patch.name?.trim(),
      gender: patch.gender,
      age: patch.age,
      title: patch.title,
      sortOrder: patch.sortOrder,
      enabled: patch.enabled,
    },
  });
  await writeAudit('employee.update', { name: updated.name, operator });
  return {
    id: updated.id,
    departmentId: updated.departmentId,
    name: updated.name,
    gender: updated.gender,
    age: updated.age,
    title: updated.title,
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

/** 名单导出：只含启用职工，列序与导入模板一致（导出件可直接再导入）。 */
export async function listRosterForExport(
  departmentId: string | undefined,
  sessionId: string | undefined,
): Promise<
  Array<{ departmentName: string; name: string; gender: string | null; age: number | null; title: string | null }>
> {
  const rows = await prisma.employee.findMany({
    where: { departmentId, enabled: true, sessionId: await resolveSessionId(sessionId) },
    orderBy: [{ department: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
    include: { department: { select: { name: true } } },
  });
  return rows.map((row) => ({
    departmentName: row.department.name,
    name: row.name,
    gender: row.gender,
    age: row.age,
    title: row.title,
  }));
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
 * 按「部门名 + 姓名」upsert：同名同部门的行视为同一人，更新其性别/年龄/职称。
 * 部门不存在时按名称自动创建，避免管理员为了导入一份名单先手工建十几个部门。
 *
 * 单行失败只计入 errors 并继续，不整批回滚 —— 一份上千行的名单里有一行脏数据，
 * 让管理员自己改那一行比重传整份文件现实。
 */
export async function importEmployees(
  rows: Array<{
    rowNumber: number;
    departmentName: string;
    name: string;
    gender: string | null;
    age: number | null;
    title: string | null;
  }>,
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

      const sameName = await prisma.employee.findFirst({
        where: { departmentId, name: row.name },
      });
      if (sameName) {
        await prisma.employee.update({
          where: { id: sameName.id },
          data: { gender: row.gender, age: row.age, title: row.title },
        });
        result.updated += 1;
      } else {
        await prisma.employee.create({
          data: {
            departmentId,
            sessionId: targetSessionId,
            name: row.name,
            gender: row.gender,
            age: row.age,
            title: row.title,
          },
        });
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

export async function listCriteria(opts: {
  sessionId?: string;
  departmentId?: string;
  /** 模板评议项目类型过滤（person/workshop）；此时只查 departmentId 为空的模板行。 */
  templateType?: string;
}): Promise<CriterionDto[]> {
  const where: {
    sessionId?: string;
    departmentId?: string | null;
    templateType?: string;
  } = { sessionId: opts.sessionId };
  if (opts.templateType !== undefined) {
    where.departmentId = null;
    where.templateType = opts.templateType;
  } else if (opts.departmentId !== undefined) {
    where.departmentId = opts.departmentId;
  }
  const rows = await prisma.criterion.findMany({
    where,
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  return rows.map((row) => ({
    id: row.id,
    departmentId: row.departmentId,
    templateType: row.templateType,
    name: row.name,
    description: row.description,
    minScore: row.minScore,
    maxScore: row.maxScore,
    sortOrder: row.sortOrder,
    enabled: row.enabled,
  }));
}

export interface CriterionCreateInput {
  /** 模板评议项目：评议 + 类型（person/workshop）。 */
  sessionId?: string;
  templateType?: string;
  name: string;
  description?: string | null;
  minScore: number;
  maxScore: number;
  sortOrder?: number;
}

/** 新增模板评议项目。0010 起评议项目只在模板层维护（部门级评议项目仅为历史评分保留）。 */
export async function createCriterion(
  input: CriterionCreateInput,
  operator: string,
): Promise<CriterionDto> {
  if (input.maxScore <= input.minScore) {
    throw ApiError.badRequest('最高分必须大于最低分', 'CRITERION_RANGE_INVALID');
  }
  if (input.templateType === undefined || !QUESTIONNAIRE_TYPES.includes(input.templateType)) {
    throw ApiError.badRequest('必须指定打分表模板类型（个人打分表/车间打分表）', 'TEMPLATE_TYPE_INVALID');
  }

  const sessionId = await resolveSessionId(input.sessionId);
  // 追加到末尾：新项点排在该模板现有项点之后。
  const last = await prisma.criterion.findFirst({
    where: { sessionId, departmentId: null, templateType: input.templateType },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  });

  const created = await prisma.criterion.create({
    data: {
      departmentId: null,
      sessionId,
      templateType: input.templateType,
      name: input.name.trim(),
      description: normalizeDescription(input.description),
      minScore: input.minScore,
      maxScore: input.maxScore,
      sortOrder: input.sortOrder ?? (last?.sortOrder ?? -1) + 1,
    },
  });
  await writeAudit('criterion.create', {
    name: created.name,
    templateType: created.templateType,
    operator,
  });
  return {
    id: created.id,
    departmentId: created.departmentId,
    templateType: created.templateType,
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
  if (!current) throw ApiError.notFound('评议项目不存在');

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
    templateType: updated.templateType,
    name: updated.name,
    description: updated.description,
    minScore: updated.minScore,
    maxScore: updated.maxScore,
    sortOrder: updated.sortOrder,
    enabled: updated.enabled,
  };
}

/** 删除评议项目 —— 软删除，历史评分里的该项仍可读。 */
export async function disableCriterion(id: string, operator: string): Promise<void> {
  const current = await prisma.criterion.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('评议项目不存在');
  await prisma.criterion.update({ where: { id }, data: { enabled: false } });
  await writeAudit('criterion.disable', { name: current.name, operator });
}

// -----------------------------------------------------------------------------
// 评议打分表模板（个人 / 车间各一套抬头配置）
// -----------------------------------------------------------------------------

/** 读一套模板。行不存在时返回默认值（新评议首访自动以默认文案展示，保存时才落行）。 */
export async function listQuestionnaireTemplate(
  sessionId: string,
  type: string,
): Promise<QuestionnaireTemplateDto> {
  if (!QUESTIONNAIRE_TYPES.includes(type)) {
    throw ApiError.badRequest('打分表模板类型只能是「个人打分表」或「车间打分表」', 'TEMPLATE_TYPE_INVALID');
  }
  // 该表的 Prisma 编译有 bug（P2022），读写一律走原生 SQL 封装 questionnaireTemplateStore。
  const row = await findTemplate(prisma, sessionId, type);
  return {
    sessionId,
    type,
    headerNote: row?.headerNote ?? '附件1-1',
    title: row?.title ?? '',
    footerNote: row?.footerNote ?? '',
  };
}

/** 改一套模板（附件号 / 标题 / 填写说明，PATCH 语义：缺省不改）。 */
export async function updateQuestionnaireTemplate(
  sessionId: string,
  type: string,
  patch: { headerNote?: string; title?: string; footerNote?: string },
  operator: string,
): Promise<QuestionnaireTemplateDto> {
  if (!QUESTIONNAIRE_TYPES.includes(type)) {
    throw ApiError.badRequest('打分表模板类型只能是「个人打分表」或「车间打分表」', 'TEMPLATE_TYPE_INVALID');
  }
  await resolveSessionId(sessionId);
  const data: { headerNote?: string; title?: string; footerNote?: string } = {};
  if (patch.headerNote !== undefined) data.headerNote = patch.headerNote.trim();
  if (patch.title !== undefined) data.title = patch.title.trim();
  if (patch.footerNote !== undefined) data.footerNote = patch.footerNote.trim();

  // 该表的 Prisma 编译有 bug（P2022），读写一律走原生 SQL 封装 questionnaireTemplateStore。
  // PATCH 语义（缺省不改）由 upsertTemplate 内部保持：先读现行值合并，再 UPSERT 落库。
  const row = await upsertTemplate(prisma, sessionId, type, data);
  await writeAudit('questionnaire_template.update', { type, operator });
  return {
    sessionId: row.sessionId,
    type: row.type,
    headerNote: row.headerNote,
    title: row.title,
    footerNote: row.footerNote,
  };
}

// -----------------------------------------------------------------------------
// 被评列（打分表的列）
// -----------------------------------------------------------------------------

/**
 * 副本工号 → 人员目录条目 id。
 *
 * 只用于把「已选人」回显成人员目录下拉的选中项：列里存的是场次副本 id，
 * 下拉的 value 是人员目录 id，两者必须靠工号接起来。
 */
async function staffIdsByEmployeeNo(employeeNos: Array<string | null>): Promise<Map<string, string>> {
  const nos = [...new Set(employeeNos.filter((no): no is string => Boolean(no)))];
  if (nos.length === 0) return new Map();
  const entries = await prisma.staffDirectoryEntry.findMany({
    where: { employeeNo: { in: nos } },
    select: { id: true, employeeNo: true },
  });
  return new Map(entries.map((entry) => [entry.employeeNo, entry.id]));
}

function toVoteColumnDto(
  row: {
    id: string;
    departmentId: string;
    name: string;
    employeeId: string | null;
    sortOrder: number;
    enabled: boolean;
    employee: { name: string; employeeNo: string | null } | null;
  },
  staffIdByNo: Map<string, string>,
): VoteColumnDto {
  const employeeNo = row.employee?.employeeNo ?? null;
  return {
    id: row.id,
    departmentId: row.departmentId,
    name: row.name,
    employeeId: row.employeeId,
    employeeName: row.employee?.name ?? null,
    employeeNo,
    staffDirectoryId: employeeNo ? (staffIdByNo.get(employeeNo) ?? null) : null,
    sortOrder: row.sortOrder,
    enabled: row.enabled,
  };
}

export async function listVoteColumns(
  departmentId?: string,
  sessionId?: string,
): Promise<VoteColumnDto[]> {
  const rows = await prisma.voteColumn.findMany({
    where: { departmentId, sessionId },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { employee: { select: { name: true, employeeNo: true } } },
  });
  const staffIdByNo = await staffIdsByEmployeeNo(rows.map((row) => row.employee?.employeeNo ?? null));
  return rows.map((row) => toVoteColumnDto(row, staffIdByNo));
}

export interface VoteColumnCreateInput {
  departmentId: string;
  /** 可选：显式指定评议时必须与部门所属评议一致，否则 400。 */
  sessionId?: string;
  name: string;
  /** 该职务列的具体被评议人（可选）。仅接受本部门已有的评议副本。 */
  employeeId?: string | null;
  /**
   * 从全局人员目录选人（可选）。后端按 (sessionId, 工号) 幂等落一条场次副本，
   * 副本归属**列所属部门**——允许跨部门选人，但打印仍按本部门归集。
   * 与 `employeeId` 同时传时以本字段为准。
   */
  staffDirectoryId?: string | null;
  sortOrder?: number;
}

/**
 * 校验被评人：必须存在且属于该列所在部门。
 *
 * 直传 `employeeId` 的旧路径仍守这条边界（防前端传错 id 把别部门的人塞进本表）；
 * 跨部门选人是人员管理选人的**有**意能力，走 `staffDirectoryId` 那条路径。
 */
async function resolveEmployeeId(
  employeeId: string | null | undefined,
  departmentId: string,
): Promise<string | null> {
  if (employeeId === null || employeeId === undefined) return employeeId ?? null;
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw ApiError.badRequest('被评议人不存在');
  if (employee.departmentId !== departmentId) throw ApiError.badRequest('被评议人必须属于该部门');
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
    throw ApiError.badRequest('部门不属于该评议', 'SESSION_MISMATCH');
  }
  const employeeId = input.staffDirectoryId
    ? await employeeIdFromStaff(input.staffDirectoryId, {
        departmentId: department.id,
        sessionId: department.sessionId,
      })
    : await resolveEmployeeId(input.employeeId, input.departmentId);

  const created = await prisma.voteColumn.create({
    data: {
      departmentId: input.departmentId,
      sessionId: department.sessionId,
      name,
      employeeId,
      sortOrder: input.sortOrder ?? 0,
    },
    include: { employee: { select: { name: true, employeeNo: true } } },
  });
  await writeAudit('vote_column.create', { name, department: department.name, operator });
  const staffIdByNo = await staffIdsByEmployeeNo([created.employee?.employeeNo ?? null]);
  return toVoteColumnDto(created, staffIdByNo);
}

export async function updateVoteColumn(
  id: string,
  patch: {
    name?: string;
    employeeId?: string | null;
    staffDirectoryId?: string | null;
    sortOrder?: number;
    enabled?: boolean;
  },
  operator: string,
): Promise<VoteColumnDto> {
  const current = await prisma.voteColumn.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('被评议人列不存在');
  // 人员管理选人优先；清除已选人仍走 `employeeId: null`。
  const employeeId = patch.staffDirectoryId
    ? await employeeIdFromStaff(patch.staffDirectoryId, {
        departmentId: current.departmentId,
        sessionId: current.sessionId,
      })
    : patch.employeeId === undefined
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
    include: { employee: { select: { name: true, employeeNo: true } } },
  });
  await writeAudit('vote_column.update', { name: updated.name, operator });
  const staffIdByNo = await staffIdsByEmployeeNo([updated.employee?.employeeNo ?? null]);
  return toVoteColumnDto(updated, staffIdByNo);
}

/** 删除被评议人列 —— 软删除，历史评分里的该列仍可读。 */
export async function disableVoteColumn(id: string, operator: string): Promise<void> {
  const current = await prisma.voteColumn.findUnique({ where: { id } });
  if (!current) throw ApiError.notFound('被评议人列不存在');
  await prisma.voteColumn.update({ where: { id }, data: { enabled: false } });
  await writeAudit('vote_column.disable', { name: current.name, operator });
}

// -----------------------------------------------------------------------------
// 设置
// -----------------------------------------------------------------------------

const DEFAULT_SETTING_MAP = new Map(DEFAULT_SETTINGS.map((item) => [item.key, item.value]));

/** 设置项的键名元组：用元组而不是 Object.values，键名才能收敛成字面量联合类型。 */
const SETTINGS_KEY_LIST = [SETTING_KEYS.systemTitle] as const;

function settingValue(map: Map<string, string>, key: string): string {
  return map.get(key) ?? DEFAULT_SETTING_MAP.get(key) ?? '';
}

/**
 * 读取全部设置。
 *
 * 库里缺行时回落到默认值：设置项由 seed 写入，但测试库或新部署可能还没跑 seed，
 * 此时返回默认标题比返回 undefined 让前端崩掉要好。
 */
export async function getSettings(): Promise<SettingsDto> {
  const rows = await prisma.setting.findMany();
  const map = new Map(rows.map((row) => [row.key, row.value]));
  return {
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