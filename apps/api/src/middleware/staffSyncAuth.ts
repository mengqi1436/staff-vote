import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { env } from '../env.js';
import { ApiError } from './errorHandler.js';

/**
 * 外部系统同步鉴权。
 *
 * 走请求头 `X-Sync-Token` 而不是后台的 Cookie 会话：定期推送是机器调用，
 * 没有登录态，也不该让它占用管理员权限码。
 *
 * 未配置 `STAFF_SYNC_TOKEN` 时端点直接关闭（503），
 * 避免默认部署就暴露一条无鉴权的写入口。
 * 比对使用 `timingSafeEqual`，与口令校验同一口径。
 */
export const staffSyncAuth: RequestHandler = (req, _res, next) => {
  const expected = env.STAFF_SYNC_TOKEN;
  if (!expected) {
    throw new ApiError(503, 'SYNC_DISABLED', '人员同步未启用（服务端未配置 STAFF_SYNC_TOKEN）');
  }

  const provided = req.header('x-sync-token') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw ApiError.unauthorized('同步令牌无效', 'SYNC_TOKEN_INVALID');
  }

  next();
};
