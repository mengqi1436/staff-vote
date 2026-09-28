import { prisma } from '../db.js';
import {
  evaluateVoteWindow,
  VOTE_CLOSED_MESSAGE,
  type VoteWindowState,
  type VoteWindowSession,
} from '../lib/settings.js';
import { signVoteToken, type VoteTokenPayload } from '../lib/token.js';
import { ApiError } from '../middleware/errorHandler.js';
import { z } from 'zod';

/**
 * 投票入口的业务逻辑。
 *
 * 分层：路由只负责 HTTP 形状（解析请求、装配响应、抛 ApiError），
 * 规则与数据访问都在这里，因此每条规则都能被接口测试直接命中。
 *
 * 匿名边界（设计文档 13.3）：写 `score_sheets` 时只落
 * departmentId / ticketTypeId / submittedAt 三列，**绝不**写 ticketId、IP、User-Agent。
 * 这是「无法从评分反推投票人」的物理保证：连字段都不存在，后续改动就无法"顺手"关联。
 */

/** 投票人可见的票种信息。只到票种粒度，不含任何票据标识。 */
export interface TicketTypeView {
  id: string;
  code: string;
  name: string;
  /** 计分权重百分比，投票页可据此提示"你的票种占 X%" */
  weightPercent: number;
}

export interface DepartmentView {
  id: string;
  name: string;
}

export interface CriterionView {
  id: string;
  name: string;
  /** 项点描述，显示在打分表项点名称下方（参考表里的长文字） */
  description: string | null;
  minScore: number;
  maxScore: number;
}

/** 被评列：打分表的「列」。个人问卷是各被评职务，车间问卷只有一列「得分」。 */
export interface VoteColumnView {
  id: string;
  name: string;
  /** 该职务列对应的具体被评人姓名（表头第二行「职务与姓名」），未选人为 null。 */
  employeeName: string | null;
}

export interface VoteSessionResult {
  token: string;
  ticketType: TicketTypeView;
  /** 票所属场次：前端展示与后续 /status?sessionId= 查询都用它 */
  session: { id: string; name: string; status: string };
  departments: DepartmentView[];
}

/** 打分表：表头文案 + 项点（行）+ 被评列（列）。 */
export interface VoteSheetResult {
  department: DepartmentView;
  /** person = 个人问卷，workshop = 车间问卷 */
  questionnaireType: string;
  /** 左上角附件号，如「附件1-1」 */
  headerNote: string;
  /** 表标题，如「xx车间负责人评价问卷」 */
  title: string;
  /** 表尾填写说明 */
  footerNote: string;
  criteria: CriterionView[];
  voteColumns: VoteColumnView[];
}

/** 一个待写入的打分单元格。 */
export interface SubmitItem {
  voteColumnId: string;
  criterionId: string;
  score: number;
}

/**
 * 读取投票开放状态。
 *
 * 传入场次时按该场次精确判定；不传（/status 未带 sessionId）时聚合判定：
 * 库中存在任一场次 status=voting 且在其窗口内即开放——多场部署下
 * 投票首页不该因「没选场」而关死（聚合判定拿不到单一场次的时间，回传 null）。
 *
 * @param session 待判定的场次（含 status 与开放时间窗）；不传做聚合判定
 * @returns 开放标志、对职工显示的文案与场次开放时间
 */
export async function getVoteStatus(
  session?: VoteWindowSession | null,
): Promise<VoteWindowState> {
  if (session) return evaluateVoteWindow(session);

  const candidates = await prisma.voteSession.findMany({
    select: { status: true, opensAt: true, closesAt: true },
  });
  const now = new Date();
  for (const row of candidates) {
    const state = evaluateVoteWindow(row, now);
    if (state.open) return state;
  }
  return { open: false, message: VOTE_CLOSED_MESSAGE, opensAt: null, closesAt: null };
}

