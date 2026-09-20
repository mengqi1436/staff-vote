/**
 * 随机码页「一键作废未使用码」与发码/作废权限门控测试。
 *
 * 覆盖：
 *   - 有 `tickets.revoke` 时一键作废按钮在、无权限时不在（行内作废禁用并带提示）；
 *   - 有 `tickets.generate` 时发码按钮在、无权限时不在；
 *   - 点击一键作废**先查准确数量**再弹确认框，数量取自 list({status:'unused', pageSize:1}).total；
 *   - N = 0 时按钮 disabled 并说明「当前筛选下没有未使用码」；
 *   - 确认后调新接口、提示「已作废 N 张」并刷新列表。
 *
 * 权限只决定按钮显隐，真正的防线在后端 requirePermission —— 那部分由
 * apps/api/test/revoke-bulk.test.ts 覆盖，这里不重复。
 *
 * 为什么每个用例都显式放宽超时：antd 的 Table/Modal 在 jsdom 里渲染一次要 1-3 秒，
 * 整套测试并行跑（多个文件抢 CPU）时会超过 vitest 默认的 5 秒，出现与断言无关的
 * 「Test timed out」——那是环境耗时，不是行为错误。
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithAuth } from '../../../test-utils.js';

vi.mock('../../../lib/api.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../lib/api.js');

  return {
    ...actual,
    adminApi: {
      ticketTypes: { list: vi.fn() },
      tickets: {
        list: vi.fn(),
        revokeBulk: vi.fn(),
        generate: vi.fn(),
        revoke: vi.fn(),
        exportUrl: () => '/api/admin/tickets/export',
      },
      batches: { list: vi.fn() },
    },
  };
});

const { adminApi } = await import('../../../lib/api.js');
const { AdminTickets } = await import('../Tickets.js');

const listMock = vi.mocked(adminApi.tickets.list);
const revokeBulkMock = vi.mocked(adminApi.tickets.revokeBulk);

const UNUSED_CODE = 'ABCD2345';

/** 未使用码总数：既决定一键作废按钮的 disabled，也决定确认框里的 N。 */
let unusedTotal = 3;

function renderPage(permissions?: string[]) {
  return renderWithAuth(
    <ConfigProvider>
      <AntApp>
        <MemoryRouter initialEntries={['/admin/tickets']}>
          <AdminTickets />
        </MemoryRouter>
      </AntApp>
    </ConfigProvider>,
    permissions,
  );
}

beforeEach(() => {
  unusedTotal = 3;
  vi.clearAllMocks();

  vi.mocked(adminApi.ticketTypes.list).mockResolvedValue([
    { id: 'a', code: 'A', name: '领导班子', weightPercent: 100, sortOrder: 1, enabled: true },
  ]);
  vi.mocked(adminApi.batches.list).mockResolvedValue([]);
  vi.mocked(adminApi.tickets.generate).mockResolvedValue({
    batchId: 'batch1',
    count: 1,
    codes: [UNUSED_CODE],
  });
  revokeBulkMock.mockResolvedValue({ revoked: 2 });

  listMock.mockImplementation(async (params = {}) => {
    if (params.status === 'unused') {
      return { items: [], total: unusedTotal, page: 1, pageSize: params.pageSize ?? 20 };
    }
    return {
      items: [
        {
          id: 'k1',
          code: UNUSED_CODE,
          status: 'unused',
          usedAt: null,
          createdAt: '2026-09-19T02:00:00.000Z',
          ticketType: { id: 'a', code: 'A', name: '领导班子' },
          batchId: 'batch1',
        },
      ],
      total: 1,
      page: 1,
      pageSize: params.pageSize ?? 20,
    };
  });
});

describe('一键作废未使用码', () => {
  it('有 tickets.revoke 权限时按钮在，未使用数量加载完成后可用', async () => {
    renderPage();

    const button = await screen.findByRole('button', { name: /一键作废未使用码/ });
    await waitFor(() => expect(button).toBeEnabled());
  }, 15_000);

  it('无 tickets.revoke 权限时不渲染一键作废，行内作废禁用并给出权限提示', async () => {
    renderPage(['tickets.generate']);

    expect(await screen.findByText(UNUSED_CODE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /一键作废未使用码/ })).toBeNull();

    // 行内作废：整列不消失，改为禁用并说明原因
    const inline = screen.getByRole('button', { name: /^作\s*废$/ });
    expect(inline).toBeDisabled();

    await userEvent.hover(inline);
    expect(await screen.findByText(/无「作废随机码（单张与一键）」权限/)).toBeInTheDocument();
  }, 15_000);

  it('无 tickets.generate 权限时不渲染发码与按权重一键发码按钮', async () => {
    renderPage(['tickets.revoke']);

    expect(await screen.findByText('批量发码')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /生成随机码/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /按权重一键发码/ })).toBeNull();
    // 有作废权限，一键作废照常渲染
    expect(await screen.findByRole('button', { name: /一键作废未使用码/ })).toBeInTheDocument();
  }, 15_000);

  it('点击后先取准确数量，确认框显示该数量且此时尚未作废', async () => {
    unusedTotal = 7;
    renderPage();

    const button = await screen.findByRole('button', { name: /一键作废未使用码/ });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);

    expect(
      await screen.findByText(/将作废当前筛选下\s*7\s*张未使用码/),
    ).toBeInTheDocument();
    expect(await screen.findByText(/已使用的码不受影响/)).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith({
      status: 'unused',
      ticketTypeId: undefined,
      pageSize: 1,
    });
    // 只是确认框，点「确认作废」之前不能写库
    expect(revokeBulkMock).not.toHaveBeenCalled();
  }, 15_000);

  it('N = 0 时按钮 disabled，并说明当前筛选下没有未使用码', async () => {
    unusedTotal = 0;
    renderPage();

    const button = await screen.findByRole('button', { name: /一键作废未使用码/ });
    expect(await screen.findByText('当前筛选下没有未使用码')).toBeInTheDocument();
    expect(button).toBeDisabled();
  }, 15_000);

  it('确认后调用接口、提示已作废数量并刷新列表', async () => {
    unusedTotal = 2;
    revokeBulkMock.mockResolvedValue({ revoked: 2 });
    renderPage();

    const button = await screen.findByRole('button', { name: /一键作废未使用码/ });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);

    const confirm = await screen.findByRole('button', { name: /确认作废/ });
    const listCallsBefore = listMock.mock.calls.length;
    await userEvent.click(confirm);

    expect(await screen.findByText('已作废 2 张')).toBeInTheDocument();
    expect(revokeBulkMock).toHaveBeenCalledWith(undefined);
    // 作废后必须重新拉列表与未使用数量，界面不能停留在旧数据
    await waitFor(() => expect(listMock.mock.calls.length).toBeGreaterThan(listCallsBefore));
  }, 15_000);
});