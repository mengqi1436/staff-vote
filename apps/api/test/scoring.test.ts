import { describe, expect, it } from 'vitest';
import { computeResults, type ScoringInput } from '../src/lib/scoring.js';

/**
 * 计分口径测试。
 *
 * 锁定的是「参考表口径 + 设计文档第 13 节」：票种加权、项点归一化后等权平均，
 * 以及参考表明确要求的「弃权、不填视为 0 分」。口径若被改动，这些断言必须一起改，
 * 不允许静默漂移。
 */

function input(partial: Partial<ScoringInput>): ScoringInput {
  return {
    voteColumnIds: [],
    criteria: [],
    ticketTypes: [],
    sheets: [],
    ...partial,
  };
}

describe('computeResults —— 票种加权', () => {
  it('单一票种时，结果等于该票种均分', () => {
    const result = computeResults(
      input({
        voteColumnIds: ['v1'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        ticketTypes: [{ id: 'tA', weightPercent: 100 }],
        sheets: [{ ticketTypeId: 'tA', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 80 }] }],
      }),
    );

    const column = result.voteColumns[0];
    expect(column?.criteria[0]?.rawScore).toBe(80);
    expect(column?.comprehensiveScore).toBe(80);
  });

  it('多票种按权重百分比加权', () => {
    // A 票 50% 打 90 分；B 票 50% 打 70 分 → 0.5*90 + 0.5*70 = 80
    const result = computeResults(
      input({
        voteColumnIds: ['v1'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        ticketTypes: [
          { id: 'tA', weightPercent: 50 },
          { id: 'tB', weightPercent: 50 },
        ],
        sheets: [
          { ticketTypeId: 'tA', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 90 }] },
          { ticketTypeId: 'tB', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 70 }] },
        ],
      }),
    );

    expect(result.voteColumns[0]?.criteria[0]?.rawScore).toBe(80);
  });

  it('某票种零票时，按实际有票的票种重新归一化，不把缺失票种当 0 分', () => {
    // A 票占 50% 但没有任何 A 票提交；只剩 B(30) 与 C(20)。
    // 归一化后： (75*30 + 85*20) / 50 = 79，而不是 (0*50 + 75*30 + 85*20)/100 = 39.5
    const result = computeResults(
      input({
        voteColumnIds: ['v1'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        ticketTypes: [
          { id: 'tA', weightPercent: 50 },
          { id: 'tB', weightPercent: 30 },
          { id: 'tC', weightPercent: 20 },
        ],
        sheets: [
          { ticketTypeId: 'tB', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 75 }] },
          { ticketTypeId: 'tC', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 85 }] },
        ],
      }),
    );

    expect(result.voteColumns[0]?.criteria[0]?.rawScore).toBe(79);
    expect(result.voteColumns[0]?.criteria[0]?.participatingTicketTypeIds).toEqual(['tB', 'tC']);
    expect(result.ticketTypesInvolved).toEqual(['tB', 'tC']);
  });

  it('同一票种多张表都填了该格时取均分', () => {
    // 三张 B 票分别打 60 / 90 / 90 → 均分 80
    const result = computeResults(
      input({
        voteColumnIds: ['v1'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        ticketTypes: [{ id: 'tB', weightPercent: 100 }],
        sheets: [
          { ticketTypeId: 'tB', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 60 }] },
          { ticketTypeId: 'tB', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 90 }] },
          { ticketTypeId: 'tB', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 90 }] },
        ],
      }),
    );

    expect(result.voteColumns[0]?.criteria[0]?.rawScore).toBe(80);
  });

  it('权重为 0 的票种不参与计算', () => {
    const result = computeResults(
      input({
        voteColumnIds: ['v1'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        ticketTypes: [
          { id: 'tA', weightPercent: 0 },
          { id: 'tB', weightPercent: 100 },
        ],
        sheets: [
          { ticketTypeId: 'tA', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 10 }] },
          { ticketTypeId: 'tB', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 90 }] },
        ],
      }),
    );

    expect(result.voteColumns[0]?.criteria[0]?.rawScore).toBe(90);
  });
});

