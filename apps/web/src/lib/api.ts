/**
 * 后端 API 客户端。
 *
 * 契约与 docs/superpowers/specs/2026-09-19-staff-vote-design.md 第 12 节一致。
 * 所有失败响应形状统一为 `{ error: { code, message, fields? } }`，
 * 这里解析成 ApiError 抛出，调用方只需 catch 一种错误类型。
 */

const BASE = '/api';

export interface ApiFieldError {
  path: string;
  message: string;
}

/** 统一的接口错误。`status` 为 HTTP 状态码，`code` 为后端错误码。 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: ApiFieldError[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** 投票端令牌。管理端走 httpOnly Cookie，不需要传。 */
  token?: string;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, token } = options;

  const headers: Record<string, string> = {};
  // FormData 交给浏览器自动生成 multipart boundary，不能手动设 Content-Type
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      // 管理端会话在 httpOnly Cookie 里
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', '网络连接失败，请检查网络后重试');
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = undefined;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
  }

  if (!response.ok) {
    const errorShape = (payload as { error?: { code?: string; message?: string; fields?: ApiFieldError[] } })
      ?.error;
    throw new ApiError(
      response.status,
      errorShape?.code ?? 'UNKNOWN',
      errorShape?.message ?? `请求失败（${response.status}）`,
      errorShape?.fields,
    );
  }

  return payload as T;
}

/** 下载文件（导出 Excel 等）。浏览器直接触发下载，不走 fetch。 */
export function downloadUrl(path: string): string {
  return `${BASE}${path}`;
}

/**
 * fetch 方式下载：先看响应状态再落盘。入参是 downloadUrl() 的返回值（带 /api 前缀）。
 * 导出答卷这类「可能没有产物」的接口需要区分 404（无答卷）与真实下载，
 * 直链 <a href> 无法拦截错误响应，浏览器只会默默展示一段 JSON。
 */
export async function downloadFile(url: string): Promise<void> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let code = 'UNKNOWN';
    let message = `请求失败（${response.status}）`;
    try {
      const payload = JSON.parse(text) as { error?: { code?: string; message?: string } };
      code = payload.error?.code ?? code;
      message = payload.error?.message ?? message;
    } catch {
      // 非 JSON 错误体：保留默认文案
    }
    throw new ApiError(response.status, code, message);
  }
  const blob = await response.blob();
  // 文件名取 Content-Disposition（后端 attachment 形态），取不到退回路径末段
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const fallback = decodeURIComponent(url.split('/').pop() ?? 'download.xlsx');
  const name = match ? decodeURIComponent(match[1]!) : fallback;
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}

/** 职工名单导入的返回体，与后端 ImportEmployeesResult 一致。 */
export interface ImportFeedback {
  total?: number;
  created?: number;
  updated?: number;
  skipped?: number;
  departmentsCreated?: number;
  errors?: Array<{ row: number; message: string }>;
}

// -----------------------------------------------------------------------------
// 类型
// -----------------------------------------------------------------------------

export interface VoteStatus {
  open: boolean;
  message: string;
  /** 场次开放窗口起点；null = 不限开始 */
  opensAt: string | null;
  /** 场次开放窗口终点；null = 长期开放 */
  closesAt: string | null;
  /** 所在场次（多场评议）；旧后端不返回该字段（undefined），多场聚合判定回传 null，调用方必须容错 */
  session?: { id: string; name: string; status: string } | null;
}

/** 场次（多场评议的顶层组织单位）。状态机：draft → voting → paused ⇄ voting → ended（终态）。 */
export interface AdminSessionDto {
  id: string;
  name: string;
  status: 'draft' | 'voting' | 'paused' | 'ended';
  /** 开放窗口起点；null = 不限开始（开放与否还取决于 status 与 closesAt） */
  opensAt: string | null;
  /** 开放窗口终点；null = 长期开放 */
  closesAt: string | null;
  startAt: string | null;
  endedAt: string | null;
  createdAt: string;
  /** 所属全局部门 id；旧场次（建场前没有全局部门字典）为 null */
  orgDepartmentId: string | null;
  /** 所属全局部门名（冗余展示用，与 orgDepartmentId 同源）；旧场次为 null */
  orgDepartmentName: string | null;
  /** draft 场次开始投票前的阻塞缺项；非空 = 配置未完成，开始按钮应禁用。非 draft 恒为空。 */
  startBlockers: string[];
  /** 打分范围：person = 仅负责人评价；both = 负责人评价 + 车间评价两张表，齐交才核销 */
  scoreScope: 'person' | 'both';
}

