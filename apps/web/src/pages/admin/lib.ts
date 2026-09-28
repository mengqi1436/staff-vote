/**
 * 后台管理页面的纯函数工具集。
 *
 * 单独成文件是为了可单测：权重合计、按权重拆分数量，
 * 都是算错了会直接影响发码的逻辑，不能只靠肉眼核对。
 */
import dayjs from 'dayjs';
import { ApiError } from '../../lib/api.js';

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
 * 统一提取错误文案：后端 zod 字段明细拼在消息后面，
 * 让管理员一眼知道是哪个字段不合法，而不是只看「请求失败」。
 * SESSION_REQUIRED（多场时未选场次）单独给指引文案，落到「请先选择场次」这一个动作上。
 */
export function describeError(caught: unknown, fallback = '操作失败，请重试'): string {
  if (!(caught instanceof Error)) return fallback;
  if (caught instanceof ApiError) {
    if (caught.code === 'SESSION_REQUIRED') return '请先选择场次';
    if (caught.fields?.length) {
      const detail = caught.fields.map((field) => `${field.path}: ${field.message}`).join('；');
      return `${caught.message}（${detail}）`;
    }
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