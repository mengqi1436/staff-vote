import { describe, expect, it } from 'vitest';
import { requiredSheetTypes, SCORE_SCOPES } from '../src/lib/scope.js';

/**
 * 打分范围的判定（纯函数，任何环境可跑）。
 *
 * 这三种取值决定「一张码要交哪几张表、什么时候核销」，
 * 投票链路（取表/提交/核销/进度）与完整性校验共用同一份口径。
 */
describe('requiredSheetTypes', () => {
  it('person：只要求负责人打分表', () => {
    expect(requiredSheetTypes('person')).toEqual(['person']);
  });

  it('workshop：只要求车间打分表', () => {
    expect(requiredSheetTypes('workshop')).toEqual(['workshop']);
  });

  it('both：负责人 + 车间两张', () => {
    expect(requiredSheetTypes('both')).toEqual(['person', 'workshop']);
  });

  it('未知取值回落 person：脏数据/老数据不会让投票链路取不到表', () => {
    expect(requiredSheetTypes('')).toEqual(['person']);
    expect(requiredSheetTypes('SOMETHING_ELSE')).toEqual(['person']);
  });

  it('合法取值清单覆盖三种模式', () => {
    expect([...SCORE_SCOPES]).toEqual(['person', 'workshop', 'both']);
  });
});
