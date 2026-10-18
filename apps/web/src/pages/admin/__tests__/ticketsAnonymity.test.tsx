/**
 * 随机码页匿名边界测试（设计要求第 1 条「不记名投票」）。
 *
 * 覆盖：
 *   - 明细列表请求固定 status:'unused'，管理员无法按「已使用」筛选；
 *   - 表格没有「状态」「使用时间」列，也没有行内「导出答卷」入口；
 *   - 状态筛选下拉不存在，导出按钮固定为「导出未使用码」；
 *   - 「人员类别使用统计」以人员类别级聚合（已发放/已使用/未使用/已作废）披露使用进度。
 *
 * 后端防线（列表/导出忽略 status 条件）由 apps/api 的接口测试覆盖。
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithAuth } from '../../../test-utils.js';

vi.mock('../../../lib/api.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../lib/api.js');
  return {
    ...actual,
    /** 下载改为 fetch 实现，测试里不该真的发请求 */
    downloadFile: vi.fn(async () => undefined),
    adminApi: {
      ticketTypes: {
        list: vi.fn(async () => [
          {
            id: 'a',
            code: 'A',
            name: '领导班子',
            weightPercent: 100,
            sortOrder: 1,
            enabled: true,
            issuedCount: 10,
            usedCount: 4,
            unusedCount: 3,
          },
        ]),
      },
      tickets: {
        list: vi.fn(),
        revokeBulk: vi.fn(),
        generate: vi.fn(),
        revoke: vi.fn(),
        exportUrl: () => '/api/admin/tickets/export',
        exportByTicketTypeUrl: (batchIds: string[]) =>
          `/api/admin/tickets/export-by-type.xlsx?batchIds=${encodeURIComponent(batchIds.join(','))}`,
      },
      departments: {
        list: vi.fn(async () => [
          { id: 'd1', name: '贵阳西车间', sortOrder: 1, enabled: true },
        ]),
      },
      batches: { list: vi.fn(async () => []) },
    },
  };
});

const { adminApi, downloadFile } = await import('../../../lib/api.js');
const { AdminTickets } = await import('../Tickets.js');

const listMock = vi.mocked(adminApi.tickets.list);

/** 未使用码行：明细里唯一允许出现的状态。 */
const UNUSED_ROW = {
  id: 'k1',
  code: 'ABCD2345',
  status: 'unused' as const,
  usedAt: null,
  createdAt: '2026-09-19T02:00:00.000Z',
  ticketType: { id: 'a', code: 'A', name: '领导班子' },
  batchId: 'batch1',
};

function renderPage() {
  return renderWithAuth(
    <ConfigProvider>
      <AntApp>
        <MemoryRouter initialEntries={['/admin/tickets']}>
          <AdminTickets />
        </MemoryRouter>
      </AntApp>
    </ConfigProvider>,
    ['tickets.generate', 'tickets.revoke'],
    's1',
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue({
    items: [UNUSED_ROW],
    total: 1,
    page: 1,
    pageSize: 20,
  });
});

describe('随机码明细匿名边界', () => {
  it('列表请求固定 status:unused，无法按已使用筛选', async () => {
    renderPage();

    await screen.findByText('ABCD2345');
    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'unused', sessionId: 's1' }),
    );
    const usedCalls = listMock.mock.calls.filter((call) => call[0]?.status !== 'unused');
    expect(usedCalls).toHaveLength(0);
  }, 15_000);

  it('明细表没有状态列、使用时间列与行内导出答卷入口', async () => {
    renderPage();

    await screen.findByText('ABCD2345');
    expect(screen.queryByText('状态')).toBeNull();
    expect(screen.queryByText('使用时间')).toBeNull();
    expect(screen.queryByRole('button', { name: '导出答卷' })).toBeNull();
  }, 15_000);

  it('没有状态筛选下拉；导出未使用码与发码下载走同一条 fetch 下载路径', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('ABCD2345');
    expect(screen.queryByRole('combobox', { name: '按状态筛选' })).toBeNull();

    // 不再是 <a href> 直链：错误响应会被拦下，而不是把 JSON 存成 .xlsx
    expect(screen.queryByRole('link', { name: /导出未使用码/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: /导出未使用码/ }));
    await waitFor(() => expect(vi.mocked(downloadFile)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(downloadFile).mock.calls[0]![0]).toContain('/api/admin/tickets/export');
  }, 15_000);

  it('人员类别使用统计以聚合说明展示已发放/已使用/未使用/已作废', async () => {
    renderPage();

    expect(await screen.findByText('人员类别使用统计')).toBeInTheDocument();
    // 已作废 = 已发放 10 − 已使用 4 − 未使用 3 = 3
    // 「领导班子（A）」在统计卡与明细表都会出现，取带统计数字的那一行
    const statsRow = screen
      .getAllByText('领导班子（A）')
      .map((el) => el.closest('tr')!)
      .find((tr) => tr.textContent.includes('10'))!;
    expect(statsRow).toBeTruthy();
    expect(statsRow.textContent).toContain('4');
    expect(statsRow.textContent).toContain('3');
  }, 15_000);
});

