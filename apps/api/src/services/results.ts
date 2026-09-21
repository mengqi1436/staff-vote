/**
 * 结果与导出数据。
 *
 * **计分口径只有一份**：这里负责取数、组装与排名，真正的权重与归一化计算全部
 * 交给 `lib/scoring.ts` 的 computeResults。结果页与 Excel 导出共用同一次计算的
 * 输出，避免「页面一个数、导出另一个数」这类最难解释的差异。
 *
 * 维度是**被评列**（主任、党支部书记、车间得分…）而不是职工：参考表的打分对象是
 * 职务/车间，职工名单不参与打分（见 docs/参考表.xlsx 与 0003_questionnaire 迁移）。
 *
 * 软删除后的数据仍然参与统计：被停用的部门、被评列、项点、票种都不会从结果里
 * 消失，只有 `enabled` 标记变 false，保证历史成绩可读（设计文档第 15 节）。
 */
import { computeResults } from '../lib/scoring.js';
import { prisma } from '../db.js';
import { ApiError } from '../middleware/errorHandler.js';

export interface ResultCriterionScore {
  criterionId: string;
  criterionName: string;
  rawScore: number;
  normalizedScore: number;
  participatingTicketTypeIds: string[];
}

export interface ResultRow {
  rank: number;
  voteColumnId: string;
  voteColumnName: string;
  /** 被评列是否启用；停用的列仍出现在结果里，便于解释历史成绩 */
  enabled: boolean;
  comprehensiveScore: number;
  criteria: ResultCriterionScore[];
}

export interface ResultsDto {
  department: { id: string; name: string };
  criteria: Array<{
    id: string;
    name: string;
    minScore: number;
    maxScore: number;
    enabled: boolean;
  }>;
  rows: ResultRow[];
  ticketTypesInvolved: Array<{
    id: string;
    code: string;
    name: string;
    weightPercent: number;
  }>;
  sheetCount: number;
  generatedAt: string;
}

/** 结果页与导出共用的一次性计算结果。 */
export interface DepartmentResults {
  dto: ResultsDto;
  /** 各项明细（被评列 × 有成数据的项点），导出用 */
  details: Array<{
    voteColumnName: string;
    criterionName: string;
    rawScore: number;
    normalizedScore: number;
    ticketTypes: string[];
  }>;
  /** 全部票种 + 是否真正参与计分，导出「参与票种口径」sheet 用 */
  ticketTypes: Array<{ code: string; name: string; weightPercent: number; involved: boolean }>;
}

/**
 * 计算某部门的结果。
 *
 * @param departmentId 部门 ID
 * @throws ApiError 部门不存在时 404
 */
export async function computeDepartmentResults(departmentId: string): Promise<DepartmentResults> {
  const department = await prisma.department.findUnique({ where: { id: departmentId } });
  if (!department) throw ApiError.notFound('部门不存在');

  const [voteColumns, criteria, ticketTypes, sheets] = await Promise.all([
    prisma.voteColumn.findMany({
      where: { departmentId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.criterion.findMany({
      where: { departmentId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.ticketType.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] }),
    prisma.scoreSheet.findMany({ where: { departmentId }, include: { items: true } }),
  ]);

  const scoring = computeResults({
    voteColumnIds: voteColumns.map((column) => column.id),
    criteria: criteria.map((criterion) => ({
      id: criterion.id,
      minScore: criterion.minScore,
      maxScore: criterion.maxScore,
    })),
    ticketTypes: ticketTypes.map((type) => ({ id: type.id, weightPercent: type.weightPercent })),
    sheets: sheets.map((sheet) => ({
      ticketTypeId: sheet.ticketTypeId,
      items: sheet.items.map((item) => ({
        voteColumnId: item.voteColumnId,
        criterionId: item.criterionId,
        score: item.score,
      })),
    })),
  });

  const columnById = new Map(voteColumns.map((column) => [column.id, column]));
  const criterionById = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const ticketTypeById = new Map(ticketTypes.map((type) => [type.id, type]));

  // 排名：综合得分降序，同分并列（1、2、2、4 式），同分内按列名稳定排序。
  const sorted = [...scoring.voteColumns].sort((a, b) => {
    if (b.comprehensiveScore !== a.comprehensiveScore) return b.comprehensiveScore - a.comprehensiveScore;
    const nameA = columnById.get(a.voteColumnId)?.name ?? '';
    const nameB = columnById.get(b.voteColumnId)?.name ?? '';
    return nameA.localeCompare(nameB, 'zh-CN');
  });

  let rank = 0;
  let previousScore: number | null = null;
  const rows: ResultRow[] = sorted.map((column, index) => {
    if (previousScore === null || column.comprehensiveScore !== previousScore) {
      rank = index + 1;
      previousScore = column.comprehensiveScore;
    }
    const meta = columnById.get(column.voteColumnId);
    return {
      rank,
      voteColumnId: column.voteColumnId,
      voteColumnName: meta?.name ?? '',
      enabled: meta?.enabled ?? false,
      comprehensiveScore: column.comprehensiveScore,
      criteria: column.criteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        criterionName: criterionById.get(criterion.criterionId)?.name ?? '',
        rawScore: criterion.rawScore,
        normalizedScore: criterion.normalizedScore,
        participatingTicketTypeIds: criterion.participatingTicketTypeIds,
      })),
    };
  });

  const codeOf = (ticketTypeId: string): string =>
    ticketTypeById.get(ticketTypeId)?.code ?? ticketTypeId;

  const details = rows.flatMap((row) =>
    row.criteria.map((criterion) => ({
      voteColumnName: row.voteColumnName,
      criterionName: criterion.criterionName,
      rawScore: criterion.rawScore,
      normalizedScore: criterion.normalizedScore,
      ticketTypes: criterion.participatingTicketTypeIds.map(codeOf),
    })),
  );

  const involved = new Set(scoring.ticketTypesInvolved);
  return {
    dto: {
      department: { id: department.id, name: department.name },
      criteria: criteria.map((criterion) => ({
        id: criterion.id,
        name: criterion.name,
        minScore: criterion.minScore,
        maxScore: criterion.maxScore,
        enabled: criterion.enabled,
      })),
      rows,
      ticketTypesInvolved: ticketTypes
        .filter((type) => involved.has(type.id))
        .map((type) => ({
          id: type.id,
          code: type.code,
          name: type.name,
          weightPercent: type.weightPercent,
        })),
      sheetCount: sheets.length,
      generatedAt: new Date().toISOString(),
    },
    details,
    ticketTypes: ticketTypes.map((type) => ({
      code: type.code,
      name: type.name,
      weightPercent: type.weightPercent,
      involved: involved.has(type.id),
    })),
  };
}