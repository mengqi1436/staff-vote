/**
 * RBAC 管理端点：权限目录、角色、管理员账号。
 *
 * 整段挂在 `requirePermission(MANAGE_PERMISSION)` 之下 —— 没有这个权限的账号
 * 连权限目录都读不到：该目录本身就是「谁能改什么」的地图，没有对外开放的理由。
 * 真正的规则与守卫在 `services/rbac.ts`，这里只做「取参 → 调服务 → 回响应」。
 *
 * 三个资源共用一个 router：它们的权限门控完全相同，拆成三个 router 只会把
 * 同一句 requirePermission 抄三遍。
 *
 * 契约（挂载于 `/api/admin`）：
 *   GET    /permissions   → 权限目录（按 groupName + sortOrder）
 *   GET    /roles         → 角色列表（含权限码数组与使用中的账号数）
 *   POST   /roles         → 创建角色，200
 *   PATCH  /roles/:id     → 改名称/描述/权限（不含 code）
 *   DELETE /roles/:id     → 204；内置角色或仍被账号使用 → 409
 *   GET    /admins        → 账号列表
 *   POST   /admins        → 创建账号，200
 *   PATCH  /admins/:id    → 改角色/启停/重置口令
 *   DELETE /admins/:id    → 204
 */
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/permission.js';
import { MIN_PASSWORD_LENGTH, MANAGE_PERMISSION } from '../../services/rbac.js';
import {
  createAdmin,
  createRole,
  listAdmins,
  listPermissions,
  listRoles,
  removeAdmin,
  removeRole,
  updateAdmin,
  updateRole,
} from '../../services/rbac.js';
import { IdParamSchema, operatorOf } from './helpers.js';

const RoleCreateSchema = z.object({
  code: z.string().trim().min(1, '请输入角色代码').max(64),
  name: z.string().trim().min(1, '请输入角色名称').max(64),
  description: z.string().trim().max(200).nullish(),
  permissions: z.array(z.string().min(1)).default([]),
});

/** 刻意没有 code：角色代码是权限判定的锚点，随请求体传进来也会被剥掉。 */
const RolePatchSchema = z.object({
  name: z.string().trim().min(1, '请输入角色名称').max(64).optional(),
  description: z.string().trim().max(200).nullish(),
  permissions: z.array(z.string().min(1)).optional(),
});

const AdminCreateSchema = z.object({
  username: z.string().trim().min(1, '请输入用户名').max(64),
  password: z.string().min(MIN_PASSWORD_LENGTH, `口令至少 ${MIN_PASSWORD_LENGTH} 位`).max(128),
  roleId: z.string().min(1).nullish(),
});

/** 改角色、启停、重置口令都走这一个 PATCH。 */
const AdminPatchSchema = z.object({
  roleId: z.string().min(1).nullish(),
  enabled: z.boolean().optional(),
  password: z.string().min(MIN_PASSWORD_LENGTH, `口令至少 ${MIN_PASSWORD_LENGTH} 位`).max(128).optional(),
});

/** 当前操作者账号 id。adminAuth 已保证存在，兜底值只为类型收敛。 */
function actorIdOf(req: Request): string {
  return req.admin?.id ?? '';
}

export const rbacRouter: Router = Router();

rbacRouter.use(requirePermission(MANAGE_PERMISSION));

rbacRouter.get('/permissions', (_req, res) => {
  res.json(listPermissions());
});

rbacRouter.get('/roles', async (_req, res) => {
  res.json(await listRoles());
});

rbacRouter.post('/roles', async (req, res) => {
  res.json(await createRole(RoleCreateSchema.parse(req.body), operatorOf(req)));
});

rbacRouter.patch('/roles/:id', async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  res.json(await updateRole(id, RolePatchSchema.parse(req.body), operatorOf(req)));
});

rbacRouter.delete('/roles/:id', async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  await removeRole(id, operatorOf(req));
  res.status(204).end();
});

rbacRouter.get('/admins', async (_req, res) => {
  res.json(await listAdmins());
});

rbacRouter.post('/admins', async (req, res) => {
  res.json(await createAdmin(AdminCreateSchema.parse(req.body), operatorOf(req)));
});

rbacRouter.patch('/admins/:id', async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  res.json(
    await updateAdmin(id, AdminPatchSchema.parse(req.body), actorIdOf(req), operatorOf(req)),
  );
});

rbacRouter.delete('/admins/:id', async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  await removeAdmin(id, actorIdOf(req), operatorOf(req));
  res.status(204).end();
});