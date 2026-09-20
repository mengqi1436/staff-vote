/**
 * 管理端认证：登录、登出、当前身份。
 *
 * 分成两个 router 是有意为之：`loginRouter` 必须挂在 `adminAuth` **之前**
 * （还没有会话可校验），`sessionRouter` 挂在之后，保证除登录外所有管理端点都要鉴权。
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { isProduction } from '../../env.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { adminLoginLimiter } from '../../lib/rateLimit.js';
import { signAdminToken } from '../../lib/token.js';
import { ADMIN_COOKIE } from '../../middleware/adminAuth.js';
import { ApiError } from '../../middleware/errorHandler.js';

/** 会话时长，与 lib/token.ts 里签发的 2 小时保持一致。 */
const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const LoginSchema = z.object({
  username: z.string().trim().min(1, '请输入用户名').max(64),
  password: z.string().min(1, '请输入口令').max(128),
});

/**
 * Cookie 选项。
 * httpOnly 让脚本读不到令牌（XSS 拿不走），SameSite=Lax 阻止跨站请求携带它，
 * 因此不需要额外的 CSRF token；生产环境（HTTPS）再加 Secure。
 */
function cookieOptions(): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  maxAge: number;
  path: string;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: SESSION_MAX_AGE_MS,
    path: '/',
  };
}

/**
 * 用户名不存在时用来「陪跑」一次校验的哈希。
 *
 * 若不存在就立刻返回，攻击者可以用响应耗时区分「用户名不存在」与「口令错误」，
 * 从而枚举管理员账号。惰性生成一次即可（scrypt 约几十毫秒，只算一遍）。
 */
let decoyHashPromise: Promise<string> | undefined;
function decoyHash(): Promise<string> {
  decoyHashPromise ??= hashPassword('decoy-not-a-real-password');
  return decoyHashPromise;
}

export const loginRouter: Router = Router();

loginRouter.post('/login', adminLoginLimiter, async (req, res) => {
  const { username, password } = LoginSchema.parse(req.body);

  const admin = await prisma.adminUser.findUnique({ where: { username } });
  const matched = await verifyPassword(password, admin?.passwordHash ?? (await decoyHash()));

  // 失败文案刻意不区分「用户名不存在」与「口令错误」：不给枚举账号的提示。
  if (!admin || !matched) {
    throw ApiError.unauthorized('用户名或口令错误', 'INVALID_CREDENTIALS');
  }

  res.cookie(ADMIN_COOKIE, signAdminToken(admin.id, admin.username), cookieOptions());
  res.json({ id: admin.id, username: admin.username });
});

export const sessionRouter: Router = Router();

sessionRouter.post('/logout', (_req, res) => {
  res.clearCookie(ADMIN_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
  });
  res.status(204).end();
});

sessionRouter.get('/me', (req, res) => {
  const admin = req.admin;
  if (!admin) throw ApiError.unauthorized();
  // 前端靠这几个字段决定按钮显隐；权限码列表是权威值，前端不自己推断
  res.json({
    id: admin.id,
    username: admin.username,
    roleId: admin.roleId,
    roleName: admin.roleName,
    permissions: admin.permissions,
  });
});