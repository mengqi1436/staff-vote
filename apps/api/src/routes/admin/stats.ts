/**
 * 统计与结果。
 *
 * `/results` 与 `/results/export.xlsx` 共用 `services/results.ts` 的同一次计算
 * （内部走 lib/scoring.ts 的 computeResults），保证页面与导出件完全一致。
 */
import { Router } from 'express';
import { z } from 'zod';
import { computeDepartmentResults } from '../../services/results.js';
import { getStatsOverview } from '../../services/stats.js';
import { buildResultsWorkbook, fileStamp, sendWorkbook, workbookToBuffer } from '../../lib/xlsx.js';

/** 结果按部门出：项点列是每部门一套，跨部门汇总没有可比性。 */
const ResultsQuerySchema = z.object({
  departmentId: z.string().min(1, '缺少 departmentId 参数'),
});

export const statsRouter: Router = Router();

statsRouter.get('/overview', async (_req, res) => {
  res.json(await getStatsOverview());
});

export const resultsRouter: Router = Router();

resultsRouter.get('/', async (req, res) => {
  const { departmentId } = ResultsQuerySchema.parse(req.query);
  res.json((await computeDepartmentResults(departmentId)).dto);
});

/** 多 sheet 导出：综合排名、各项明细、参与票种口径。 */
resultsRouter.get('/export.xlsx', async (req, res) => {
  const { departmentId } = ResultsQuerySchema.parse(req.query);
  const { dto, details, ticketTypes } = await computeDepartmentResults(departmentId);

  const workbook = buildResultsWorkbook({
    departmentName: dto.department.name,
    generatedAt: new Date(dto.generatedAt),
    rows: dto.rows.map((row) => ({
      rank: row.rank,
      employeeName: row.employeeName,
      employeeNo: row.employeeNo,
      comprehensiveScore: row.comprehensiveScore,
      criterionCount: row.criteria.length,
    })),
    details,
    ticketTypes,
  });

  sendWorkbook(
    res,
    `评议结果-${dto.department.name}-${fileStamp()}.xlsx`,
    await workbookToBuffer(workbook),
  );
});