import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminApi, ApiError } from '../../../lib/api.js';
import { renderWithAuth } from '../../../test-utils.js';

/**
 * 场次管理页与「当前场次」切换器的页面级测试。
 *
 * 覆盖四件事：列表与状态 Tag、新建、操作按钮按状态机渲染（含结束的二次确认）、
 * 非法流转 409 的错误提示；另有一条集成用例验证切换场次后概览请求带上新 sessionId。
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
    startAt: null,
    endedAt: null,
    createdAt: '2026-09-19T00:00:00.000Z',
  },
  {
    id: 's2',
    name: '安顺车站',
    status: 'voting' as const,
    startAt: '2026-09-19T00:00:00.000Z',
    endedAt: null,
    createdAt: '2026-09-19T00:00:00.000Z',
  },
  {
    id: 's3',
    name: '贵阳西车站',
    status: 'paused' as const,
    startAt: '2026-09-19T00:00:00.000Z',
    endedAt: null,
    createdAt: '2026-09-19T00:00:00.000Z',
  },
  {
    id: 's4',
    name: '货运车间',
    status: 'ended' as const,
    startAt: '2026-09-18T00:00:00.000Z',
    endedAt: '2026-09-18T12:00:00.000Z',
    createdAt: '2026-09-18T00:00:00.000Z',
  },
];

const overview = {
  ticketTypes: [],
  totals: { issued: 0, used: 0, unused: 0, revoked: 0, sheets: 0 },
  departments: [],
  voteWindow: { open: true, message: '', startAt: null, endAt: null },
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
      stats: { overview: vi.fn(async () => overview) },
    },
  };
});

const { AdminSessions } = await import('../Sessions.js');
const { AdminLayout } = await import('../AdminLayout.js');
const { AdminDashboard } = await import('../Dashboard.js');

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderWithRoutes(ui: ReactElement, path: string) {
  return renderWithAuth(
    <ConfigProvider>
      <AntApp>
        <MemoryRouter initialEntries={[path]}>
          <Routes>{ui}</Routes>
        </MemoryRouter>
      </AntApp>
    </ConfigProvider>,
  );
}

describe('场次管理页', () => {
  it('渲染列表：名称、状态文字与开始/结束时间', async () => {
    renderWithRoutes(<Route path="/admin/sessions" element={<AdminSessions />} />, '/admin/sessions');

    expect(await screen.findByText('内设机构')).toBeInTheDocument();
    expect(screen.getByText('安顺车站')).toBeInTheDocument();
    // 状态文字表意（Tag 颜色仅辅助）
    expect(screen.getByText('未开始')).toBeInTheDocument();
    expect(screen.getByText('投票中')).toBeInTheDocument();
    expect(screen.getByText('已暂停')).toBeInTheDocument();
    expect(screen.getByText('已结束')).toBeInTheDocument();
    // 开始/结束时间列存在
    expect(screen.getByRole('columnheader', { name: '开始时间' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '结束时间' })).toBeInTheDocument();
  });

  it('操作按钮按状态机渲染：draft 开始、voting 暂停/结束、paused 继续/结束、ended 无操作', async () => {
    renderWithRoutes(<Route path="/admin/sessions" element={<AdminSessions />} />, '/admin/sessions');

    expect(await screen.findByRole('button', { name: '开始投票' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '暂停投票' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续投票' })).toBeInTheDocument();
    // 结束投票出现在 voting 与 paused 两行
    expect(screen.getAllByRole('button', { name: '结束投票' })).toHaveLength(2);
    // ended 终态没有操作按钮，只有占位符
    const endedRow = screen.getByText('货运车间').closest('tr')!;
    expect(endedRow.textContent).toContain('-');
    expect(endedRow.querySelectorAll('button')).toHaveLength(0);
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
});

describe('当前场次切换器', () => {
  it('切换场次后，概览统计请求带上新场次 id', async () => {
    const user = userEvent.setup();
    renderWithRoutes(
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<AdminDashboard />} />
      </Route>,
      '/admin',
    );

    // 首次加载：未选择场次（多个场次时不自动选），请求不带 sessionId
    await screen.findByText('开放投票');
    expect(vi.mocked(adminApi.stats.overview)).toHaveBeenCalledWith({ sessionId: null });

    // 头部选择器切到「安顺车站」后，概览按新场次重新拉取
    await user.click(await screen.findByRole('combobox', { name: '当前场次' }));
    await user.click(await screen.findByText('安顺车站'));
    await waitFor(() =>
      expect(vi.mocked(adminApi.stats.overview)).toHaveBeenLastCalledWith({ sessionId: 's2' }),
    );
  });

  it('只有一个场次时自动选中，请求默认带上该场次', async () => {
    vi.mocked(adminApi.sessions.list).mockResolvedValueOnce({
      sessions: [SESSION_ROWS[0]!],
    });
    renderWithRoutes(
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<AdminDashboard />} />
      </Route>,
      '/admin',
    );

    await screen.findByText('开放投票');
    await waitFor(() =>
      expect(vi.mocked(adminApi.stats.overview)).toHaveBeenLastCalledWith({ sessionId: 's1' }),
    );
  });
});
