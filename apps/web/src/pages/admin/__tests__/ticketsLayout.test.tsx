/**
 * 随机码页的操作流布局契约。
 *
 * 依据 UI/UX 审查（ui-ux-pro-max 规则 + impeccable operate 模式）：
 *   1. 破坏性批量操作必须和它作用的对象（未使用码列表 + 人员类别筛选）在同一区域，
 *      不能放在「发码」卡片里——那里的按钮才刚生成码，旁边就是作废，容易误触，
 *      而且它的作用范围由另一张卡片的下拉决定，用户在视觉上无法预判。
 *   2. 必填的「评议部门」排在数量表格之前：人的填写顺序是 选部门 → 填数量 → 生成，
 *      视觉顺序必须一致。
 *   3. 卡片顺序按实际动作走：发码 → 核对/导出 → 看统计。统计是监控信息，
 *      夹在「发码」和「去哪儿核对」之间会把操作流打断。
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithAuth } from '../../../test-utils.js';

vi.mock('../../../lib/api.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../lib/api.js');
  return {
    ...actual,
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
    },
  };
});

const { adminApi } = await import('../../../lib/api.js');
const { AdminTickets } = await import('../Tickets.js');

const listMock = vi.mocked(adminApi.tickets.list);

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

/** 按标题文本找到它所在的 antd Card。 */
function cardOf(title: string): HTMLElement {
  const card = screen.getByText(title).closest('.ant-card');
  if (card === null) throw new Error(`找不到卡片：${title}`);
  return card as HTMLElement;
}

/** a 是否在 b 之前（文档顺序）。 */
function precedes(a: Node, b: Node): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue({ items: [UNUSED_ROW], total: 1, page: 1, pageSize: 20 });
});

describe('随机码页操作流布局', () => {
  it('「一键作废未使用码」在未使用码卡内，不在发码卡内', async () => {
    renderPage();

    await screen.findByText('ABCD2345');

    const unusedCard = cardOf('未使用随机码');
    expect(within(unusedCard).getByRole('button', { name: /一键作废未使用码/ })).toBeInTheDocument();
    expect(
      within(cardOf('批量发码')).queryByRole('button', { name: /一键作废未使用码/ }),
    ).toBeNull();
  });

  it('评议部门排在数量表格之前（选部门 → 填数量 → 生成）', async () => {
    renderPage();

    await screen.findByText('ABCD2345');

    const department = screen.getByLabelText('评议部门');
    const quantityHeader = screen.getByText(/本批发放数量/);
    expect(precedes(department, quantityHeader)).toBe(true);
  });

  it('卡片顺序是 发码 → 未使用码 → 使用统计', async () => {
    renderPage();

    await screen.findByText('ABCD2345');

    expect(precedes(cardOf('批量发码'), cardOf('未使用随机码'))).toBe(true);
    expect(precedes(cardOf('未使用随机码'), cardOf('人员类别使用统计'))).toBe(true);
  });

  it('填写数量后就地显示本批合计，生成前可核对', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('ABCD2345');
    // 未填写时给出下一步，而不是空白
    expect(screen.getByText('填写数量后生成')).toBeInTheDocument();

    await user.type(screen.getByLabelText('「领导班子」发放数量'), '12');

    expect(await screen.findByText('本批共 12 张')).toBeInTheDocument();
  });
});
