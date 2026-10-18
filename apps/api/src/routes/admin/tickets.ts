/**
 * 随机码：发码、分页查询、导出、作废（单张与一键）。
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
  findSessionName,
  findSessionNameByBatches,
  generateTickets,
  listTickets,
  listTicketsByBatches,
  listTicketsForExport,
  resolveSessionId,
  revokeTicket,
  revokeTicketsBulk,
} from '../../services/admin.js';
import { loadTicketAnswerExport } from '../../services/results.js';
import {
  buildAnswerSheetWorkbook,
  buildTicketsByTypeWorkbook,
  buildTicketsWorkbook,
  fileStamp,
  safeFileLabel,
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

/** 发码结果导出：按批次取码，一次最多 20 个批次（一次发码每个人员类别一个批次）。 */
const BatchExportSchema = z.object({
  batchIds: z
    .string()
    .min(1, '缺少 batchIds')
    .refine(
      (value) => value.split(',').filter((id) => id.trim().length > 0).length <= 20,
      '一次最多导出 20 个批次',
    ),
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

export const ticketsRouter: Router = Router();

ticketsRouter.get('/', async (req, res) => {
  const query = ListQuerySchema.parse(req.query);
  res.json(await listTickets({ ...query, sessionId: await resolveSessionId(query.sessionId) }));
});

/** 导出随机码清单（发放对账材料，仅未使用的码；列：随机码、人员类别、批次、创建时间）。 */
ticketsRouter.get('/export', async (req, res) => {
  const filter = ExportQuerySchema.parse(req.query);
  const sessionId = await resolveSessionId(filter.sessionId);
  const rows = await listTicketsForExport({ ...filter, sessionId });
  const sessionName = await findSessionName(sessionId);
  const label = safeFileLabel(sessionName ?? '');
  const workbook = buildTicketsWorkbook(
    rows.map((row) => ({
      code: row.code,
      ticketType: `${row.ticketType.code} ${row.ticketType.name}`.trim(),
      batchId: row.batchId,
      createdAt: row.createdAt,
    })),
  );
  sendWorkbook(res, `${label}-随机码清单-${fileStamp()}.xlsx`, await workbookToBuffer(workbook));
});

/**
 * 发码结果导出：**一列一个票别**，列下是该票别的随机码。
 *
 * 按批次在服务端取码（前端刚生成的那几个批次），不接受回传的码本身：
 * 码是敏感材料，不走上行请求体，也不进日志。每个票别一次发码产生一个批次。
 */
ticketsRouter.get('/export-by-type.xlsx', async (req, res) => {
  const { batchIds } = BatchExportSchema.parse(req.query);
  const ids = batchIds
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const rows = await listTicketsByBatches(ids);

  // 按票别分组，组顺序沿用查询里的票种 sortOrder（Map 保持插入顺序）
  const groups = new Map<string, { header: string; codes: string[] }>();
  for (const row of rows) {
    const header = `${row.ticketType.name}（${row.ticketType.code}）`;
    const group = groups.get(header) ?? { header, codes: [] };
    group.codes.push(row.code);
    groups.set(header, group);
  }

  // 文件名用场次名：一次发码可能跨多个票别，但都属于同一个场次
  const sessionName = await findSessionNameByBatches(ids);
  const label = safeFileLabel(sessionName ?? '');
  const workbook = buildTicketsByTypeWorkbook([...groups.values()]);
  sendWorkbook(res, `${label}-随机码-${fileStamp()}.xlsx`, await workbookToBuffer(workbook));
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