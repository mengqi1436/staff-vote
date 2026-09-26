/**
 * 设置键名与投票开放窗口的判定逻辑。
 *
 * 「什么时候能投票」按场次判定（vote_sessions.opens_at / closes_at），
 * 全局只剩系统标题一个设置项。判定集中在此，避免投票端与管理端各自硬编码而漂移。
 */

export const SETTING_KEYS = {
  /** 系统标题，显示在投票入口与后台 */
  systemTitle: 'system.title',
} as const;

/** 投票关闭时对职工显示的统一文案（需求明确要求这一句）。 */
export const VOTE_CLOSED_MESSAGE = '当前未开放投票';

/** 默认设置，seed 时写入。 */
export const DEFAULT_SETTINGS: ReadonlyArray<{ key: string; value: string }> = [
  { key: SETTING_KEYS.systemTitle, value: '职工素质评议' },
];

export interface VoteWindowState {
  open: boolean;
  /** 给前端直接显示的文案 */
  message: string;
  /** 场次计划开放时间（未设置则为 null），前端可提前告知职工 */
  opensAt: string | null;
  /** 场次开放截止时间（未设置则为 null） */
  closesAt: string | null;
}

/**
 * 参与投票开放判定的场次切片。
 * 调用方直接传 VoteSession 行或其投影（票所属场次 / 待统计场次）。
 */
export interface VoteWindowSession {
  status: string;
  /** 开放开始时间；null = 不限制开始 */
  opensAt: Date | null;
  /** 开放结束时间；null = 长期开放 */
  closesAt: Date | null;
}

/**
 * 判定某场次当前是否处于投票开放期。
 *
 * 三层条件全部满足才算开放：status 为 voting、当前时间不早于 opensAt（若设）、
 * 不晚于 closesAt（若设）。时间留空表示该侧不限制。
 *
 * @param session 票所属或待判定的场次
 * @param now 判定时刻，可注入以便测试
 * @returns 开放状态与对职工显示的文案
 */
export function evaluateVoteWindow(
  session: VoteWindowSession,
  now: Date = new Date(),
): VoteWindowState {
  const beforeOpen = session.opensAt !== null && now.getTime() < session.opensAt.getTime();
  const afterClose = session.closesAt !== null && now.getTime() > session.closesAt.getTime();
  // 场次未开始（draft）、暂停（paused）或已结束（ended）都与窗口未到同一文案。
  const open = session.status === 'voting' && !beforeOpen && !afterClose;

  return {
    open,
    message: open ? '' : VOTE_CLOSED_MESSAGE,
    opensAt: session.opensAt?.toISOString() ?? null,
    closesAt: session.closesAt?.toISOString() ?? null,
  };
}
