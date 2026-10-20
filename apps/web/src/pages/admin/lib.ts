/**
 * 后台管理页面的纯函数工具集。
 *
 * 单独成文件是为了可单测：时间格式化、后端错误文案提取，
 * 都是每个页面都会用到、写错了会直接让管理员看不懂原因的逻辑。
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

/**
 * 统一提取错误文案：后端 zod 字段明细拼在消息后面，
 * 让管理员一眼知道是哪个字段不合法，而不是只看「请求失败」。
 * SESSION_REQUIRED（多场时未选评议）单独给指引文案，落到「请先选择评议」这一个动作上。
 */
export function describeError(caught: unknown, fallback = '操作失败，请重试'): string {
  if (!(caught instanceof Error)) return fallback;
  if (caught instanceof ApiError) {
    if (caught.code === 'SESSION_REQUIRED') return '请先选择评议';
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