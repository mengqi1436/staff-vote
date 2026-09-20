import { describe, expect, it } from 'vitest';
import { computeResults, type ScoringInput } from '../src/lib/scoring.js';

/**
 * 计分口径测试。这些用例锁定的是设计文档第 13 节的口径，
 * 口径若被改动，这些断言必须一起改，不允许静默漂移。
 */

function input(partial: Partial<ScoringInput>): ScoringInput {
  return {
    employeeIds: [],
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
        employeeIds: ['e1'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        ticketTypes: [{ id: 'tA', weightPercent: 100 }],
        sheets: [
          { ticketTypeId: 'tA', items: [{ employeeId: 'e1', criterionId: 'c1', score: 80 }] },
        ],
      }),
    );

    const employee = result.employees[0];
    expect(employee?.criteria[0]?.rawScore).toBe(80);
    expect(employee?.comprehensiveScore).toBe(80);
  });

  it('多票种按权重百分比加权', () => {
    // A 票 50% 打 90 分；B 票 50% 打 70 分 → 0.5*90 + 0.5*70 = 80
    const result = computeResults(
      input({
        employeeIds: ['e1'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        ticketTypes: [
          { id: 'tA', weightPercent: 50 },
          { id: 'tB', weightPercent: 50 },
        ],
        sheets: [
          { ticketTypeId: 'tA', items: [{ employeeId: 'e1', criterionId: 'c1', score: 90 }] },
          { ticketTypeId: 'tB', items: [{ employeeId: 'e1', criterionId: 'c1', score: 70 }] },
        ],
      }),
    );

    expect(result.employees[0]?.criteria[0]?.rawScore).toBe(80);
  });

  it('某票种零票时，按实际有票的票种重新归一化，不把缺失票种当 0 分', () => {
    // A 票占 50% 但没有任何 A 票提交；只剩 B(30) 与 C(20)。
    // 归一化后： (75*30 + 85*20) / 50 = 79，而不是 (0*50 + 75*30 + 85*20)/100 = 39.5
    const result = computeResults(
      input({
        employeeIds: ['e1'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        ticketTypes: [
          { id: 'tA', weightPercent: 50 },
          { id: 'tB', weightPercent: 30 },
          { id: 'tC', weightPercent: 20 },
        ],
        sheets: [
          { ticketTypeId: 'tB', items: [{ employeeId: 'e1', criterionId: 'c1', score: 75 }] },
          { ticketTypeId: 'tC', items: [{ employeeId: 'e1', criterionId: 'c1', score: 85 }] },
        ],
      }),
    );

    expect(result.employees[0]?.criteria[0]?.rawScore).toBe(79);
    expect(result.employees[0]?.criteria[0]?.participatingTicketTypeIds).toEqual(['tB', 'tC']);
    expect(result.ticketTypesInvolved).toEqual(['tB', 'tC']);
  });

  it('同一票种多张表取均分', () => {
    // 三张 B 票分别打 60 / 90 / 90 → 均分 80
    const result = computeResults(
      input({
        employeeIds: ['e1'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        ticketTypes: [{ id: 'tB', weightPercent: 100 }],
        sheets: [
          { ticketTypeId: 'tB', items: [{ employeeId: 'e1', criterionId: 'c1', score: 60 }] },
          { ticketTypeId: 'tB', items: [{ employeeId: 'e1', criterionId: 'c1', score: 90 }] },
          { ticketTypeId: 'tB', items: [{ employeeId: 'e1', criterionId: 'c1', score: 90 }] },
        ],
      }),
    );

    expect(result.employees[0]?.criteria[0]?.rawScore).toBe(80);
  });

  it('权重为 0 的票种不参与计算', () => {
    const result = computeResults(
      input({
        employeeIds: ['e1'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        ticketTypes: [
          { id: 'tA', weightPercent: 0 },
          { id: 'tB', weightPercent: 100 },
        ],
        sheets: [
          { ticketTypeId: 'tA', items: [{ employeeId: 'e1', criterionId: 'c1', score: 10 }] },
          { ticketTypeId: 'tB', items: [{ employeeId: 'e1', criterionId: 'c1', score: 90 }] },
        ],
      }),
    );

    expect(result.employees[0]?.criteria[0]?.rawScore).toBe(90);
  });
});

describe('computeResults —— 项点间汇总', () => {
  it('min 非 0 时按区间归一化', () => {
    // 区间 60-100，得 80 → (80-60)/40*100 = 50
    const result = computeResults(
      input({
        employeeIds: ['e1'],
        criteria: [{ id: 'c1', minScore: 60, maxScore: 100 }],
        ticketTypes: [{ id: 'tA', weightPercent: 100 }],
        sheets: [
          { ticketTypeId: 'tA', items: [{ employeeId: 'e1', criterionId: 'c1', score: 80 }] },
        ],
      }),
    );

    expect(result.employees[0]?.criteria[0]?.rawScore).toBe(80);
    expect(result.employees[0]?.criteria[0]?.normalizedScore).toBe(50);
  });

  it('各项满分不同时归一化到百分制后再等权平均', () => {
    // c1 满分 100 得 90 → 90；c2 满分 10 得 8 → 80。综合 = (90+80)/2 = 85
    // 若直接把原始分相加，8 分会在总分里被彻底淹没。
    const result = computeResults(
      input({
        employeeIds: ['e1'],
        criteria: [
          { id: 'c1', minScore: 0, maxScore: 100 },
          { id: 'c2', minScore: 0, maxScore: 10 },
        ],
        ticketTypes: [{ id: 'tA', weightPercent: 100 }],
        sheets: [
          {
            ticketTypeId: 'tA',
            items: [
              { employeeId: 'e1', criterionId: 'c1', score: 90 },
              { employeeId: 'e1', criterionId: 'c2', score: 8 },
            ],
          },
        ],
      }),
    );

    expect(result.employees[0]?.criteria.map((c) => c.normalizedScore)).toEqual([90, 80]);
    expect(result.employees[0]?.comprehensiveScore).toBe(85);
  });

  it('某项点零票时该项不参与综合得分，不会按 0 分计入', () => {
    // c2 完全没有票 → 综合得分只由 c1 决定，仍为 90，而不是 (90+0)/2 = 45
    const result = computeResults(
      input({
        employeeIds: ['e1'],
        criteria: [
          { id: 'c1', minScore: 0, maxScore: 100 },
          { id: 'c2', minScore: 0, maxScore: 100 },
        ],
        ticketTypes: [{ id: 'tA', weightPercent: 100 }],
        sheets: [
          { ticketTypeId: 'tA', items: [{ employeeId: 'e1', criterionId: 'c1', score: 90 }] },
        ],
      }),
    );

    expect(result.employees[0]?.criteria).toHaveLength(1);
    expect(result.employees[0]?.comprehensiveScore).toBe(90);
  });

  it('完全没有任何票的职工综合得分为 0 且项点结果为空', () => {
    const result = computeResults(
      input({
        employeeIds: ['e1'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        ticketTypes: [{ id: 'tA', weightPercent: 100 }],
        sheets: [],
      }),
    );

    expect(result.employees[0]?.criteria).toEqual([]);
    expect(result.employees[0]?.comprehensiveScore).toBe(0);
  });

  it('非法区间（max <= min）不产生 NaN', () => {
    const result = computeResults(
      input({
        employeeIds: ['e1'],
        criteria: [{ id: 'c1', minScore: 100, maxScore: 100 }],
        ticketTypes: [{ id: 'tA', weightPercent: 100 }],
        sheets: [
          { ticketTypeId: 'tA', items: [{ employeeId: 'e1', criterionId: 'c1', score: 100 }] },
        ],
      }),
    );

    expect(Number.isNaN(result.employees[0]?.comprehensiveScore)).toBe(false);
    expect(result.employees[0]?.comprehensiveScore).toBe(100);
  });
});

describe('computeResults —— 多职工隔离', () => {
  it('不同职工的分数互不串扰', () => {
    const result = computeResults(
      input({
        employeeIds: ['e1', 'e2'],
        criteria: [{ id: 'c1', minScore: 0, maxScore: 100 }],
        ticketTypes: [{ id: 'tA', weightPercent: 100 }],
        sheets: [
          {
            ticketTypeId: 'tA',
            items: [
              { employeeId: 'e1', criterionId: 'c1', score: 100 },
              { employeeId: 'e2', criterionId: 'c1', score: 20 },
            ],
          },
        ],
      }),
    );

    expect(result.employees.find((e) => e.employeeId === 'e1')?.comprehensiveScore).toBe(100);
    expect(result.employees.find((e) => e.employeeId === 'e2')?.comprehensiveScore).toBe(20);
  });
});