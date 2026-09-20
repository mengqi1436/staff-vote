/**
 * 「权重分配」表单的行为测试。
 *
 * 核心正确性是**提交顺序**：后端单行 PATCH 的校验是「启用票种合计升权后必须正好 100」，
 * 所以一次性改权重时只能先提交降权（合计变小，恒合法）、再提交升权（合计逐步回到 100）。
 * 顺序写反就会出现「第二步被 409 拒绝」——正是本表单要解决的痛点，必须用 mock.calls 锁死。
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_PERMISSIONS, renderWithAuth } from '../../../test-utils.js';

/** 启用票种合计 100%（50+30+20），另有停用票种 10% 不计入也不可调。 */
function ticketTypes() {
  return [
    { id: 'a', code: 'A', name: '领导班子', weightPercent: 50, sortOrder: 1, enabled: true },
    { id: 'b', code: 'B', name: '中层干部', weightPercent: 30, sortOrder: 2, enabled: true },
    { id: 'c', code: 'C', name: '职工代表', weightPercent: 20, sortOrder: 3, enabled: true },
    { id: 'd', code: 'D', name: '退休人员', weightPercent: 10, sortOrder: 4, enabled: false },
  ];
}

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../../../lib/api.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../lib/api.js');
  return {
    ...actual,
    adminApi: { ticketTypes: { list: mocks.list, update: mocks.update } },
  };
});

const { ApiError } = await import('../../../lib/api.js');
const { AdminTicketTypes } = await import('../TicketTypes.js');

function renderWeights(permissions: string[] = ALL_PERMISSIONS) {
  return renderWithAuth(
    <ConfigProvider>
      <AntApp>
        <MemoryRouter>
          <AdminTicketTypes />
        </MemoryRouter>
      </AntApp>
    </ConfigProvider>,
    permissions,
  );
}

/**
 * 修改某一行的权重：antd InputNumber 用 aria-label「<票种名> 计分占比」定位。
 * 刻意不含「权重」二字，避免与编辑弹窗里的「权重（%）」标签在 getByLabelText 下重名。
 */
async function setWeight(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  value: string,
): Promise<void> {
  const input = screen.getByLabelText(`${name} 计分占比`);
  await user.clear(input);
  await user.type(input, value);
}

/** 全量并发运行（多个测试文件同时渲染 antd 重页面）时，单用例可能超过 vitest 默认的 5 秒。 */
const TIMEOUT_MS = 20_000;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockImplementation(async () => ticketTypes());
  mocks.update.mockImplementation(async (id: string, body: Record<string, unknown>) => ({
    ...ticketTypes().find((type) => type.id === id),
    ...body,
  }));
});

describe('权重分配表单', () => {
  it('合计不等于 100% 时保存按钮禁用并写清差额', async () => {
    const user = userEvent.setup({ delay: null });
    renderWeights();

    expect(await screen.findByText('合计 100%，符合要求')).toBeInTheDocument();

    // 50 → 60：合计 110%，超出 10%
    await setWeight(user, '领导班子', '60');
    expect(await screen.findByText('合计 110%，超出 10%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /保存权重/ })).toBeDisabled();

    // 20 → 10：合计回到 100%，且有改动 → 可以保存
    await setWeight(user, '职工代表', '10');
    expect(await screen.findByText('合计 100%，符合要求')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /保存权重/ })).toBeEnabled();
  }, TIMEOUT_MS);

  it('保存时先提交降权、再提交升权', async () => {
    const user = userEvent.setup({ delay: null });
    renderWeights();
    await screen.findByText('合计 100%，符合要求');

    await setWeight(user, '领导班子', '60'); // a：50 → 60，升权
    await setWeight(user, '中层干部', '20'); // b：30 → 20，降权
    expect(await screen.findByText('合计 100%，符合要求')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /保存权重/ }));

    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    // 降权的 b 必须先于升权的 a：b 之后合计 90，a 之后合计 100，两步都合法
    expect(mocks.update.mock.calls.map((call) => call[0])).toEqual(['b', 'a']);
    expect(mocks.update.mock.calls.map((call) => call[1])).toEqual([
      { weightPercent: 20 },
      { weightPercent: 60 },
    ]);
  }, TIMEOUT_MS);

  it('只提交发生变化的票种', async () => {
    const user = userEvent.setup({ delay: null });
    renderWeights();
    await screen.findByText('合计 100%，符合要求');

    await setWeight(user, '领导班子', '40'); // a：50 → 40，降权
    await setWeight(user, '中层干部', '40'); // b：30 → 40，升权，合计仍 100
    expect(await screen.findByText('合计 100%，符合要求')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /保存权重/ }));

    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    const patched = mocks.update.mock.calls.map((call) => call[0]);
    expect(patched).toEqual(['a', 'b']);
    // 未改动的「职工代表」(c) 不产生请求
    expect(patched).not.toContain('c');
  }, TIMEOUT_MS);

  it('无 ticketTypes.write 权限时不渲染保存按钮', async () => {
    renderWeights(['departments.write']);

    expect(await screen.findByText('权重分配')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /保存权重/ })).toBeNull();
    expect(screen.getByText(/调整权重需「管理票种与权重」权限/)).toBeInTheDocument();
  }, TIMEOUT_MS);

  it('某条失败时停止提交并提示已成功项数与后端消息', async () => {
    const user = userEvent.setup({ delay: null });
    // 降权的 b 成功，随后升权的 a 被后端 409 拒绝
    mocks.update.mockImplementation(async (id: string, body: Record<string, unknown>) => {
      if (id === 'a') {
        throw new ApiError(
          409,
          'WEIGHT_SUM_INVALID',
          '启用票种权重合计为 110%，不得超过 100%（差额 -10）',
        );
      }
      return { ...ticketTypes().find((type) => type.id === id), ...body };
    });

    renderWeights();
    await screen.findByText('合计 100%，符合要求');

    await setWeight(user, '领导班子', '60'); // a：升权，会失败
    await setWeight(user, '中层干部', '20'); // b：降权，会成功
    await user.click(screen.getByRole('button', { name: /保存权重/ }));

    const notices = await screen.findAllByText(/已成功 1 项，第 2 项失败：/);
    expect(notices[0]?.textContent).toContain(
      '启用票种权重合计为 110%，不得超过 100%（差额 -10）',
    );
    // 失败即停：不再有第 3 次提交
    expect(mocks.update).toHaveBeenCalledTimes(2);
    // 失败后重新拉列表，界面权重回到库中的实际值
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  }, TIMEOUT_MS);
});