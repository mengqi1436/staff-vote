/**
 * 统计与结果。
 *
 * `/results` 与 `/results/export.xlsx` 共用 `services/results.ts` 的同一次计算
 * （内部走 lib/scoring.ts 的 computeResults），保证页面与导出件完全一致。
 */
import { Router } from 'express';
import { z } from 'zod';
import { resolveSessionId } from '../../services/admin.js';
import { computeDepartmentResults } from '../../services/results.js';
import { getStatsOverview } from '../../services/stats.js';
import { buildResultsWorkbook, fileStamp, sendWorkbook, workbookToBuffer } from '../../lib/xlsx.js';

/** 结果按部门出：项点列是每部门一套，跨部门汇总没有可比性。 */
const ResultsQuerySchema = z.object({
  departmentId: z.string().min(1, '缺少 departmentId 参数'),
});

/** 统计的场次过滤：未带时单场自动解析，多场 400 SESSION_REQUIRED。 */
const StatsQuerySchema = z.object({
  sessionId: z.string().min(1).optional(),
});

export const statsRouter: Router = Router();

statsRouter.get('/overview', async (req, res) => {
  const { sessionId } = StatsQuerySchema.parse(req.query);
  res.json(await getStatsOverview(await resolveSessionId(sessionId)));
});

export const resultsRouter: Router = Router();

resultsRouter.get('/', async (req, res) => {
  const { departmentId } = ResultsQuerySchema.parse(req.query);
  res.json((await computeDepartmentResults(departmentId)).dto);
});

/** 多 sheet 导出：综合排名、各项明细、参与票种口径、票别单项/合计明细。 */
resultsRouter.get('/export.xlsx', async (req, res) => {
  const { departmentId } = ResultsQuerySchema.parse(req.query);
  const { dto, details, ticketTypes, perTicketType } = await computeDepartmentResults(departmentId);

  const workbook = buildResultsWorkbook({
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
  });

  sendWorkbook(
    res,
    `评议结果-${dto.department.name}-${fileStamp()}.xlsx`,
    await workbookToBuffer(workbook),
  );
});