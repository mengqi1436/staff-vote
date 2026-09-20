/**
 * 后台统计。
 *
 * 口径说明（与设计文档第 12.2 / 15 节一致）：
 *   - ticketTypes[].issued / used / unused / revoked：按随机码状态计数，合计即该票种发放量；
 *   - totals：全部票种的合计 + 已提交打分表数（sheets）；
 *   - departments[].employeeCount：该部门**启用**职工数（软删除的职工不再计入在册人数）；
 *   - departments[].sheetCount：该部门已提交的打分表数（软删除不影响历史数据）。
 *
 * 全部计数用一次 groupBy 拿到，不做「每行一次 count」的循环查询。
 */
import { prisma } from '../db.js';
import { evaluateVoteWindow, toSettingMap, type VoteWindowState } from '../lib/settings.js';

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

export interface StatsDepartmentRow {
  id: string;
  name: string;
  enabled: boolean;
  employeeCount: number;
  sheetCount: number;
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
  departments: StatsDepartmentRow[];
  voteWindow: VoteWindowState;
  generatedAt: string;
}

/** 汇总票种发放/使用情况 + 部门进度 + 当前投票窗口。 */
export async function getStatsOverview(): Promise<StatsOverviewDto> {
  const [ticketTypes, ticketGroups, sheets, departments, employeeGroups, sheetGroups, settingRows] =
    await Promise.all([
      prisma.ticketType.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] }),
      prisma.ticket.groupBy({ by: ['ticketTypeId', 'status'], _count: { _all: true } }),
      prisma.scoreSheet.count(),
      prisma.department.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      prisma.employee.groupBy({
        by: ['departmentId'],
        where: { enabled: true },
        _count: { _all: true },
      }),
      prisma.scoreSheet.groupBy({ by: ['departmentId'], _count: { _all: true } }),
      prisma.setting.findMany(),
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
    departments: departments.map((department) => ({
      id: department.id,
      name: department.name,
      enabled: department.enabled,
      employeeCount: employeeCountByDepartment.get(department.id) ?? 0,
      sheetCount: sheetCountByDepartment.get(department.id) ?? 0,
    })),
    voteWindow: evaluateVoteWindow(toSettingMap(settingRows)),
    generatedAt: new Date().toISOString(),
  };
}