describe('computeResults —— 弃权、不填视为 0 分（参考表口径）', () => {
  it('该票种的表缺某一格时，该格按 0 分进入平均', () => {
    // 参考表填写说明：弃权、不填视为 0 分。
    // 两张 B 票，一张给 v1·c1 打了 60，另一张跳过了这格 → (60 + 0) / 2 = 30，
    // 而不是把缺格摘掉只算 60。
    const result = computeResults(
      input({
        voteColumnIds: ['v1'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        ticketTypes: [{ id: 'tB', weightPercent: 100 }],
        sheets: [
          { ticketTypeId: 'tB', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 60 }] },
          { ticketTypeId: 'tB', items: [] },
        ],
      }),
    );

    expect(result.voteColumns[0]?.criteria[0]?.rawScore).toBe(30);
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
        ticketTypes: [{ id: 'tB', weightPercent: 100 }],
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

    expect(result.voteColumns[0]?.criteria.find((c) => c.criterionId === 'c1')?.rawScore).toBe(70);
    expect(result.voteColumns[0]?.criteria.find((c) => c.criterionId === 'c2')?.rawScore).toBe(20);
  });

  it('本部门一张表都没有时，项点结果为空且综合得分为 0（不是 0 分参与）', () => {
    // 没发过票与「投了但弃权」是两件事：一张表都没有时整票种跳过，不制造 0 分。
    const result = computeResults(
      input({
        voteColumnIds: ['v1'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        ticketTypes: [{ id: 'tA', weightPercent: 100 }],
        sheets: [],
      }),
    );

    expect(result.voteColumns[0]?.criteria).toEqual([]);
    expect(result.voteColumns[0]?.comprehensiveScore).toBe(0);
  });
});

describe('computeResults —— 项点间汇总', () => {
  it('min 非 0 时按区间归一化', () => {
    // 区间 60-100，得 80 → (80-60)/40*100 = 50
    const result = computeResults(
      input({
        voteColumnIds: ['v1'],
        criteria: [{ id: 'c1', minScore: 60, maxScore: 100 }],
        ticketTypes: [{ id: 'tA', weightPercent: 100 }],
        sheets: [{ ticketTypeId: 'tA', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 80 }] }],
      }),
    );

    expect(result.voteColumns[0]?.criteria[0]?.rawScore).toBe(80);
    expect(result.voteColumns[0]?.criteria[0]?.normalizedScore).toBe(50);
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
        ticketTypes: [{ id: 'tA', weightPercent: 100 }],
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

    expect(result.voteColumns[0]?.criteria.map((c) => c.normalizedScore)).toEqual([90, 80]);
    expect(result.voteColumns[0]?.comprehensiveScore).toBe(85);
  });

  it('非法区间（max <= min）不产生 NaN', () => {
    const result = computeResults(
      input({
        voteColumnIds: ['v1'],
        criteria: [{ id: 'c1', minScore: 100, maxScore: 100 }],
        ticketTypes: [{ id: 'tA', weightPercent: 100 }],
        sheets: [
          { ticketTypeId: 'tA', items: [{ voteColumnId: 'v1', criterionId: 'c1', score: 100 }] },
        ],
      }),
    );

    expect(Number.isNaN(result.voteColumns[0]?.comprehensiveScore)).toBe(false);
    expect(result.voteColumns[0]?.comprehensiveScore).toBe(100);
  });
});

describe('computeResults —— 多被评列隔离', () => {
  it('不同被评列的分数互不串扰', () => {
    const result = computeResults(
      input({
        voteColumnIds: ['v1', 'v2'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        ticketTypes: [{ id: 'tA', weightPercent: 100 }],
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

    expect(result.voteColumns.find((c) => c.voteColumnId === 'v1')?.comprehensiveScore).toBe(100);
    expect(result.voteColumns.find((c) => c.voteColumnId === 'v2')?.comprehensiveScore).toBe(20);
  });
});