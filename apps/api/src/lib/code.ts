import { randomInt } from 'node:crypto';

/**
 * 随机码生成与规范化。
 *
 * 码为固定 12 位、字符集 `0123456789`，空间 10^12 ≈ 1.0e12，
 * 与旧方案 32^8 ≈ 1.1e12 同量级，熵不下降。
 * 纯数字免去剔除易混字母的取舍，也便于职工抄录与电话口述；
 * 配合登录接口的按 IP 限流，暴力枚举不可行。
 */

/** 随机码长度。 */
export const CODE_LENGTH = 12;

/** 码空间上界（不含），即 10^12；10^12 < 2^48，满足 `crypto.randomInt` 的取值范围要求。 */
const CODE_MAX = 1_000_000_000_000;

/**
 * 生成一个随机码。使用 `crypto.randomInt` 而非 `Math.random`：
 * 后者是可预测的伪随机数，用于票据场景会被推测出同批次其他码。
 * @returns 形如 `000000012345` 的 12 位数字码（前导零必须保留）
 */
export function generateCode(): string {
  return String(randomInt(0, CODE_MAX)).padStart(CODE_LENGTH, '0');
}

/**
 * 规范化用户输入的随机码：先 NFKC（全角数字转半角），再去空白、去连字符。
 * 打印发放的码常被手工抄录，允许带空格或连字符可显著降低无效登录。
 * 纯数字下大小写无意义，因此不再 `toUpperCase()`。
 * @param input 用户输入
 * @returns 规范化后的码；非数字字符不做替换，交由查库判定失败
 */
export function normalizeCode(input: string): string {
  return input.normalize('NFKC').replace(/[\s-]/g, '');
}

/**
 * 批量生成互不重复的随机码。
 * @param count 需要的数量
 * @returns 去重后的码数组；数量较多时靠调用方与数据库唯一索引兜底
 */
export function generateUniqueCodes(count: number): string[] {
  const seen = new Set<string>();
  // 生成量远小于空间容量（10^12），碰撞概率可忽略；循环条件仍保留 seen 校验，
  // 使同一批内重复概率在数学上为零而非「几乎为零」。跨批次/跨场次由 tickets.code
  // 全局唯一索引兜底。
  while (seen.size < count) {
    seen.add(generateCode());
  }
  return [...seen];
}
