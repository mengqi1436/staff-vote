/**
 * 全局人员目录（人员管理）。
 *
 * 两条入口分开放：
 *   - `POST /sync` 给外部系统定期推送，鉴权走 `X-Sync-Token`（无 Cookie 会话），
 *     因此挂在 adminAuth **之前**；
 *   - 其余 CRUD 是后台页面用的，跟随 adminAuth，写操作挂 `employees.write`。
 *
 * 权限复用 `employees.write`：人员管理就是「管理职工名单」这件事本身，
 * 新增权限码会让既有角色在 seed 后仍然没有授权（seed 不覆盖管理员改过的授权）。
 */
import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/permission.js';
import { staffSyncAuth } from '../../middleware/staffSyncAuth.js';
import {
  createStaffEntry,
  disableStaffEntry,
  getStaffEntry,
  listStaffDirectory,
  syncStaffDirectory,
  updateStaffEntry,
} from '../../services/staffDirectory.js';
import { IdParamSchema, operatorOf } from './helpers.js';

// -----------------------------------------------------------------------------
// 外部同步（无 Cookie 鉴权）
// -----------------------------------------------------------------------------

const SyncRowSchema = z.object({
  employeeNo: z.string().trim().min(1, '工号不能为空'),
  name: z.string().trim().min(1, '姓名不能为空'),
  gender: z.string().trim().max(10).nullable().optional(),
  age: z.number().int().min(0).max(150).nullable().optional(),
  title: z.string().trim().max(50).nullable().optional(),
  /** 部门名称，按名称匹配全局部门列表。 */
  department: z.string().trim().max(100).nullable().optional(),
});

const SyncSchema = z.object({
  /** replace = 本次名单视为全量，名单外的人停用；upsert = 只写名单里的人。 */
  mode: z.enum(['upsert', 'replace']).default('upsert'),
  staff: z.array(SyncRowSchema).min(1, '同步名单不能为空').max(5000),
});

export const staffDirectorySyncRouter: Router = Router();

staffDirectorySyncRouter.post('/sync', staffSyncAuth, async (req, res) => {
  const body = SyncSchema.parse(req.body);
  res.json(await syncStaffDirectory(body.staff, { mode: body.mode }, 'external-sync'));
});

// -----------------------------------------------------------------------------
// 后台 CRUD（跟随 adminAuth）
// -----------------------------------------------------------------------------

const ListQuerySchema = z.object({
  q: z.string().trim().optional(),
  orgDepartmentId: z.string().min(1).optional(),
  /** false = 连停用的一起返回；缺省只看启用的。 */
  enabledOnly: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const CreateSchema = z.object({
  employeeNo: z.string().trim().min(1, '工号不能为空').max(50),
  name: z.string().trim().min(1, '姓名不能为空').max(64),
  gender: z.string().trim().max(10).nullable().optional(),
  age: z.number().int().min(0).max(150).nullable().optional(),
  title: z.string().trim().max(50).nullable().optional(),
  orgDepartmentId: z.string().min(1).nullable().optional(),
});

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  gender: z.string().trim().max(10).nullable().optional(),
  age: z.number().int().min(0).max(150).nullable().optional(),
  title: z.string().trim().max(50).nullable().optional(),
  orgDepartmentId: z.string().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
});

export const staffDirectoryRouter: Router = Router();

staffDirectoryRouter.get('/', async (req, res) => {
  const query = ListQuerySchema.parse(req.query);
  res.json(
    await listStaffDirectory({
      q: query.q,
      orgDepartmentId: query.orgDepartmentId,
      enabledOnly: query.enabledOnly !== 'false',
      limit: query.limit,
    }),
  );
});

staffDirectoryRouter.get('/:id', async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  res.json(await getStaffEntry(id));
});

staffDirectoryRouter.post('/', requirePermission('employees.write'), async (req, res) => {
  const body = CreateSchema.parse(req.body);
  res.json(await createStaffEntry(body, operatorOf(req)));
});

staffDirectoryRouter.patch('/:id', requirePermission('employees.write'), async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  const body = PatchSchema.parse(req.body);
  res.json(await updateStaffEntry(id, body, operatorOf(req)));
});

staffDirectoryRouter.delete('/:id', requirePermission('employees.write'), async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  await disableStaffEntry(id, operatorOf(req));
  res.status(204).end();
});
