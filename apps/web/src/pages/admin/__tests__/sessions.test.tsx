import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminApi, ApiError } from '../../../lib/api.js';
import { renderWithAuth } from '../../../test-utils.js';

/**
 * 评议管理页与评议工作台的页面级测试。
 *
 * 覆盖：列表与状态 Tag、开放时间列、新建、操作按钮按状态机渲染（含结束的二次确认）、
 * 非法流转 409 的错误提示、行内编辑窗口（留空提交 null）；
 * 工作台：路由评议同步进上下文后各页签按评议取数、评议不存在时引导返回列表。
 * 与 pages.test.tsx 同一惯例：mock adminApi、注入身份上下文、补 jsdom 缺失的 ResizeObserver。
 */
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

const SESSION_ROWS = [
  {
    id: 's1',
    name: '内设机构',
    status: 'draft' as const,
    opensAt: null,
    closesAt: null,
    startAt: null,
    endedAt: null,
    createdAt: '2026-09-19T00:00:00.000Z',
    // draft 带阻塞清单：开始投票按钮应禁用（见下方用例）
    startBlockers: ['尚未配置启用部门：至少需要一个启用部门'],
  },
  {
    id: 's2',
    name: '安顺车站',
    status: 'voting' as const,
    opensAt: '2026-09-19T00:00:00.000Z',
    closesAt: '2026-09-30T23:59:00.000Z',
    startAt: '2026-09-19T00:00:00.000Z',
    endedAt: null,
    createdAt: '2026-09-19T00:00:00.000Z',
  },
  {
    id: 's3',
    name: '贵阳西车站',
    status: 'paused' as const,
    opensAt: null,
    closesAt: null,
    startAt: '2026-09-19T00:00:00.000Z',
    endedAt: null,
    createdAt: '2026-09-19T00:00:00.000Z',
  },
  {
    id: 's4',
    name: '货运车间',
    status: 'ended' as const,
    opensAt: null,
    closesAt: null,
    startAt: '2026-09-18T00:00:00.000Z',
    endedAt: '2026-09-18T12:00:00.000Z',
    createdAt: '2026-09-18T00:00:00.000Z',
  },
  {
    // 配置完整的 draft：开始按钮可点，409 防御路径的用例靠它触发
    id: 's5',
    name: '盘江车站',
    status: 'draft' as const,
    opensAt: null,
    closesAt: null,
    startAt: null,
    endedAt: null,
    createdAt: '2026-09-19T00:00:00.000Z',
    startBlockers: [],
  },
];

const overview = {
  ticketTypes: [],
  totals: { issued: 0, used: 0, unused: 0, revoked: 0, sheets: 0 },
  departments: [],
  voteWindow: { open: false, message: '评议尚未开放', opensAt: null, closesAt: null, status: 'draft' },
  generatedAt: '2026-09-19T02:00:00.000Z',
};

