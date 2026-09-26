/**
 * 投票场次管理：列表、创建、编辑与状态机控制。
 *
 * 状态机（draft → voting ⇄ paused → ended，ended 终态）：
 *   PATCH /:id       更新名称与开放时间窗（opensAt / closesAt，null=清空）
 *   POST /:id/start  draft|paused → voting（首次 start 写 startAt）
 *   POST /:id/pause  voting → paused
 *   POST /:id/end    voting|paused → ended（写 endedAt，之后不可逆）
 * 非法流转返回 409 INVALID_SESSION_TRANSITION。
 *
 * 权限沿用 settings.write：场次的开停与「投票开放窗口」同属评议执行控制，
 * 不新增权限码可以让既有角色在 seed 后立即具备组织场次的能力。
 *
 * 写操作逐个挂 requirePermission：列表读操作不设权限，只读角色可看场次状态。
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  createSession,
  listSessions,
  transitionSession,
  updateSession,
} from '../../services/admin.js';
import { requirePermission } from '../../middleware/permission.js';
import { IdParamSchema, operatorOf } from './helpers.js';

const CreateSchema = z.object({
  name: z.string().trim().min(1, '场次名称不能为空').max(100),
});

/** ISO 8601 时间；Date.parse 对 '2026-09-19T08:00:00+08:00' 这类写法都成立。 */
const isoTime = z.string().refine((value) => !Number.isNaN(Date.parse(value)), '必须为 ISO 8601 时间');

/** PATCH 语义：缺省（undefined）= 不改；显式 null = 清空（该侧恢复不限制）。 */
const UpdateSchema = z.object({
  name: z.string().trim().min(1, '场次名称不能为空').max(100).optional(),
  opensAt: isoTime.nullable().optional(),
  closesAt: isoTime.nullable().optional(),
});

const ActionParamSchema = z.object({
  id: z.string().min(1),
  /** start | pause | end */
  action: z.enum(['start', 'pause', 'end']),
});

export const sessionsRouter: Router = Router();

sessionsRouter.get('/', async (_req, res) => {
  res.json(await listSessions());
});

sessionsRouter.post('/', requirePermission('settings.write'), async (req, res) => {
  const body = CreateSchema.parse(req.body);
  // 契约形状：{ session: {...} }（与 GET 的 { sessions: [...] } 对齐）
  res.json({ session: await createSession(body, operatorOf(req)) });
});

/** 更新名称与开放时间窗：{ session: {...} }，形状同 create。 */
sessionsRouter.patch('/:id', requirePermission('settings.write'), async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  const body = UpdateSchema.parse(req.body);
  res.json({ session: await updateSession(id, body, operatorOf(req)) });
});

/** 统一注册 start / pause / end 三个流转端点。 */
for (const action of ['start', 'pause', 'end'] as const) {
  sessionsRouter.post(`/:id/${action}`, requirePermission('settings.write'), async (req, res) => {
    const { id } = ActionParamSchema.parse({ ...req.params, action });
    // 契约形状：{ session: {...} }，与 create / PATCH 一致
    res.json({ session: await transitionSession(id, action, operatorOf(req)) });
  });
}
