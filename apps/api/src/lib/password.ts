import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * 口令哈希。依据 OWASP 密码存储备忘单：
 *   "Passwords should be securely hashed using modern, adaptive hashing algorithms
 *    (e.g., Argon2id, bcrypt, or PBKDF2), rather than encrypted or stored in plaintext."
 *
 * 选择 scrypt 而非 AES 或 SHA 系列：
 *   - 不用 AES：可逆加密意味着拿到密钥就能还原原始口令（OWASP 明确禁止）；
 *   - 不用 SHA-256：太快，攻击者可高速爆破；
 *   - scrypt 是 Node 标准库自带的内存硬慢哈希，零依赖。
 *
 * 参数取自 OWASP 推荐值：N=16384, r=8, p=1, keylen=64, salt >= 16 字节。
 */

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

/** OWASP 推荐参数。修改 N 会使旧哈希无法校验，如需升级请同时支持多套参数。 */
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

/** 128 * N * r 是 scrypt 的内存开销，N=16384/r=8 时为 16 MiB。 */
const MAXMEM = 64 * 1024 * 1024;

/** 存储格式：scrypt$N$r$p$saltHex$hashHex —— 参数随哈希一起存，便于日后轮换。 */
const PREFIX = 'scrypt';

/**
 * 生成口令哈希。
 * @param password 明文口令
 * @returns `scrypt$N$r$p$saltHex$hashHex` 格式串
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `${PREFIX}$${N}$${R}$${P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * 校验口令。比对使用 `timingSafeEqual`（恒定时间），避免通过响应耗时逐字节猜测哈希。
 * @param password 待校验明文口令
 * @param stored 数据库中存储的哈希串
 * @returns 匹配为 true；格式非法或参数不可解析时返回 false，不抛异常
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;

  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (!saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length, {
      N: n,
      r,
      p,
      maxmem: MAXMEM,
    });
  } catch {
    // 参数超限（例如人为把 N 改成天文数字）时 scrypt 会抛错，视为校验不通过即可，
    // 不需要把细节暴露给调用方。
    return false;
  }

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}