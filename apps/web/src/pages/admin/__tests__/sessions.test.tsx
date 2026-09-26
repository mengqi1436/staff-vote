import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminApi, ApiError } from '../../../lib/api.js';
import { renderWithAuth } from '../../../test-utils.js';

/**
 * 场次管理页与场次工作台的页面级测试。
 *
 * 覆盖：列表与状态 Tag、开放时间窗列、新建、操作按钮按状态机渲染（含结束的二次确认）、
 * 非法流转 409 的错误提示、行内编辑窗口（留空提交 null）；
 * 工作台：路由场次同步进上下文后各页签按场次取数、场次不存在时引导返回列表。
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
];

const overview = {
  ticketTypes: [],
  totals: { issued: 0, used: 0, unused: 0, revoked: 0, sheets: 0 },
  departments: [],
  voteWindow: { open: false, message: '场次尚未开放', opensAt: null, closesAt: null, status: 'draft' },
  generatedAt: '2026-09-19T02:00:00.000Z',
};

vi.mock('../../../lib/api.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../lib/api.js');
  return {
    ...actual,
    adminApi: {
      sessions: {
        list: vi.fn(async () => ({ sessions: SESSION_ROWS })),
        create: vi.fn(async (name: string) => ({
          session: { ...SESSION_ROWS[0], id: 's9', name, status: 'draft' },
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
      },
      departments: { list: vi.fn(async () => []) },
      stats: { overview: vi.fn(async () => overview) },
    },
  };
});

const { AdminSessions } = await import('../Sessions.js');
const { SessionWorkspace } = await import('../SessionWorkspace.js');
const { formatWindow } = await import('../sessionShared.js');

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderWithRoutes(ui: ReactElement, path: string, sessionId: string | null = null) {
  return renderWithAuth(
    <ConfigProvider>
      <AntApp>
        <MemoryRouter initialEntries={[path]}>
          <Routes>{ui}</Routes>
        </MemoryRouter>
      </AntApp>
    </ConfigProvider>,
    undefined,
    sessionId,
  );
}

describe('场次管理页', () => {
  it('渲染列表：名称、状态文字、开放时间窗与开始/结束时间', async () => {
    renderWithRoutes(<Route path="/admin/sessions" element={<AdminSessions />} />, '/admin/sessions');

    expect(await screen.findByText('内设机构')).toBeInTheDocument();
    expect(screen.getByText('安顺车站')).toBeInTheDocument();
    // 状态文字表意（Tag 颜色仅辅助）
    expect(screen.getByText('未开始')).toBeInTheDocument();
    expect(screen.getByText('投票中')).toBeInTheDocument();
    expect(screen.getByText('已暂停')).toBeInTheDocument();
    expect(screen.getByText('已结束')).toBeInTheDocument();
    // 开放时间窗列：两侧留空给明确说法（s1/s3/s4 三行），设置了窗口则展示时间
    expect(screen.getByRole('columnheader', { name: '开放时间窗' })).toBeInTheDocument();
    expect(screen.getAllByText(/不限开始 ～ 长期开放/)).toHaveLength(3);
    // 开始/结束时间列存在
    expect(screen.getByRole('columnheader', { name: '开始时间' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '结束时间' })).toBeInTheDocument();
  });

  it('操作按钮按状态机渲染：draft 开始、voting 暂停/结束、paused 继续/结束；行内固定有编辑窗口与进入工作台', async () => {
    renderWithRoutes(<Route path="/admin/sessions" element={<AdminSessions />} />, '/admin/sessions');

    expect(await screen.findByRole('button', { name: '开始投票' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '暂停投票' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续投票' })).toBeInTheDocument();
    // 结束投票出现在 voting 与 paused 两行
    expect(screen.getAllByRole('button', { name: '结束投票' })).toHaveLength(2);
    // ended 终态没有状态机按钮，但进入工作台仍然可用（看结果与导出）
    const endedRow = screen.getByText('货运车间').closest('tr')!;
    expect(endedRow.textContent).not.toContain('结束投票');
    expect(screen.getAllByRole('button', { name: '进入工作台' })).toHaveLength(4);
  });

  it('新建场次：输入名称后提交创建请求', async () => {
    const user = userEvent.setup();
    renderWithRoutes(<Route path="/admin/sessions" element={<AdminSessions />} />, '/admin/sessions');

    await user.click(await screen.findByRole('button', { name: /新建场次/ }));
    await user.type(await screen.findByLabelText('场次名称'), '六盘水车站');
    await user.click(screen.getByRole('button', { name: /创\s*建/ }));

    await waitFor(() =>
      expect(vi.mocked(adminApi.sessions.create)).toHaveBeenCalledWith('六盘水车站'),
    );
  });

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

    await user.click(await screen.findByRole('button', { name: '开始投票' }));

    // 409 走统一 ApiError 提示路径：后端原文直接出现在全局提示里
    expect(await screen.findByText('当前状态不允许开始投票')).toBeInTheDocument();
  });

  it('行内编辑窗口：两侧留空提交 null（清空限制），弹窗写明「结束时间为空视为长期开放」', async () => {
    const user = userEvent.setup();
    renderWithRoutes(<Route path="/admin/sessions" element={<AdminSessions />} />, '/admin/sessions');

    // 第一行（内设机构，无窗口）打开编辑弹窗
    await user.click((await screen.findAllByRole('button', { name: '编辑窗口' }))[0]!);

    expect(await screen.findByText(/开放时间窗 · 内设机构/)).toBeInTheDocument();
    expect(await screen.findByText(/结束时间为空视为长期开放/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /保\s*存/ }));

    await waitFor(() =>
      expect(vi.mocked(adminApi.sessions.update)).toHaveBeenCalledWith('s1', {
        opensAt: null,
        closesAt: null,
      }),
    );
  });
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

describe('场次工作台', () => {
  it('按路由场次渲染页头（状态与窗口）与八个页签，数据请求带上场次 id', async () => {
    renderWithRoutes(
      <Route path="/admin/sessions/:id" element={<SessionWorkspace />} />,
      '/admin/sessions/s2',
      's2',
    );

    // 页头常驻开放控制：场次名（注入的固定场次名）+ 状态 Tag（注入固定为 draft）+ 开放窗口
    expect(await screen.findByText('测试场次')).toBeInTheDocument();
    expect(screen.getByText('未开始')).toBeInTheDocument();
    expect(screen.getByText(/开放窗口：/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /编辑窗口/ })).toBeInTheDocument();

    // 页签顺序：部门 → 项点 → 职工 → 问卷 → 票种权重 → 随机码 → 统计 → 结果导出
    const labels = screen
      .getAllByRole('tab')
      .map((tab) => tab.textContent)
      .filter((text) => text !== null);
    expect(labels).toEqual(['部门', '项点', '职工', '问卷', '票种权重', '随机码', '统计', '结果导出']);

    // 路由场次已同步进上下文：页签里的页面组件按该场次取数
    await waitFor(() =>
      expect(vi.mocked(adminApi.departments.list)).toHaveBeenCalledWith({ sessionId: 's2' }),
    );
  }, 20_000);

  it('场次不存在时给出引导，返回场次列表', async () => {
    renderWithRoutes(
      <Route path="/admin/sessions/:id" element={<SessionWorkspace />} />,
      '/admin/sessions/nope',
    );

    expect(await screen.findByText('场次不存在或已被删除')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回场次列表' })).toBeInTheDocument();
    // 不存在的场次不写入上下文：不发生任何按场次取数的请求
    expect(vi.mocked(adminApi.departments.list)).not.toHaveBeenCalled();
  });
});