/**
 * 全局部门字典（跨场次复用的部门目录）。
 * 场内 departments 是「这一场实际参评的部门」，建场时从本字典选定并自动落一条；
 * 本字典才是管理员维护的主数据。
 */
export interface OrgDepartmentDto {
  id: string;
  name: string;
  sortOrder: number;
  enabled: boolean;
  createdAt: string;
}

/** 场次票别规划的单行请求体（PUT /sessions/:id/ticket-plan）。 */
export interface TicketPlanItem {
  /** 票种编码，场次内唯一（1-8 字符） */
  code: string;
  name: string;
  weightPercent: number;
  /** 本票种要发放的随机码数量；0 = 只建票种不发码 */
  count: number;
}

/** 票别规划提交结果：逐票种的建批与发码情况（不含明文码）。 */
export interface TicketPlanResult {
  ticketTypes: TicketTypeDto[];
  generated: Array<{ ticketTypeId: string; batchId: string; count: number }>;
}

/** 前端门控用的权限码常量（目录真源在后端 lib/permissions.ts）。 */
export const PERMISSION_RESULTS_EXPORT = 'results.export';

/** 拼接 `?sessionId=` 查询串；未选场次时不带参数（后端单场数据兼容）。 */
function sessionIdQuery(sessionId?: string | null): string {
  return sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
}

export interface DepartmentBrief {
  id: string;
  name: string;
  /** 问卷类型：both 场次的部门列表会带，用于投票端区分「负责人评价/车间评价」；缺省未知 */
  questionnaireType?: string;
}

/** 后台部门视图：除基础字段外还带问卷表头配置（参考表的抬头与表尾说明）。 */
export interface DepartmentAdminDto extends DepartmentBrief {
  sortOrder: number;
  enabled: boolean;
  /** person = 个人问卷（多列被评职务），workshop = 车间问卷（单列得分） */
  questionnaireType: string;
}

export interface TicketTypeDto {
  id: string;
  code: string;
  name: string;
  weightPercent: number;
  sortOrder: number;
  enabled: boolean;
  /** 已发放数量，仅列表接口返回 */
  issuedCount?: number;
  usedCount?: number;
  unusedCount?: number;
}

/**
 * 投票会话里的票种视图。
 *
 * 后端只返回这四项（不含 sortOrder / enabled），因此不能用完整的 TicketTypeDto 描述：
 * 类型上存在、运行时恒为 undefined 的字段会误导调用方写出永远不成立的判断。
 */
export type VoteTicketTypeDto = Pick<TicketTypeDto, 'id' | 'code' | 'name' | 'weightPercent'>;

export interface VoteSessionResult {
  token: string;
  ticketType: VoteTicketTypeDto;
  departments: DepartmentBrief[];
  /** 所在场次；旧后端不返回该字段，恒为 undefined，调用方必须容错 */
  session?: {
    id: string;
    name: string;
    status: string;
    /** person = 仅负责人评价一张表；both = 负责人 + 车间两张表齐交才核销（旧后端缺省） */
    scoreScope?: 'person' | 'both';
  };
}

/** 打分进度（GET /vote/progress）：both 场次判断还差哪类表用。 */
export interface VoteProgressResult {
  scoreScope: 'person' | 'both';
  /** 必答的问卷类型（both = ['person','workshop']；单表 = [绑定部门类型]） */
  required: string[];
  /** 已提交的问卷类型 */
  submitted: string[];
  /** 还差的（required 减 submitted） */
  remaining: string[];
}

