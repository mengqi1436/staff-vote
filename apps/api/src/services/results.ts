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
import { findTemplate } from './questionnaireTemplateStore.js';

export interface ResultCriterionScore {
  criterionId: string;
  criterionName: string;
  rawScore: number;
  normalizedScore: number;
  participatingTicketTypeIds: string[];
}

export interface ResultRow {
  rank: number;
  /** 车间问卷唯一一格虚拟「得分」列为 null */
  voteColumnId: string | null;
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
  /** 票别口径明细（名称已填好），导出「票别单项明细 / 票别合计明细」sheet 用 */
  perTicketType: {
    criteriaRows: Array<{
      ticketTypeCode: string;
      voteColumnName: string;
      criterionName: string;
      avg: number;
    }>;
    columnRows: Array<{ ticketTypeCode: string; voteColumnName: string; average: number }>;
  };
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

  const isWorkshop = department.questionnaireType === 'workshop';

  const [voteColumns, templateCriteria, legacyCriteria, ticketTypes, sheets] = await Promise.all([
    // 车间问卷没有被评列（0010）：只有一格虚拟「得分」列，计分时以 null 表示。
    isWorkshop
      ? Promise.resolve([])
      : prisma.voteColumn.findMany({
          where: { departmentId },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        }),
    // 现行配置 = 场次模板项点；历史 sheet 可能引用 0010 前的部门项点，一并并入
    // 结果口径（模板项点在前），保证旧答卷的分数仍能落在对应项点上。
    prisma.criterion.findMany({
      where: {
        sessionId: department.sessionId,
        departmentId: null,
        templateType: department.questionnaireType,
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.criterion.findMany({
      where: { departmentId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    // 票种按部门所属场次过滤：多场次下别的场次的票种与本部门结果无关。
    prisma.ticketType.findMany({
      where: { sessionId: department.sessionId },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    }),
    prisma.scoreSheet.findMany({ where: { departmentId }, include: { items: true } }),
  ]);

  // 去重合并：模板项点优先；部门旧项点只在 id 不重复时追加。
  const criteria = [...templateCriteria, ...legacyCriteria.filter((c) => !templateCriteria.some((t) => t.id === c.id))];

  const scoring = computeResults({
    // 车间问卷传唯一一格虚拟列（null）；person 传部门被评列。
    voteColumnIds: isWorkshop ? [null] : voteColumns.map((column) => column.id),
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

  // 车间问卷的虚拟「得分」列没有 VoteColumn 行：null 一律显示为「得分」。
  const columnMetaOf = (voteColumnId: string | null) =>
    voteColumnId === null
      ? { name: '得分', enabled: true }
      : columnById.get(voteColumnId) ?? { name: '', enabled: false };

  // 排名：综合得分降序，同分并列（1、2、2、4 式），同分内按列名稳定排序。
  const sorted = [...scoring.voteColumns].sort((a, b) => {
    if (b.comprehensiveScore !== a.comprehensiveScore) return b.comprehensiveScore - a.comprehensiveScore;
    const nameA = columnMetaOf(a.voteColumnId).name;
    const nameB = columnMetaOf(b.voteColumnId).name;
    return nameA.localeCompare(nameB, 'zh-CN');
  });

  let rank = 0;
  let previousScore: number | null = null;
  const rows: ResultRow[] = sorted.map((column, index) => {
    if (previousScore === null || column.comprehensiveScore !== previousScore) {
      rank = index + 1;
      previousScore = column.comprehensiveScore;
    }
    const meta = columnMetaOf(column.voteColumnId);
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

  // 票别口径展开成带名称的行：单项（票种×被评对象×项点）与合计（票种×被评对象）。
  const perTicketType = {
    criteriaRows: scoring.perTicketType.flatMap((ticketType) =>
      ticketType.voteColumns.flatMap((column) =>
        column.criteria.map((criterion) => ({
          ticketTypeCode: codeOf(ticketType.ticketTypeId),
          voteColumnName: columnMetaOf(column.voteColumnId).name,
          criterionName: criterionById.get(criterion.criterionId)?.name ?? '',
          avg: criterion.avg,
        })),
      ),
    ),
    columnRows: scoring.perTicketType.flatMap((ticketType) =>
      ticketType.voteColumns.map((column) => ({
        ticketTypeCode: codeOf(ticketType.ticketTypeId),
        voteColumnName: columnMetaOf(column.voteColumnId).name,
        average: column.average,
      })),
    ),
  };

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
    perTicketType,
  };
}

// -----------------------------------------------------------------------------
// 按随机码导出答卷（受控映射的唯二读取方之一，两处导出都在 results.export 门内）
// -----------------------------------------------------------------------------

/** 单码答卷导出的数据（附件8 形态：行 = 项点，列 = 被评列，格 = 分数）。 */
export interface TicketAnswerExport {
  headerNote: string;
  /** 表标题（其中「xx」已替换为部门名） */
  title: string;
  footerNote: string;
  departmentName: string;
  /** 被评列名，按 sortOrder 排列（含停用列：历史答卷里可能有分） */
  columnNames: string[];
  /** 每行 = [项点名(含描述), ...各被评列分数（缺格空串）] */
  rows: Array<Array<string | number>>;
  submittedAt: Date;
  /** 票别标签：如「A（领导评议）」 */
  ticketTypeLabel: string;
}

/**
 * 取某随机码的答卷（导出附件8 形态用）。
 *
 * 校验顺序：码存在（404）→ 码已使用（unused/revoked 均 409，无答卷可导）→
 * 有受控映射且有答卷（404 TICKET_NO_SHEET）。历史答卷可能没有映射（功能上线前
 * 提交的），同样按「无答卷可导」处理。
 *
 * 项点与被评列**不筛 enabled**：停用的行/列在答卷里可能有分，导出要忠实还原提交时的表。
 */
export async function loadTicketAnswerExport(ticketId: string): Promise<TicketAnswerExport> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: { ticketType: { select: { code: true, name: true } } },
  });
  if (!ticket) throw ApiError.notFound('随机码不存在');
  if (ticket.status === 'unused') {
    throw ApiError.conflict('该随机码尚未使用，还没有答卷可导出', 'TICKET_NOT_USED');
  }
  if (ticket.status === 'revoked') {
    throw ApiError.conflict('该随机码已作废，不能导出答卷', 'TICKET_REVOKED');
  }

  const sheet = await prisma.scoreSheet.findFirst({
    where: { ticketMap: { ticketId } },
    include: { items: true },
  });
  if (!sheet) throw ApiError.notFound('未找到该随机码的答卷', 'TICKET_NO_SHEET');

  const department = await prisma.department.findUnique({ where: { id: sheet.departmentId } });
  if (!department) throw ApiError.notFound('答卷所属部门不存在');

  const isWorkshop = department.questionnaireType === 'workshop';

  // 附件号/标题/说明的真源在 0010 起的场次模板表；行缺失（迁移前的老场次）退回默认文案。
  // 该表的 Prisma 编译有 bug（P2022），读写一律走原生 SQL 封装 questionnaireTemplateStore。
  const template = await findTemplate(prisma, sheet.sessionId, department.questionnaireType);

  const [criteria, voteColumns] = await Promise.all([
    // 与结果页同一口径：模板项点优先，历史答卷引用的部门旧项点并入尾部。
    prisma.criterion.findMany({
      where: {
        sessionId: sheet.sessionId,
        departmentId: null,
        templateType: department.questionnaireType,
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    }),
    // 车间问卷没有被评列；导出形态是一列「得分」。
    prisma.voteColumn.findMany({
      where: { departmentId: sheet.departmentId },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    }),
  ]);
  const allCriteria = [
    ...criteria,
    ...(await prisma.criterion
      .findMany({
        where: { departmentId: sheet.departmentId },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      })
      .then((legacy) => legacy.filter((c) => !criteria.some((t) => t.id === c.id)))),
  ];

  const scoreAt = new Map(sheet.items.map((item) => [`${item.voteColumnId}|${item.criterionId}`, item.score]));
  const rows = allCriteria.map((criterion) => [
    criterion.description ? `${criterion.name}\n${criterion.description}` : criterion.name,
    // 车间问卷：唯一一格虚拟列（voteColumnId=null），键即 'null|<项点>'。
    ...(isWorkshop
      ? [scoreAt.get(`null|${criterion.id}`) ?? '']
      : voteColumns.map((column) => scoreAt.get(`${column.id}|${criterion.id}`) ?? '')),
  ]);

  return {
    headerNote: template?.headerNote ?? '附件1-1',
    title: (template?.title ?? '').replace('xx', department.name),
    footerNote: template?.footerNote ?? '',
    departmentName: department.name,
    columnNames: isWorkshop ? ['得分'] : voteColumns.map((column) => column.name),
    rows,
    submittedAt: sheet.submittedAt,
    ticketTypeLabel: `${ticket.ticketType.code}（${ticket.ticketType.name}）`,
  };
}

/** 整场导出中「答卷汇总」sheet 的一行。 */
export interface SessionAnswerSummaryRow {
  /** 提交时间升序的序号，从 1 起 */
  seq: number;
  /** 受控映射带出的随机码；无映射的历史答卷为空串 */
  code: string;
  submittedAt: Date;
  ticketTypeCode: string;
  /** 各「被评列 × 项点」格子的分数，与 summaryColumns 一一对应（缺格空串） */
  scores: Array<number | string>;
}

/** 整场导出的汇总列：一列一个「被评列 × 项点」组合。 */
export interface SessionAnswerSummaryColumn {
  header: string;
}

export interface SessionAnswerSummary {
  columns: SessionAnswerSummaryColumn[];
  rows: SessionAnswerSummaryRow[];
}

/**
 * 取整场导出的答卷汇总数据。
 *
 * 行 = 该场次的全部答卷（提交时间升序），经 sheet_ticket_map join 带出随机码；
 * 无映射的历史答卷也一并包含（code 留空）。列 = 本场次（含历史停用部门）的
 * 全部「被评列 × 项点」组合，跨部门的列互不填数。
 */
export async function loadSessionAnswerSummary(sessionId: string): Promise<SessionAnswerSummary> {
  const [sheets, columns, departments] = await Promise.all([
    prisma.scoreSheet.findMany({
      where: { sessionId },
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      include: {
        ticketType: { select: { code: true } },
        ticketMap: { include: { ticket: { select: { code: true } } } },
        items: true,
      },
    }),
    prisma.voteColumn.findMany({
      where: { sessionId },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      include: {
        department: { select: { sortOrder: true, name: true, questionnaireType: true } },
      },
    }),
    // 车间问卷没有被评列：为每个车间部门补一列虚拟「得分」。
    prisma.department.findMany({
      where: { sessionId, enabled: true, questionnaireType: 'workshop' },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
  ]);

  const criteria = await prisma.criterion.findMany({
    where: { sessionId },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });

  // 列序：部门（sortOrder）→ 被评列（sortOrder）→ 项点（sortOrder）。
  // 被评列的 sortOrder 只在部门内有意义，跨部门先按部门的 sortOrder 分组排序。
  const sortedColumns = [...columns].sort((a, b) => {
    const deptDiff = a.department.sortOrder - b.department.sortOrder;
    if (deptDiff !== 0) return deptDiff;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.id < b.id ? -1 : 1;
  });
  // 0010 起项点在模板层（departmentId 为空），按 templateType 对应部门类型；
  // 0010 前的部门旧项点（departmentId=部门）按原部门对应到该部门的列（历史评分可读）。
  const templateCriteriaByType = new Map<string, typeof criteria>();
  const legacyCriteriaByDepartment = new Map<string, typeof criteria>();
  for (const criterion of criteria) {
    if (criterion.departmentId === null && criterion.templateType !== null) {
      const list = templateCriteriaByType.get(criterion.templateType) ?? [];
      list.push(criterion);
      templateCriteriaByType.set(criterion.templateType, list);
    } else if (criterion.departmentId !== null) {
      const list = legacyCriteriaByDepartment.get(criterion.departmentId) ?? [];
      list.push(criterion);
      legacyCriteriaByDepartment.set(criterion.departmentId, list);
    }
  }
  const orderedColumns: SessionAnswerSummaryColumn[] = [];
  const columnKeyByOrder: string[] = [];
  for (const column of sortedColumns) {
    const departmentCriteria = [
      ...(legacyCriteriaByDepartment.get(column.departmentId) ?? []),
      ...(templateCriteriaByType.get(column.department.questionnaireType) ?? []),
    ];
    for (const criterion of departmentCriteria) {
      orderedColumns.push({ header: `${column.department.name}-${column.name}-${criterion.name}` });
      columnKeyByOrder.push(`${column.id}|${criterion.id}`);
    }
  }
  // 车间部门的虚拟「得分」列：分数格没有 vote_column_id（null），
  // 键加部门前缀避免多个车间部门的 'null|项点' 互相串格。
  for (const department of departments) {
    for (const criterion of templateCriteriaByType.get('workshop') ?? []) {
      orderedColumns.push({ header: `${department.name}-得分-${criterion.name}` });
      columnKeyByOrder.push(`${department.id}|null|${criterion.id}`);
    }
  }

  const rows = sheets.map((sheet, index) => {
    const scoreAt = new Map(
      sheet.items.map((item) => [
        item.voteColumnId === null
          ? `${sheet.departmentId}|null|${item.criterionId}`
          : `${item.voteColumnId}|${item.criterionId}`,
        item.score,
      ]),
    );
    return {
      seq: index + 1,
      code: sheet.ticketMap?.ticket.code ?? '',
      submittedAt: sheet.submittedAt,
      ticketTypeCode: sheet.ticketType.code,
      scores: columnKeyByOrder.map((key) => scoreAt.get(key) ?? ''),
    };
  });

  return { columns: orderedColumns, rows };
}