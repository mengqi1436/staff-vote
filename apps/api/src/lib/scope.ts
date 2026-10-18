/**
 * 场次打分范围（score_scope）的单一真源。
 *
 * 投票链路（取表 / 提交 / 核销 / 进度）与后台完整性校验都从这里取口径，
 * 避免「哪张表算完成」在两处漂移。
 */
export type ScoreScope = 'person' | 'workshop' | 'both';

/** 合法的打分范围取值，供请求校验使用。 */
export const SCORE_SCOPES: readonly ScoreScope[] = ['person', 'workshop', 'both'];

/**
 * 该打分范围要求持码人提交的答卷类型。
 *
 *   person   —— 只评负责人（个人问卷）；
 *   workshop —— 只评车间（车间问卷）；
 *   both     —— 负责人 + 车间两张，齐交才核销随机码。
 */
export function requiredSheetTypes(scoreScope: string): string[] {
  if (scoreScope === 'both') return ['person', 'workshop'];
  if (scoreScope === 'workshop') return ['workshop'];
  return ['person'];
}
