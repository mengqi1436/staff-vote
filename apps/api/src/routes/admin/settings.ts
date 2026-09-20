/**
 * 全局设置：投票总开关、开放起止时间、系统标题。
 *
 * 时间统一用 ISO 8601 字符串，空串表示该侧不限制（与 lib/settings.ts 的解析口径一致）。
 * GET 在库里缺行时回落到默认值，避免新部署或测试库没跑 seed 时前端拿到 undefined。
 *
 * 写操作逐个挂 `requirePermission`（不是 router.use 整段挂）：读操作不设权限，
 * 没有 settings.write 的角色天然只读，GET 必须照常放行。
 */
import { Router } from 'express';
import { z } from 'zod';
import { getSettings, updateSettings } from '../../services/admin.js';
import { requirePermission } from '../../middleware/permission.js';
import { operatorOf } from './helpers.js';

/** ISO 8601 时间或空串。Date.parse 对 '2026-09-19T08:00:00+08:00' 这类写法都成立。 */
const isoTimeOrEmpty = z
  .string()
  .trim()
  .refine((value) => value === '' || !Number.isNaN(Date.parse(value)), '必须为 ISO 8601 时间或空串');

const SettingsPatchSchema = z.object({
  'vote.open': z.enum(['true', 'false']).optional(),
  'vote.startAt': isoTimeOrEmpty.optional(),
  'vote.endAt': isoTimeOrEmpty.optional(),
  'system.title': z.string().trim().min(1, '系统标题不能为空').max(100).optional(),
});

export const settingsRouter: Router = Router();

settingsRouter.get('/', async (_req, res) => {
  res.json(await getSettings());
});

settingsRouter.put('/', requirePermission('settings.write'), async (req, res) => {
  const patch = SettingsPatchSchema.parse(req.body);
  res.json(await updateSettings(patch, operatorOf(req)));
});