vi.mock('../../../lib/api.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../lib/api.js');
  return {
    ...actual,
    adminApi: {
      sessions: {
        list: vi.fn(async () => ({ sessions: SESSION_ROWS })),
        // 契约 B：create 收对象体（name + 全局部门 + 时间窗）
        create: vi.fn(async (values: { name: string; orgDepartmentId: string; opensAt: string; closesAt?: string | null }) => ({
          session: {
            ...SESSION_ROWS[0],
            id: 's9',
            name: values.name,
            status: 'draft',
            orgDepartmentId: values.orgDepartmentId,
            orgDepartmentName: '客运车间',
          },
        })),
        update: vi.fn(async (id: string, body: Record<string, unknown>) => ({
          session: { ...SESSION_ROWS.find((row) => row.id === id)!, ...body },
        })),
        start: vi.fn(async (id: string) => ({
          session: { ...SESSION_ROWS.find((row) => row.id === id)!, status: 'voting' },
        })),
        pause: vi.fn(async (id: string) => ({
          session: { ...SESSION_ROWS.find((row) => row.id === id)!, status: 'paused' },
        })),
        end: vi.fn(async (id: string) => ({
          session: { ...SESSION_ROWS.find((row) => row.id === id)!, status: 'ended' },
        })),
        // 删除评议：成功返回 204（request 层解析为 undefined）
        remove: vi.fn(async () => undefined),
        // 契约 D：人员类别规划返回建种与发码结果
        ticketPlan: vi.fn(async () => ({
          ticketTypes: [
            { id: 't1', code: 'A', name: '职工代表', weightPercent: 100, sortOrder: 1, enabled: true },
          ],
          generated: [{ ticketTypeId: 't1', batchId: 'b1', count: 10 }],
        })),
      },
      // 建场向导第 1 步的全局部门列表
      orgDepartments: {
        list: vi.fn(async () => ({
          departments: [
            { id: 'od1', name: '客运车间', sortOrder: 1, enabled: true, createdAt: '2026-09-01T00:00:00.000Z' },
          ],
        })),
      },
      departments: { list: vi.fn(async () => []) },
      voteColumns: { list: vi.fn(async () => []) },
      criteria: { list: vi.fn(async () => []) },
      employees: { list: vi.fn(async () => []) },
      /** 打分表网格的选人下拉已改为查全局人员目录 */
      staffDirectory: { list: vi.fn(async () => []) },
      ticketTypes: { list: vi.fn(async () => []) },
      stats: {
        overview: vi.fn(async () => overview),
        samples: vi.fn(async () => ({
          personal: { criteriaNames: [], rows: [] },
          workshop: { criteriaNames: [], rows: [] },
          sheetCount: 0,
          generatedAt: '2026-09-19T02:00:00.000Z',
        })),
      },
    },
  };
});

const { AdminSessions } = await import('../Sessions.js');
const { SessionWorkspace } = await import('../SessionWorkspace.js');
const { formatWindow } = await import('../sessionShared.js');
const { AdminSessionProvider, useAdminSession } = await import('../../../lib/sessionContext.js');

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderWithRoutes(
  ui: ReactElement,
  path: string,
  sessionId: string | null = null,
  permissions?: string[],
  sessionOverrides?: Parameters<typeof renderWithAuth>[3],
) {
  return renderWithAuth(
    <ConfigProvider>
      <AntApp>
        <MemoryRouter initialEntries={[path]}>
          <Routes>{ui}</Routes>
        </MemoryRouter>
      </AntApp>
    </ConfigProvider>,
    permissions,
    sessionId,
    sessionOverrides,
  );
}

