/**
 * 计分算法。纯函数、无 I/O，便于独立测试与日后替换口径。
 *
 * 口径（见设计文档第 13 节）：
 *
 * 1) 票种加权，按【实际收到票的票种】归一化：
 *
 *      某职工在某项点 d 的得分
 *        = Σ_t(该票种在 d 上的均分 × 票种权重%) / Σ_t(票种权重%)
 *
 *    t 遍历在该单元格上真正有票的票种。不归一化时，某部门未收到 A 票会让
 *    那部分权重按 0 计入，把全体分数整体压低，而现实中无法保证每部门各票种都有票。
 *
 * 2) 项点间汇总：各项满分可能不同（一项 100、一项 10），原始分不能直接相加，
 *    否则低分制项点在总分里几乎无足轻重。所以先按各自区间归一化到百分制，
 *    再取等权平均作为综合得分。
 */

export interface ScoringCriterion {
  id: string;
  minScore: number;
  maxScore: number;
}

export interface ScoringTicketType {
  id: string;
  weightPercent: number;
}

export interface ScoringItem {
  employeeId: string;
  criterionId: string;
  score: number;
}

export interface ScoringSheet {
  ticketTypeId: string;
  items: ScoringItem[];
}

export interface ScoringInput {
  employeeIds: string[];
  criteria: ScoringCriterion[];
  ticketTypes: ScoringTicketType[];
  sheets: ScoringSheet[];
}

export interface CriterionResult {
  criterionId: string;
  /** 票种加权后的原始分（仍在该项点的 min/max 区间内） */
  rawScore: number;
  /** 归一化到 0-100 的分数 */
  normalizedScore: number;
  /** 本单元格实际参与计算的票种 ID，用于结果页标注口径 */
  participatingTicketTypeIds: string[];
}

export interface EmployeeResult {
  employeeId: string;
  /** 综合得分：各项归一化分的等权平均；无任何有效评分时为 0 */
  comprehensiveScore: number;
  criteria: CriterionResult[];
}

export interface ScoringResult {
  employees: EmployeeResult[];
  /** 本次计算中真正贡献了分数的票种 */
  ticketTypesInvolved: string[];
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 把原始分按项点区间归一化到 0-100 并夹紧。
 * `max <= min` 属于非法配置（没有打分空间），服务层在写入项点时会拒绝；
 * 此处仍做防御，返回 100 而非除零，避免整张报表变成 NaN。
 */
function normalizeScore(raw: number, min: number, max: number): number {
  if (max <= min) return 100;
  const ratio = ((raw - min) / (max - min)) * 100;
  return Math.min(100, Math.max(0, ratio));
}

/**
 * 计算全部职工的成绩。
 *
 * 复杂度 O(票种数 × 表数 × 单元格数) 的线性遍历：先把评分按
 * `票种 → (职工|项点) → 分数列表` 建索引，再逐格聚合，
 * 不做嵌套扫描。
 *
 * @param input 职工、项点、票种与已提交的打分表
 * @returns 每位职工的各项结果与综合得分
 */
export function computeResults(input: ScoringInput): ScoringResult {
  const { employeeIds, criteria, ticketTypes, sheets } = input;

  // 票种 → 单元格键 → 分数列表
  const cellsByTicketType = new Map<string, Map<string, number[]>>();
  for (const sheet of sheets) {
    let cells = cellsByTicketType.get(sheet.ticketTypeId);
    if (!cells) {
      cells = new Map<string, number[]>();
      cellsByTicketType.set(sheet.ticketTypeId, cells);
    }
    for (const item of sheet.items) {
      const key = `${item.employeeId}|${item.criterionId}`;
      const existing = cells.get(key);
      if (existing) existing.push(item.score);
      else cells.set(key, [item.score]);
    }
  }

  const weightByTicketType = new Map(ticketTypes.map((t) => [t.id, t.weightPercent]));
  const involved = new Set<string>();

  const employees: EmployeeResult[] = employeeIds.map((employeeId) => {
    const criterionResults: CriterionResult[] = [];

    for (const criterion of criteria) {
      const key = `${employeeId}|${criterion.id}`;

      let weightedSum = 0;
      let weightTotal = 0;
      const participants: string[] = [];

      for (const [ticketTypeId, cells] of cellsByTicketType) {
        const scores = cells.get(key);
        if (!scores || scores.length === 0) continue;

        const weight = weightByTicketType.get(ticketTypeId);
        if (weight === undefined || weight <= 0) continue;

        weightedSum += average(scores) * weight;
        weightTotal += weight;
        participants.push(ticketTypeId);
      }

      // 该单元格没有任何票：跳过。它不参与综合得分，也不会变成 0 分拉低此人。
      if (weightTotal === 0) continue;

      const rawScore = weightedSum / weightTotal;
      for (const participant of participants) involved.add(participant);

      criterionResults.push({
        criterionId: criterion.id,
        rawScore: round2(rawScore),
        normalizedScore: round2(normalizeScore(rawScore, criterion.minScore, criterion.maxScore)),
        participatingTicketTypeIds: participants,
      });
    }

    const comprehensiveScore =
      criterionResults.length === 0
        ? 0
        : round2(average(criterionResults.map((c) => c.normalizedScore)));

    return { employeeId, comprehensiveScore, criteria: criterionResults };
  });

  return { employees, ticketTypesInvolved: [...involved] };
}