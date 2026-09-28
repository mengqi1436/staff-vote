/**
 * 投票场次管理：列表、创建（向导第一步）、编辑与状态机控制，以及向导第三步的
 * 票别分配（ticket-plan）与整场整合导出。
 *
 * 状态机（draft → voting ⇄ paused → ended，ended 终态）：
 *   PATCH /:id       更新名称与开放时间窗（opensAt / closesAt，null=清空）
 *   POST /:id/start  draft|paused → voting（首次 start 写 startAt）；
 *                    draft→voting 前做完整性校验，缺项 409 SESSION_INCOMPLETE
 *   POST /:id/pause  voting → paused
 *   POST /:id/end    voting|paused → ended（写 endedAt，之后不可逆）
 * 非法流转返回 409 INVALID_SESSION_TRANSITION。
 *
 * 票别分配 PUT /:id/ticket-plan：一次提交启用票种全集并自动发码，
 * 权限同时要求 ticketTypes.write 与 tickets.generate（既改票种又发码）。
 *
 * 整场导出 GET /:id/export.xlsx：多 sheet 统分排名 + 答卷汇总（results.export）。
 *
 * 场次的开停与「投票开放窗口」同属评议执行控制，沿用 settings.write 权限码；
 * 写操作逐个挂 requirePermission：列表读操作不设权限，只读角色可看场次状态。
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  applyTicketPlan,
  createSession,
  listSessions,
  transitionSession,
  updateSession,
} from '../../services/admin.js';
import { loadSessionAnswerSummary, computeDepartmentResults } from '../../services/results.js';
import { prisma } from '../../db.js';
import { ApiError } from '../../middleware/errorHandler.js';
import {
  buildSessionWorkbook,
  fileStamp,
  sendWorkbook,
  workbookToBuffer,
} from '../../lib/xlsx.js';
import { requirePermission } from '../../middleware/permission.js';
import { IdParamSchema, operatorOf } from './helpers.js';

const CreateSchema = z.object({
  name: z.string().trim().min(1, '场次名称不能为空').max(64, '场次名称最长 64 个字符'),
  orgDepartmentId: z.string().uuid('部门标识不合法'),
  opensAt: isoTimeField(),
  /** 可空：留空（null/缺省）= 永久开放。 */
  closesAt: isoTimeField().nullable().optional(),
});

/** ISO 8601 时间；Date.parse 对 '2026-09-19T08:00:00+08:00' 这类写法都成立。 */
function isoTimeField() {
  return z.string().refine((value) => !Number.isNaN(Date.parse(value)), '必须为 ISO 8601 时间');
}

/** PATCH 语义：缺省（undefined）= 不改；显式 null = 清空（该侧恢复不限制）。 */
const UpdateSchema = z.object({
  name: z.string().trim().min(1, '场次名称不能为空').max(100).optional(),
  opensAt: isoTimeField().nullable().optional(),
  closesAt: isoTimeField().nullable().optional(),
  /** 打分范围：person 仅个人问卷 / both 两张问卷都打。 */
  scoreScope: z.enum(['person', 'both']).optional(),
});

const ActionParamSchema = z.object({
  id: z.string().min(1),
  /** start | pause | end */
  action: z.enum(['start', 'pause', 'end']),
});

/** 票别分配的一行：编码 1-8 字符、名称 1-32 字符、权重整数、数量 ≥0。 */
const TicketPlanSchema = z.object({
  types: z
    .array(
      z.object({
        code: z.string().trim().min(1, '票种编码不能为空').max(8, '票种编码最长 8 个字符'),
        name: z.string().trim().min(1, '票种名称不能为空').max(32, '票种名称最长 32 个字符'),
        weightPercent: z.number().int('权重必须为整数').min(0, '权重不能为负'),
        count: z.number().int('数量必须为整数').min(0, '数量不能为负'),
      }),
    )
    // 同一次提交里编码重复会让「启用票种全集」出现歧义，直接在校验层拦下。
    .refine(
      (types) => new Set(types.map((type) => type.code)).size === types.length,
      '票种编码在本次提交中重复',
    ),
});

export const sessionsRouter: Router = Router();

sessionsRouter.get('/', async (_req, res) => {
  res.json(await listSessions());
});

sessionsRouter.post('/', requirePermission('settings.write'), async (req, res) => {
  const body = CreateSchema.parse(req.body);
  // 契约形状：{ session: {...} }（与 GET 的 { sessions: [...] } 对齐）
  res.json({ session: await createSession(body, operatorOf(req)) });
});

/** 更新名称与开放时间窗：{ session: {...} }，形状同 create。 */
sessionsRouter.patch('/:id', requirePermission('settings.write'), async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  const body = UpdateSchema.parse(req.body);
  res.json({ session: await updateSession(id, body, operatorOf(req)) });
});

/**
 * 票别分配（向导第三步）：本次提交集合 = 启用票种全集，权重合计必须 100，
 * count>0 的票种自动建批次发码（响应不返回明文码）。
 * 先挂 ticketTypes.write 再挂 tickets.generate：两个权限缺一不可。
 */
sessionsRouter.put(
  '/:id/ticket-plan',
  requirePermission('ticketTypes.write'),
  requirePermission('tickets.generate'),
  async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    const body = TicketPlanSchema.parse(req.body);
    res.json(await applyTicketPlan(id, body, operatorOf(req)));
  },
);

/** 整场整合导出：每个启用部门一组的统分与排名 + 末尾「答卷汇总」sheet。 */
sessionsRouter.get('/:id/export.xlsx', requirePermission('results.export'), async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  const session = await prisma.voteSession.findUnique({ where: { id }, select: { name: true } });
  if (!session) throw ApiError.notFound('场次不存在');

  // 每个启用部门一组：结果页与导出共用 computeDepartmentResults 的同一次计算。
  const departments = await prisma.department.findMany({
    where: { sessionId: id, enabled: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true },
  });
  const parts = await Promise.all(
    departments.map(async (department) => {
      const { dto, details, ticketTypes, perTicketType } = await computeDepartmentResults(
        department.id,
      );
      return {
        label: department.name,
        input: {
          departmentName: dto.department.name,
          generatedAt: new Date(dto.generatedAt),
          rows: dto.rows.map((row) => ({
            rank: row.rank,
            voteColumnName: row.voteColumnName,
            comprehensiveScore: row.comprehensiveScore,
            criterionCount: row.criteria.length,
          })),
          details,
          ticketTypes,
          perTicketType,
        },
      };
    }),
  );
  const summary = await loadSessionAnswerSummary(id);

  sendWorkbook(
    res,
    `评议整合-${session.name}-${fileStamp()}.xlsx`,
    await workbookToBuffer(buildSessionWorkbook(parts, summary)),
  );
});

/** 统一注册 start / pause / end 三个流转端点。 */
for (const action of ['start', 'pause', 'end'] as const) {
  sessionsRouter.post(`/:id/${action}`, requirePermission('settings.write'), async (req, res) => {
    const { id } = ActionParamSchema.parse({ ...req.params, action });
    // 契约形状：{ session: {...} }，与 create / PATCH 一致
    res.json({ session: await transitionSession(id, action, operatorOf(req)) });
  });
}