describe('评议管理页', () => {
  it('渲染列表：名称、状态文字、开放时间与开始/结束时间', async () => {
    renderWithRoutes(<Route path="/admin/sessions" element={<AdminSessions />} />, '/admin/sessions');

    expect(await screen.findByText('内设机构')).toBeInTheDocument();
    expect(screen.getByText('安顺车站')).toBeInTheDocument();
    // 状态文字表意（Tag 颜色仅辅助）；s1 与 s5 两个 draft 都是「未开始」
    expect(screen.getAllByText('未开始')).toHaveLength(2);
    expect(screen.getByText('投票中')).toBeInTheDocument();
    expect(screen.getByText('已暂停')).toBeInTheDocument();
    expect(screen.getByText('已结束')).toBeInTheDocument();
    // 开放时间列：两侧留空给明确说法（s1/s3/s4/s5 四行），设置了窗口则展示时间
    expect(screen.getByRole('columnheader', { name: /开放时间/ })).toBeInTheDocument();
    expect(screen.getAllByText(/不限开始 ～ 长期开放/)).toHaveLength(4);
    // 开始/结束时间列存在
    expect(screen.getByRole('columnheader', { name: '开始时间' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '结束时间' })).toBeInTheDocument();
  });

  it('操作按钮按状态机渲染：draft 开始、voting 暂停/结束、paused 继续/结束；draft 行内是「继续配置」', async () => {
    renderWithRoutes(<Route path="/admin/sessions" element={<AdminSessions />} />, '/admin/sessions');

    expect(await screen.findByRole('button', { name: '暂停投票' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续投票' })).toBeInTheDocument();
    // 开始投票出现在两行 draft：s1 配置未完成（禁用）、s5 配置完整（可点）
    expect(screen.getAllByRole('button', { name: '开始投票' })).toHaveLength(2);
    // 结束投票出现在 voting 与 paused 两行
    expect(screen.getAllByRole('button', { name: '结束投票' })).toHaveLength(2);
    // ended 终态没有状态机按钮，但进入工作台仍然可用（看结果与导出）
    const endedRow = screen.getByText('货运车间').closest('tr')!;
    expect(endedRow.textContent).not.toContain('结束投票');
    // draft 行的入口文案是「继续配置」（契约 M），其余各行是「进入工作台」
    expect(screen.getAllByRole('button', { name: '进入工作台' })).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: '继续配置' })).toHaveLength(2);
  });

  it('draft 评议配置未完成时「开始投票」禁用（startBlockers 非空）', async () => {
    renderWithRoutes(<Route path="/admin/sessions" element={<AdminSessions />} />, '/admin/sessions');

    // s1 的 startBlockers 非空：按钮渲染为禁用态，Tooltip 说明缺项（span 包裹保证可触发）
    const startButtons = await screen.findAllByRole('button', { name: '开始投票' });
    expect(startButtons).toHaveLength(2);
    const disabled = startButtons.find((b) => b.hasAttribute('disabled'));
    expect(disabled).toBeTruthy();
    expect(disabled!.closest('span')).not.toBeNull();
  });

  it('新建评议向导第 1 步：选部门自动填默认名称，提交契约 B 的创建请求', async () => {
    const user = userEvent.setup();
    renderWithRoutes(<Route path="/admin/sessions" element={<AdminSessions />} />, '/admin/sessions');

    await user.click(await screen.findByRole('button', { name: /新建评议/ }));
    expect(await screen.findByText('基本信息')).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(adminApi.orgDepartments.list)).toHaveBeenCalled());

    // 部门下拉来自全局部门列表。注意 antd 6 的 Select 会渲染一个隐藏的 aria 镜像
    // option（role=option 但不可交互），必须点浮层里真正可见的 option 元素
    await user.click(screen.getByRole('combobox', { name: '选择部门' }));
    await user.click(await screen.findByText('客运车间'));

    // 名称默认「{部门名}评议」
    expect(await screen.findByLabelText(/评议名称/)).toHaveValue('客运车间评议');

    // 开始时间必填；结束时间留空 = 永久开放
    await user.type(screen.getByLabelText('开始时间'), '2026-10-01 09:00');
    await user.tab();

    await user.click(screen.getByRole('button', { name: /创建并配置打分表/ }));

    await waitFor(() => expect(vi.mocked(adminApi.sessions.create)).toHaveBeenCalledTimes(1));
    const values = vi.mocked(adminApi.sessions.create).mock.calls[0]![0]!;
    expect(values.name).toBe('客运车间评议');
    expect(values.orgDepartmentId).toBe('od1');
    expect(values.closesAt).toBeNull();
    expect(values.opensAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);

    // 创建成功进入第 2 步（打分表网格），评议列表同步刷新；
    // 打分表网格自身也会拉一次评议（scoreScope），所以是 ≥2 而非精确次数
    expect(await screen.findByText(/下一步：人员类别分配/)).toBeInTheDocument();
    await waitFor(() =>
      expect(vi.mocked(adminApi.sessions.list).mock.calls.length).toBeGreaterThanOrEqual(2),
    );
  }, 20_000);

  it('新建评议向导第 3 步：权重合计实时校验，达 100 后提交 ticketPlan 并显示发码数', async () => {
    const user = userEvent.setup();
    renderWithRoutes(<Route path="/admin/sessions" element={<AdminSessions />} />, '/admin/sessions');

    await user.click(await screen.findByRole('button', { name: /新建评议/ }));
    await user.click(await screen.findByRole('combobox', { name: '选择部门' }));
    await user.click(await screen.findByText('客运车间'));
    await user.type(await screen.findByLabelText('开始时间'), '2026-10-01 09:00');
    await user.tab();
    await user.click(screen.getByRole('button', { name: /创建并配置打分表/ }));

    // 第 2 步 → 第 3 步
    await user.click(await screen.findByRole('button', { name: /下一步：人员类别分配/ }));
    await user.click(await screen.findByRole('button', { name: /添加人员类别/ }));
    await user.type(await screen.findByLabelText('人员类别编码（第 1 行）'), 'A');
    await user.type(screen.getByLabelText('人员类别名称（第 1 行）'), '职工代表');
    await user.type(screen.getByLabelText('人员类别权重（第 1 行）'), '80');
    await user.type(screen.getByLabelText('发码数量（第 1 行）'), '10');

    // 权重合计实时校验：80% 时按钮禁用并写清差额
    expect(screen.getByText(/还差 20%/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /保存人员类别并生成随机码/ })).toBeDisabled();

    await user.clear(screen.getByLabelText('人员类别权重（第 1 行）'));
    await user.type(screen.getByLabelText('人员类别权重（第 1 行）'), '100');
    expect(await screen.findByText(/符合要求/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /保存人员类别并生成随机码/ }));
    await waitFor(() =>
      expect(vi.mocked(adminApi.sessions.ticketPlan)).toHaveBeenCalledWith('s9', [
        { code: 'A', name: '职工代表', weightPercent: 100, count: 10 },
      ]),
    );

    // 完成态：显示各人员类别发码数与「进入工作台」入口（列表行内也有同名链接，断言数量增加即可）
    expect(await screen.findByText('职工代表（A）')).toBeInTheDocument();
    expect(screen.getByText(/10 张/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /进入工作台/ }).length).toBeGreaterThan(0);
  }, 30_000);

  it('结束投票需二次确认，确认后才调用 end', async () => {
    const user = userEvent.setup();
    renderWithRoutes(<Route path="/admin/sessions" element={<AdminSessions />} />, '/admin/sessions');

    await screen.findByText('安顺车站');
    // voting 与 paused 两行都有「结束投票」，取第一行（voting，安顺车站）的触发按钮
    await user.click(screen.getAllByRole('button', { name: '结束投票' })[0]!);

    // 未确认前不调用
    expect(adminApi.sessions.end).not.toHaveBeenCalled();
    // Popconfirm 打开后气泡里出现确认按钮（挂载在 body 末尾），点它
    const confirmButtons = await screen.findAllByRole('button', { name: '结束投票' });
    expect(confirmButtons.length).toBe(3);
    await user.click(confirmButtons[confirmButtons.length - 1]!);

    await waitFor(() => expect(vi.mocked(adminApi.sessions.end)).toHaveBeenCalledWith('s2'));
  });

  it('暂停投票直接调用 pause', async () => {
    const user = userEvent.setup();
    renderWithRoutes(<Route path="/admin/sessions" element={<AdminSessions />} />, '/admin/sessions');

    await user.click(await screen.findByRole('button', { name: '暂停投票' }));

    await waitFor(() => expect(vi.mocked(adminApi.sessions.pause)).toHaveBeenCalledWith('s2'));
  });

  it('开始投票被 409 拒绝时提示后端文案', async () => {
    vi.mocked(adminApi.sessions.start).mockRejectedValueOnce(
      new ApiError(409, 'INVALID_SESSION_TRANSITION', '当前状态不允许开始投票'),
    );
    const user = userEvent.setup();
    renderWithRoutes(<Route path="/admin/sessions" element={<AdminSessions />} />, '/admin/sessions');

    // 禁用行（s1）点不了，点配置完整的 s5 行模拟列表数据陈旧的竞态
    const startButtons = await screen.findAllByRole('button', { name: '开始投票' });
    await user.click(startButtons.find((b) => !b.hasAttribute('disabled'))!);

    // 409 走统一 ApiError 提示路径：后端原文直接出现在全局提示里
    expect(await screen.findByText('当前状态不允许开始投票')).toBeInTheDocument();
  });

  it('开始投票被 SESSION_INCOMPLETE 拒绝时，弹窗列出缺项清单并引导回工作台（契约 M）', async () => {
    vi.mocked(adminApi.sessions.start).mockRejectedValueOnce(
      new ApiError(409, 'SESSION_INCOMPLETE', '1. 启用部门不足；2. 启用人员类别权重合计未达 100%'),
    );
    const user = userEvent.setup();
    renderWithRoutes(<Route path="/admin/sessions" element={<AdminSessions />} />, '/admin/sessions');

    const startButtons = await screen.findAllByRole('button', { name: '开始投票' });
    await user.click(startButtons.find((b) => !b.hasAttribute('disabled'))!);

    // confirm 弹窗的标题在 Modal 壳与 confirm 体内各渲染一份，用 findAllByText
    expect(await screen.findAllByText(/配置未完成，还不能开始投票/)).not.toHaveLength(0);
    expect(screen.getByText(/启用人员类别权重合计未达 100%/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去工作台继续配置' })).toBeInTheDocument();
  });

  it('行内编辑窗口：两侧留空提交 null（清空限制），弹窗写明「结束时间为空视为长期开放」', async () => {
    const user = userEvent.setup();
    renderWithRoutes(<Route path="/admin/sessions" element={<AdminSessions />} />, '/admin/sessions');

    // 第一行（内设机构，无窗口）打开编辑弹窗
    await user.click((await screen.findAllByRole('button', { name: '编辑开放时间' }))[0]!);

    expect(await screen.findByText(/开放时间 · 内设机构/)).toBeInTheDocument();
    // 留空含义已收进「时间范围」旁的说明图标，悬停后才可见
    const dialog = await screen.findByRole('dialog');
    await user.hover(within(dialog).getByRole('button', { name: '查看说明' }));
    expect(await screen.findByText(/结束时间为空表示一直开放/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /保\s*存/ }));

    await waitFor(() =>
      expect(vi.mocked(adminApi.sessions.update)).toHaveBeenCalledWith('s1', {
        opensAt: null,
        closesAt: null,
      }),
    );
  });

  it('删除评议：投票中的行禁用，其余需二次确认后才调用 remove', async () => {
    const user = userEvent.setup();
    renderWithRoutes(<Route path="/admin/sessions" element={<AdminSessions />} />, '/admin/sessions');

    await screen.findByText('内设机构');
    const deleteButtons = screen.getAllByRole('button', { name: '删除' });
    expect(deleteButtons.length).toBe(5);

    // 投票中的 s2 行禁用并给出原因，不进入 Popconfirm
    const votingDelete = deleteButtons[1]!;
    expect(votingDelete).toBeDisabled();
    await userEvent.hover(votingDelete);
    expect(await screen.findByText(/评议正在投票，请先暂停或结束再删除/)).toBeInTheDocument();

    // 其余行可点：第一行 s1（draft）
    expect(adminApi.sessions.remove).not.toHaveBeenCalled();
    await user.click(deleteButtons[0]!);
    expect(adminApi.sessions.remove).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(vi.mocked(adminApi.sessions.remove)).toHaveBeenCalledWith('s1'));
  });

  it('删除被 409 拒绝时提示后端文案（有答卷不可删）', async () => {
    vi.mocked(adminApi.sessions.remove).mockRejectedValueOnce(
      new ApiError(409, 'SESSION_HAS_SHEETS', '评议「内设机构」已收到 3 份答卷，不能删除（历史评分必须保留）'),
    );
    const user = userEvent.setup();
    renderWithRoutes(<Route path="/admin/sessions" element={<AdminSessions />} />, '/admin/sessions');

    const deleteButtons = await screen.findAllByRole('button', { name: '删除' });
    await user.click(deleteButtons[0]!);
    await user.click(await screen.findByRole('button', { name: '确认删除' }));

    expect(await screen.findByText(/已收到 3 份答卷，不能删除/)).toBeInTheDocument();
  });
});

