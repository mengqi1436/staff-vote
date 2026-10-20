import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CODE_LENGTH, generateCode, generateUniqueCodes, normalizeCode } from '../src/lib/code.js';

const { randomIntMock } = vi.hoisted(() => ({ randomIntMock: vi.fn() }));

// 只替换 randomInt，保留 node:crypto 的其余导出，避免影响运行时其它模块
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomInt: randomIntMock };
});

/** 12 位纯数字。 */
const DIGITS_ONLY = /^[0-9]{12}$/;

describe('code —— 随机码生成与规范化', () => {
  beforeEach(async () => {
    // 默认走真实 CSPRNG；只有「前导零」与「码空间」用例覆盖返回值
    const { randomInt } = await vi.importActual<typeof import('node:crypto')>('node:crypto');
    randomIntMock.mockReset();
    randomIntMock.mockImplementation((min: number, max: number) => randomInt(min, max));
  });

  it('长度常量为 12', () => {
    expect(CODE_LENGTH).toBe(12);
  });

  it('生成的码为 12 位纯数字', () => {
    for (let i = 0; i < 500; i += 1) {
      expect(generateCode()).toMatch(DIGITS_ONLY);
    }
  });

  it('码空间取 [0, 10^12)', () => {
    randomIntMock.mockReturnValue(42);
    generateCode();
    expect(randomIntMock).toHaveBeenCalledWith(0, 1_000_000_000_000);
  });

  describe('前导零保留', () => {
    it('randomInt 返回 0 → 全零 12 位', () => {
      randomIntMock.mockReturnValue(0);
      expect(generateCode()).toBe('000000000000');
    });

    it('randomInt 返回 12345 → 补足 12 位', () => {
      randomIntMock.mockReturnValue(12345);
      expect(generateCode()).toBe('000000012345');
    });

    it('randomInt 返回 999999999999 → 12 位不变', () => {
      randomIntMock.mockReturnValue(999_999_999_999);
      expect(generateCode()).toBe('999999999999');
    });
  });

  describe('normalizeCode —— 抄录容错', () => {
    it('去掉首尾与中间的空格', () => {
      expect(normalizeCode(' 1234 5678 9012 ')).toBe('123456789012');
    });

    it('去掉连字符', () => {
      expect(normalizeCode('1234-5678-9012')).toBe('123456789012');
    });

    it('全角数字按 NFKC 转半角（中文输入法/粘贴）', () => {
      expect(normalizeCode('１２３４ ５６７８ ９０１２')).toBe('123456789012');
    });

    it('已规范化的码原样返回', () => {
      expect(normalizeCode('123456789012')).toBe('123456789012');
    });

    it('空串与纯空白返回空串', () => {
      expect(normalizeCode('')).toBe('');
      expect(normalizeCode('   ')).toBe('');
    });
  });

  it('批量生成 2000 个互不重复的 12 位码', () => {
    const codes = generateUniqueCodes(2000);
    expect(codes).toHaveLength(2000);
    expect(new Set(codes).size).toBe(2000);
    for (const code of codes) {
      expect(code).toMatch(DIGITS_ONLY);
    }
  });
});
