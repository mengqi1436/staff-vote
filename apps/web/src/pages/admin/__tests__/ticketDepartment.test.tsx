/**
 * 随机码绑定部门：管理端发码 UI 测试。
 *
 * 覆盖：
 *   - 发码卡未选「评议部门」时提交被拦截（generate 不发起，提示必选）；
 *   - 选择部门后 generate 收到 departmentId；
 *   - 选「不限定（全部部门）」时出现确认弹窗，确认后 generate 不带 departmentId；
 *   - 批次一览表「评议部门」列：绑定显部门名，null 显「全部部门」。
 *
 * 后端强校验（DEPARTMENT_NOT_IN_SESSION / DEPARTMENT_DISABLED）由 apps/api 的接口测试覆盖。
 */
import { screen } from '@testing-library/react';
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
      ticketTypes: {
        list: vi.fn(async () => [
          {
            id: 'a',
            code: 'A',
            name: '领导班子',
            weightPercent: 100,
            sortOrder: 1,
            enabled: true,
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
      batches: { list: vi.fn() },
      departments: { list: vi.fn() },
    },
  };
});

const { adminApi } = await import('../../../lib/api.js');
const { AdminTickets } = await import('../Tickets.js');

const generateMock = vi.mocked(adminApi.tickets.generate);
const listMock = vi.mocked(adminApi.tickets.list);
const batchesMock = vi.mocked(adminApi.batches.list);
const departmentsMock = vi.mocked(adminApi.departments.list);

/** 场内部门：一个启用（可作发码选项）、一个停用（不得出现在选项里）。 */
const DEPARTMENTS = [
  {
    id: 'd1',
    name: '生产部',
    sortOrder: 1,
    enabled: true,
    questionnaireType: 'person',
    headerNote: '',
    title: '',
    footerNote: '',
  },
  {
    id: 'd2',
    name: '后勤部',
    sortOrder: 2,
    enabled: false,
    questionnaireType: 'person',
    headerNote: '',
    title: '',
    footerNote: '',
  },
];

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

/** 把发码表单准备到「只差点生成」的状态：填好数量。 */
async function fillCount(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await screen.findByText('批量发码');
  await user.type(screen.getByLabelText('「领导班子」发放数量'), '5');
}

/** 打开评议部门下拉并选中指定选项；antd option 需用 title 查询（role=option 命中的是可访问性占位层，点击不触发选择）。 */
async function selectDepartment(
  user: ReturnType<typeof userEvent.setup>,
  optionName: string,
): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: '评议部门' }));
  await user.click(await screen.findByTitle(optionName));
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue({ items: [UNUSED_ROW], total: 1, page: 1, pageSize: 20 });
  batchesMock.mockResolvedValue([
    {
      id: 'b1',
      count: 5,
      operator: 'admin',
      createdAt: '2026-09-19T02:00:00.000Z',
      ticketType: { id: 'a', code: 'A', name: '领导班子' },
      departmentId: 'd1',
      departmentName: '生产部',
    },
    {
      id: 'b2',
      count: 3,
      operator: 'admin',
      createdAt: '2026-09-19T01:00:00.000Z',
      ticketType: { id: 'a', code: 'A', name: '领导班子' },
      departmentId: null,
      departmentName: null,
    },
  ]);
  departmentsMock.mockResolvedValue(DEPARTMENTS);
  generateMock.mockResolvedValue({ batchId: 'b9', count: 5, codes: ['NEWC2345'] });
});

describe('发码卡的评议部门必选闸', () => {
  it('未选部门时点生成被拦截：提示必选且不发请求', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await fillCount(user);

    await user.click(screen.getByRole('button', { name: '生成随机码' }));

    expect(await screen.findByText('请先选择本批随机码可评议的部门')).toBeInTheDocument();
    expect(generateMock).not.toHaveBeenCalled();
  }, 15_000);

  it('部门选项只含启用部门与「不限定」，停用部门不出现', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await fillCount(user);

    await user.click(screen.getByRole('combobox', { name: '评议部门' }));

    expect(screen.getByRole('option', { name: '不限定（全部部门）' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '生产部' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '后勤部' })).toBeNull();
  }, 15_000);

  it('选择部门后生成：generate 收到 departmentId', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await fillCount(user);

    await selectDepartment(user, '生产部');
    // 等选中状态落定（findAllByText：下拉收起动画期间 option 与回显可能并存）
    await screen.findAllByText('生产部');

    await user.click(screen.getByRole('button', { name: '生成随机码' }));

    await vi.waitFor(() => {
      expect(generateMock).toHaveBeenCalledWith('a', 5, {
        sessionId: 's1',
        departmentId: 'd1',
      });
    });
  }, 15_000);

  it('选「不限定」时弹确认框，确认后 generate 不带 departmentId', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await fillCount(user);

    await selectDepartment(user, '不限定（全部部门）');
    // 等选中状态落定
    await screen.findAllByText('不限定（全部部门）');

    await user.click(screen.getByRole('button', { name: '生成随机码' }));

    // 确认弹窗先出现、generate 仍未发起
    expect(await screen.findByText('不限定部门发出的随机码可评议全部部门，确认继续？')).toBeInTheDocument();
    expect(generateMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '继续生成' }));

    await vi.waitFor(() => {
      expect(generateMock).toHaveBeenCalledWith('a', 5, { sessionId: 's1' });
    });
  }, 15_000);

  it('「不限定」弹窗点取消则不发起生成', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    await fillCount(user);

    await selectDepartment(user, '不限定（全部部门）');
    await screen.findAllByText('不限定（全部部门）');

    await user.click(screen.getByRole('button', { name: '生成随机码' }));
    await screen.findByText('不限定部门发出的随机码可评议全部部门，确认继续？');

    // antd 按钮两汉字间默认插空格（「取 消」），用正则兼容
    await user.click(screen.getByRole('button', { name: /取\s*消/ }));
    // Modal 关闭动画（CSS transition）在 jsdom 中不结束、DOM 不移除，
    // 故不断言文案消失，只断言取消后始终未发请求
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(generateMock).not.toHaveBeenCalled();
  }, 15_000);
});

describe('批次一览的评议部门列', () => {
  it('绑定部门显部门名，未绑定显「全部部门」', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();
    // 等 usePolling 首轮加载完成（页面 skeleton 消失、Tabs 渲染）再切页签
    await screen.findByText('批量发码');

    await user.click(screen.getByRole('tab', { name: '发放批次' }));

    expect(await screen.findByText('生产部')).toBeInTheDocument();
    expect(screen.getByText('全部部门')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '评议部门' })).toBeInTheDocument();
  }, 15_000);
});
