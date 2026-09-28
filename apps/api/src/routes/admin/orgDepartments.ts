/**
 * 全局部门字典（新建场次向导第一步的部门来源）。
 *
 * 与场内 departments 的关系：字典是跨场次复用的名单，建场次时按所选字典部门
 * 「按名复制」一条到场内；删除字典项不影响已建场次（引用时 409 拦下）。
 *
 * 权限：写操作挂 `departments.write`（字典与场内部门同属部门管理范畴），
 * 读操作不设权限 —— 登录即可读，只读角色也能进建场次向导选部门。
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  createOrgDepartment,
  deleteOrgDepartment,
  listOrgDepartments,
  updateOrgDepartment,
} from '../../services/admin.js';
import { requirePermission } from '../../middleware/permission.js';
import { IdParamSchema, operatorOf } from './helpers.js';

const CreateSchema = z.object({
  name: z.string().trim().min(1, '部门名称不能为空').max(100),
  sortOrder: z.number().int().min(0).optional(),
});

/** PATCH 语义：缺省不改；enabled 显式停用/启用。 */
const PatchSchema = z.object({
  name: CreateSchema.shape.name.optional(),
  sortOrder: CreateSchema.shape.sortOrder,
  enabled: z.boolean().optional(),
});

export const orgDepartmentsRouter: Router = Router();

/** 列表：{ departments: [...] }（与场内部门列表直接返回数组的旧形状无关，新契约带键）。 */
orgDepartmentsRouter.get('/', async (_req, res) => {
  res.json(await listOrgDepartments());
});

orgDepartmentsRouter.post('/', requirePermission('departments.write'), async (req, res) => {
  const body = CreateSchema.parse(req.body);
  // 契约形状：{ department: {...} }
  res.json({ department: await createOrgDepartment(body, operatorOf(req)) });
});

orgDepartmentsRouter.patch('/:id', requirePermission('departments.write'), async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  const body = PatchSchema.parse(req.body);
  res.json({ department: await updateOrgDepartment(id, body, operatorOf(req)) });
});

orgDepartmentsRouter.delete('/:id', requirePermission('departments.write'), async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  await deleteOrgDepartment(id, operatorOf(req));
  res.status(204).end();
});
