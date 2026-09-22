import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminApi } from '../../../lib/api.js';
import { renderWithAuth } from '../../../test-utils.js';

/**
 * 随机码页「选配领码人」的页面级测试。
 *
 * 验证两件事：不勾选职工时生成请求不带 assignments；勾选后生成请求 body
 * 按契约带 assignments（当前场次 id + 该票别勾选的职工）。
 * 场次上下文由 renderWithAuth 注入（当前场次 s1）。
 */
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

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
            weightPercent: 60,
            sortOrder: 1,
            enabled: true,
          },
        ]),
      },
      tickets: {
        list: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 })),
        generate: vi.fn(async () => ({ batchId: 'b1', count: 2, codes: ['AAAA2222', 'BBBB3333'] })),
        exportUrl: () => '/api/admin/tickets/export',
      },
      batches: { list: vi.fn(async () => []) },
      employees: {
        list: vi.fn(async () => [
          { id: 'e1', name: '张三', employeeNo: '001', sortOrder: 1, enabled: true },
          { id: 'e2', name: '李四', employeeNo: null, sortOrder: 2, enabled: true },
        ]),
      },
    },
  };
});

const { AdminTickets } = await import('../Tickets.js');

afterEach(() => {
  vi.clearAllMocks();
});

/** 渲染发码页（注入当前场次 s1）。 */
function renderTickets() {
  return renderWithAuth(
    <ConfigProvider>
      <AntApp>
        <MemoryRouter initialEntries={['/admin/tickets']}>
          <AdminTickets />
        </MemoryRouter>
      </AntApp>
    </ConfigProvider>,
    undefined,
    's1',
  );
}

/**
 * 打开指定名称的 Select 下拉并选中某个选项。
 * 与 questionnaire.test.tsx 同一惯例：user.click 打开下拉，点 option 的 title 文本
 * （antd option 的可访问名会带权重后缀，title 就是完整 label 文本）。
 */
async function pickOption(user: ReturnType<typeof userEvent.setup>, comboboxName: string, optionTitle: string) {
  await user.click(await screen.findByRole('combobox', { name: comboboxName }));
  await user.click(await screen.findByTitle(optionTitle));
}

describe('发码选配领码人', () => {
  it('职工列表请求带上当前场次 id', async () => {
    renderTickets();
    await screen.findByText('批量发码');
    await waitFor(() =>
      expect(vi.mocked(adminApi.employees.list)).toHaveBeenCalledWith(undefined, 's1'),
    );
  });

  it('不勾选职工时生成请求不带 assignments', async () => {
    const user = userEvent.setup({ delay: null });
    renderTickets();

    await pickOption(user, '选择票种', '领导班子（A，权重 60%）');
    await user.click(await screen.findByRole('button', { name: /生成随机码/ }));

    await waitFor(() =>
      expect(vi.mocked(adminApi.tickets.generate)).toHaveBeenCalledWith(
        'a',
        100,
        expect.objectContaining({ sessionId: 's1', assignments: undefined }),
      ),
    );
  });

  it('勾选职工后生成请求按票别带 assignments', async () => {
    const user = userEvent.setup({ delay: null });
    renderTickets();

    await pickOption(user, '选择票种', '领导班子（A，权重 60%）');
    await pickOption(user, '选配领码人', '张三（001）');
    await pickOption(user, '选配领码人', '李四');
    await user.click(await screen.findByRole('button', { name: /生成随机码/ }));

    await waitFor(() =>
      expect(vi.mocked(adminApi.tickets.generate)).toHaveBeenCalledWith('a', 100, {
        sessionId: 's1',
        assignments: [{ ticketTypeId: 'a', employeeIds: ['e1', 'e2'] }],
      }),
    );
  });
});
