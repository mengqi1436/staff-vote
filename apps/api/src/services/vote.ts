import { prisma } from '../db.js';
import {
  evaluateVoteWindow,
  toSettingMap,
  VOTE_CLOSED_MESSAGE,
  type VoteWindowState,
} from '../lib/settings.js';
import { signVoteToken, type VoteTokenPayload } from '../lib/token.js';
import { ApiError } from '../middleware/errorHandler.js';

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
  minScore: number;
  maxScore: number;
}

export interface EmployeeView {
  id: string;
  name: string;
}

export interface VoteSessionResult {
  token: string;
  ticketType: TicketTypeView;
  departments: DepartmentView[];
}

export interface VoteSheetResult {
  department: DepartmentView;
  criteria: CriterionView[];
  employees: EmployeeView[];
}

/** 一个待写入的打分单元格。 */
export interface SubmitItem {
  employeeId: string;
  criterionId: string;
  score: number;
}

/**
 * 读取投票开放状态。
 * @returns 开放标志、对职工显示的文案与起止时间
 */
export async function getVoteStatus(): Promise<VoteWindowState> {
  const rows = await prisma.setting.findMany({ select: { key: true, value: true } });
  return evaluateVoteWindow(toSettingMap(rows));
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
    include: { ticketType: true },
  });

  if (!ticket) throw ApiError.unauthorized('随机码无效，请核对后重试', 'INVALID_CODE');
  if (ticket.status === 'used') throw ApiError.unauthorized('该票据已使用', 'TICKET_USED');
  if (ticket.status === 'revoked') throw ApiError.unauthorized('该票据已作废', 'TICKET_REVOKED');

  const status = await getVoteStatus();
  if (!status.open) throw ApiError.forbidden(VOTE_CLOSED_MESSAGE, 'VOTE_CLOSED');

  const departments = await prisma.department.findMany({
    where: { enabled: true },
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
    departments,
  };
}

/**
 * 取某部门的打分表骨架。
 * 停用部门与不存在的部门同样返回 404：软删除的数据对外就当不存在。
 *
 * @param departmentId 部门 ID
 * @returns 部门、项点列（含区间）与职工行，均只含启用项并按 sortOrder 升序
 */
export async function getVoteSheet(departmentId: string): Promise<VoteSheetResult> {
  const department = await prisma.department.findFirst({
    where: { id: departmentId, enabled: true },
    select: { id: true, name: true },
  });
  if (!department) throw ApiError.notFound('部门不存在或已停用');

  const [criteria, employees] = await Promise.all([
    prisma.criterion.findMany({
      where: { departmentId, enabled: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, minScore: true, maxScore: true },
    }),
    prisma.employee.findMany({
      where: { departmentId, enabled: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true },
    }),
  ]);

  return { department, criteria, employees };
}

/**
 * 提交一张打分表并核销该码。
 *
 * 三个不可动摇的点：
 *   1. 分数区间以数据库里的 criterion 为准，客户端传来什么区间的提示都不参与判定；
 *   2. employeeId / criterionId 必须属于该部门且处于启用状态，越权写一律拒绝；
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
  const status = await getVoteStatus();
  if (!status.open) throw ApiError.forbidden(VOTE_CLOSED_MESSAGE, 'VOTE_CLOSED');

  const department = await prisma.department.findFirst({
    where: { id: departmentId, enabled: true },
    select: { id: true },
  });
  if (!department) throw ApiError.notFound('部门不存在或已停用');

  const [criteria, employees] = await Promise.all([
    prisma.criterion.findMany({
      where: { departmentId, enabled: true },
      select: { id: true, name: true, minScore: true, maxScore: true },
    }),
    prisma.employee.findMany({ where: { departmentId, enabled: true }, select: { id: true } }),
  ]);
  const criterionById = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const validEmployeeIds = new Set(employees.map((employee) => employee.id));

  const seenCells = new Set<string>();
  for (const item of items) {
    const criterion = criterionById.get(item.criterionId);
    if (!criterion) {
      throw ApiError.badRequest('打分项不属于该部门，或该项点已停用', 'ITEM_OUT_OF_DEPARTMENT');
    }
    if (!validEmployeeIds.has(item.employeeId)) {
      throw ApiError.badRequest('被评职工不属于该部门，或该职工已停用', 'ITEM_OUT_OF_DEPARTMENT');
    }
    if (item.score < criterion.minScore || item.score > criterion.maxScore) {
      throw ApiError.badRequest(
        `「${criterion.name}」的分数须在 ${criterion.minScore}-${criterion.maxScore} 之间`,
        'SCORE_OUT_OF_RANGE',
      );
    }
    // 同一单元格重复出现会撞 score_items 的唯一约束；提前拒绝，避免变成 500。
    const cell = `${item.employeeId}|${item.criterionId}`;
    if (seenCells.has(cell)) {
      throw ApiError.badRequest('同一职工与项点重复提交', 'DUPLICATE_ITEM');
    }
    seenCells.add(cell);
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

    // 匿名边界：只写这三列。任何"顺手"加上的 ticketId / IP / UA 都会让匿名性失效。
    const sheet = await tx.scoreSheet.create({
      data: { departmentId, ticketTypeId: ticket.ticketTypeId, submittedAt },
      select: { id: true },
    });

    await tx.scoreItem.createMany({
      data: items.map((item) => ({
        sheetId: sheet.id,
        employeeId: item.employeeId,
        criterionId: item.criterionId,
        score: item.score,
      })),
    });
  });
}