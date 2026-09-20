import { prisma } from '../db.js';
import { env } from '../env.js';

/**
 * 敏感字段的可逆加密（pgcrypto / AES-128）。
 *
 * 适用对象：需要【还原显示】的数据，例如职工手机号、身份证号。
 * 官方依据：PostgreSQL 文档中 pgp_sym_encrypt 的默认 `cipher-algo` 即 aes128，
 * 这里显式写出以免默认值将来变动而静默降级。
 *
 * ⚠️ 严禁用于口令。
 *   OWASP 密码存储备忘单："Passwords should be securely hashed using modern, adaptive
 *   hashing algorithms ... rather than encrypted or stored in plaintext."
 *   口令是可逆加密最典型的误用场景：拿到密钥即可还原原始口令，而口令常被跨系统复用。
 *   本项目的口令一律走 ./password.ts 的 scrypt 单向哈希。
 *
 * 本期不落任何加密字段，本模块只把能力铺通：将来新增加密列时不需要改架构。
 * 存储形态为 base64 文本，便于直接放进 TEXT 列。
 */

/** 显式指定 AES-128（pgcrypto 的官方默认值，此处写死以防默认值变化）。 */
const CIPHER_OPTIONS = 'cipher-algo=aes128';

function requireKey(): string {
  const key = env.SENSITIVE_FIELD_KEY;
  if (!key) {
    throw new Error(
      'SENSITIVE_FIELD_KEY 未配置，无法加解密敏感字段。请在 .env 中设置后重启。',
    );
  }
  return key;
}

/**
 * 加密一个敏感字段值。
 * @param plaintext 明文
 * @returns base64 编码的密文，可直接存入 TEXT 列
 */
export async function encryptField(plaintext: string): Promise<string> {
  const key = requireKey();
  const rows = await prisma.$queryRaw<Array<{ ciphertext: string }>>`
    SELECT encode(
      pgp_sym_encrypt(${plaintext}::text, ${key}::text, ${CIPHER_OPTIONS}::text),
      'base64'
    ) AS ciphertext
  `;
  const row = rows[0];
  if (!row) throw new Error('pgp_sym_encrypt 未返回结果');
  return row.ciphertext;
}

/**
 * 解密一个敏感字段值。
 * @param ciphertext `encryptField` 产出的 base64 密文
 * @returns 明文
 * @throws 密钥不符或密文损坏时 pgcrypto 会报错，此处让其抛出，由调用方决定处理方式
 */
export async function decryptField(ciphertext: string): Promise<string> {
  const key = requireKey();
  const rows = await prisma.$queryRaw<Array<{ plaintext: string }>>`
    SELECT pgp_sym_decrypt(decode(${ciphertext}::text, 'base64'), ${key}::text) AS plaintext
  `;
  const row = rows[0];
  if (!row) throw new Error('pgp_sym_decrypt 未返回结果');
  return row.plaintext;
}