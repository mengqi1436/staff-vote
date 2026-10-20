import { describe, expect, it } from 'vitest';
import { computeResults, type ScoringInput } from '../src/lib/scoring.js';

/**
 * 计分口径测试。
 *
 * 锁定的是「参考表口径 + 设计文档第 13 节」：**按人员类别分别统计、不跨类别合并、
 * 不加权**；类别内多张答卷同格取均分；项点归一化后等权平均；以及参考表明确要求的
 * 「弃权、不填视为 0 分」。口径若被改动，这些断言必须一起改，不允许静默漂移。
 */

function input(partial: Partial<ScoringInput>): ScoringInput {
  return {
    voteColumnIds: [],
    criteria: [],
    sheets: [],
    ...partial,
  };
}

describe('computeResults —— 按人员类别分别统计（不合并、不加权）', () => {
  it('单一人员类别时，结果等于该人员类别均分', () => {
    const result = computeResults(
      input({
        voteColumnIds: ['v1'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        sheets: [{ ticketTypeId: 'tA', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 80 }] }],
      }),
    );

    const column = result.perTicketType[0]?.voteColumns[0];
    expect(result.perTicketType.map((row) => row.ticketTypeId)).toEqual(['tA']);
    expect(column?.criteria[0]?.rawScore).toBe(80);
    expect(column?.criteria[0]?.normalizedScore).toBe(80);
    expect(column?.comprehensiveScore).toBe(80);
  });

  it('多人员类别分别输出各自得分，不产生任何合并值', () => {
    // A 打 90、B 打 50：分别输出 90 与 50。旧口径会合并成一个跨类别总分
    // （此处若按等权合并是 70、按权重合并会是别的数），新口径下两者都不存在。
    const result = computeResults(
      input({
        voteColumnIds: ['v1'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        sheets: [
          { ticketTypeId: 'tA', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 90 }] },
          { ticketTypeId: 'tB', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 50 }] },
        ],
      }),
    );

    const byType = new Map(result.perTicketType.map((row) => [row.ticketTypeId, row]));
    expect(byType.get('tA')?.voteColumns[0]?.criteria[0]?.rawScore).toBe(90);
    expect(byType.get('tB')?.voteColumns[0]?.criteria[0]?.rawScore).toBe(50);
    expect(byType.get('tA')?.voteColumns[0]?.comprehensiveScore).toBe(90);
    expect(byType.get('tB')?.voteColumns[0]?.comprehensiveScore).toBe(50);
    // 跨类别合并口径已整体删除：不存在任何 70 之类的合并结果
    expect((result as unknown as Record<string, unknown>).voteColumns).toBeUndefined();
    expect(result.perTicketType).toHaveLength(2);
  });

  it('零票人员类别不参与：既不出现，也不当 0 分拉低同类别的其他人', () => {
    // 只有 B(75) 与 C(85) 有票；A 一张表都没有。旧口径会把两者归一化成 80，
    // 新口径下各自独立：B 输出 75、C 输出 85，A 不出现。
    const result = computeResults(
      input({
        voteColumnIds: ['v1'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        sheets: [
          { ticketTypeId: 'tB', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 75 }] },
          { ticketTypeId: 'tC', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 85 }] },
        ],
      }),
    );

    expect(result.perTicketType.map((row) => row.ticketTypeId)).toEqual(['tB', 'tC']);
    expect(result.perTicketType.map((row) => row.voteColumns[0]?.criteria[0]?.rawScore)).toEqual([75, 85]);
    expect(result.ticketTypesInvolved).toEqual(['tB', 'tC']);
  });

  it('同一人员类别多张表都填了该格时取均分', () => {
    // 三张 B 票分别打 60 / 90 / 90 → 均分 80
    const result = computeResults(
      input({
        voteColumnIds: ['v1'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        sheets: [
          { ticketTypeId: 'tB', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 60 }] },
          { ticketTypeId: 'tB', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 90 }] },
          { ticketTypeId: 'tB', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 90 }] },
        ],
      }),
    );

    expect(result.perTicketType[0]?.voteColumns[0]?.criteria[0]?.rawScore).toBe(80);
    expect(result.perTicketType[0]?.voteColumns[0]?.comprehensiveScore).toBe(80);
  });
});

