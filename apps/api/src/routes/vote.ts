import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { normalizeCode } from '../lib/code.js';
import { voteLoginLimiter } from '../lib/rateLimit.js';
import { verifyVoteToken, type VoteTokenPayload } from '../lib/token.js';
import { ApiError } from '../middleware/errorHandler.js';
import {
  createVoteSession,
  getVoteSheet,
  getVoteStatus,
  submitVote,
} from '../services/vote.js';

/**
 * 投票入口路由，挂载于 `/api/vote`。
 *
 * 契约（见 docs/superpowers/specs/2026-09-19-staff-vote-design.md 第 12.1 节）：
 *
 *   GET  /status                  → { open, message, startAt, endAt }
 *                                   未开放时 message = "当前未开放投票"
 *   POST /session   { code }      → { token, ticketType, departments }
 *                                   校验码存在、未使用、投票开放；限流用 voteLoginLimiter
 *   GET  /sheet?departmentId=     → { department, questionnaireType, headerNote, title, footerNote,
 *                                    criteria[], voteColumns[] }
 *                                   需投票令牌；项点含 description 与 min/max，
 *                                   被评列即打分表的列（个人问卷为各职务，车间问卷为「得分」）
 *   POST /submit    { departmentId, items[{voteColumnId, criterionId, score}] }
 *                                 → { ok: true }
 *                                   需投票令牌；提交即原子核销该码
 *
 * 规则与数据访问在 `services/vote.ts`，本文件只管 HTTP 形状。
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** 由 voteAuth 中间件注入的投票令牌载荷 */
      voteTicket?: VoteTokenPayload;
    }
  }
}

const SessionSchema = z.object({
  code: z.string().min(1, '请填写随机码'),
});

const SubmitSchema = z.object({
  departmentId: z.string().min(1, '请选择部门'),
  items: z
    .array(
      z.object({
        voteColumnId: z.string().min(1),
        criterionId: z.string().min(1),
        // 只收整数：小数、字符串、布尔值一律 400。前端输入框的 step=1 只是提示，不是防线。
        score: z.int(),
      }),
    )
    .min(1, '打分内容不能为空'),
});

/**
 * 投票会话鉴权。
 *
 * 令牌只从 `Authorization: Bearer` 读取，不用 Cookie：投票页与后台同域，
 * 共用 Cookie 会让两套会话互相覆盖。verifyVoteToken 内部强制 `kind === 'vote'`，
 * 因此管理端令牌拿到这里同样被拒。
 */
function voteAuth(req: Request, _res: Response, next: NextFunction): void {
  // 认证方案名按 RFC 7235 不区分大小写，因此用 /i 匹配而不是 startsWith('Bearer ')。
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]?.trim() ?? '';
  const payload = token ? verifyVoteToken(token) : null;

  if (!payload) {
    next(ApiError.unauthorized('投票会话无效或已过期，请重新登录'));
    return;
  }

  req.voteTicket = payload;
  next();
}

export const voteRouter: Router = Router();

/** 投票开放状态。投票页据此渲染「当前未开放投票」遮罩。 */
voteRouter.get('/status', async (_req, res) => {
  res.json(await getVoteStatus());
});

/** 凭随机码换取投票令牌。 */
voteRouter.post('/session', voteLoginLimiter, async (req, res) => {
  const { code } = SessionSchema.parse(req.body);
  res.json(await createVoteSession(normalizeCode(code)));
});

/** 取某部门的打分表骨架（行 = 职工，列 = 项点）。 */
voteRouter.get('/sheet', voteAuth, async (req, res) => {
  const departmentId = typeof req.query.departmentId === 'string' ? req.query.departmentId.trim() : '';
  if (!departmentId) throw ApiError.badRequest('缺少 departmentId');
  res.json(await getVoteSheet(departmentId));
});

/** 提交打分并核销该码，一码一票。 */
voteRouter.post('/submit', voteAuth, async (req, res) => {
  const { departmentId, items } = SubmitSchema.parse(req.body);
  // voteAuth 已保证注入；非空断言只是给类型收窄用（Express 的 Request 类型无法表达
  // "经过某中间件后该字段必然存在"）。
  await submitVote(req.voteTicket!, departmentId, items);
  res.json({ ok: true });
});