export interface CriterionDto {
  id: string;
  /** 模板项点为 null；0010 前的存量部门项点指向原部门。 */
  departmentId: string | null;
  /** 模板项点的问卷类型（person/workshop）；部门项点为 null。 */
  templateType: string | null;
  name: string;
  /** 项点描述，显示在打分表项点名称下方（参考表里的那段长文字） */
  description: string | null;
  minScore: number;
  maxScore: number;
  sortOrder: number;
  enabled: boolean;
}

/** 场次问卷模板表头：同一场次内按问卷类型各存一份（附件8 的附件号/标题/填写说明）。 */
export interface QuestionnaireTemplateDto {
  sessionId: string;
  type: string;
  headerNote: string;
  title: string;
  footerNote: string;
}

/** 被评列：打分表的「列」，与职工名单分离（主任、党支部书记、得分…）。 */
export interface VoteColumnDto {
  id: string;
  departmentId: string;
  name: string;
  /** 该职务列对应的具体被评人（表头第二行的姓名），未选人为 null。 */
  employeeId: string | null;
  employeeName: string | null;
  sortOrder: number;
  enabled: boolean;
}

/** 打分表里的被评列视图：投票端只需要 id、名称与被评人姓名。 */
export interface VoteColumnBrief {
  id: string;
  name: string;
  /** 该职务列对应的具体被评人姓名（表头第二行），未选人为 null。 */
  employeeName: string | null;
}

/** 打分表用的项点视图：不含排序与启停（后端只返回启用的）。 */
export type VoteCriterionDto = Pick<
  CriterionDto,
  'id' | 'name' | 'description' | 'minScore' | 'maxScore'
>;

export interface EmployeeDto {
  id: string;
  name: string;
  gender: string | null;
  age: number | null;
  title: string | null;
  sortOrder: number;
  enabled: boolean;
}

/** 打分表：表头文案 + 项点（行）+ 被评列（列），与 docs/参考表.xlsx 的结构一致。 */
export interface VoteSheetResult {
  department: DepartmentBrief;
  /** person = 个人问卷（多列被评职务），workshop = 车间问卷（单列得分） */
  questionnaireType: string;
  headerNote: string;
  title: string;
  footerNote: string;
  criteria: VoteCriterionDto[];
  voteColumns: VoteColumnBrief[];
}

export interface SubmitItem {
  voteColumnId: string;
  criterionId: string;
  score: number;
}

export interface SubmitPayload {
  departmentId: string;
  items: SubmitItem[];
}

export interface TicketDto {
  id: string;
  code: string;
  status: 'unused' | 'used' | 'revoked';
  usedAt: string | null;
  createdAt: string;
  ticketType: { id: string; code: string; name: string };
  batchId: string;
}

