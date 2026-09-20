import { describe, expect, it } from 'vitest';
import { CODE_ALPHABET, CODE_LENGTH, generateCode, generateUniqueCodes, normalizeCode } from '../src/lib/code.js';

describe('code —— 随机码生成与规范化', () => {
  it('字符集剔除易混字符 O/0/I/1', () => {
    expect(CODE_ALPHABET).not.toContain('O');
    expect(CODE_ALPHABET).not.toContain('0');
    expect(CODE_ALPHABET).not.toContain('I');
    expect(CODE_ALPHABET).not.toContain('1');
  });

  it('生成的码符合长度与字符集约束', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateCode();
      expect(code).toHaveLength(CODE_LENGTH);
      for (const char of code) {
        expect(CODE_ALPHABET).toContain(char);
      }
    }
  });

  it('大量生成不出现重复', () => {
    const codes = generateUniqueCodes(2000);
    expect(codes).toHaveLength(2000);
    expect(new Set(codes).size).toBe(2000);
  });

  it('规范化：去空格、去连字符、转大写', () => {
    expect(normalizeCode(' k7m2 qp9x ')).toBe('K7M2QP9X');
    expect(normalizeCode('k7m2-qp9x')).toBe('K7M2QP9X');
    expect(normalizeCode('K7M2QP9X')).toBe('K7M2QP9X');
  });

  it('规范化后的码能被字符集覆盖（含边界输入）', () => {
    expect(normalizeCode('')).toBe('');
    expect(normalizeCode('   ')).toBe('');
    expect(normalizeCode('a b\tc\n')).toBe('ABC');
  });
});