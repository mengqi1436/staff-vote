/**
 * 全局设置（当前仅系统标题）。投票开放窗口按场次配置（vote_sessions.opens_at / closes_at）。
 *
 * GET 在库里缺行时回落到默认值，避免新部署或测试库没跑 seed 时前端拿到 undefined。
 * 已退役的键（vote.open / vote.startAt / vote.endAt）由 zod 剥离：请求成功但不落库。
 *
 * 写操作逐个挂 `requirePermission`（不是 router.use 整段挂）：读操作不设权限，
 * 没有 settings.write 的角色天然只读，GET 必须照常放行。
 */
import { Router } from 'express';
import { z } from 'zod';
import { getSettings, updateSettings } from '../../services/admin.js';
import { requirePermission } from '../../middleware/permission.js';
import { operatorOf } from './helpers.js';

const SettingsPatchSchema = z.object({
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