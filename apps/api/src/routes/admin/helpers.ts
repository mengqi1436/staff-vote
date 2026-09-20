import type { Request } from 'express';
import { z } from 'zod';

/** `:id` 路径参数的公共校验，五个资源路由共用。 */
export const IdParamSchema = z.object({ id: z.string().min(1) });

/**
 * 当前操作者用户名。
 * 写入 TicketBatch.operator 与 AuditLog，用于回答「这批码是谁发的」。
 * adminAuth 已保证 req.admin 存在，兜底值只为类型收敛。
 */
export function operatorOf(req: Request): string {
  return req.admin?.username ?? 'unknown';
}