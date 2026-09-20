import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/lib/password.js';

describe('password —— scrypt 口令哈希', () => {
  it('正确口令通过校验', async () => {
    const hash = await hashPassword('Sjc980514!');
    await expect(verifyPassword('Sjc980514!', hash)).resolves.toBe(true);
  });

  it('错误口令被拒绝', async () => {
    const hash = await hashPassword('correct-horse-battery');
    await expect(verifyPassword('correct-horse-battery1', hash)).resolves.toBe(false);
    await expect(verifyPassword('', hash)).resolves.toBe(false);
    await expect(verifyPassword('CORRECT-HORSE-BATTERY', hash)).resolves.toBe(false);
  });

  it('哈希串带参数前缀，不包含明文', async () => {
    const hash = await hashPassword('Sjc980514!');
    expect(hash.startsWith('scrypt$16384$8$1$')).toBe(true);
    // 明文绝不能以任何形式出现在存储值里
    expect(hash).not.toContain('Sjc980514');
    expect(hash.split('$')).toHaveLength(6);
  });

  it('同一口令两次哈希结果不同（每次独立随机盐）', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
    // 但都能校验通过
    await expect(verifyPassword('same-password', a)).resolves.toBe(true);
    await expect(verifyPassword('same-password', b)).resolves.toBe(true);
  });

  it('存储值格式非法时返回 false 而非抛异常', async () => {
    await expect(verifyPassword('x', '')).resolves.toBe(false);
    await expect(verifyPassword('x', 'plaintext')).resolves.toBe(false);
    await expect(verifyPassword('x', 'bcrypt$1$2$3$4$5')).resolves.toBe(false);
    await expect(verifyPassword('x', 'scrypt$abc$8$1$aa$bb')).resolves.toBe(false);
    await expect(verifyPassword('x', 'scrypt$16384$8$1$$')).resolves.toBe(false);
  });

  it('scrypt 参数被篡改成超限值时不崩溃', async () => {
    // maxmem 上限之内的近似值会被正常计算，超限值必须被 catch 住
    await expect(verifyPassword('x', 'scrypt$1073741824$8$1$aabb$ccdd')).resolves.toBe(false);
  });
});