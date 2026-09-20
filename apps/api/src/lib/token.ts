import jwt from 'jsonwebtoken';
import { env } from '../env.js';

/**
 * 会话令牌。
 *
 * 两类令牌用 `kind` 字段区分，校验时严格比对，避免把投票令牌当管理端令牌使用
 * （否则任何一张随机码都能换来后台权限）。
 */

const ADMIN_TTL_SECONDS = 2 * 60 * 60;
/** 投票会话给足填写时间：一张几十行的表需要逐步录入。 */
const VOTE_TTL_SECONDS = 2 * 60 * 60;

export interface AdminTokenPayload {
  kind: 'admin';
  /** 管理员 ID */
  sub: string;
  username: string;
}

export interface VoteTokenPayload {
  kind: 'vote';
  /** 随机码 ID（UUID），用于提交时的原子核销。令牌里不含码明文。 */
  sub: string;
  /** 票种 ID，用于计分加权。 */
  ticketTypeId: string;
}

/**
 * 签发管理端令牌。
 * @param adminId 管理员 ID
 * @param username 登录名，仅用于界面显示
 */
export function signAdminToken(adminId: string, username: string): string {
  const payload: AdminTokenPayload = { kind: 'admin', sub: adminId, username };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: ADMIN_TTL_SECONDS });
}

/**
 * 签发投票会话令牌。
 *
 * 刻意不含随机码明文：评分表本身也不记录 ticketId，
 * 因此即使令牌泄漏，也无法从令牌反推某张评分表由哪张码投出。
 * @param ticketId 随机码 ID，提交时用于原子核销
 * @param ticketTypeId 票种 ID，用于加权计算
 */
export function signVoteToken(ticketId: string, ticketTypeId: string): string {
  const payload: VoteTokenPayload = { kind: 'vote', sub: ticketId, ticketTypeId };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: VOTE_TTL_SECONDS });
}

/**
 * 校验管理端令牌。
 * @returns 合法则返回载荷，否则返回 null（不抛异常，由中间件决定响应）
 */
export function verifyAdminToken(token: string): AdminTokenPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (typeof decoded === 'string') return null;
    if (decoded.kind !== 'admin') return null;
    const { sub, username } = decoded as jwt.JwtPayload & { username?: unknown };
    if (typeof sub !== 'string' || typeof username !== 'string') return null;
    return { kind: 'admin', sub, username };
  } catch {
    // 过期、签名不符、格式非法一律归为「未认证」，细节不回传给客户端。
    return null;
  }
}

/**
 * 校验投票会话令牌。
 * @returns 合法则返回载荷，否则返回 null
 */
export function verifyVoteToken(token: string): VoteTokenPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (typeof decoded === 'string') return null;
    if (decoded.kind !== 'vote') return null;
    const { sub, ticketTypeId } = decoded as jwt.JwtPayload & { ticketTypeId?: unknown };
    if (typeof sub !== 'string' || typeof ticketTypeId !== 'string') return null;
    return { kind: 'vote', sub, ticketTypeId };
  } catch {
    return null;
  }
}