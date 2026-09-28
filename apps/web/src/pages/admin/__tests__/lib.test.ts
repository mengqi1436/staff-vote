import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../lib/api.js';
import {
  describeLoginError,
  formatDateTime,
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