/**
 * 解析 /status 查询里可选的场次。
 *
 * 显式指定 → 校验存在；未指定 → 库里恰有一场时用那一场（单场部署的时间窗
 * 因此能回传给前端；恰一场时聚合判定与该场判定等价），零场或多场返回 null，
 * 由 getVoteStatus 做聚合判定。
 *
 * @param sessionId 查询参数里的场次 ID，可空
 * @returns 场次行或 null
 */
export async function resolveStatusSession(sessionId?: string): Promise<{
  id: string;
  name: string;
  status: string;
  opensAt: Date | null;
  closesAt: Date | null;
} | null> {
  if (sessionId) {
    const found = await prisma.voteSession.findUnique({
      where: { id: sessionId },
      select: { id: true, name: true, status: true, opensAt: true, closesAt: true },
    });
    if (!found) throw ApiError.badRequest('场次不存在', 'SESSION_NOT_FOUND');
    return found;
  }
  const rows = await prisma.voteSession.findMany({
    select: { id: true, name: true, status: true, opensAt: true, closesAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.length === 1 ? rows[0]! : null;
}

/**
 * 凭随机码换取投票会话。
 *
 * 校验顺序固定为「码存在 → 码未用 → 投票开放」：无效码与已用码在任何时候都得到
 * 同一种拒绝，不因为窗口开没开而泄露码的存在性。
 *
 * @param code 已规范化（去空白、转大写）的随机码
 * @returns 投票令牌（载荷只含票据 ID 与票种 ID，不含码明文）与启用部门列表
 */
export async function createVoteSession(code: string): Promise<VoteSessionResult> {
  const ticket = await prisma.ticket.findUnique({
    where: { code },
    include: {
      ticketType: true,
      // 票所属场次：开放判定（status + 场次时间窗）与响应都要用（各场次数据隔离）。
      session: { select: { id: true, name: true, status: true, opensAt: true, closesAt: true } },
    },
  });

  if (!ticket) throw ApiError.unauthorized('随机码无效，请核对后重试', 'INVALID_CODE');
  if (ticket.status === 'used') throw ApiError.unauthorized('该票据已使用', 'TICKET_USED');
  if (ticket.status === 'revoked') throw ApiError.unauthorized('该票据已作废', 'TICKET_REVOKED');

  // 开放 = 本场次处于 voting 且当前时间在场次时间窗内。
  const status = evaluateVoteWindow(ticket.session);
  if (!status.open) throw ApiError.forbidden(VOTE_CLOSED_MESSAGE, 'VOTE_CLOSED');

  // 部门绑定：绑定码只返回被绑定的部门（停用则自然查不出 → 空数组，Gate 有零部门兜底）；
  // NULL = 不限定，保持「万能码」语义返回全部启用部门（存量码兼容）。
  const departments = await prisma.department.findMany({
    where: {
      enabled: true,
      sessionId: ticket.sessionId,
      ...(ticket.departmentId ? { id: ticket.departmentId } : {}),
    },
    // sortOrder 相同时用 id 兜底，保证顺序稳定：管理端调整排序时表格不应跳动。
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true },
  });

  return {
    token: signVoteToken(ticket.id, ticket.ticketTypeId),
    ticketType: {
      id: ticket.ticketType.id,
      code: ticket.ticketType.code,
      name: ticket.ticketType.name,
      weightPercent: ticket.ticketType.weightPercent,
    },
    session: {
      id: ticket.session.id,
      name: ticket.session.name,
      status: ticket.session.status,
    },
    departments,
  };
}

/**
 * 取某部门的打分表骨架。
 * 停用部门与不存在的部门同样返回 404：软删除的数据对外就当不存在。
 * 部门必须属于票所在场次：跨场次的 departmentId 在查询条件里直接落空（404），
 * 一个码只能看到并使用自己场次的打分表。
 *
 * 表形与参考表一致：行 = 评价项点（含描述），列 = 被评列（职务 / 得分），
 * 外加表头的附件号、标题与表尾填写说明。
 *
 * @param ticketId 投票令牌载荷里的票据 ID（用于锁定场次）
 * @param departmentId 被评部门
 * @returns 部门、问卷表头文案、项点行与被评列，均只含启用项并按 sortOrder 升序
 */
export async function getVoteSheet(ticketId: string, departmentId: string): Promise<VoteSheetResult> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { sessionId: true, departmentId: true },
  });
  if (!ticket) throw ApiError.conflict('该票据已使用，不能重复提交', 'TICKET_USED');

  // 部门绑定强校验：绑定码只能取绑定部门的打分表。
  if (ticket.departmentId && ticket.departmentId !== departmentId) {
    throw ApiError.forbidden('该随机码仅限评议指定部门', 'TICKET_DEPARTMENT_MISMATCH');
  }

  const department = await prisma.department.findFirst({
    where: { id: departmentId, enabled: true, sessionId: ticket.sessionId },
    select: {
      id: true,
      name: true,
      questionnaireType: true,
      headerNote: true,
      title: true,
      footerNote: true,
    },
  });
  if (!department) throw ApiError.notFound('部门不存在或已停用');

  const [criteria, voteColumns] = await Promise.all([
    prisma.criterion.findMany({
      where: { departmentId, enabled: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, description: true, minScore: true, maxScore: true },
    }),
    prisma.voteColumn.findMany({
      where: { departmentId, enabled: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, employee: { select: { name: true } } },
    }),
  ]);

  return {
    department: { id: department.id, name: department.name },
    questionnaireType: department.questionnaireType,
    headerNote: department.headerNote,
    title: department.title,
    footerNote: department.footerNote,
    criteria,
    voteColumns: voteColumns.map((column) => ({
      id: column.id,
      name: column.name,
      employeeName: column.employee?.name ?? null,
    })),
  };
}