describe('发码结果按人员类别分组', () => {
  /**
   * 一次给多个人员类别发码后，结果弹窗必须能看出「哪些码是哪个人员类别」。
   * 曾经只收集码字符串，管理员面对一堆码分不清人员类别（发错人员类别 = 发错权重）。
   */
  it('多人员类别一次发码：弹窗按人员类别分组并各自标注张数', async () => {
    const user = userEvent.setup();
    // 未使用码总数与列表同源（列表的 total）：初始 0（一键作废禁用）→ 发码后变 3（立即可用）
    let listTotal = 0;
    listMock.mockImplementation(
      async () => ({ items: [], total: listTotal, page: 1, pageSize: 20 }) as never,
    );
    vi.mocked(adminApi.ticketTypes.list).mockResolvedValue([
      {
        id: 'a',
        code: 'A',
        name: '领导班子',
        weightPercent: 50,
        sortOrder: 1,
        enabled: true,
        issuedCount: 0,
        usedCount: 0,
        unusedCount: 0,
      },
      {
        id: 'c',
        code: 'C',
        name: '职工',
        weightPercent: 50,
        sortOrder: 2,
        enabled: true,
        issuedCount: 0,
        usedCount: 0,
        unusedCount: 0,
      },
    ] as never);
    vi.mocked(adminApi.tickets.generate).mockImplementation(
      async (ticketTypeId: string, count: number) => {
        listTotal += ticketTypeId === 'a' ? 2 : 1;
        return {
          ticketTypeId,
          batchId: ticketTypeId === 'a' ? 'batch-a' : 'batch-c',
          count,
          codes: ticketTypeId === 'a' ? ['AAAA1111', 'AAAA2222'] : ['CCCC3333'],
        } as never;
      },
    );

    renderPage();

    // 发码前：列表已取数且确为 0（「没有未使用码」只在数据已知且为 0 时出现），按钮禁用
    expect(await screen.findByText('当前筛选下没有未使用码')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /一键作废未使用码/ })).toBeDisabled();

    await user.type(await screen.findByLabelText('「领导班子」发放数量'), '2');
    await user.type(screen.getByLabelText('「职工」发放数量'), '1');

    // 评议部门必选
    await user.click(screen.getByLabelText('评议部门'));
    await user.click(await screen.findByText('贵阳西车间'));

    const statsCallsBefore = vi.mocked(adminApi.ticketTypes.list).mock.calls.length;

    await user.click(screen.getByRole('button', { name: /生成随机码/ }));

    // 发码后：未使用码总数被刷新，一键作废立即可用（曾经漏刷新，按钮一直禁用）
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /一键作废未使用码/ })).toBeEnabled(),
    );
    // 人员类别使用统计也是独立数据源，同样要在发码后重新取数
    await waitFor(() =>
      expect(vi.mocked(adminApi.ticketTypes.list).mock.calls.length).toBeGreaterThan(
        statsCallsBefore,
      ),
    );

    // 弹窗按人员类别分组：每组标题 + 张数，码落在各自组内
    expect(await screen.findByText('本次生成的随机码')).toBeInTheDocument();
    // 「领导班子（A）」在统计卡与明细表也会出现，断言限定在弹窗内
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('领导班子（A）')).toBeInTheDocument();
    expect(within(dialog).getByText('职工（C）')).toBeInTheDocument();
    expect(within(dialog).getByText(/2 张/)).toBeInTheDocument();
    expect(within(dialog).getByText(/1 张/)).toBeInTheDocument();
    expect(within(dialog).getByText('AAAA1111')).toBeInTheDocument();
    expect(within(dialog).getByText('CCCC3333')).toBeInTheDocument();

    // 只保留下载：复制全部与「我已保存」都已移除
    expect(within(dialog).queryByText('复制全部')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: '我已保存' })).toBeNull();

    // 下载后自动结束本次发码（弹窗关闭）
    await user.click(within(dialog).getByRole('button', { name: /下载 Excel/ }));
    await waitFor(() => expect(vi.mocked(downloadFile)).toHaveBeenCalledTimes(1));
    const url = vi.mocked(downloadFile).mock.calls[0]![0];
    expect(url).toContain('batchIds=batch-a%2Cbatch-c');
    // 下载完成即收尾：提示「发码完成」（Modal 的关闭动画在 jsdom 里不会结束，不断言 DOM 移除）
    expect(await screen.findByText('发码完成，已下载随机码')).toBeInTheDocument();
  }, 20_000);

  /**
   * 失败路径也要刷新：请求抛错不等于后端没写入（超时、响应丢失、网关 502 时
   * 事务可能已提交）。只刷新成功路径会让页面显示「没生成」而库里多了一批码。
   */
  it('发码请求失败也刷新视图：库里已写入的码必须立刻可见', async () => {
    const user = userEvent.setup();
    let listTotal = 0;
    listMock.mockImplementation(
      async () => ({ items: [], total: listTotal, page: 1, pageSize: 20 }) as never,
    );
    vi.mocked(adminApi.ticketTypes.list).mockResolvedValue([
      {
        id: 'a',
        code: 'A',
        name: '领导班子',
        weightPercent: 100,
        sortOrder: 1,
        enabled: true,
        issuedCount: 0,
        usedCount: 0,
        unusedCount: 0,
      },
    ] as never);
    vi.mocked(adminApi.tickets.generate).mockImplementation(async () => {
      // 模拟「事务已提交但响应丢失」：库里多了一张码，前端却收到错误
      listTotal = 1;
      throw new Error('网关超时');
    });

    renderPage();
    await user.type(await screen.findByLabelText('「领导班子」发放数量'), '1');
    await user.click(screen.getByLabelText('评议部门'));
    await user.click(await screen.findByText('贵阳西车间'));

    await user.click(screen.getByRole('button', { name: /生成随机码/ }));

    expect(await screen.findByText(/网关超时/)).toBeInTheDocument();
    // finally 里的刷新让「库里已存在的那张码」立刻反映到按钮状态上
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /一键作废未使用码/ })).toBeEnabled(),
    );
  }, 20_000);
});