describe('computeResults —— 弃权、不填视为 0 分（参考表说明）', () => {
  it('该人员类别的表缺某一格时，该格按 0 分进入平均', () => {
    // 参考表填写说明：弃权、不填视为 0 分。
    // 两张 B 票，一张给 v1·c1 打了 60，另一张跳过了这格 → (60 + 0) / 2 = 30，
    // 而不是把缺格摘掉只算 60。
    const result = computeResults(
      input({
        voteColumnIds: ['v1'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        sheets: [
          { ticketTypeId: 'tB', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 60 }] },
          { ticketTypeId: 'tB', items: [] },
        ],
      }),
    );

    expect(result.perTicketType[0]?.voteColumns[0]?.criteria[0]?.rawScore).toBe(30);
  });

  it('缺格按 0 分只影响本格，同表其他格照常计分', () => {
    // c1 有两张表填了（80、60）→ 70；c2 只有一张表填了（40），另一张缺 → 20
    const result = computeResults(
      input({
        voteColumnIds: ['v1'],
        criteria: [
          { id: 'c1', minScore: 0, maxScore: 100 },
          { id: 'c2', minScore: 0, maxScore: 100 },
        ],
        sheets: [
          {
            ticketTypeId: 'tB',
            items: [
              { voteColumnId: 'v1', criterionId: 'c1', score: 80 },
              { voteColumnId: 'v1', criterionId: 'c2', score: 40 },
            ],
          },
          { ticketTypeId: 'tB', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 60 }] },
        ],
      }),
    );

    const criteria = result.perTicketType[0]?.voteColumns[0]?.criteria;
    expect(criteria?.find((c) => c.criterionId === 'c1')?.rawScore).toBe(70);
    expect(criteria?.find((c) => c.criterionId === 'c2')?.rawScore).toBe(20);
  });

  it('本部门一张表都没有时不产生任何人员类别结果（不是 0 分参与）', () => {
    // 没发过票与「投了但弃权」是两件事：一张表都没有时整个类别都不出现。
    const result = computeResults(
      input({
        voteColumnIds: ['v1'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        sheets: [],
      }),
    );

    expect(result.perTicketType).toEqual([]);
    expect(result.ticketTypesInvolved).toEqual([]);
  });
});

describe('computeResults —— 评议项目间汇总', () => {
  it('min 非 0 时按区间归一化', () => {
    // 区间 60-100，得 80 → (80-60)/40*100 = 50
    const result = computeResults(
      input({
        voteColumnIds: ['v1'],
        criteria: [{ id: 'c1', minScore: 60, maxScore: 100 }],
        sheets: [{ ticketTypeId: 'tA', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 80 }] }],
      }),
    );

    const column = result.perTicketType[0]?.voteColumns[0];
    expect(column?.criteria[0]?.rawScore).toBe(80);
    expect(column?.criteria[0]?.normalizedScore).toBe(50);
    expect(column?.comprehensiveScore).toBe(50);
  });

  it('各项满分不同时归一化到百分制后再等权平均', () => {
    // c1 满分 100 得 90 → 90；c2 满分 20 得 16 → 80。综合 = (90+80)/2 = 85
    // 若直接把原始分相加，16 分会在总分里被彻底淹没。
    const result = computeResults(
      input({
        voteColumnIds: ['v1'],
        criteria: [
          { id: 'c1', minScore: 0, maxScore: 100 },
          { id: 'c2', minScore: 0, maxScore: 20 },
        ],
        sheets: [
          {
            ticketTypeId: 'tA',
            items: [
              { voteColumnId: 'v1', criterionId: 'c1', score: 90 },
              { voteColumnId: 'v1', criterionId: 'c2', score: 16 },
            ],
          },
        ],
      }),
    );

    const column = result.perTicketType[0]?.voteColumns[0];
    expect(column?.criteria.map((c) => c.normalizedScore)).toEqual([90, 80]);
    expect(column?.comprehensiveScore).toBe(85);
  });

  it('非法区间（max <= min）不产生 NaN', () => {
    const result = computeResults(
      input({
        voteColumnIds: ['v1'],
        criteria: [{ id: 'c1', minScore: 100, maxScore: 100 }],
        sheets: [
          { ticketTypeId: 'tA', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 100 }] },
        ],
      }),
    );

    expect(Number.isNaN(result.perTicketType[0]?.voteColumns[0]?.comprehensiveScore)).toBe(false);
    expect(result.perTicketType[0]?.voteColumns[0]?.comprehensiveScore).toBe(100);
  });
});

