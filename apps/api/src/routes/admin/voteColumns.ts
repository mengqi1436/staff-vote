/**
 * 被评列（打分表的列）。
 *
 * 参考表的两张问卷共用这一份模型：个人问卷是「主任 / 党支部书记 / 党支部副书记 / 副主任」，
 * 车间问卷只有一列「得分」。列与职工名单无关（职工名单不参与打分）。
 *
 * 权限沿用 `criteria.write`：被评列与项点同属「评议准备」里的问卷结构配置，
 * 新增独立权限码会让既有角色在 seed 后仍然没有该权限（seed 不覆盖管理员改过的授权），
 * 反而把能配问卷的人挡在门外。
 *
 * 写操作逐个挂 `requirePermission`：读操作不设权限，没有该权限的角色天然只读。
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  createVoteColumn,
  disableVoteColumn,
  listVoteColumns,
  resolveSessionId,
  updateVoteColumn,
} from '../../services/admin.js';
import { requirePermission } from '../../middleware/permission.js';
import { IdParamSchema, operatorOf } from './helpers.js';

const ListQuerySchema = z.object({
  departmentId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
});

const CreateSchema = z.object({
  departmentId: z.string().min(1, '必须指定部门'),
  sessionId: z.string().min(1).optional(),
  name: z.string().trim().min(1, '列名不能为空').max(50),
  /** 该职务列的具体被评人；null/undefined = 未选人。 */
  employeeId: z.string().min(1).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  /** 传 null 清除已选的被评人。 */
  employeeId: z.string().min(1).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
});

export const voteColumnsRouter: Router = Router();

voteColumnsRouter.get('/', async (req, res) => {
  const { departmentId, sessionId } = ListQuerySchema.parse(req.query);
  res.json(await listVoteColumns(departmentId, await resolveSessionId(sessionId)));
});

voteColumnsRouter.post('/', requirePermission('criteria.write'), async (req, res) => {
  const body = CreateSchema.parse(req.body);
  res.json(await createVoteColumn(body, operatorOf(req)));
});

voteColumnsRouter.patch('/:id', requirePermission('criteria.write'), async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  const body = PatchSchema.parse(req.body);
  res.json(await updateVoteColumn(id, body, operatorOf(req)));
});

voteColumnsRouter.delete('/:id', requirePermission('criteria.write'), async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  await disableVoteColumn(id, operatorOf(req));
  res.status(204).end();
});