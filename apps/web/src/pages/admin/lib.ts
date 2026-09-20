/**
 * 后台管理页面的纯函数工具集。
 *
 * 单独成文件是为了可单测：权重合计、按权重拆分数量、开放时间三层判定，
 * 都是算错了会直接影响发码与投票开关的逻辑，不能只靠肉眼核对。
 */
import dayjs, { type Dayjs } from 'dayjs';
import { ApiError, type SettingsDto } from '../../lib/api.js';

/** 空值占位符，避免表格里出现无法分辨的空单元格。
 *  用普通连字符而不是长破折号：长破折号在整套界面里是禁用字符。 */
export const EMPTY_TEXT = '-';

/** 按本地时区显示到分钟。 */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return EMPTY_TEXT;
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm') : EMPTY_TEXT;
}

/** 按本地时区显示到日（打印表头、日期栏用）。 */
export function formatDate(value: string | null | undefined): string {
  if (!value) return EMPTY_TEXT;
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD') : EMPTY_TEXT;
}

export interface WeightSummary {
  /** 启用票种的权重合计 */
  total: number;
  /** 距 100 的差额：正数表示还差多少，负数表示超出多少 */
  diff: number;
  /** 启用票种数量 */
  enabledCount: number;
}

/**
 * 汇总启用票种的权重。
 *
 * 后端校验的是「启用票种权重合计 = 100」，因此停用票种一律不计入，
 * 否则管理员会被一个与后端口径不同的数字误导。
 */
export function summarizeWeights(
  types: Array<{ weightPercent: number; enabled: boolean }>,
): WeightSummary {
  const enabled = types.filter((type) => type.enabled);
  const total = enabled.reduce((sum, type) => sum + type.weightPercent, 0);
  return { total, diff: 100 - total, enabledCount: enabled.length };
}

/**
 * 按权重把总数量拆分到各票种，保证拆分结果之和恰好等于 total。
 *
 * 先按精确值向下取整，再把余数按小数部分从大到小逐个补足
 * （Array#sort 稳定，小数部分相同时保持传入顺序）。
 */
export function splitByWeight<T extends { id: string; weightPercent: number }>(
  total: number,
  types: T[],
): Array<{ id: string; count: number }> {
  const zero = types.map((type) => ({ id: type.id, count: 0 }));
  if (!Number.isFinite(total) || total <= 0 || types.length === 0) return zero;

  const totalWeight = types.reduce((sum, type) => sum + type.weightPercent, 0);
  if (totalWeight <= 0) return zero;

  const quota = total / totalWeight;
  const rows = types.map((type) => {
    const exact = quota * type.weightPercent;
    const base = Math.floor(exact);
    return { id: type.id, count: base, frac: exact - base };
  });

  let rest = total - rows.reduce((sum, row) => sum + row.count, 0);
  for (const row of [...rows].sort((a, b) => b.frac - a.frac)) {
    if (rest <= 0) break;
    row.count += 1;
    rest -= 1;
  }

  return rows.map((row) => ({ id: row.id, count: row.count }));
}

export interface VoteWindowState {
  open: boolean;
  /** 未开放的原因；开放时为空串 */
  reason: string;
}

/** 开放条件的单行判定结果。 */
export interface VoteWindowCondition {
  /** 行号标记（①②③），展示用 */
  seq: string;
  /** 条件描述 */
  condition: string;
  /** 当前值描述 */
  current: string;
  /** 是否满足 */
  met: boolean;
  /** 不满足时的原因文案；evaluateVoteWindow 的 reason 直接取自这里，保证两处口径同源 */
  reason: string;
}

/**
 * 投票开放的三层条件逐条判定：总开关 + 起始时间 + 结束时间。
 *
 * 这是前端窗口判定的唯一实现：设置页的判定表直接渲染它，
 * evaluateVoteWindow 的结论也从它派生，不再各写一份。
 * 与后端 evaluateVoteWindow 口径一致，但前端展示只是提示：
 * 真正的防线在后端，非开放时段提交一定被拒。
 *
 * @param settings 设置接口返回的原始字符串值
 * @param now 当前时间，显式传入以便测试与复用
 */
export function voteWindowConditions(
  settings: Pick<SettingsDto, 'vote.open' | 'vote.startAt' | 'vote.endAt'>,
  now: Dayjs,
): VoteWindowCondition[] {
  const open = settings['vote.open'] === 'true';
  const startAt = settings['vote.startAt'];
  const endAt = settings['vote.endAt'];
  const start = startAt ? dayjs(startAt) : null;
  const end = endAt ? dayjs(endAt) : null;

  return [
    {
      seq: '①',
      condition: '投票总开关为开',
      current: open ? '总开关：已开启' : '总开关：已关闭',
      met: open,
      reason: '投票总开关已关闭',
    },
    {
      seq: '②',
      condition: '当前时间不早于开始时间',
      current:
        start && start.isValid()
          ? `开始时间：${formatDateTime(startAt)}`
          : '开始时间：未填，视为不限制',
      met: !(start && start.isValid() && now.isBefore(start)),
      reason: `尚未到开始时间（${formatDateTime(startAt)}）`,
    },
    {
      seq: '③',
      condition: '当前时间不晚于结束时间',
      current: end && end.isValid() ? `结束时间：${formatDateTime(endAt)}` : '结束时间：未填，视为不限制',
      met: !(end && end.isValid() && now.isAfter(end)),
      reason: `已过结束时间（${formatDateTime(endAt)}）`,
    },
  ];
}

/**
 * 投票开放结论，由 voteWindowConditions 派生：第一条不满足的条件即原因。
 *
 * @param settings 设置接口返回的原始字符串值
 * @param now 当前时间，显式传入以便测试与复用
 */
export function evaluateVoteWindow(
  settings: Pick<SettingsDto, 'vote.open' | 'vote.startAt' | 'vote.endAt'>,
  now: Dayjs,
): VoteWindowState {
  const failed = voteWindowConditions(settings, now).find((row) => !row.met);
  return failed ? { open: false, reason: failed.reason } : { open: true, reason: '' };
}

/**
 * 统一提取错误文案：后端 zod 字段明细拼在消息后面，
 * 让管理员一眼知道是哪个字段不合法，而不是只看「请求失败」。
 */
export function describeError(caught: unknown, fallback = '操作失败，请重试'): string {
  if (!(caught instanceof Error)) return fallback;
  if (caught instanceof ApiError && caught.fields?.length) {
    const detail = caught.fields.map((field) => `${field.path}: ${field.message}`).join('；');
    return `${caught.message}（${detail}）`;
  }
  return caught.message || fallback;
}

/** 登录失败提示。区分 401（口令错误）与 429（限流），其余回显后端消息。 */
export function describeLoginError(caught: unknown): string {
  if (caught instanceof ApiError) {
    if (caught.status === 401) return '用户名或口令错误';
    if (caught.status === 429) return '尝试过于频繁，请稍后再试';
    if (caught.status === 0) return caught.message;
    return caught.message || '登录失败，请稍后重试';
  }
  return '登录失败，请稍后重试';
}