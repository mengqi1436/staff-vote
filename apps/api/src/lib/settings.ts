/**
 * 全局设置的键名与解析逻辑。
 *
 * 集中在此，避免投票端与管理端各自硬编码字符串而写错键名 ——
 * 那种错误不会报错，只会表现为「开关点了没反应」。
 */

export const SETTING_KEYS = {
  /** 'true' | 'false'，投票总开关 */
  voteOpen: 'vote.open',
  /** ISO 8601 字符串，开放起始时间；空串表示不限制 */
  voteStartAt: 'vote.startAt',
  /** ISO 8601 字符串，开放结束时间；空串表示不限制 */
  voteEndAt: 'vote.endAt',
  /** 系统标题，显示在投票入口与后台 */
  systemTitle: 'system.title',
} as const;

/** 投票关闭时对职工显示的统一文案（需求明确要求这一句）。 */
export const VOTE_CLOSED_MESSAGE = '当前未开放投票';

/** 默认设置，seed 时写入。 */
export const DEFAULT_SETTINGS: ReadonlyArray<{ key: string; value: string }> = [
  { key: SETTING_KEYS.voteOpen, value: 'false' },
  { key: SETTING_KEYS.voteStartAt, value: '' },
  { key: SETTING_KEYS.voteEndAt, value: '' },
  { key: SETTING_KEYS.systemTitle, value: '职工素质评议' },
];

export interface VoteWindowState {
  open: boolean;
  /** 给前端直接显示的文案 */
  message: string;
  /** 计划开放时间（未设置则为 null），前端可提前告知职工 */
  startAt: string | null;
  endAt: string | null;
}

/**
 * 解析 ISO 时间字符串。
 * @returns 合法则返回 Date，空串或非法值返回 null（视为不限制）
 */
function parseTime(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 判定当前是否处于投票开放期。
 *
 * 三层条件全部满足才算开放：总开关打开、当前时间不早于起始、不晚于结束。
 * 起始/结束留空表示该侧不限制。
 *
 * @param settings 设置键值对
 * @param now 判定时刻，可注入以便测试
 * @returns 开放状态与对职工显示的文案
 */
export function evaluateVoteWindow(
  settings: Map<string, string>,
  now: Date = new Date(),
): VoteWindowState {
  const openFlag = settings.get(SETTING_KEYS.voteOpen) === 'true';
  const startAt = parseTime(settings.get(SETTING_KEYS.voteStartAt));
  const endAt = parseTime(settings.get(SETTING_KEYS.voteEndAt));

  const beforeStart = startAt !== null && now.getTime() < startAt.getTime();
  const afterEnd = endAt !== null && now.getTime() > endAt.getTime();
  const open = openFlag && !beforeStart && !afterEnd;

  return {
    open,
    message: open ? '' : VOTE_CLOSED_MESSAGE,
    startAt: startAt?.toISOString() ?? null,
    endAt: endAt?.toISOString() ?? null,
  };
}

/**
 * 读取全部设置并转成 Map。
 * @param rows 数据库中的设置行
 */
export function toSettingMap(rows: Array<{ key: string; value: string }>): Map<string, string> {
  return new Map(rows.map((row) => [row.key, row.value]));
}