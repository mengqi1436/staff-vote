import type { Request, RequestHandler } from 'express';
import { prisma } from '../db.js';
import { verifyAdminToken } from '../lib/token.js';
import { ApiError } from './errorHandler.js';

/** adminAuth 注入的当前管理员上下文：身份 + 角色 + 权限码。 */
export interface AdminContext {
  id: string;
  username: string;
  roleId: string | null;
  roleName: string | null;
  /** 权限码列表。没有角色时为空数组，等价于只读 */
  permissions: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** 由 adminAuth 中间件注入的管理员上下文 */
      admin?: AdminContext;
    }
  }
}

/** 管理端会话 Cookie 名。 */
export const ADMIN_COOKIE = 'staff_vote_admin';

/**
 * 读取指定 Cookie。
 *
 * 刻意不引入 cookie-parser：本应用只需要读取一个自有 Cookie，
 * 无需签名校验与解析选项，五行代码即可，不值得多一个依赖。
 */
function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/**
 * 管理端鉴权中间件。
 *
 * 令牌放在 httpOnly Cookie 中而非 localStorage：
 * httpOnly 使脚本无法读取，XSS 拿不到令牌；SameSite=Lax 阻止跨站请求携带它，
 * 因而无需额外实现 CSRF token。
 *
 * 这里【每次请求都查库】取角色与权限，而不是把权限写进令牌，原因是：
 *   1. 调整角色权限、换角色后立即生效，不必等 2 小时会话过期；
 *   2. 管理员被停用或删除后，其尚未过期的令牌立刻失效 —— 把权限写进令牌做不到。
 *
 * ponytail: 代价是每请求一次关联查询。管理端是内部系统（管理员个位数、QPS 极低），
 * 不值得为它加缓存；若将来管理端压力上来，在此按 adminId 加 30 秒 TTL 缓存即可。
 */
export const adminAuth: RequestHandler = async (req, _res, next) => {
  const token = readCookie(req, ADMIN_COOKIE);
  if (!token) {
    next(ApiError.unauthorized());
    return;
  }

  const payload = verifyAdminToken(token);
  if (!payload) {
    next(ApiError.unauthorized());
    return;
  }

  const admin = await prisma.adminUser.findUnique({
    where: { id: payload.sub },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });

  if (!admin || !admin.enabled) {
    next(ApiError.unauthorized('账号不存在或已停用', 'ACCOUNT_DISABLED'));
    return;
  }

  req.admin = {
    id: admin.id,
    username: admin.username,
    roleId: admin.roleId,
    roleName: admin.role?.name ?? null,
    permissions: admin.role?.permissions.map((item) => item.permission.code) ?? [],
  };
  next();
};