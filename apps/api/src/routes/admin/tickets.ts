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
  TICKET_STATUS_LABELS,
  generateTickets,
  listTicketBatches,
  listTickets,
  listTicketsForExport,
  revokeTicket,
  revokeTicketsBulk,
  type TicketStatusValue,
} from '../../services/admin.js';
import { buildTicketsWorkbook, fileStamp, sendWorkbook, workbookToBuffer } from '../../lib/xlsx.js';
import { requirePermission } from '../../middleware/permission.js';
import { IdParamSchema, operatorOf } from './helpers.js';

// 从 LABELS 派生而非再写一遍字面量：状态集合的单一真源在 Prisma 生成的枚举，
// LABELS 的 Record<TicketStatusValue, string> 类型保证 keys 恰好覆盖全部状态。
const TICKET_STATUSES = Object.keys(TICKET_STATUS_LABELS) as [TicketStatusValue, ...TicketStatusValue[]];

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  status: z.enum(TICKET_STATUSES).optional(),
  ticketTypeId: z.string().min(1).optional(),
});

const ExportQuerySchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  ticketTypeId: z.string().min(1).optional(),
});

const GenerateSchema = z.object({
  ticketTypeId: z.string().min(1),
  count: z.number().int().min(1).max(2000),
});

/** 一键作废的范围：不带 body 或不带 ticketTypeId 都是「全部票种」。 */
const RevokeBulkSchema = z.object({
  ticketTypeId: z.string().min(1).optional(),
});

export const ticketsRouter: Router = Router();

ticketsRouter.get('/', async (req, res) => {
  const query = ListQuerySchema.parse(req.query);
  res.json(await listTickets(query));
});

/** 导出随机码清单（列：随机码、票种、状态、核销时间、批次、创建时间）。 */
ticketsRouter.get('/export', async (req, res) => {
  const filter = ExportQuerySchema.parse(req.query);
  const rows = await listTicketsForExport(filter);
  // 状态用中文，导出件是给人看的，不是给程序解析的。
  const workbook = buildTicketsWorkbook(
    rows.map((row) => ({
      code: row.code,
      ticketType: `${row.ticketType.code} ${row.ticketType.name}`.trim(),
      status: TICKET_STATUS_LABELS[row.status],
      usedAt: row.usedAt,
      batchId: row.batchId,
      createdAt: row.createdAt,
    })),
  );
  sendWorkbook(res, `随机码清单-${fileStamp()}.xlsx`, await workbookToBuffer(workbook));
});

ticketsRouter.post('/generate', requirePermission('tickets.generate'), async (req, res) => {
  const { ticketTypeId, count } = GenerateSchema.parse(req.body);
  const result = await generateTickets(ticketTypeId, count, operatorOf(req));
  res.json(result);
});

/**
 * 一键作废：把当前范围内的全部未使用码作废。
 *
 * 注册在 `/:id/revoke` 之前只是可读性上的顺序（两者路径段数不同，不会互相匹配）。
 */
ticketsRouter.post('/revoke-bulk', requirePermission('tickets.revoke'), async (req, res) => {
  const { ticketTypeId } = RevokeBulkSchema.parse(req.body ?? {});
  res.json(await revokeTicketsBulk({ ticketTypeId }, operatorOf(req)));
});

ticketsRouter.post('/:id/revoke', requirePermission('tickets.revoke'), async (req, res) => {
  const { id } = IdParamSchema.parse(req.params);
  res.json(await revokeTicket(id, operatorOf(req)));
});

export const ticketBatchesRouter: Router = Router();

ticketBatchesRouter.get('/', async (_req, res) => {
  res.json(await listTicketBatches());
});