/**
 * 计分算法。纯函数、无 I/O，便于独立测试与日后替换口径。
 *
 * 口径（参考表口径 + 设计文档第 13 节）：
 *
 * 1) 票种加权，按【实际收到票的票种】归一化：
 *
 *      某被评列在某项点 d 的得分
 *        = Σ_t(该票种在 d 上的均分 × 票种权重%) / Σ_t(票种权重%)
 *
 *    t 遍历在该单元格上真正有票的票种。不归一化时，某部门未收到 A 票会让
 *    那部分权重按 0 计入，把全体分数整体压低，而现实中无法保证每部门各票种都有票。
 *
 * 2) 弃权、不填视为 0 分（参考表填写说明的口径）：
 *    某票种只要在本部门有已提交的表，它的每一格都参与平均 —— 某张表缺某一格
 *    （项点后增、或者投票人跳过）即按 0 分计入，而不是把该格从分母里摘掉。
 *    这与「不填就不算」的旧口径相反，是参考表明确要求的：不填等于弃权弃分。
 *    该票种在本部门一张表都没有时仍然整票种跳过：那是没发这种票，不是弃权。
 *
 * 3) 项点间汇总：各项满分可能不同（一项 20、一项 100），原始分不能直接相加，
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
  voteColumnId: string;
  criterionId: string;
  score: number;
}

export interface ScoringSheet {
  ticketTypeId: string;
  items: ScoringItem[];
}

export interface ScoringInput {
  voteColumnIds: string[];
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

export interface VoteColumnResult {
  voteColumnId: string;
  /** 综合得分：各项归一化分的等权平均；无任何有效评分时为 0 */
  comprehensiveScore: number;
  criteria: CriterionResult[];
}

/** 单票别对单个项点格的平均分（缺格/弃权计 0，分母为该票种的表数）。 */
export interface TicketTypeCriterionAvg {
  criterionId: string;
  avg: number;
}

/** 单票别对单个被评列的结果：每格平均分 + 列内均分。 */
export interface TicketTypeColumnResult {
  voteColumnId: string;
  criteria: TicketTypeCriterionAvg[];
  /** 该票种对该被评列的均分：各格平均分的等权平均 */
  average: number;
}

/** 单票别的全部口径（统计四口径里的「票别 × 被评列 × 项点」与「票别 × 被评列」）。 */
export interface TicketTypeResult {
  ticketTypeId: string;
  voteColumns: TicketTypeColumnResult[];
}

export interface ScoringResult {
  voteColumns: VoteColumnResult[];
  /** 本次计算中真正贡献了分数的票种 */
  ticketTypesInvolved: string[];
  /** 每个有票票种的独立口径（零票种排除：一张表都没有的票种不出现） */
  perTicketType: TicketTypeResult[];
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
 * 计算全部被评列的成绩。
 *
 * 复杂度 O(票种数 × 表数 × 单元格数) 的线性遍历：先把评分按
 * `票种 → 表 → (被评列|项点) → 分数` 建索引，再逐格聚合，不做嵌套扫描。
 *
 * @param input 被评列、项点、票种与已提交的打分表
 * @returns 每个被评列的各项结果与综合得分
 */
export function computeResults(input: ScoringInput): ScoringResult {
  const { voteColumnIds, criteria, ticketTypes, sheets } = input;

  // 票种 → 该票种下每张表的「单元格 → 分数」索引。
  // 保留“每张表”这一层，是因为弃权/不填要按 0 分进入平均：分母是该票种的表数。
  const sheetsByTicketType = new Map<string, Array<Map<string, number>>>();
  for (const sheet of sheets) {
    const cells = new Map<string, number>();
    for (const item of sheet.items) {
      cells.set(`${item.voteColumnId}|${item.criterionId}`, item.score);
    }
    const list = sheetsByTicketType.get(sheet.ticketTypeId);
    if (list) list.push(cells);
    else sheetsByTicketType.set(sheet.ticketTypeId, [cells]);
  }

  const weightByTicketType = new Map(ticketTypes.map((t) => [t.id, t.weightPercent]));
  const involved = new Set<string>();

  const voteColumns: VoteColumnResult[] = voteColumnIds.map((voteColumnId) => {
    const criterionResults: CriterionResult[] = [];

    for (const criterion of criteria) {
      const key = `${voteColumnId}|${criterion.id}`;

      let weightedSum = 0;
      let weightTotal = 0;
      const participants: string[] = [];

      for (const [ticketTypeId, cellList] of sheetsByTicketType) {
        const weight = weightByTicketType.get(ticketTypeId);
        if (weight === undefined || weight <= 0) continue;

        // 弃权、不填视为 0 分：本票种的每一张表都参与本格，缺格按 0 计入分母。
        const cellAverage = average(cellList.map((cells) => cells.get(key) ?? 0));

        weightedSum += cellAverage * weight;
        weightTotal += weight;
        participants.push(ticketTypeId);
      }

      // 本部门一张表都没有：整格无成绩。它不参与综合得分，也不会变成 0 分。
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

    return { voteColumnId, comprehensiveScore, criteria: criterionResults };
  });

  // 票别口径：与加权结果相互独立。遍历 sheetsByTicketType 天然排除零票种
  // （一张表都没有的票种不建键）；权重为 0 但有票的票种仍参与本口径 ——
  // 「票别均分」回答的是该票别打了多少分，与加权无关。
  const perTicketType: TicketTypeResult[] = [...sheetsByTicketType.entries()].map(
    ([ticketTypeId, cellList]) => ({
      ticketTypeId,
      voteColumns: voteColumnIds.map((voteColumnId) => {
        const criteriaAvg = criteria.map((criterion) => ({
          criterionId: criterion.id,
          // 与加权口径同一规则：该票种的每一张表都参与本格，缺格按 0 计入分母。
          avg: round2(average(cellList.map((cells) => cells.get(`${voteColumnId}|${criterion.id}`) ?? 0))),
        }));
        return {
          voteColumnId,
          criteria: criteriaAvg,
          average: criteriaAvg.length === 0 ? 0 : round2(average(criteriaAvg.map((c) => c.avg))),
        };
      }),
    }),
  );

  return { voteColumns, ticketTypesInvolved: [...involved], perTicketType };
}