export interface TicketBatchDto {
  id: string;
  count: number;
  operator: string;
  createdAt: string;
  ticketType: { id: string; code: string; name: string };
  /** 本批次绑定评议部门；null = 不限定（存量码/向导发码兼容，可评议全部部门） */
  departmentId: string | null;
  /** 冗余展示用部门名，与 departmentId 同源；null 同上 */
  departmentName: string | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface StatsOverview {
  ticketTypes: Array<{
    id: string;
    code: string;
    name: string;
    weightPercent: number;
    issued: number;
    used: number;
    unused: number;
    revoked: number;
    /** 选配领码人数量（按票别选配人员发码时返回）；未选配时不返回，恒为 undefined */
    assignedCount?: number;
    /** 已投票的领码人名单（仅姓名）；未按场次统计时不返回，恒为 undefined */
    usedByAssignee?: Array<{ employeeId: string; employeeName: string; count: number }>;
  }>;
  totals: { issued: number; used: number; unused: number; revoked: number; sheets: number };
  departments: Array<{ id: string; name: string; enabled: boolean; employeeCount: number; sheetCount: number }>;
  /** 本场次的投票开放判定（场次 status + 场次窗口，不再读全局设置） */
  voteWindow: {
    open: boolean;
    message: string;
    opensAt: string | null;
    closesAt: string | null;
    /** 判定所针对的场次状态（draft / voting / paused / ended） */
    status: string;
  };
  generatedAt: string;
}

/** 参考样表统计的行：被评对象 × 票别（docs/附件文件包/参考样表.xlsx 形态）。 */
export interface SampleStatRowDto {
  departmentId: string;
  departmentName: string;
  /** 被评列 ID：同名被评列（如两个「副主任」）各自行唯一，用作 rowKey */
  voteColumnId: string;
  /** 被评对象：个人表为被评列名（主任…），车间表为车间名 */
  targetName: string;
  /** 票种 ID；「ABC汇总」行为 null */
  ticketTypeId: string | null;
  /** 票别显示：A / B / C /「ABC汇总」 */
  ticketCode: string;
  /** 各项点得分，顺序与 criteriaNames 对齐 */
  scores: number[];
  /** 1-5合计：各项点得分之和 */
  total: number;
  /** 综合评价得分 */
  comprehensiveScore: number;
  /** 综合评价得分排序（组内同分并列） */
  rank: number;
}

export interface SampleStatTableDto {
  criteriaNames: string[];
  rows: SampleStatRowDto[];
}

/** GET /admin/stats/samples：参考样表口径的已提交表单计算结果。 */
export interface StatsSamplesDto {
  /** 个人问卷表（车间负责人评价） */
  personal: SampleStatTableDto;
  /** 车间问卷表（车间评价） */
  workshop: SampleStatTableDto;
  sheetCount: number;
  generatedAt: string;
}

export interface CriterionScoreDto {
  criterionId: string;
  criterionName: string;
  rawScore: number;
  normalizedScore: number;
  participatingTicketTypeIds: string[];
}

export interface ResultRowDto {
  rank: number;
  voteColumnId: string;
  /** 被评对象（被评列名：主任、党支部书记、车间得分…） */
  voteColumnName: string;
  /** 该被评列是否仍在启用；停用的列仍出现在结果里，便于解释历史成绩 */
  enabled: boolean;
  comprehensiveScore: number;
  criteria: CriterionScoreDto[];
}

export interface ResultsDto {
  department: DepartmentBrief;
  criteria: Array<{ id: string; name: string; minScore: number; maxScore: number; enabled: boolean }>;
  rows: ResultRowDto[];
  ticketTypesInvolved: Array<{ id: string; code: string; name: string; weightPercent: number }>;
  sheetCount: number;
  generatedAt: string;
}

/** 系统设置。窗口下沉到场次后，全局设置只剩系统标题。 */
export interface SettingsDto {
  'system.title': string;
}

// -----------------------------------------------------------------------------
// 投票端（无需登录；令牌放在 sessionStorage，公共电脑上关掉标签即失效）
// -----------------------------------------------------------------------------

export const VOTE_TOKEN_KEY = 'staff_vote_token';

export function readVoteToken(): string | null {
  return sessionStorage.getItem(VOTE_TOKEN_KEY);
}

export function saveVoteToken(token: string): void {
  sessionStorage.setItem(VOTE_TOKEN_KEY, token);
}

export function clearVoteToken(): void {
  sessionStorage.removeItem(VOTE_TOKEN_KEY);
}

export const voteApi = {
  status: () => request<VoteStatus>('/vote/status'),

  session: (code: string) =>
    request<VoteSessionResult>('/vote/session', { method: 'POST', body: { code } }),

  sheet: (departmentId: string, token: string) =>
    request<VoteSheetResult>(`/vote/sheet?departmentId=${encodeURIComponent(departmentId)}`, {
      token,
    }),

  submit: (payload: SubmitPayload, token: string) =>
    request<{ ok: true }>('/vote/submit', { method: 'POST', body: payload, token }),

  /** 打分进度：both 场次提交一张表后查询还差哪类表，齐交才核销。 */
  progress: (token: string) => request<VoteProgressResult>('/vote/progress', { token }),
};

// -----------------------------------------------------------------------------
// 管理端（Cookie 会话）
// -----------------------------------------------------------------------------

export interface AdminMe {
  id: string;
  username: string;
  roleId: string | null;
  roleName: string | null;
  /** 权限码列表，由后端权威给出；前端只用它决定按钮显隐，真正的防线在后端 */
  permissions: string[];
}

/** 权限目录项（后端 lib/permissions.ts 同步到库的那份）。 */
export interface PermissionDto {
  code: string;
  name: string;
  groupName: string;
  sortOrder: number;
}

export interface RoleDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  /** 内置角色不可删除 */
  builtin: boolean;
  permissions: string[];
  /** 正在使用该角色的账号数，用于删除前提示 */
  adminCount: number;
}

