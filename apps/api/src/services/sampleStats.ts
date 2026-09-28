/**
 * 「统计」页签的参考样表口径统计（docs/附件文件包/参考样表.xlsx）。
 *
 * 样表形态：行 = 被评对象 × 票别（A / B / C / ABC汇总），列 = 各项点得分 +
 * 「1-5合计」+ 综合评价得分 + 综合评价得分排序。两张表：
 *   - 个人问卷表：行 = person 部门的被评列（主任、党支部书记…）× 票别；
 *   - 车间问卷表：行 = workshop 部门（车间本身即被评对象）× 票别。
 *
 * **计分口径只有一份**：全部数值来自 lib/scoring.ts 的 computeResults ——
 *   - 单票别行的项点得分 = 该票别对被评对象在该项点的均分（弃权/不填计 0）；
 *   - 单票别行的综合评价得分 = 该票别各项点均分的等权平均（scoring 的票别口径）；
 *   - ABC汇总行的项点得分 = 票种加权后的原始分；综合评价得分 = 加权归一化等权平均
 *     （与「结果导出」完全一致）；
 *   - 「1-5合计」= 各项点得分之和（样表口径；项点满分不一致时此列仅作参考，
 *     以综合评价得分为准 —— 与 scoring.ts 的口径说明一致）。
 *
 * 排名（样表「综合评价得分排序」）：综合得分降序、同分并列（1、2、2 式）。
 *   - 个人表：部门 × 票别组内排名（被评对象之间比）；
 *   - 车间表：票别组内排名（车间之间比，样表表2即一张表内多车间）。
 *
 * 全部数据一次取回、内存分组，每部门调一次纯函数 computeResults，无 N+1。
 * 没有任何已提交打分表的部门不产生行（样表只统计「已提交的表单」）。
 */
import { computeResults } from '../lib/scoring.js';
import { prisma } from '../db.js';

/** 参考样表统计的行：被评对象 × 票别。 */
export interface SampleStatRow {
  departmentId: string;
  departmentName: string;
  /** 被评列 ID：同名被评列（如两个「副主任」）也各自唯一，前端 rowKey 依赖；车间虚拟得分列为 null */
  voteColumnId: string | null;
  /** 被评对象：个人表为被评列名（主任…），车间表为车间名（部门自身） */
  targetName: string;
  /** 票种 ID；ABC汇总行为 null */
  ticketTypeId: string | null;
  /** 票别显示：A / B / C / 「ABC汇总」 */
  ticketCode: string;
  /** 各项点得分，顺序与 criteriaNames 对齐 */
  scores: number[];
  /** 1-5合计：各项点得分之和 */
  total: number;
  /** 综合评价得分 */
  comprehensiveScore: number;
  /** 综合评价得分排序（组内同分并列） */
  rank: number;
}

export interface SampleStatTable {
  /** 项点列名（取该类型下第一个产出行的部门的项点顺序） */
  criteriaNames: string[];
  rows: SampleStatRow[];
}

export interface SessionSampleStatsDto {
  /** 个人问卷表（person 部门：车间负责人评价） */
  personal: SampleStatTable;
  /** 车间问卷表（workshop 部门：车间评价） */
  workshop: SampleStatTable;
  /** 已提交打分表总数 */
  sheetCount: number;
  generatedAt: string;
}

/** ABC汇总行的票种占位键。 */
const SUMMARY_KEY = 'SUMMARY';
const SUMMARY_CODE = 'ABC汇总';

