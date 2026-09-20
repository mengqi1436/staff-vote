import { randomInt } from 'node:crypto';

/**
 * 随机码生成与规范化。
 *
 * 字符集刻意剔除易混字符 O/0/I/1，以及容易读错的 S/5 之外的其他歧义字符。
 * 剩余 32 个字符 × 8 位 ≈ 1.1e12 组合，配合登录接口的按 IP 限流，
 * 暴力枚举不可行。
 */

/** 32 个字符，无 O、0、I、1。 */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 随机码长度。 */
export const CODE_LENGTH = 8;

/**
 * 生成一个随机码。使用 `crypto.randomInt` 而非 `Math.random`：
 * 后者是可预测的伪随机数，用于票据场景会被推测出同批次其他码。
 * @returns 形如 `K7M2QP9X` 的 8 位大写码
 */
export function generateCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * 规范化用户输入的随机码：去空白、去连字符、转大写。
 * 打印发放的码常被手工抄录，允许带空格或小写可显著降低无效登录。
 * @param input 用户输入
 * @returns 规范化后的码；`O`/`I` 等不在字符集内的字母不做替换，交由查库判定失败
 */
export function normalizeCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * 批量生成互不重复的随机码。
 * @param count 需要的数量
 * @returns 去重后的码数组；数量较多时靠调用方与数据库唯一索引兜底
 */
export function generateUniqueCodes(count: number): string[] {
  const seen = new Set<string>();
  // 生成量远小于空间容量（1.1e12），碰撞概率可忽略；循环条件仍保留 seen 校验，
  // 使重复概率在数学上为零而非「几乎为零」。
  while (seen.size < count) {
    seen.add(generateCode());
  }
  return [...seen];
}