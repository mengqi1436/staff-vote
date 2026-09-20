import type { RequestHandler } from 'express';
import { PERMISSION_NAMES } from '../lib/permissions.js';
import { ApiError } from './errorHandler.js';

/**
 * 权限校验中间件。
 *
 * 必须挂在 `adminAuth` 之后：adminAuth 已把该管理员的角色与权限码注入 `req.admin`。
 *
 * 前端会按权限隐藏按钮，但那只是体验层（让人不去点没用的按钮）；
 * 真正的防线是这里 —— 直接调接口一样会被拦下。
 *
 * @param code 权限码，取自 `lib/permissions.ts` 的目录
 * @returns Express 中间件；无权限时以 403 `PERMISSION_DENIED` 结束
 */
export function requirePermission(code: string): RequestHandler {
  return (req, _res, next) => {
    const admin = req.admin;
    if (!admin) {
      next(ApiError.unauthorized());
      return;
    }

    if (!admin.permissions.includes(code)) {
      const name = PERMISSION_NAMES.get(code) ?? code;
      next(
        ApiError.forbidden(`当前账号没有「${name}」权限，请联系超级管理员`, 'PERMISSION_DENIED'),
      );
      return;
    }

    next();
  };
}