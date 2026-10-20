/**
 * 计分算法。纯函数、无 I/O，便于独立测试与日后替换口径。
 *
 * 口径（参考表口径 + 设计文档第 13 节）：
 *
 * 1) 按【人员类别】分别统计，不跨类别合并、不加权：
 *    每个人员类别独立出一组结果，排名只在同一人员类别内有效。类别之间票数
 *    悬殊也不影响各自得分（没有「权重」，也没有合并总分）。
 *
 * 2) 弃权、不填视为 0 分（参考表填写说明的口径）：
 *    某人员类别只要在本部门有已提交的表，它的每一格都参与平均 —— 某张表缺某一格
 *    （项点后增、或者投票人跳过）即按 0 分计入，而不是把该格从分母里摘掉。
 *    这与「不填就不算」的旧口径相反，是参考表明确要求的：不填等于弃权弃分。
 *    该人员类别在本部门一张表都没有时整类别跳过：那是没发这类票，不是弃权。
 *
 * 3) 项点间汇总：各项满分可能不同（一项 20、一项 100），原始分不能直接相加，
 *    否则低分制项点在总分里几乎无足轻重。所以先按各自区间归一化到百分制，
 *    再取等权平均作为类别内综合得分。
 */

export interface ScoringCriterion {
  id: string;
  minScore: number;
  maxScore: number;
}

export interface ScoringItem {
  /** 被评议人列。null = 车间打分表的虚拟「得分」列（0010：车间表没有被评议人列）。 */
  voteColumnId: string | null;
  criterionId: string;
  score: number;
}

export interface ScoringSheet {
  ticketTypeId: string;
  items: ScoringItem[];
}

export interface ScoringInput {
  /** 被评议人列 ID 列表；车间打分表传 [null]（唯一一格虚拟「得分」列）。 */
  voteColumnIds: Array<string | null>;
  criteria: ScoringCriterion[];
  sheets: ScoringSheet[];
}

/** 单人员类别在单个被评议人列、单个评议项目上的结果。 */
export interface CriterionResult {
  criterionId: string;
  /** 该人员类别在本格的平均原始分（仍在该评议项目的 min/max 区间内） */
  rawScore: number;
  /** 归一化到 0-100 的分数 */
  normalizedScore: number;
  /** 本格真正参与计算的人员类别 ID，用于结果页标注说明 */
  participatingTicketTypeIds: string[];
}

/** 单人员类别对单个被评议人列的结果。 */
export interface VoteColumnResult {
  /** null = 车间打分表的虚拟「得分」列。 */
  voteColumnId: string | null;
  /** 类别内综合得分：各项归一化分的等权平均；无任何有效评分时为 0 */
  comprehensiveScore: number;
  criteria: CriterionResult[];
}

/** 单个人员类别的全部结果（原「人员类别说明」，现在是唯一结果口径）。 */
export interface TicketTypeResult {
  ticketTypeId: string;
  voteColumns: VoteColumnResult[];
}

export interface ScoringResult {
  /** 每个有票人员类别一组独立结果（零人员类别排除：一张表都没有的人员类别不出现） */
  perTicketType: TicketTypeResult[];
  /** 本次计算中真正有票的人员类别 */
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
 * 计算每个人员类别各自的成绩。
 *
 * 复杂度 O(票种数 × 表数 × 单元格数) 的线性遍历：先把评分按
 * `人员类别 → 表 → (被评议人列|评议项目) → 分数` 建索引，再逐格聚合，不做嵌套扫描。
 *
 * 注意：无票的被评议人列也会产出一组 0 分条目（本函数不知道「没发这种票」），
 * 调用方按原始打分记录过滤（results.ts / sampleStats.ts 的 scoredKeys）。
 *
 * @param input 被评列、项点与已提交的打分表
 * @returns 每个有票人员类别的一组结果
 */
export function computeResults(input: ScoringInput): ScoringResult {
  const { voteColumnIds, criteria, sheets } = input;

  // 票种 → 该票种下每张表的「单元格 → 分数」索引。
  // 保留“每张表”这一层，是因为弃权/不填要按 0 分进入平均：分母是该票种的表数。
  const sheetsByTicketType = new Map<string, Array<Map<string, number>>>();
  // 「票种|被评议人列」有打分记录：区分「没发这种票」与「投了但弃权」。
  const recordedColumns = new Set<string>();
  for (const sheet of sheets) {
    const cells = new Map<string, number>();
    for (const item of sheet.items) {
      cells.set(`${item.voteColumnId}|${item.criterionId}`, item.score);
      recordedColumns.add(`${sheet.ticketTypeId}|${item.voteColumnId}`);
    }
    const list = sheetsByTicketType.get(sheet.ticketTypeId);
    if (list) list.push(cells);
    else sheetsByTicketType.set(sheet.ticketTypeId, [cells]);
  }

  // 遍历 sheetsByTicketType 天然排除零票类别（一张表都没有的类别不建键）。
  const perTicketType: TicketTypeResult[] = [...sheetsByTicketType.entries()].map(
    ([ticketTypeId, cellList]) => ({
      ticketTypeId,
      voteColumns: voteColumnIds.map((voteColumnId) => {
        const hasRecords = recordedColumns.has(`${ticketTypeId}|${voteColumnId}`);
        const criterionResults: CriterionResult[] = criteria.map((criterion) => {
          // 弃权、不填视为 0 分：本类别的每一张表都参与本格，缺格按 0 计入分母。
          const rawScore = average(
            cellList.map((cells) => cells.get(`${voteColumnId}|${criterion.id}`) ?? 0),
          );
          return {
            criterionId: criterion.id,
            rawScore: round2(rawScore),
            normalizedScore: round2(normalizeScore(rawScore, criterion.minScore, criterion.maxScore)),
            participatingTicketTypeIds: hasRecords ? [ticketTypeId] : [],
          };
        });

        return {
          voteColumnId,
          comprehensiveScore:
            criterionResults.length === 0
              ? 0
              : round2(average(criterionResults.map((c) => c.normalizedScore))),
          criteria: criterionResults,
        };
      }),
    }),
  );

  return { perTicketType, ticketTypesInvolved: [...sheetsByTicketType.keys()] };
}