/**
 * 提交一张打分表并核销该码。
 *
 * 三个不可动摇的点：
 *   1. 分数区间以数据库里的 criterion 为准，客户端传来什么区间的提示都不参与判定；
 *   2. voteColumnId / criterionId 必须属于该部门且处于启用状态，越权写一律拒绝；
 *   3. 核销与写表在同一事务内，核销靠 `UPDATE ... WHERE id=? AND status='unused'`
 *      的受影响行数判定，因此并发提交只可能有一张表落库。
 *
 * @param ticket 已通过签名校验的投票令牌载荷
 * @param departmentId 被评部门
 * @param items 打分单元格
 */
export async function submitVote(
  ticket: VoteTokenPayload,
  departmentId: string,
  items: SubmitItem[],
): Promise<void> {
  // 登录后窗口可能被管理员关闭，提交前必须重新判定，否则"关闭投票"形同虚设。
  // 场次判定用票所属场次的 status 与时间窗：未开放一律拒绝（403 VOTE_CLOSED）。
  const ticketRow = await prisma.ticket.findUnique({
    where: { id: ticket.sub },
    select: {
      sessionId: true,
      departmentId: true,
      session: { select: { status: true, opensAt: true, closesAt: true } },
    },
  });
  // 令牌签名有效但票已被删：按已使用处理，不再继续任何校验。
  if (!ticketRow) throw ApiError.conflict('该票据已使用，不能重复提交', 'TICKET_USED');
  const status = evaluateVoteWindow(ticketRow.session);
  if (!status.open) throw ApiError.forbidden(VOTE_CLOSED_MESSAGE, 'VOTE_CLOSED');

  // 部门绑定强校验：绑定码只能提交到绑定部门，非绑定部门一律 403。
  if (ticketRow.departmentId && ticketRow.departmentId !== departmentId) {
    throw ApiError.forbidden('该随机码仅限评议指定部门', 'TICKET_DEPARTMENT_MISMATCH');
  }

  // 部门必须属于票所在场次：跨场次提交在查询条件里直接落空（404）。
  const department = await prisma.department.findFirst({
    where: { id: departmentId, enabled: true, sessionId: ticketRow.sessionId },
    select: { id: true },
  });
  if (!department) throw ApiError.notFound('部门不存在或已停用');

  const [criteria, voteColumns] = await Promise.all([
    prisma.criterion.findMany({
      where: { departmentId, enabled: true },
      select: { id: true, name: true, minScore: true, maxScore: true },
    }),
    prisma.voteColumn.findMany({ where: { departmentId, enabled: true }, select: { id: true } }),
  ]);
  const criterionById = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const validVoteColumnIds = new Set(voteColumns.map((column) => column.id));

  const seenCells = new Set<string>();
  for (const item of items) {
    const criterion = criterionById.get(item.criterionId);
    if (!criterion) {
      throw ApiError.badRequest('打分项不属于该部门，或该项点已停用', 'ITEM_OUT_OF_DEPARTMENT');
    }
    if (!validVoteColumnIds.has(item.voteColumnId)) {
      throw ApiError.badRequest('被评列不属于该部门，或该列已停用', 'ITEM_OUT_OF_DEPARTMENT');
    }
    if (item.score < criterion.minScore || item.score > criterion.maxScore) {
      throw ApiError.badRequest(
        `「${criterion.name}」的分数须在 ${criterion.minScore}-${criterion.maxScore} 之间`,
        'SCORE_OUT_OF_RANGE',
      );
    }
    // 同一单元格重复出现会撞 score_items 的唯一约束；提前拒绝，避免变成 500。
    const cell = `${item.voteColumnId}|${item.criterionId}`;
    if (seenCells.has(cell)) {
      throw ApiError.badRequest('同一被评列与项点重复提交', 'DUPLICATE_ITEM');
    }
    seenCells.add(cell);
  }

  // 提交完整性：必须填满全部「被评列 × 项点」单元格才能提交（此时 items 已通过
  // 上面的越权/区间/重复校验，只会是"缺格"这一种不完整）。
  const expectedCells = criteria.length * voteColumns.length;
  const SheetItemsSchema = z
    .array(z.unknown())
    .superRefine((val, ctx) => {
      const missing = expectedCells - val.length;
      if (missing > 0) {
        ctx.addIssue({
          code: 'custom',
          message: `还有 ${missing} 个项点未完成打分`,
        });
      }
    });
  const parsed = SheetItemsSchema.safeParse(items);
  if (!parsed.success) {
    throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '打分表未填写完整', 'INCOMPLETE_SHEET');
  }

  const submittedAt = new Date();

  await prisma.$transaction(async (tx) => {
    // 原子核销，等价于：
    //   UPDATE tickets SET status = 'used', used_at = now() WHERE id = $1 AND status = 'unused'
    // 受影响行数为 0 说明这张码已被先前或并发的提交消耗 → 拒绝，且不写任何评分数据。
    const consumed = await tx.ticket.updateMany({
      where: { id: ticket.sub, status: 'unused' },
      data: { status: 'used', usedAt: submittedAt },
    });
    if (consumed.count === 0) {
      throw ApiError.conflict('该票据已使用，不能重复提交', 'TICKET_USED');
    }

    // 匿名边界：只写这几列。任何"顺手"加上的 ticketId / IP / UA 都会让匿名性失效。
    const sheet = await tx.scoreSheet.create({
      data: {
        departmentId,
        ticketTypeId: ticket.ticketTypeId,
        sessionId: ticketRow.sessionId,
        submittedAt,
      },
      select: { id: true },
    });

    // 按随机码导出答卷的受控映射，仅 results.export 权限的导出路径读取，
    // 评分与统计链路不使用本表（score_sheets 本身仍不含任何票据标识）。
    // ON CONFLICT DO NOTHING：正常流程一码只提交成功一次，此处的幂等只是兜底，
    // 同一码的第二次提交会在上面的核销步骤就被拒绝、整个事务回滚。
    await tx.sheetTicketMap.createMany({
      data: {
        ticketId: ticket.sub,
        sheetId: sheet.id,
        sessionId: ticketRow.sessionId,
      },
      skipDuplicates: true,
    });

    await tx.scoreItem.createMany({
      data: items.map((item) => ({
        sheetId: sheet.id,
        voteColumnId: item.voteColumnId,
        criterionId: item.criterionId,
        score: item.score,
      })),
    });
  });
}