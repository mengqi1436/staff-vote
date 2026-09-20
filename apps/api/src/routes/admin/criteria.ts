/**
 * 素质项点（打分表的列）。
 *
 * 硬要求：minScore / maxScore 必须为整数，且 maxScore > minScore —— 否则该项
 * 没有打分空间，计分归一化也会退化成除零。PATCH 时按「合并后的区间」校验，
 * 只改一端导致区间反转同样会被拒。
 *
 * 写操作逐个挂 `requirePermission`（不是 router.use 整段挂）：读操作不设权限，
 * 没有 criteria.write 的角色天然只读，GET 必须照常放行。
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  createCriterion,
  disableCriterion,
  listCriteria,
  updateCriterion,
} from '../../services/admin.js';
import { requirePermission } from '../../middleware/permission.js';
import { IdParamSchema, operatorOf } from './helpers.js';

const ListQuerySchema = z.object({
  departmentId: z.string().min(1).optional(),
});

const CreateSchema = z.object({
  departmentId: z.string().min(1, '必须指定部门'),
  name: z.string().trim().min(1, '项点名称不能为空').max(50),
  minScore: z.number().int(),
  maxScore: z.number().int(),
  sortOrder: z.number().int().min(0).optional(),
});

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  minScore: z.number().int().optional(),
  maxScore: z.number().int().optional(),
  sortOrder: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
});

export const criteriaRouter: Router = Router();

criteriaRouter.get('/', async (req, res) => {
  const { departmentId } = ListQuerySchema.parse(req.query);
  res.json(await listCriteria(departmentId));
});

criteriaRouter.post('/', requirePermission('criteria.write'), async (req, res) => {
  const body = CreateSchema.parse(req.body);
  res.json(await createCriterion(body, operatorOf(req)));
});

criteriaRouter.patch('/:id', requirePermission('criteria.write'), async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  const body = PatchSchema.parse(req.body);
  res.json(await updateCriterion(id, body, operatorOf(req)));
});

criteriaRouter.delete('/:id', requirePermission('criteria.write'), async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  await disableCriterion(id, operatorOf(req));
  res.status(204).end();
});