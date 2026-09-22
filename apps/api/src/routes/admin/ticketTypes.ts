/**
 * 票种与权重。
 *
 * 权重合计必须为 100 的校验放在 `services/admin.ts`（含过渡写的例外规则说明）。
 * 这里的 DELETE 是停用（软删除），不是物理删除：已发出的随机码与已提交的评分表
 * 都引用了票种，物理删除会连带毁掉历史数据。
 *
 * 写操作逐个挂 `requirePermission`（不是 router.use 整段挂）：读操作不设权限，
 * 没有 ticketTypes.write 的角色天然只读，GET 必须照常放行。
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  createTicketType,
  disableTicketType,
  listTicketTypes,
  resolveSessionId,
  updateTicketType,
} from '../../services/admin.js';
import { requirePermission } from '../../middleware/permission.js';
import { IdParamSchema, operatorOf } from './helpers.js';

const CreateSchema = z.object({
  sessionId: z.string().min(1).optional(),
  code: z.string().trim().min(1, '票种编码不能为空').max(20),
  name: z.string().trim().min(1, '票种名称不能为空').max(100),
  weightPercent: z.number().int().min(0).max(100),
  sortOrder: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
});

const PatchSchema = CreateSchema.partial();

/** 列表类接口的场次过滤：?sessionId= 可选，未带时单场自动解析、多场 400。 */
const ListQuerySchema = z.object({
  sessionId: z.string().min(1).optional(),
});

export const ticketTypesRouter: Router = Router();

ticketTypesRouter.get('/', async (req, res) => {
  const { sessionId } = ListQuerySchema.parse(req.query);
  res.json(await listTicketTypes(await resolveSessionId(sessionId)));
});

ticketTypesRouter.post('/', requirePermission('ticketTypes.write'), async (req, res) => {
  const body = CreateSchema.parse(req.body);
  res.json(await createTicketType(body, operatorOf(req)));
});

ticketTypesRouter.patch('/:id', requirePermission('ticketTypes.write'), async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  const body = PatchSchema.parse(req.body);
  res.json(await updateTicketType(id, body, operatorOf(req)));
});

ticketTypesRouter.delete('/:id', requirePermission('ticketTypes.write'), async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  await disableTicketType(id, operatorOf(req));
  res.status(204).end();
});