export interface AdminUserDto {
  id: string;
  username: string;
  roleId: string | null;
  roleName: string | null;
  enabled: boolean;
  createdAt: string;
}

export const adminApi = {
  login: (username: string, password: string) =>
    request<AdminMe>('/admin/login', { method: 'POST', body: { username, password } }),

  logout: () => request<void>('/admin/logout', { method: 'POST' }),

  me: () => request<AdminMe>('/admin/me'),

  /**
   * 场次管理。状态机：draft → voting → paused ⇄ voting → ended（终态）。
   * 非法流转后端返回 409 INVALID_SESSION_TRANSITION，调用方按普通 ApiError 提示即可。
   * paused → voting 也走 start（「继续投票」）。
   */
  sessions: {
    list: () => request<{ sessions: AdminSessionDto[] }>('/admin/sessions'),
    /**
     * 创建场次（建场向导第 1 步）。请求体含所属全局部门与开放窗口起点（必填）：
     * 后端在同一事务里建场次并自动落一条场内部门（name=所选字典部门名，个人问卷）。
     * closesAt 省略或 null = 长期开放；opensAt 必须 < closesAt，违反返回 422。
     */
    create: (values: {
      name: string;
      orgDepartmentId: string;
      opensAt: string;
      closesAt?: string | null;
    }) => request<{ session: AdminSessionDto }>('/admin/sessions', { method: 'POST', body: values }),
    /**
     * 更新场次名称、开放窗口与打分范围。
     *
     * opensAt / closesAt 传 ISO 字符串或 null：null = 清空该侧限制，
     * 缺省 = 不修改。两者均非空时后端校验 opensAt < closesAt，违反返回 400。
     * scoreScope：person = 仅负责人评价；both = 负责人 + 车间两张表，齐交才核销。
     */
    update: (
      id: string,
      body: {
        name?: string;
        opensAt?: string | null;
        closesAt?: string | null;
        scoreScope?: 'person' | 'both';
      },
    ) => request<{ session: AdminSessionDto }>(`/admin/sessions/${id}`, { method: 'PATCH', body }),
    start: (id: string) =>
      request<{ session: AdminSessionDto }>(`/admin/sessions/${id}/start`, { method: 'POST' }),
    pause: (id: string) =>
      request<{ session: AdminSessionDto }>(`/admin/sessions/${id}/pause`, { method: 'POST' }),
    end: (id: string) =>
      request<{ session: AdminSessionDto }>(`/admin/sessions/${id}/end`, { method: 'POST' }),
    /**
     * 票别规划（建场向导第 3 步）：本次提交集合 = 启用票种全集，
     * 逐票种 upsert 并按 count 建批发码（count=0 只建票种）；
     * 启用票种权重合计必须恰为 100，违反返回 422 WEIGHT_SUM。
     */
    ticketPlan: (sessionId: string, types: TicketPlanItem[]) =>
      request<TicketPlanResult>(`/admin/sessions/${sessionId}/ticket-plan`, {
        method: 'PUT',
        body: { types },
      }),
    /** 整场整合导出（多 sheet：四层统分排名 + 答卷汇总），权限 results.export。 */
    exportFullUrl: (id: string) => downloadUrl(`/admin/sessions/${id}/export.xlsx`),
  },

  /** 权限目录：角色勾选框按 groupName 分组渲染 */
  permissions: {
    list: () => request<PermissionDto[]>('/admin/permissions'),
  },

  roles: {
    list: () => request<RoleDto[]>('/admin/roles'),
    create: (body: { code: string; name: string; description?: string | null; permissions: string[] }) =>
      request<RoleDto>('/admin/roles', { method: 'POST', body }),
    update: (id: string, body: { name?: string; description?: string | null; permissions?: string[] }) =>
      request<RoleDto>(`/admin/roles/${id}`, { method: 'PATCH', body }),
    remove: (id: string) => request<void>(`/admin/roles/${id}`, { method: 'DELETE' }),
  },

  admins: {
    list: () => request<AdminUserDto[]>('/admin/admins'),
    create: (body: { username: string; password: string; roleId?: string | null }) =>
      request<AdminUserDto>('/admin/admins', { method: 'POST', body }),
    /** 改角色、启停、重置口令都走这一个 PATCH */
    update: (
      id: string,
      body: { roleId?: string | null; enabled?: boolean; password?: string },
    ) => request<AdminUserDto>(`/admin/admins/${id}`, { method: 'PATCH', body }),
    remove: (id: string) => request<void>(`/admin/admins/${id}`, { method: 'DELETE' }),
  },

  ticketTypes: {
    list: (options: { sessionId?: string | null } = {}) =>
      request<TicketTypeDto[]>(`/admin/ticket-types${sessionIdQuery(options.sessionId)}`),
    create: (body: Partial<TicketTypeDto>, sessionId?: string | null) =>
      request<TicketTypeDto>('/admin/ticket-types', { method: 'POST', body: sessionId ? { ...body, sessionId } : body }),
    update: (id: string, body: Partial<TicketTypeDto>) =>
      request<TicketTypeDto>(`/admin/ticket-types/${id}`, { method: 'PATCH', body }),
    remove: (id: string) => request<void>(`/admin/ticket-types/${id}`, { method: 'DELETE' }),
  },

  tickets: {
    list: (
      params: {
        page?: number;
        pageSize?: number;
        status?: string;
        ticketTypeId?: string;
        sessionId?: string | null;
      } = {},
    ) => {
      const query = new URLSearchParams();
      if (params.page) query.set('page', String(params.page));
      if (params.pageSize) query.set('pageSize', String(params.pageSize));
      if (params.status) query.set('status', params.status);
      if (params.ticketTypeId) query.set('ticketTypeId', params.ticketTypeId);
      if (params.sessionId) query.set('sessionId', params.sessionId);
      return request<Paged<TicketDto>>(`/admin/tickets?${query.toString()}`);
    },
    generate: (
      ticketTypeId: string,
      count: number,
      options: { sessionId?: string | null; departmentId?: string } = {},
    ) =>
      request<{ batchId: string; count: number; codes: string[] }>('/admin/tickets/generate', {
        method: 'POST',
        // sessionId 为 null（未选场次）时不带该字段：契约里「不传」与「传 null」语义不同
        body: {
          ticketTypeId,
          count,
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          // departmentId 省略 = 不限定部门（仅「不限定」选项显式确认后使用）
          ...(options.departmentId ? { departmentId: options.departmentId } : {}),
        },
      }),
    revoke: (id: string) => request<TicketDto>(`/admin/tickets/${id}/revoke`, { method: 'POST' }),
    /**
     * 一键作废：作废该场次下当前筛选的全部「未使用」码（used / revoked 不受影响）。
     *
     * @param sessionId 必传：作废范围必须限定在单个场次
     * @param ticketTypeId 传则只作废该票种；不传即全部票种
     * @returns 实际作废的数量
     */
    revokeBulk: (sessionId: string, ticketTypeId?: string) =>
      request<{ revoked: number }>('/admin/tickets/revoke-bulk', {
        method: 'POST',
        body: ticketTypeId ? { ticketTypeId, sessionId } : { sessionId },
      }),
    exportUrl: (params: { status?: string; ticketTypeId?: string; sessionId?: string | null } = {}) => {
      const query = new URLSearchParams();
      if (params.status) query.set('status', params.status);
      if (params.ticketTypeId) query.set('ticketTypeId', params.ticketTypeId);
      if (params.sessionId) query.set('sessionId', params.sessionId);
      return downloadUrl(`/admin/tickets/export?${query.toString()}`);
    },
    /**
     * 单个随机码的答卷导出（附件8 形态单 sheet），权限 results.export。
     * 码未使用/已作废返回 409；无答卷或无映射返回 404，走 downloadFile 才能拦到。
     */
    exportAnswerUrl: (id: string) => downloadUrl(`/admin/tickets/${id}/export.xlsx`),
  },

  batches: {
    list: (options: { sessionId?: string | null } = {}) =>
      request<TicketBatchDto[]>(`/admin/ticket-batches${sessionIdQuery(options.sessionId)}`),
  },

  /**
   * 全局部门字典（跨场次主数据，路由 /admin/departments 独立页维护）。
   * 读 = 登录即可；写操作权限 departments.write。
   * 删除被场次引用时返回 409 ORG_DEPARTMENT_IN_USE（只能停用）。
   */
  orgDepartments: {
    list: () => request<{ departments: OrgDepartmentDto[] }>('/admin/org-departments'),
    create: (body: { name: string; sortOrder?: number }) =>
      request<{ department: OrgDepartmentDto }>('/admin/org-departments', {
        method: 'POST',
        body,
      }),
    update: (id: string, body: { name?: string; sortOrder?: number; enabled?: boolean }) =>
      request<{ department: OrgDepartmentDto }>(`/admin/org-departments/${id}`, {
        method: 'PATCH',
        body,
      }),
    remove: (id: string) => request<void>(`/admin/org-departments/${id}`, { method: 'DELETE' }),
  },

  departments: {
    list: (options: { sessionId?: string | null } = {}) =>
      request<DepartmentAdminDto[]>(`/admin/departments${sessionIdQuery(options.sessionId)}`),
    create: (body: { name: string; sortOrder?: number }, sessionId?: string | null) =>
      request<DepartmentAdminDto>('/admin/departments', {
        method: 'POST',
        body: sessionId ? { ...body, sessionId } : body,
      }),
    /** 除名称/排序/启停外，PATCH 还负责问卷类型归类（表头三件套已移到场次模板层） */
    update: (
      id: string,
      body: {
        name?: string;
        sortOrder?: number;
        enabled?: boolean;
        questionnaireType?: string;
      },
    ) => request<DepartmentAdminDto>(`/admin/departments/${id}`, { method: 'PATCH', body }),
    remove: (id: string) => request<void>(`/admin/departments/${id}`, { method: 'DELETE' }),
  },

  /** 被评列：打分表的列，与职工名单分离（参考表的主任/副书记/得分） */
  voteColumns: {
    list: (departmentId?: string, sessionId?: string | null) => {
      const query = new URLSearchParams();
      if (departmentId) query.set('departmentId', departmentId);
      if (sessionId) query.set('sessionId', sessionId);
      const qs = query.toString();
      return request<VoteColumnDto[]>(`/admin/vote-columns${qs ? `?${qs}` : ''}`);
    },
    create: (
      body: { departmentId: string; name: string; employeeId?: string | null; sortOrder?: number },
      sessionId?: string | null,
    ) =>
      request<VoteColumnDto>('/admin/vote-columns', {
        method: 'POST',
        body: sessionId ? { ...body, sessionId } : body,
      }),
    update: (id: string, body: { name?: string; employeeId?: string | null; sortOrder?: number; enabled?: boolean }) =>
      request<VoteColumnDto>(`/admin/vote-columns/${id}`, { method: 'PATCH', body }),
    remove: (id: string) => request<void>(`/admin/vote-columns/${id}`, { method: 'DELETE' }),
  },

  employees: {
    list: (departmentId?: string, sessionId?: string | null) => {
      const query = new URLSearchParams();
      if (departmentId) query.set('departmentId', departmentId);
      if (sessionId) query.set('sessionId', sessionId);
      const qs = query.toString();
      return request<EmployeeDto[]>(`/admin/employees${qs ? `?${qs}` : ''}`);
    },
    create: (
      body: {
        departmentId: string;
        name: string;
        gender?: string | null;
        age?: number | null;
        title?: string | null;
        sortOrder?: number;
      },
      sessionId?: string | null,
    ) =>
      request<EmployeeDto>('/admin/employees', { method: 'POST', body: sessionId ? { ...body, sessionId } : body }),
    update: (id: string, body: Partial<EmployeeDto> & { departmentId?: string }) =>
      request<EmployeeDto>(`/admin/employees/${id}`, { method: 'PATCH', body }),
    remove: (id: string) => request<void>(`/admin/employees/${id}`, { method: 'DELETE' }),
    /** 名单导入：multipart 上传，表单字段名 file（与后端手写解析器约定一致）。 */
    import: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return request<ImportFeedback>('/admin/employees/import', { method: 'POST', body: form });
    },
    /** 名单导出：后端生成 xlsx，走 downloadFile 才能拦到错误响应。 */
    exportUrl: (departmentId?: string, sessionId?: string | null) => {
      const query = new URLSearchParams();
      if (departmentId) query.set('departmentId', departmentId);
      if (sessionId) query.set('sessionId', sessionId);
      return downloadUrl(`/admin/employees/export?${query.toString()}`);
    },
    /** 导入模板（xlsx 版）：后端生成；CSV 版由前端直接拼字符串。 */
    importTemplateUrl: () => downloadUrl('/admin/employees/import-template.xlsx'),
  },

  /** 项点：场次级模板（departmentId=null + templateType），同一场次内两类问卷各一套 */
  criteria: {
    list: (templateType: string, sessionId?: string | null) => {
      const query = new URLSearchParams();
      query.set('templateType', templateType);
      if (sessionId) query.set('sessionId', sessionId);
      return request<CriterionDto[]>(`/admin/criteria?${query.toString()}`);
    },
    create: (
      body: {
        templateType: string;
        name: string;
        description?: string | null;
        minScore: number;
        maxScore: number;
        sortOrder?: number;
      },
      sessionId?: string | null,
    ) =>
      request<CriterionDto>('/admin/criteria', { method: 'POST', body: sessionId ? { ...body, sessionId } : body }),
    update: (id: string, body: Partial<CriterionDto>) =>
      request<CriterionDto>(`/admin/criteria/${id}`, { method: 'PATCH', body }),
    remove: (id: string) => request<void>(`/admin/criteria/${id}`, { method: 'DELETE' }),
  },

  /** 场次问卷模板表头：附件号/标题/填写说明按问卷类型（person/workshop）各存一份 */
  questionnaireTemplates: {
    get: (type: string, sessionId?: string | null) => {
      const query = new URLSearchParams();
      query.set('type', type);
      if (sessionId) query.set('sessionId', sessionId);
      return request<QuestionnaireTemplateDto>(`/admin/questionnaire-templates?${query.toString()}`);
    },
    update: (
      body: { type: string; headerNote?: string; title?: string; footerNote?: string },
      sessionId?: string | null,
    ) =>
      request<QuestionnaireTemplateDto>('/admin/questionnaire-templates', {
        method: 'PATCH',
        body: sessionId ? { ...body, sessionId } : body,
      }),
  },

  settings: {
    get: () => request<SettingsDto>('/admin/settings'),
    update: (body: Partial<SettingsDto>) => request<SettingsDto>('/admin/settings', { method: 'PUT', body }),
  },

  stats: {
    overview: (options: { sessionId?: string | null } = {}) =>
      request<StatsOverview>(`/admin/stats/overview${sessionIdQuery(options.sessionId)}`),
    /** 参考样表统计（被评对象 × 票别）；重计算，由统计页签在投票结束后按需加载。 */
    samples: (options: { sessionId?: string | null } = {}) =>
      request<StatsSamplesDto>(`/admin/stats/samples${sessionIdQuery(options.sessionId)}`),
  },

  results: {
    list: (departmentId: string, sessionId?: string | null) => {
      const query = new URLSearchParams();
      query.set('departmentId', departmentId);
      if (sessionId) query.set('sessionId', sessionId);
      return request<ResultsDto>(`/admin/results?${query.toString()}`);
    },
    exportUrl: (departmentId: string, sessionId?: string | null) => {
      const query = new URLSearchParams();
      query.set('departmentId', departmentId);
      if (sessionId) query.set('sessionId', sessionId);
      return downloadUrl(`/admin/results/export.xlsx?${query.toString()}`);
    },
  },
};