describe('computeResults —— perTicketType 人员类别结果（人员类别×被评议人列×评议项目 / 人员类别×被评议人列）', () => {
  it('每人员类别对每格输出平均分与归一化分，人员类别对列输出类别内综合分', () => {
    // tA 对 v1·c1 打 90；tB 两张表打 60 / 90 → 75。两者互不影响。
    const result = computeResults(
      input({
        voteColumnIds: ['v1'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        sheets: [
          { ticketTypeId: 'tA', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 90 }] },
          { ticketTypeId: 'tB', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 60 }] },
          { ticketTypeId: 'tB', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 90 }] },
        ],
      }),
    );

    const byType = new Map(result.perTicketType.map((row) => [row.ticketTypeId, row]));
    expect(byType.get('tA')?.voteColumns[0]?.criteria[0]?.rawScore).toBe(90);
    expect(byType.get('tA')?.voteColumns[0]?.criteria[0]?.normalizedScore).toBe(90);
    expect(byType.get('tA')?.voteColumns[0]?.comprehensiveScore).toBe(90);
    expect(byType.get('tB')?.voteColumns[0]?.criteria[0]?.rawScore).toBe(75);
    expect(byType.get('tB')?.voteColumns[0]?.criteria[0]?.normalizedScore).toBe(75);
    expect(byType.get('tB')?.voteColumns[0]?.comprehensiveScore).toBe(75);
  });

  it('缺格计 0 进入平均，多列多格相互独立', () => {
    // tB 两张表：一张填 v1·c1=80，另一张全缺 → c1 均分 40。
    // v2 没有任何票填过 → 该格是 0，且没有参与人员类别（无票 ≠ 0 分，由调用方过滤）。
    const result = computeResults(
      input({
        voteColumnIds: ['v1', 'v2'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        sheets: [
          { ticketTypeId: 'tB', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 80 }] },
          { ticketTypeId: 'tB', items: [] },
        ],
      }),
    );

    const columns = result.perTicketType[0]?.voteColumns;
    expect(columns?.find((c) => c.voteColumnId === 'v1')?.criteria[0]?.rawScore).toBe(40);
    expect(columns?.find((c) => c.voteColumnId === 'v1')?.comprehensiveScore).toBe(40);
    expect(columns?.find((c) => c.voteColumnId === 'v1')?.criteria[0]?.participatingTicketTypeIds).toEqual(['tB']);
    expect(columns?.find((c) => c.voteColumnId === 'v2')?.criteria[0]?.rawScore).toBe(0);
    expect(columns?.find((c) => c.voteColumnId === 'v2')?.comprehensiveScore).toBe(0);
    expect(columns?.find((c) => c.voteColumnId === 'v2')?.criteria[0]?.participatingTicketTypeIds).toEqual([]);
  });

  it('类别内综合分是各格平均分的等权平均（round2 一致）', () => {
    // v1 上 c1 均分 80、c2 均分 75 → 类别内综合 77.5
    const result = computeResults(
      input({
        voteColumnIds: ['v1'],
        criteria: [
          { id: 'c1', minScore: 0, maxScore: 100 },
          { id: 'c2', minScore: 0, maxScore: 100 },
        ],
        sheets: [
          {
            ticketTypeId: 'tA',
            items: [
              { voteColumnId: 'v1', criterionId: 'c1', score: 80 },
              { voteColumnId: 'v1', criterionId: 'c2', score: 75 },
            ],
          },
        ],
      }),
    );

    const column = result.perTicketType[0]?.voteColumns[0];
    expect(column?.criteria.map((c) => c.rawScore)).toEqual([80, 75]);
    expect(column?.comprehensiveScore).toBe(77.5);
  });

  it('类别内综合分用归一化分等权平均，不是原始分等权平均', () => {
    // c1 满分 100 得 90 → 90；c2 满分 20 得 16 → 80。
    // 归一化等权 = 85；若错用原始分等权则是 (90+16)/2 = 53。
    const result = computeResults(
      input({
        voteColumnIds: ['v1'],
        criteria: [
          { id: 'c1', minScore: 0, maxScore: 100 },
          { id: 'c2', minScore: 0, maxScore: 20 },
        ],
        sheets: [
          {
            ticketTypeId: 'tA',
            items: [
              { voteColumnId: 'v1', criterionId: 'c1', score: 90 },
              { voteColumnId: 'v1', criterionId: 'c2', score: 16 },
            ],
          },
        ],
      }),
    );

    const column = result.perTicketType[0]?.voteColumns[0];
    expect(column?.comprehensiveScore).toBe(85);
    expect(column?.comprehensiveScore).not.toBe(53);
  });

  it('零人员类别排除：一张表都没有的人员类别不出现在 perTicketType', () => {
    const result = computeResults(
      input({
        voteColumnIds: ['v1'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        sheets: [{ ticketTypeId: 'tB', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 70 }] }],
      }),
    );

    expect(result.perTicketType.map((row) => row.ticketTypeId)).toEqual(['tB']);
    expect(result.ticketTypesInvolved).toEqual(['tB']);
  });
});

describe('computeResults —— 多被评议人列隔离', () => {
  it('不同被评议人列的分数互不串扰', () => {
    const result = computeResults(
      input({
        voteColumnIds: ['v1', 'v2'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        sheets: [
          {
            ticketTypeId: 'tA',
            items: [
              { voteColumnId: 'v1', criterionId: 'c1', score: 100 },
              { voteColumnId: 'v2', criterionId: 'c1', score: 20 },
            ],
          },
        ],
      }),
    );

    const columns = result.perTicketType[0]?.voteColumns;
    expect(columns?.find((c) => c.voteColumnId === 'v1')?.comprehensiveScore).toBe(100);
    expect(columns?.find((c) => c.voteColumnId === 'v2')?.comprehensiveScore).toBe(20);
  });
});
