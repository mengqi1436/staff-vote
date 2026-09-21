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
  startAt: string | null;
  endAt: string | null;
}

export interface DepartmentBrief {
  id: string;
  name: string;
}

/** 后台部门视图：除基础字段外还带问卷表头配置（参考表的抬头与表尾说明）。 */
export interface DepartmentAdminDto extends DepartmentBrief {
  sortOrder: number;
  enabled: boolean;
  /** person = 个人问卷（多列被评职务），workshop = 车间问卷（单列得分） */
  questionnaireType: string;
  headerNote: string;
  title: string;
  footerNote: string;
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
}

export interface CriterionDto {
  id: string;
  name: string;
  /** 项点描述，显示在打分表项点名称下方（参考表里的那段长文字） */
  description: string | null;
  minScore: number;
  maxScore: number;
  sortOrder: number;
  enabled: boolean;
}

/** 被评列：打分表的「列」，与职工名单分离（主任、党支部书记、得分…）。 */
export interface VoteColumnDto {
  id: string;
  departmentId: string;
  name: string;
  sortOrder: number;
  enabled: boolean;
}

/** 打分表里的被评列视图：投票端只需要 id 与名称。 */
export interface VoteColumnBrief {
  id: string;
  name: string;
}

/** 打分表用的项点视图：不含排序与启停（后端只返回启用的）。 */
export type VoteCriterionDto = Pick<
  CriterionDto,
  'id' | 'name' | 'description' | 'minScore' | 'maxScore'
>;

export interface EmployeeDto {
  id: string;
  name: string;
  employeeNo: string | null;
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
  }>;
  totals: { issued: number; used: number; unused: number; revoked: number; sheets: number };
  departments: Array<{ id: string; name: string; enabled: boolean; employeeCount: number; sheetCount: number }>;
  voteWindow: VoteStatus;
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

