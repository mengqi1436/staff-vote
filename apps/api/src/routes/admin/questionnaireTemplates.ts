/**
 * 场次问卷模板（0010 起）：个人 / 车间各一套「附件号 + 标题 + 填写说明」，
 * 所有同类型部门共用——改一处，全场生效。
 *
 *   GET   /?sessionId=&type=person   读一套模板（行不存在返回默认文案）
 *   PATCH /?sessionId=&type=person   改一套模板（PATCH 语义：缺省不改）
 *
 * 权限沿用 departments.write：问卷抬头配置原本就属于部门写权限的职责范围。
 * 写操作逐个挂 `requirePermission`：读操作不设权限，只读角色可看模板。
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  listQuestionnaireTemplate,
  resolveSessionId,
  updateQuestionnaireTemplate,
} from '../../services/admin.js';
import { requirePermission } from '../../middleware/permission.js';
import { operatorOf } from './helpers.js';

/** 问卷表头文案可以清空（表标题留空时不渲染该行），因此不设 min(1)。 */
const TemplateQuerySchema = z.object({
  sessionId: z.string().min(1).optional(),
  type: z.enum(['person', 'workshop']),
});

const TemplatePatchSchema = z.object({
  sessionId: z.string().min(1).optional(),
  type: z.enum(['person', 'workshop']),
  headerNote: z.string().trim().max(50).optional(),
  title: z.string().trim().max(100).optional(),
  footerNote: z.string().trim().max(500).optional(),
});

export const questionnaireTemplatesRouter: Router = Router();

questionnaireTemplatesRouter.get('/', async (req, res) => {
  const { sessionId, type } = TemplateQuerySchema.parse(req.query);
  res.json(await listQuestionnaireTemplate(await resolveSessionId(sessionId), type));
});

questionnaireTemplatesRouter.patch('/', requirePermission('departments.write'), async (req, res) => {
  const { sessionId, type, headerNote, title, footerNote } = TemplatePatchSchema.parse(req.body);
  res.json(
    await updateQuestionnaireTemplate(
      await resolveSessionId(sessionId),
      type,
      { headerNote, title, footerNote },
      operatorOf(req),
    ),
  );
});
