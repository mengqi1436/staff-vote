import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../lib/api.js';
import {
  describeLoginError,
  formatDateTime,
  splitByWeight,
  summarizeWeights,
} from '../lib.js';

describe('summarizeWeights', () => {
  it('启用票种合计 100 时差额为 0', () => {
    expect(
      summarizeWeights([
        { weightPercent: 50, enabled: true },
        { weightPercent: 30, enabled: true },
        { weightPercent: 20, enabled: true },
      ]),
    ).toEqual({ total: 100, diff: 0, enabledCount: 3 });
  });

  it('停用票种不计入合计（与后端校验口径一致）', () => {
    expect(
      summarizeWeights([
        { weightPercent: 60, enabled: true },
        { weightPercent: 40, enabled: false },
      ]),
    ).toEqual({ total: 60, diff: 40, enabledCount: 1 });
  });

  it('合计超出 100 时差额为负', () => {
    expect(
      summarizeWeights([
        { weightPercent: 80, enabled: true },
        { weightPercent: 40, enabled: true },
      ]).diff,
    ).toBe(-20);
  });

  it('空列表合计为 0，差额为 100', () => {
    expect(summarizeWeights([])).toEqual({ total: 0, diff: 100, enabledCount: 0 });
  });
});

describe('splitByWeight', () => {
  const types = [
    { id: 'a', weightPercent: 50 },
    { id: 'b', weightPercent: 30 },
    { id: 'c', weightPercent: 20 },
  ];

  it('整除时按权重精确拆分', () => {
    expect(splitByWeight(100, types)).toEqual([
      { id: 'a', count: 50 },
      { id: 'b', count: 30 },
      { id: 'c', count: 20 },
    ]);
  });

  it('不能整除时合计仍恰好等于总数，余数给小数部分最大的票种', () => {
    const result = splitByWeight(7, types);
    expect(result).toEqual([
      { id: 'a', count: 4 },
      { id: 'b', count: 2 },
      { id: 'c', count: 1 },
    ]);
    expect(result.reduce((sum, row) => sum + row.count, 0)).toBe(7);
  });

  it('权重合计不是 100 时按实际权重归一化', () => {
    expect(
      splitByWeight(100, [
        { id: 'a', weightPercent: 25 },
        { id: 'b', weightPercent: 25 },
      ]),
    ).toEqual([
      { id: 'a', count: 50 },
      { id: 'b', count: 50 },
    ]);
  });

  it('总数为 0、负数、权重合计为 0 时全部给 0', () => {
    expect(splitByWeight(0, types).every((row) => row.count === 0)).toBe(true);
    expect(splitByWeight(-5, types).every((row) => row.count === 0)).toBe(true);
    expect(
      splitByWeight(10, [
        { id: 'a', weightPercent: 0 },
        { id: 'b', weightPercent: 0 },
      ]).every((row) => row.count === 0),
    ).toBe(true);
  });

  it('空票种列表返回空数组', () => {
    expect(splitByWeight(10, [])).toEqual([]);
  });
});

describe('formatDateTime', () => {
  it('空值显示占位符', () => {
    expect(formatDateTime(null)).toBe('-');
    expect(formatDateTime(undefined)).toBe('-');
    expect(formatDateTime('')).toBe('-');
  });

  it('非法字符串显示占位符', () => {
    expect(formatDateTime('not-a-date')).toBe('-');
  });

  it('按本地时区输出到分钟', () => {
    expect(formatDateTime('2026-09-19T10:00:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe('describeLoginError', () => {
  it('401 提示用户名或口令错误', () => {
    expect(describeLoginError(new ApiError(401, 'UNAUTHORIZED', '后端原文'))).toBe('用户名或口令错误');
  });

  it('429 提示尝试过于频繁', () => {
    expect(describeLoginError(new ApiError(429, 'TOO_MANY_REQUESTS', '后端原文'))).toBe(
      '尝试过于频繁，请稍后再试',
    );
  });

  it('其他错误回显后端消息', () => {
    expect(describeLoginError(new ApiError(500, 'INTERNAL', '服务异常'))).toBe('服务异常');
  });

  it('非 ApiError 给通用提示', () => {
    expect(describeLoginError(new Error('boom'))).toBe('登录失败，请稍后重试');
  });
});