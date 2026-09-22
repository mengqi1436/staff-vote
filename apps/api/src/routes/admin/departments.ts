/**
 * 部门管理。删除为软删除（enabled = false）：部门一旦产生过评分，
 * 物理删除会连带毁掉历史成绩，外键也是 RESTRICT。
 *
 * 除名称与排序外，本路由还负责**问卷表头配置**（问卷类型、附件号、标题、填写说明）：
 * 参考表的抬头与表尾说明都由这里持久化，后台「问卷配置」页保存的就是这几个字段。
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
  resolveSessionId,
  updateDepartment,
} from '../../services/admin.js';
import { requirePermission } from '../../middleware/permission.js';
import { IdParamSchema, operatorOf } from './helpers.js';

/** 列表类接口的场次过滤：?sessionId= 可选，未带时单场自动解析、多场 400。 */
const ListQuerySchema = z.object({
  sessionId: z.string().min(1).optional(),
});

const CreateSchema = z.object({
  sessionId: z.string().min(1).optional(),
  name: z.string().trim().min(1, '部门名称不能为空').max(100),
  sortOrder: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
});

/** 问卷表头文案可以清空（表标题留空时不渲染该行），因此不设 min(1)。 */
const PatchSchema = CreateSchema.partial().extend({
  questionnaireType: z.enum(['person', 'workshop']).optional(),
  headerNote: z.string().trim().max(50).optional(),
  title: z.string().trim().max(100).optional(),
  footerNote: z.string().trim().max(500).optional(),
});

export const departmentsRouter: Router = Router();

departmentsRouter.get('/', async (req, res) => {
  const { sessionId } = ListQuerySchema.parse(req.query);
  // 未带 sessionId：单场自动解析，多场 400 SESSION_REQUIRED（契约统一规则）。
  res.json(await listDepartments(await resolveSessionId(sessionId)));
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