describe('状态机按钮权限门控（只读账号）', () => {
  it('列表行内状态机按钮保留但禁用，并说明缺哪个权限', async () => {
    renderWithRoutes(
      <Route path="/admin/sessions" element={<AdminSessions />} />,
      '/admin/sessions',
      null,
      [],
    );

    const pause = await screen.findByRole('button', { name: '暂停投票' });
    expect(pause).toBeDisabled();
    // 主操作按钮无权限时不渲染（不是给一个点不动的按钮）
    expect(screen.queryByRole('button', { name: /新建评议/ })).toBeNull();
    const ends = screen.getAllByRole('button', { name: '结束投票' });
    expect(ends).toHaveLength(2);
    for (const button of ends) expect(button).toBeDisabled();

    // 删除同属 settings.write：无权限时保留但禁用（不是隐藏，整列消失会像缺功能）
    const deletes = screen.getAllByRole('button', { name: '删除' });
    expect(deletes).toHaveLength(5);
    for (const button of deletes) expect(button).toBeDisabled();

    await userEvent.hover(pause);
    expect(
      await screen.findByText(/无「修改开放时间与系统设置」权限/),
    ).toBeInTheDocument();
  }, 15_000);

  it('工作台不渲染状态机主操作按钮', async () => {
    renderWithRoutes(
      <Route path="/admin/sessions/:id" element={<SessionWorkspace />} />,
      '/admin/sessions/s2',
      's2',
      [],
    );

    expect(await screen.findByText('测试评议')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开始投票' })).toBeNull();
    expect(screen.queryByRole('button', { name: /编辑窗口/ })).toBeNull();
  }, 15_000);
});

describe('formatWindow（窗口单行描述）', () => {
  it('任一侧留空给出对应含义，有值按本地时区输出到分钟', () => {
    expect(formatWindow(null, null)).toBe('不限开始 ～ 长期开放');
    expect(formatWindow('2026-09-19T00:00:00.000Z', null)).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} ～ 长期开放$/,
    );
    expect(formatWindow(null, '2026-09-30T23:59:00.000Z')).toMatch(
      /^不限开始 ～ \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
    );
  });
});