export interface SettingsDto {
  'vote.open': string;
  'vote.startAt': string;
  'vote.endAt': string;
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
    list: () => request<TicketTypeDto[]>('/admin/ticket-types'),
    create: (body: Partial<TicketTypeDto>) =>
      request<TicketTypeDto>('/admin/ticket-types', { method: 'POST', body }),
    update: (id: string, body: Partial<TicketTypeDto>) =>
      request<TicketTypeDto>(`/admin/ticket-types/${id}`, { method: 'PATCH', body }),
    remove: (id: string) => request<void>(`/admin/ticket-types/${id}`, { method: 'DELETE' }),
  },

  tickets: {
    list: (params: { page?: number; pageSize?: number; status?: string; ticketTypeId?: string } = {}) => {
      const query = new URLSearchParams();
      if (params.page) query.set('page', String(params.page));
      if (params.pageSize) query.set('pageSize', String(params.pageSize));
      if (params.status) query.set('status', params.status);
      if (params.ticketTypeId) query.set('ticketTypeId', params.ticketTypeId);
      return request<Paged<TicketDto>>(`/admin/tickets?${query.toString()}`);
    },
    generate: (ticketTypeId: string, count: number) =>
      request<{ batchId: string; count: number; codes: string[] }>('/admin/tickets/generate', {
        method: 'POST',
        body: { ticketTypeId, count },
      }),
    revoke: (id: string) => request<TicketDto>(`/admin/tickets/${id}/revoke`, { method: 'POST' }),
    /**
     * 一键作废：作废当前筛选下全部「未使用」码（used / revoked 不受影响）。
     *
     * @param ticketTypeId 传则只作废该票种；不传即全部票种
     * @returns 实际作废的数量
     */
    revokeBulk: (ticketTypeId?: string) =>
      request<{ revoked: number }>('/admin/tickets/revoke-bulk', {
        method: 'POST',
        body: { ticketTypeId },
      }),
    exportUrl: (params: { status?: string; ticketTypeId?: string } = {}) => {
      const query = new URLSearchParams();
      if (params.status) query.set('status', params.status);
      if (params.ticketTypeId) query.set('ticketTypeId', params.ticketTypeId);
      return downloadUrl(`/admin/tickets/export?${query.toString()}`);
    },
  },

  batches: {
    list: () => request<TicketBatchDto[]>('/admin/ticket-batches'),
  },

  departments: {
    list: () => request<DepartmentAdminDto[]>('/admin/departments'),
    create: (body: { name: string; sortOrder?: number }) =>
      request<DepartmentAdminDto>('/admin/departments', { method: 'POST', body }),
    /** 除名称/排序/启停外，PATCH 还负责问卷表头配置（问卷类型、附件号、标题、填写说明） */
    update: (
      id: string,
      body: {
        name?: string;
        sortOrder?: number;
        enabled?: boolean;
        questionnaireType?: string;
        headerNote?: string;
        title?: string;
        footerNote?: string;
      },
    ) => request<DepartmentAdminDto>(`/admin/departments/${id}`, { method: 'PATCH', body }),
    remove: (id: string) => request<void>(`/admin/departments/${id}`, { method: 'DELETE' }),
  },

  /** 被评列：打分表的列，与职工名单分离（参考表的主任/副书记/得分） */
  voteColumns: {
    list: (departmentId?: string) =>
      request<VoteColumnDto[]>(
        `/admin/vote-columns${departmentId ? `?departmentId=${encodeURIComponent(departmentId)}` : ''}`,
      ),
    create: (body: { departmentId: string; name: string; sortOrder?: number }) =>
      request<VoteColumnDto>('/admin/vote-columns', { method: 'POST', body }),
    update: (id: string, body: { name?: string; sortOrder?: number; enabled?: boolean }) =>
      request<VoteColumnDto>(`/admin/vote-columns/${id}`, { method: 'PATCH', body }),
    remove: (id: string) => request<void>(`/admin/vote-columns/${id}`, { method: 'DELETE' }),
  },

  employees: {
    list: (departmentId?: string) =>
      request<EmployeeDto[]>(
        `/admin/employees${departmentId ? `?departmentId=${encodeURIComponent(departmentId)}` : ''}`,
      ),
    create: (body: { departmentId: string; name: string; employeeNo?: string | null; sortOrder?: number }) =>
      request<EmployeeDto>('/admin/employees', { method: 'POST', body }),
    update: (id: string, body: Partial<EmployeeDto> & { departmentId?: string }) =>
      request<EmployeeDto>(`/admin/employees/${id}`, { method: 'PATCH', body }),
    remove: (id: string) => request<void>(`/admin/employees/${id}`, { method: 'DELETE' }),
    /** 名单导入：multipart 上传，表单字段名 file（与后端手写解析器约定一致）。 */
    import: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return request<ImportFeedback>('/admin/employees/import', { method: 'POST', body: form });
    },
  },

  criteria: {
    list: (departmentId: string) =>
      request<CriterionDto[]>(`/admin/criteria?departmentId=${encodeURIComponent(departmentId)}`),
    create: (body: {
      departmentId: string;
      name: string;
      description?: string | null;
      minScore: number;
      maxScore: number;
      sortOrder?: number;
    }) => request<CriterionDto>('/admin/criteria', { method: 'POST', body }),
    update: (id: string, body: Partial<CriterionDto>) =>
      request<CriterionDto>(`/admin/criteria/${id}`, { method: 'PATCH', body }),
    remove: (id: string) => request<void>(`/admin/criteria/${id}`, { method: 'DELETE' }),
  },

  settings: {
    get: () => request<SettingsDto>('/admin/settings'),
    update: (body: Partial<SettingsDto>) => request<SettingsDto>('/admin/settings', { method: 'PUT', body }),
  },

  stats: {
    overview: () => request<StatsOverview>('/admin/stats/overview'),
  },

  results: {
    list: (departmentId: string) =>
      request<ResultsDto>(`/admin/results?departmentId=${encodeURIComponent(departmentId)}`),
    exportUrl: (departmentId: string) =>
      downloadUrl(`/admin/results/export.xlsx?departmentId=${encodeURIComponent(departmentId)}`),
  },
};