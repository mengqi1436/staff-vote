/**
 * 后台统计。
 *
 * 口径说明（与设计文档第 12.2 / 15 节一致）：
 *   - ticketTypes[].issued / used / unused / revoked：按随机码状态计数，合计即该票种发放量；
 *   - totals：全部票种的合计 + 已提交打分表数（sheets）；
 *   - departments[].employeeCount：该部门**启用**职工数（软删除的职工不再计入在册人数）；
 *   - departments[].sheetCount：该部门已提交的打分表数（软删除不影响历史数据）；
 *   - tickets[]：票别发放留痕口径 —— assignedCount 为已指定领码人的票数，
 *     usedByAssignee 为「已核销且领码人非空」的票按领码人分组（含姓名）。
 *     票不记名：这只是发放/核销留痕，评分数据（score_sheets 不含票据标识）仍匿名。
 *
 * 场次 ID 必传（路由层经 resolveSessionId 解析），全部计数与投票窗口限定在该场次。
 * 全部计数用 groupBy / 一次扫描拿到，不做「每行一次 count」的循环查询。
 */
import { prisma } from '../db.js';
import { evaluateVoteWindow } from '../lib/settings.js';

export interface StatsTicketTypeRow {
  id: string;
  code: string;
  name: string;
  weightPercent: number;
  issued: number;
  used: number;
  unused: number;
  revoked: number;
}

/** 票别发放留痕（一个票种一行）。 */
export interface StatsTicketRow {
  ticketTypeId: string;
  code: string;
  name: string;
  /** 已指定领码人的票数（assignee_id 非空） */
  assignedCount: number;
  /** 已核销且领码人非空的票，按领码人分组（仅发放/核销留痕，不含任何评分内容） */
  usedByAssignee: Array<{ employeeId: string; employeeName: string; count: number }>;
}

export interface StatsDepartmentRow {
  id: string;
  name: string;
  enabled: boolean;
  employeeCount: number;
  sheetCount: number;
}

/** 投票开放窗口（本场次数据）：开放判定结果 + 场次状态本身。 */
export interface StatsVoteWindow {
  open: boolean;
  message: string;
  /** 场次开放时间窗（未设置则为 null） */
  opensAt: string | null;
  closesAt: string | null;
  /** 场次状态（draft / voting / paused / ended） */
  status: string;
}

export interface StatsOverviewDto {
  ticketTypes: StatsTicketTypeRow[];
  totals: {
    issued: number;
    used: number;
    unused: number;
    revoked: number;
    sheets: number;
  };
  /** 票别发放留痕（含领码人姓名），按票种一行 */
  tickets: StatsTicketRow[];
  departments: StatsDepartmentRow[];
  voteWindow: StatsVoteWindow;
  generatedAt: string;
}

/** 汇总票种发放/使用情况 + 部门进度 + 本场次的投票窗口。 */
export async function getStatsOverview(sessionId: string): Promise<StatsOverviewDto> {
  const [ticketTypes, ticketGroups, sheets, departments, employeeGroups, sheetGroups, session, assignedTickets] =
    await Promise.all([
      prisma.ticketType.findMany({
        where: { sessionId },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      }),
      prisma.ticket.groupBy({
        by: ['ticketTypeId', 'status'],
        _count: { _all: true },
        where: { sessionId },
      }),
      prisma.scoreSheet.count({ where: { sessionId } }),
      prisma.department.findMany({
        where: { sessionId },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      prisma.employee.groupBy({
        by: ['departmentId'],
        where: { enabled: true, ...(sessionId ? { sessionId } : {}) },
        _count: { _all: true },
      }),
      prisma.scoreSheet.groupBy({
        by: ['departmentId'],
        where: { sessionId },
        _count: { _all: true },
      }),
      // 投票窗口是本场次的数据：状态 + 场次自己的开放时间窗。
      prisma.voteSession.findUniqueOrThrow({
        where: { id: sessionId },
        select: { status: true, opensAt: true, closesAt: true },
      }),
      // 发放留痕：只扫「指定了领码人」的票，票数是人级别的量，内存聚合足够。
      prisma.ticket.findMany({
        where: { sessionId, assigneeId: { not: null } },
        select: {
          ticketTypeId: true,
          status: true,
          assignee: { select: { id: true, name: true } },
        },
      }),
    ]);

  const byTicketType = new Map<string, { issued: number; used: number; unused: number; revoked: number }>();
  const totals = { issued: 0, used: 0, unused: 0, revoked: 0 };

  for (const row of ticketGroups) {
    const entry = byTicketType.get(row.ticketTypeId) ?? {
      issued: 0,
      used: 0,
      unused: 0,
      revoked: 0,
    };
    const count = row._count._all;
    entry.issued += count;
    totals.issued += count;

    if (row.status === 'used') {
      entry.used += count;
      totals.used += count;
    } else if (row.status === 'unused') {
      entry.unused += count;
      totals.unused += count;
    } else {
      entry.revoked += count;
      totals.revoked += count;
    }
    byTicketType.set(row.ticketTypeId, entry);
  }

  // 票别留痕聚合：assignedCount 计数；usedByAssignee 只统计已核销的票，按人分组。
  const assignedByType = new Map<string, { assigned: number; usedByEmployee: Map<string, { name: string; count: number }> }>();
  for (const row of assignedTickets) {
    if (!row.assignee) continue;
    const entry = assignedByType.get(row.ticketTypeId) ?? {
      assigned: 0,
      usedByEmployee: new Map<string, { name: string; count: number }>(),
    };
    entry.assigned += 1;
    if (row.status === 'used') {
      const employeeEntry = entry.usedByEmployee.get(row.assignee.id) ?? {
        name: row.assignee.name,
        count: 0,
      };
      employeeEntry.count += 1;
      entry.usedByEmployee.set(row.assignee.id, employeeEntry);
    }
    assignedByType.set(row.ticketTypeId, entry);
  }

  const employeeCountByDepartment = new Map(
    employeeGroups.map((row) => [row.departmentId, row._count._all]),
  );
  const sheetCountByDepartment = new Map(
    sheetGroups.map((row) => [row.departmentId, row._count._all]),
  );

  return {
    ticketTypes: ticketTypes.map((type) => {
      const count = byTicketType.get(type.id) ?? { issued: 0, used: 0, unused: 0, revoked: 0 };
      return {
        id: type.id,
        code: type.code,
        name: type.name,
        weightPercent: type.weightPercent,
        issued: count.issued,
        used: count.used,
        unused: count.unused,
        revoked: count.revoked,
      };
    }),
    totals: { ...totals, sheets },
    tickets: ticketTypes.map((type) => {
      const entry = assignedByType.get(type.id);
      return {
        ticketTypeId: type.id,
        code: type.code,
        name: type.name,
        assignedCount: entry?.assigned ?? 0,
        usedByAssignee: [...(entry?.usedByEmployee.entries() ?? [])].map(
          ([employeeId, item]) => ({
            employeeId,
            employeeName: item.name,
            count: item.count,
          }),
        ),
      };
    }),
    departments: departments.map((department) => ({
      id: department.id,
      name: department.name,
      enabled: department.enabled,
      employeeCount: employeeCountByDepartment.get(department.id) ?? 0,
      sheetCount: sheetCountByDepartment.get(department.id) ?? 0,
    })),
    voteWindow: { ...evaluateVoteWindow(session), status: session.status },
    generatedAt: new Date().toISOString(),
  };
}
