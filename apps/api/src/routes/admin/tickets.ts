/**
 * 随机码：发码、分页查询、导出、作废（单张与一键），以及发码批次列表。
 *
 * 作废只针对 `unused` 的码，且用带状态条件的原子更新实现（见 services/admin.ts），
 * 避免两次并发作废或「已核销后又被作废」。
 *
 * 写操作的权限（requirePermission）挂在这里而不是服务层：服务层保持纯粹的「业务规则」，
 * 鉴权归属 HTTP 边界；发码与作废分别受 tickets.generate / tickets.revoke 控制。
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  generateTickets,
  listTicketBatches,
  listTickets,
  listTicketsForExport,
  resolveSessionId,
  revokeTicket,
  revokeTicketsBulk,
} from '../../services/admin.js';
import { loadTicketAnswerExport } from '../../services/results.js';
import {
  buildAnswerSheetWorkbook,
  buildTicketsWorkbook,
  fileStamp,
  sendWorkbook,
  workbookToBuffer,
} from '../../lib/xlsx.js';
import { requirePermission } from '../../middleware/permission.js';
import { IdParamSchema, operatorOf } from './helpers.js';

// 匿名边界（设计要求第 1 条「不记名投票」）：列表与导出都不接受 status 条件 ——
// 查询一律由服务层固定为只出「未使用」的码，管理员无法按「已使用」筛选来反推谁投了票。
const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  ticketTypeId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
});

const ExportQuerySchema = z.object({
  ticketTypeId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
});

const GenerateSchema = z.object({
  sessionId: z.string().min(1).optional(),
  ticketTypeId: z.string().min(1),
  count: z.number().int().min(1).max(2000),
  /** 评议部门绑定；缺省 = 不限定（持码人可评全部部门）。 */
  departmentId: z.string().uuid().optional(),
});

/** 一键作废的范围：场次必传（误作废历史场次的有效票无法挽回）；
 *  不带 ticketTypeId 即该场次「全部票种」。 */
const RevokeBulkSchema = z.object({
  sessionId: z.string().min(1, '缺少 sessionId'),
  ticketTypeId: z.string().min(1).optional(),
});

/** 批次列表的场次过滤。 */
const BatchesQuerySchema = z.object({
  sessionId: z.string().min(1).optional(),
});

export const ticketsRouter: Router = Router();

ticketsRouter.get('/', async (req, res) => {
  const query = ListQuerySchema.parse(req.query);
  res.json(await listTickets({ ...query, sessionId: await resolveSessionId(query.sessionId) }));
});

/** 导出随机码清单（发放对账材料，仅未使用的码；列：随机码、票种、批次、创建时间）。 */
ticketsRouter.get('/export', async (req, res) => {
  const filter = ExportQuerySchema.parse(req.query);
  const rows = await listTicketsForExport({
    ...filter,
    sessionId: await resolveSessionId(filter.sessionId),
  });
  const workbook = buildTicketsWorkbook(
    rows.map((row) => ({
      code: row.code,
      ticketType: `${row.ticketType.code} ${row.ticketType.name}`.trim(),
      batchId: row.batchId,
      createdAt: row.createdAt,
    })),
  );
  sendWorkbook(res, `随机码清单-${fileStamp()}.xlsx`, await workbookToBuffer(workbook));
});

ticketsRouter.post('/generate', requirePermission('tickets.generate'), async (req, res) => {
  const { ticketTypeId, count, sessionId, departmentId } = GenerateSchema.parse(req.body);
  const result = await generateTickets(ticketTypeId, count, operatorOf(req), {
    sessionId,
    departmentId,
  });
  res.json(result);
});

/**
 * 一键作废：把该场次范围内的全部未使用码作废。
 *
 * 注册在 `/:id/revoke` 之前只是可读性上的顺序（两者路径段数不同，不会互相匹配）。
 */
ticketsRouter.post('/revoke-bulk', requirePermission('tickets.revoke'), async (req, res) => {
  const { sessionId, ticketTypeId } = RevokeBulkSchema.parse(req.body ?? {});
  res.json(await revokeTicketsBulk({ sessionId, ticketTypeId }, operatorOf(req)));
});

ticketsRouter.post('/:id/revoke', requirePermission('tickets.revoke'), async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  res.json(await revokeTicket(id, operatorOf(req)));
});

/**
 * 按随机码导出答卷（附件8 形态，results.export 门内）。
 *
 * 这是 sheet_ticket_map 受控映射的两个读取方之一（另一个是整场导出的答卷汇总）：
 * 评分与统计链路不 join 该映射，匿名边界不变 —— 这里是管理员凭 results.export
 * 权限做的受控导出，而非投票数据的常规读取路径。
 */
ticketsRouter.get('/:id/export.xlsx', requirePermission('results.export'), async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  const answer = await loadTicketAnswerExport(id);
  sendWorkbook(
    res,
    `答卷-${answer.departmentName}-${fileStamp(answer.submittedAt)}.xlsx`,
    await workbookToBuffer(buildAnswerSheetWorkbook(answer)),
  );
});

export const ticketBatchesRouter: Router = Router();

ticketBatchesRouter.get('/', async (req, res) => {
  const { sessionId } = BatchesQuerySchema.parse(req.query);
  res.json(await listTicketBatches(await resolveSessionId(sessionId)));
});