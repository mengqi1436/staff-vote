/**
 * 全局部门管理页（/admin/departments）的行为测试（契约 I 的页面部分）。
 *
 * 覆盖：
 *   - 列表渲染：名称/排序/状态文字/创建时间列与「字典口径」说明；
 *   - 新增：主按钮在（departments.write），弹窗提交 create（名称 + 默认排序）；
 *   - 编辑：行内编辑回填表单，保存走 update；
 *   - 启停：开关即改 update({ enabled })，状态有文字不只靠颜色；
 *   - 删除被场次引用 409 ORG_DEPARTMENT_IN_USE：后端原文透出到提示；
 *   - 只读账号：主按钮不渲染，行内编辑/删除/开关保留但禁用并说明缺哪个权限。
 *
 * 权限的真防线在后端 requirePermission，这里只测前端门控与提交契约。
 */
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api.js';
import { ALL_PERMISSIONS, renderWithAuth } from '../../../test-utils.js';

/** 与 questionnaire.test 同款放宽：并行渲染 antd 重页面时默认超时太紧。 */
configure({ asyncUtilTimeout: 15000 });

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../../../lib/api.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../lib/api.js');
  return {
    ...actual,
    adminApi: {
      orgDepartments: {
        list: mocks.list,
        create: mocks.create,
        update: mocks.update,
        remove: mocks.remove,
      },
    },
  };
});

const { AdminOrgDepartments } = await import('../OrgDepartments.js');

/** 两条字典数据：带可变状态，update/remove 真正改 store，refresh 回来是新配置。 */
let store: Array<Record<string, unknown>>;

function renderPage(permissions: string[] = ALL_PERMISSIONS) {
  return renderWithAuth(
    <ConfigProvider>
      <AntApp>
        <MemoryRouter>
          <AdminOrgDepartments />
        </MemoryRouter>
      </AntApp>
    </ConfigProvider>,
    permissions,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  store = [
    { id: 'od1', name: '办公室', sortOrder: 1, enabled: true, createdAt: '2026-09-01T00:00:00.000Z' },
    { id: 'od2', name: '财务科', sortOrder: 2, enabled: false, createdAt: '2026-09-01T00:00:00.000Z' },
  ];
  mocks.list.mockImplementation(async () => ({ departments: store }));
  mocks.create.mockImplementation(async (body: Record<string, unknown>) => {
    const row = { id: 'od9', createdAt: '2026-09-27T00:00:00.000Z', enabled: true, ...body };
    store.push(row);
    return { department: row };
  });
  mocks.update.mockImplementation(async (id: string, body: Record<string, unknown>) => {
    const index = store.findIndex((row) => row.id === id);
    store[index] = { ...store[index], ...body };
    return { department: store[index] };
  });
  mocks.remove.mockImplementation(async (id: string) => {
    store = store.filter((row) => row.id !== id);
  });
});

describe('全局部门管理页', () => {
  it('渲染部门列表与字典口径说明（含停用状态文字）', async () => {
    renderPage();

    expect(await screen.findByText('办公室')).toBeInTheDocument();
    expect(screen.getByText('财务科')).toBeInTheDocument();
    // 删除被引用会被拒绝的口径写在页面上（产品原则 4）
    expect(screen.getByText(/删除被场次引用的部门会被拒绝/)).toBeInTheDocument();
    // 状态有文字表意，不靠开关颜色
    expect(screen.getByText('停用')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '创建时间' })).toBeInTheDocument();
  });

  it('新增部门：弹窗默认排序 = 现有条数 + 1，提交 create', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /新增部门/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('部门名称'), '人事科');
    await user.click(within(dialog).getByRole('button', { name: /保\s*存/ }));

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create).toHaveBeenCalledWith({ name: '人事科', sortOrder: 3 });
  }, 20_000);

  it('编辑部门：表单回填当前值，保存走 update', async () => {
    const user = userEvent.setup();
    renderPage();

    const row = await screen.findByText('办公室').then((el) => el.closest('tr')!);
    await user.click(within(row).getByRole('button', { name: '编辑' }));

    const dialog = await screen.findByRole('dialog');
    const nameInput = within(dialog).getByLabelText('部门名称') as HTMLInputElement;
    expect(nameInput.value).toBe('办公室');

    await user.clear(nameInput);
    await user.type(nameInput, '综合办公室');
    await user.click(within(dialog).getByRole('button', { name: /保\s*存/ }));

    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    expect(mocks.update).toHaveBeenCalledWith('od1', { name: '综合办公室', sortOrder: 1 });
  }, 20_000);

  it('启停开关即保存 update({ enabled })', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('switch', { name: '停用「办公室」' }));

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('od1', { enabled: false }));
  }, 20_000);

  it('删除被场次引用（409 ORG_DEPARTMENT_IN_USE）时后端原文透出到提示', async () => {
    const user = userEvent.setup();
    mocks.remove.mockRejectedValueOnce(
      new ApiError(409, 'ORG_DEPARTMENT_IN_USE', '该部门已被场次引用，无法删除，请改用停用'),
    );
    renderPage();

    const row = await screen.findByText('办公室').then((el) => el.closest('tr')!);
    await user.click(within(row).getByRole('button', { name: '删除' }));
    // Popconfirm 打开后气泡里也有「删除」确认按钮（挂载在 body 末尾），取最后一个
    const confirmButtons = await screen.findAllByRole('button', { name: /^删\s*除$/ });
    await user.click(confirmButtons[confirmButtons.length - 1]!);

    expect(await screen.findByText(/已被场次引用，无法删除/)).toBeInTheDocument();
    // 删除失败不改数据
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('只读账号：主按钮不渲染，行内编辑/删除/开关禁用并说明缺哪个权限', async () => {
    renderPage([]);

    expect(await screen.findByText('办公室')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /新增部门/ })).toBeNull();

    const row = screen.getByText('办公室').closest('tr')!;
    const edit = within(row).getByRole('button', { name: '编辑' });
    expect(edit).toBeDisabled();
    const remove = within(row).getByRole('button', { name: '删除' });
    expect(remove).toBeDisabled();
    expect(within(row).getByRole('switch', { name: '停用「办公室」' })).toBeDisabled();

    await userEvent.hover(edit);
    expect(await screen.findByText('无「部门管理」权限')).toBeInTheDocument();
  }, 20_000);
});