describe('评议工作台', () => {
  it('按路由评议渲染页头（状态与窗口）与五个页签，数据请求带上评议 id', async () => {
    renderWithRoutes(
      <Route path="/admin/sessions/:id" element={<SessionWorkspace />} />,
      '/admin/sessions/s2',
      's2',
    );

    // 页头常驻开放控制：评议名（注入的固定评议名）+ 状态 Tag（注入固定为 draft）+ 开放窗口
    expect(await screen.findByText('测试评议')).toBeInTheDocument();
    expect(screen.getByText('未开始')).toBeInTheDocument();
    expect(screen.getByText(/开放时间：/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /编辑开放时间/ })).toBeInTheDocument();

    // 页签顺序：打分表 → 人员类别权重 → 随机码 → 统计 → 结果导出
    //（「部门」「评议项目」页签已移除：场内部门建场自动生成、评议项目并入打分表网格；
    //  「职工」页签已迁到全局人员管理 /admin/employees）
    const labels = screen
      .getAllByRole('tab')
      .map((tab) => tab.textContent)
      .filter((text) => text !== null);
    expect(labels).toEqual(['打分表', '人员类别权重', '随机码', '统计', '结果导出']);

    // 路由评议已同步进上下文：初始「打分表」页签按当前评议拉取场内部门
    await waitFor(() =>
      expect(vi.mocked(adminApi.departments.list)).toHaveBeenCalledWith({ sessionId: 's2' }),
    );
  }, 20_000);

  it('统计页签切走即卸载（停掉 5 秒轮询），切回重新挂载并取数', async () => {
    const user = userEvent.setup();
    // 统计页签只在投票结束后开放：注入 ended 状态评议
    renderWithRoutes(
      <Route path="/admin/sessions/:id" element={<SessionWorkspace />} />,
      '/admin/sessions/s2',
      's2',
      undefined,
      { status: 'ended', endedAt: '2026-09-20T00:00:00.000Z' },
    );

    await screen.findByText('测试评议');
    // 初始停留在「打分表」页签：统计未挂载、不取数
    expect(adminApi.stats.overview).not.toHaveBeenCalled();

    await user.click(screen.getByRole('tab', { name: '统计' }));
    expect(await screen.findByText('各人员类别发放与使用')).toBeInTheDocument();
    await waitFor(() =>
      expect(vi.mocked(adminApi.stats.overview)).toHaveBeenCalledWith({ sessionId: 's2' }),
    );

    // 切走后统计组件卸载，其 usePolling 的清理随之停掉 5 秒定时器
    await user.click(screen.getByRole('tab', { name: '打分表' }));
    await waitFor(() => expect(screen.queryByText('各人员类别发放与使用')).toBeNull());

    // 切回重新挂载并重新取数：与切走前的调用次数比对增量，不写死绝对次数，
    // 避免与 stats 的 5 秒轮询（慢环境下可能已多触发一次）竞争
    const callsBeforeReturn = vi.mocked(adminApi.stats.overview).mock.calls.length;
    await user.click(screen.getByRole('tab', { name: '统计' }));
    expect(await screen.findByText('各人员类别发放与使用')).toBeInTheDocument();
    await waitFor(() =>
      expect(vi.mocked(adminApi.stats.overview).mock.calls.length).toBeGreaterThan(callsBeforeReturn),
    );
  }, 20_000);

  it('投票未结束时统计页签禁用且不取数', async () => {
    // 注入的评议缺省即 draft（未结束）：统计页签应禁用
    renderWithRoutes(
      <Route path="/admin/sessions/:id" element={<SessionWorkspace />} />,
      '/admin/sessions/s2',
      's2',
    );

    await screen.findByText('测试评议');
    const statsTab = screen.getByRole('tab', { name: '统计' });
    expect(statsTab).toHaveAttribute('aria-disabled', 'true');
    // 禁用页签不触发任何统计取数
    expect(adminApi.stats.overview).not.toHaveBeenCalled();
    expect(adminApi.stats.samples).not.toHaveBeenCalled();
  }, 20_000);

  it('投票结束后统计页签开放', async () => {
    renderWithRoutes(
      <Route path="/admin/sessions/:id" element={<SessionWorkspace />} />,
      '/admin/sessions/s2',
      's2',
      undefined,
      { status: 'ended', endedAt: '2026-09-20T00:00:00.000Z' },
    );

    await screen.findByText('测试评议');
    expect(screen.getByRole('tab', { name: '统计' })).not.toHaveAttribute('aria-disabled', 'true');
  }, 20_000);

  it('评议不存在时给出引导，返回评议列表', async () => {
    renderWithRoutes(
      <Route path="/admin/sessions/:id" element={<SessionWorkspace />} />,
      '/admin/sessions/nope',
    );

    expect(await screen.findByText('评议不存在或已被删除')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回评议列表' })).toBeInTheDocument();
    // 不存在的评议不写入上下文：不发生任何按评议取数的请求
    expect(vi.mocked(adminApi.departments.list)).not.toHaveBeenCalled();
  });
});

describe('当前评议上下文', () => {
  it('评议被删光后清空持久化的「当前评议」，避免继续带已删除 id 发请求', async () => {
    localStorage.setItem('staff_vote_admin_session_id', 'gone');
    // 列表已空 = 最后一个评议刚被删除（真实场景：删除按钮 → reload()）
    vi.mocked(adminApi.sessions.list).mockResolvedValueOnce({ sessions: [] });

    function Probe() {
      const { sessionId, loading } = useAdminSession();
      return <span>{loading ? 'loading' : (sessionId ?? 'none')}</span>;
    }

    render(
      <AdminSessionProvider>
        <Probe />
      </AdminSessionProvider>,
    );

    expect(await screen.findByText('none')).toBeInTheDocument();
    expect(localStorage.getItem('staff_vote_admin_session_id')).toBeNull();
  });
});
