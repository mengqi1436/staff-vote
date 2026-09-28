/**
 * 随机码页匿名边界测试（设计要求第 1 条「不记名投票」）。
 *
 * 覆盖：
 *   - 明细列表请求固定 status:'unused'，管理员无法按「已使用」筛选；
 *   - 表格没有「状态」「使用时间」列，也没有行内「导出答卷」入口；
 *   - 状态筛选下拉不存在，导出按钮固定为「导出未使用码」；
 *   - 「票种使用统计」以票种级聚合（已发放/已使用/未使用/已作废）披露使用进度。
 *
 * 后端防线（列表/导出忽略 status 条件）由 apps/api 的接口测试覆盖。
 */
import { screen } from '@testing-library/react';
import { App as AntApp, ConfigProvider } from 'antd';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithAuth } from '../../../test-utils.js';

vi.mock('../../../lib/api.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../lib/api.js');
  return {
    ...actual,
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
      },
      batches: { list: vi.fn(async () => []) },
    },
  };
});

const { adminApi } = await import('../../../lib/api.js');
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

  it('没有状态筛选下拉；导出按钮固定为「导出未使用码」', async () => {
    renderPage();

    await screen.findByText('ABCD2345');
    expect(screen.queryByRole('combobox', { name: '按状态筛选' })).toBeNull();
    expect(screen.getByRole('link', { name: /导出未使用码/ })).toHaveAttribute(
      'href',
      expect.stringContaining('/api/admin/tickets/export'),
    );
  }, 15_000);

  it('票种使用统计以聚合口径展示已发放/已使用/未使用/已作废', async () => {
    renderPage();

    expect(await screen.findByText('票种使用统计')).toBeInTheDocument();
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