/** 同分并列排名：综合得分降序，1、2、2、4 式。 */
function assignRanks(rows: SampleStatRow[]): void {
  const sorted = [...rows].sort((a, b) => {
    if (b.comprehensiveScore !== a.comprehensiveScore) return b.comprehensiveScore - a.comprehensiveScore;
    if (a.departmentName !== b.departmentName) return a.departmentName.localeCompare(b.departmentName, 'zh-CN');
    return a.targetName.localeCompare(b.targetName, 'zh-CN');
  });
  let rank = 0;
  let previous: number | null = null;
  for (const [index, row] of sorted.entries()) {
    if (previous === null || row.comprehensiveScore !== previous) {
      rank = index + 1;
      previous = row.comprehensiveScore;
    }
    row.rank = rank;
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 票别显示码：有票种 ID 用其代码，汇总行用「ABC汇总」。 */
function codeOf(ticketTypeId: string | null, codeById: Map<string, string>): string {
  if (ticketTypeId === null) return SUMMARY_CODE;
  return codeById.get(ticketTypeId) ?? ticketTypeId;
}

/** 汇总一场次的参考样表统计。 */
export async function computeSessionSampleStats(sessionId: string): Promise<SessionSampleStatsDto> {
  const [departments, ticketTypes, sheets] = await Promise.all([
    prisma.department.findMany({
      where: { sessionId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.ticketType.findMany({
      where: { sessionId },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    }),
    prisma.scoreSheet.findMany({
      where: { sessionId },
      select: {
        departmentId: true,
        ticketTypeId: true,
        items: { select: { voteColumnId: true, criterionId: true, score: true } },
      },
    }),
  ]);

  const departmentIds = departments.map((department) => department.id);
  const [criteria, voteColumns] = await Promise.all([
    // 模板项点（departmentId=null，0010 起现行配置）+ 部门旧项点（历史答卷引用）都要。
    prisma.criterion.findMany({
      where: {
        OR: [{ departmentId: { in: departmentIds } }, { sessionId, departmentId: null }],
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.voteColumn.findMany({
      where: { departmentId: { in: departmentIds } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
  ]);

  const codeById = new Map(ticketTypes.map((type) => [type.id, type.code]));
  // Map 键允许 null：模板项点 departmentId 为 null，只按 templateType 归类。
  const criteriaByDepartment = new Map<string | null, typeof criteria>();
  const criteriaByTemplateType = new Map<string, typeof criteria>();
  for (const criterion of criteria) {
    const list = criteriaByDepartment.get(criterion.departmentId);
    if (list) list.push(criterion);
    else criteriaByDepartment.set(criterion.departmentId, [criterion]);
    if (criterion.templateType !== null) {
      const typed = criteriaByTemplateType.get(criterion.templateType);
      if (typed) typed.push(criterion);
      else criteriaByTemplateType.set(criterion.templateType, [criterion]);
    }
  }
  const columnsByDepartment = new Map<string, typeof voteColumns>();
  for (const column of voteColumns) {
    const list = columnsByDepartment.get(column.departmentId);
    if (list) list.push(column);
    else columnsByDepartment.set(column.departmentId, [column]);
  }
  const sheetsByDepartment = new Map<string, typeof sheets>();
  for (const sheet of sheets) {
    const list = sheetsByDepartment.get(sheet.departmentId);
    if (list) list.push(sheet);
    else sheetsByDepartment.set(sheet.departmentId, [sheet]);
  }

  // 项点列名：取该类型下第一个产出行部门的项点顺序（同类部门问卷模板一致）。
  const criteriaNames = { personal: [] as string[], workshop: [] as string[] };
  const rawRows = { personal: [] as SampleStatRow[], workshop: [] as SampleStatRow[] };

  for (const department of departments) {
    const departmentSheets = sheetsByDepartment.get(department.id);
    const isWorkshop = department.questionnaireType === 'workshop';
    // 现行口径 = 该类型的模板项点；历史答卷引用的部门旧项点并入尾部（去重）。
    const templateCriteria = criteriaByTemplateType.get(department.questionnaireType) ?? [];
    const legacyCriteria = criteriaByDepartment.get(department.id) ?? [];
    const mergedCriteria = [
      ...templateCriteria,
      ...legacyCriteria.filter((c) => !templateCriteria.some((t) => t.id === c.id)),
    ];
    // 车间问卷没有被评列：以唯一一格虚拟「得分」列（null）参与计分。
    const departmentColumns = isWorkshop ? [] : (columnsByDepartment.get(department.id) ?? []);
    if (!departmentSheets?.length || !mergedCriteria.length) continue;
    if (!isWorkshop && departmentColumns.length === 0) continue;

    const bucket = isWorkshop ? rawRows.workshop : rawRows.personal;
    if (criteriaNames[isWorkshop ? 'workshop' : 'personal'].length === 0) {
      criteriaNames[isWorkshop ? 'workshop' : 'personal'] = mergedCriteria.map((c) => c.name);
    }

    const scoring = computeResults({
      voteColumnIds: isWorkshop ? [null] : departmentColumns.map((column) => column.id),
      criteria: mergedCriteria.map((c) => ({ id: c.id, minScore: c.minScore, maxScore: c.maxScore })),
      ticketTypes: ticketTypes.map((type) => ({ id: type.id, weightPercent: type.weightPercent })),
      sheets: departmentSheets.map((sheet) => ({
        ticketTypeId: sheet.ticketTypeId,
        items: sheet.items.map((item) => ({
          voteColumnId: item.voteColumnId,
          criterionId: item.criterionId,
          score: item.score,
        })),
      })),
    });

    const criterionOrder = new Map(mergedCriteria.map((c, index) => [c.id, index]));
    // 车间问卷的虚拟「得分」列没有 VoteColumn 行：null 显示为「得分」。
    const columnById = new Map(departmentColumns.map((column) => [column.id, column]));
    const columnNameOf = (voteColumnId: string | null) =>
      voteColumnId === null ? '得分' : (columnById.get(voteColumnId)?.name ?? '');

    // scoring 对「无票的列」也会填 0 分条目（criteria 非空），无法靠其判别有无票；
    // 用原始 items 统计 (票别, 被评列) 是否真有打分记录：无票 ≠ 0 分，样表只列有票
    // 的对象，否则全 0 行会挤占排序名次、误导阅读。
    const scoredKeys = new Set<string>();
    for (const sheet of departmentSheets) {
      for (const item of sheet.items) scoredKeys.add(`${sheet.ticketTypeId}|${item.voteColumnId}`);
    }

    // 票别行：perTicketType 已排除零票种（一张表都没有的票种不出现）；
    // 该票别下一张表都没打过的被评列不产生行。
    for (const ticketTypeResult of scoring.perTicketType) {
      for (const column of ticketTypeResult.voteColumns) {
        if (!scoredKeys.has(`${ticketTypeResult.ticketTypeId}|${column.voteColumnId}`)) continue;
        const ordered = [...column.criteria].sort(
          (a, b) => (criterionOrder.get(a.criterionId) ?? 0) - (criterionOrder.get(b.criterionId) ?? 0),
        );
        const scores = ordered.map((c) => c.avg);
        bucket.push({
          departmentId: department.id,
          departmentName: department.name,
          voteColumnId: column.voteColumnId,
          targetName: columnNameOf(column.voteColumnId),
          ticketTypeId: ticketTypeResult.ticketTypeId,
          ticketCode: codeOf(ticketTypeResult.ticketTypeId, codeById),
          scores,
          total: round2(scores.reduce((sum, value) => sum + value, 0)),
          comprehensiveScore: column.average,
          rank: 0,
        });
      }
    }

    // ABC汇总行：票种加权口径（与「结果导出」一致）；任一票别都没打过的列不出现。
    const scoredColumns = new Set([...scoredKeys].map((key) => key.split('|')[1]));
    for (const column of scoring.voteColumns) {
      // 模板串把 null（车间虚拟列）字符串化成 'null'，与 scoredKeys 的键格式保持一致
      if (!scoredColumns.has(`${column.voteColumnId}`)) continue;
      const ordered = [...column.criteria].sort(
        (a, b) => (criterionOrder.get(a.criterionId) ?? 0) - (criterionOrder.get(b.criterionId) ?? 0),
      );
      const scores = ordered.map((c) => c.rawScore);
      bucket.push({
        departmentId: department.id,
        departmentName: department.name,
        voteColumnId: column.voteColumnId,
        targetName: columnNameOf(column.voteColumnId),
        ticketTypeId: null,
        ticketCode: SUMMARY_CODE,
        scores,
        total: round2(scores.reduce((sum, value) => sum + value, 0)),
        comprehensiveScore: column.comprehensiveScore,
        rank: 0,
      });
    }
  }

  // 排名：个人表在「部门 × 票别」组内比被评对象；车间表在「票别」组内比车间。
  const rankRows = (rows: SampleStatRow[], groupKey: (row: SampleStatRow) => string): void => {
    const groups = new Map<string, SampleStatRow[]>();
    for (const row of rows) {
      const key = groupKey(row);
      const list = groups.get(key);
      if (list) list.push(row);
      else groups.set(key, [row]);
    }
    for (const group of groups.values()) assignRanks(group);
  };
  rankRows(rawRows.personal, (row) => `${row.departmentId}|${row.ticketTypeId ?? SUMMARY_KEY}`);
  rankRows(rawRows.workshop, (row) => row.ticketTypeId ?? SUMMARY_KEY);

  // 输出顺序：部门（sortOrder）→ 被评对象 → 票别（票种顺序在前、ABC汇总在后）。
  const typeOrder = new Map(ticketTypes.map((type, index) => [type.id, index]));
  const sortRows = (rows: SampleStatRow[]): SampleStatRow[] =>
    rows.sort((a, b) => {
      if (a.departmentId !== b.departmentId) {
        const deptA = departments.findIndex((d) => d.id === a.departmentId);
        const deptB = departments.findIndex((d) => d.id === b.departmentId);
        return deptA - deptB;
      }
      if (a.targetName !== b.targetName) return a.targetName.localeCompare(b.targetName, 'zh-CN');
      const orderA = a.ticketTypeId === null ? Number.MAX_SAFE_INTEGER : (typeOrder.get(a.ticketTypeId) ?? 0);
      const orderB = b.ticketTypeId === null ? Number.MAX_SAFE_INTEGER : (typeOrder.get(b.ticketTypeId) ?? 0);
      return orderA - orderB;
    });

  return {
    personal: { criteriaNames: criteriaNames.personal, rows: sortRows(rawRows.personal) },
    workshop: { criteriaNames: criteriaNames.workshop, rows: sortRows(rawRows.workshop) },
    sheetCount: sheets.length,
    generatedAt: new Date().toISOString(),
  };
}
