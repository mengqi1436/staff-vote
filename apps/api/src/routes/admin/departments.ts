/**
 * 部门管理。删除为软删除（enabled = false）：部门一旦产生过评分，
 * 物理删除会连带毁掉历史成绩，外键也是 RESTRICT。
 *
 * 写操作逐个挂 `requirePermission`（不是 router.use 整段挂）：读操作不设权限，
 * 没有 departments.write 的角色天然只读，GET 必须照常放行。
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  createDepartment,
  disableDepartment,
  listDepartments,
  updateDepartment,
} from '../../services/admin.js';
import { requirePermission } from '../../middleware/permission.js';
import { IdParamSchema, operatorOf } from './helpers.js';

const CreateSchema = z.object({
  name: z.string().trim().min(1, '部门名称不能为空').max(100),
  sortOrder: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
});

const PatchSchema = CreateSchema.partial();

export const departmentsRouter: Router = Router();

departmentsRouter.get('/', async (_req, res) => {
  res.json(await listDepartments());
});

departmentsRouter.post('/', requirePermission('departments.write'), async (req, res) => {
  const body = CreateSchema.parse(req.body);
  res.json(await createDepartment(body, operatorOf(req)));
});

departmentsRouter.patch('/:id', requirePermission('departments.write'), async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  const body = PatchSchema.parse(req.body);
  res.json(await updateDepartment(id, body, operatorOf(req)));
});

departmentsRouter.delete('/:id', requirePermission('departments.write'), async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  await disableDepartment(id, operatorOf(req));
  res.status(204).end();
});