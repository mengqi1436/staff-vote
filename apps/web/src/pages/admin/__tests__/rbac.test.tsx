/**
 * 账号与权限管理页测试。
 *
 * 只回答两个问题（真实权限判定在后端 requirePermission，前端测试不重复它）：
 *   1. 有 / 没有 `admins.manage` 时，页面与危险按钮是否按预期显隐；
 *   2. 改完角色权限后，是否重新拉取身份（`useAuth().reload()`），
 *      让当前账号的按钮显隐立即跟上。
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { App as AntApp, ConfigProvider } from 'antd';
import { MemoryRouter } from 'react-router';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AuthContext } from '../../../lib/auth.js';
import { ALL_PERMISSIONS, adminWith, renderWithAuth } from '../../../test-utils.js';

vi.mock('../../../lib/api.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../lib/api.js');

  const permissions = [
    { code: 'departments.write', name: '管理部门（新增、修改、停用）', groupName: '评议准备', sortOrder: 10 },
    { code: 'employees.write', name: '管理职工名单与导入', groupName: '评议准备', sortOrder: 11 },
    { code: 'settings.write', name: '修改开放时间与系统设置', groupName: '评议执行', sortOrder: 30 },
    { code: 'admins.manage', name: '管理管理员账号与角色权限', groupName: '系统管理', sortOrder: 40 },
  ];

  const roles = [
    {
      id: 'r-super',
      code: 'super_admin',
      name: '超级管理员',
      description: '拥有全部权限',
      builtin: true,
      permissions: permissions.map((item) => item.code),
      adminCount: 1,
    },
    {
      id: 'r-view',
      code: 'viewer',
      name: '只读查看',
      description: '只能查看数据',
      builtin: false,
      permissions: [],
      adminCount: 1,
    },
  ];

  const admins = [
    {
      id: 'u1',
      username: 'admin',
      roleId: 'r-super',
      roleName: '超级管理员',
      enabled: true,
      createdAt: '2026-09-19T02:00:00.000Z',
    },
    {
      id: 'u2',
      username: 'viewer',
      roleId: 'r-view',
      roleName: '只读查看',
      enabled: false,
      createdAt: '2026-09-19T03:00:00.000Z',
    },
  ];

  return {
    ...actual,
    adminApi: {
      ...(actual.adminApi as Record<string, unknown>),
      permissions: { list: vi.fn(async () => permissions) },
      roles: {
        list: vi.fn(async () => roles),
        create: vi.fn(async () => roles[1]),
        update: vi.fn(async () => roles[0]),
        remove: vi.fn(async () => undefined),
      },
      admins: {
        list: vi.fn(async () => admins),
        create: vi.fn(async () => admins[1]),
        update: vi.fn(async () => admins[1]),
        remove: vi.fn(async () => undefined),
      },
    },
  };
});

const { AdminAdmins } = await import('../Admins.js');
const { adminApi } = await import('../../../lib/api.js');

function renderPage(node: ReactElement, permissions: string[] = ALL_PERMISSIONS) {
  return renderWithAuth(
    <ConfigProvider>
      <AntApp>
        <MemoryRouter initialEntries={['/admin/admins']}>{node}</MemoryRouter>
      </AntApp>
    </ConfigProvider>,
    permissions,
  );
}

/** 表格里某一行的 DOM 容器。 */
function rowOf(username: string): HTMLElement {
  const cell = screen.getByText(username);
  const row = cell.closest('tr');
  if (!row) throw new Error(`找不到「${username}」所在的行`);
  return row as HTMLElement;
}

describe('账号与权限管理页', { timeout: 20_000 }, () => {
  it('有 admins.manage：渲染账号列表、新增入口与角色页签', async () => {
    renderPage(<AdminAdmins />);

    expect(await screen.findByRole('tab', { name: '管理员账号' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '角色与权限' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /新增管理员/ })).toBeInTheDocument();

    // 账号表：用户名、角色与状态文字
    expect(await screen.findByText('admin')).toBeInTheDocument();
    expect(screen.getByText('viewer')).toBeInTheDocument();
    expect(screen.getByText('超级管理员')).toBeInTheDocument();
    expect(screen.getByText('启用')).toBeInTheDocument();
    expect(screen.getByText('停用')).toBeInTheDocument();
    for (const title of ['用户名', '角色', '状态', '创建时间', '操作']) {
      expect(screen.getByRole('columnheader', { name: title })).toBeInTheDocument();
    }
  });

  it('没有 admins.manage：只渲染无权限提示，不渲染任何危险入口', async () => {
    renderPage(<AdminAdmins />, []);

    expect(
      await screen.findByText(/没有「管理管理员账号与角色权限」权限/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /新增管理员/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /新增角色/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '管理员账号' })).not.toBeInTheDocument();
    expect(screen.queryByText('viewer')).not.toBeInTheDocument();

    // 无权限时一个接口都不该请求：页面根本没进入数据加载分支
    expect(vi.mocked(adminApi.admins.list)).not.toHaveBeenCalled();
    expect(vi.mocked(adminApi.roles.list)).not.toHaveBeenCalled();
    expect(vi.mocked(adminApi.permissions.list)).not.toHaveBeenCalled();
  });

  it('自己那一行的停用与删除被禁用并说明原因，其他行可用', async () => {
    renderPage(<AdminAdmins />);
    expect(await screen.findByText('admin')).toBeInTheDocument();

    // 注入的身份是 id = u1 的 admin，因此这一行就是「自己」
    const selfRow = rowOf('admin');
    expect(within(selfRow).getByRole('switch')).toBeDisabled();
    expect(within(selfRow).getByRole('button', { name: /删除/ })).toBeDisabled();
    expect(within(selfRow).getByText('不能停用或删除当前登录的账号')).toBeInTheDocument();

    const otherRow = rowOf('viewer');
    expect(within(otherRow).getByRole('switch')).not.toBeDisabled();
    expect(within(otherRow).getByRole('button', { name: /删除/ })).not.toBeDisabled();
  });

  it('角色页签：按分组渲染权限勾选，内置角色标「内置」且不可删除', async () => {
    renderPage(<AdminAdmins />);

    fireEvent.click(await screen.findByRole('tab', { name: '角色与权限' }));

    expect(await screen.findByText('超级管理员')).toBeInTheDocument();
    expect(screen.getByText('只读查看')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /新增角色/ })).toBeInTheDocument();

    // 内置角色标记与不可删除
    expect(screen.getByText('内置')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '超级管理员 删除角色' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '只读查看 删除角色' })).not.toBeDisabled();

    // 权限勾选按 groupName 分组
    fireEvent.click(screen.getByRole('button', { name: '超级管理员 编辑权限' }));
    expect(await screen.findByText('评议准备')).toBeInTheDocument();
    expect(screen.getByText('评议执行')).toBeInTheDocument();
    expect(screen.getByText('系统管理')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '管理管理员账号与角色权限' })).toBeChecked();
  });

  it(
    '保存角色权限后重新拉取身份，让按钮显隐立即跟上',
    async () => {
      const reload = vi.fn(async () => {});
      render(
        <ConfigProvider>
          <AntApp>
            <MemoryRouter initialEntries={['/admin/admins']}>
              <AuthContext.Provider
                value={{
                  admin: adminWith(),
                  loading: false,
                  error: null,
                  can: () => true,
                  reload,
                }}
              >
                <AdminAdmins />
              </AuthContext.Provider>
            </MemoryRouter>
          </AntApp>
        </ConfigProvider>,
      );

      // 这条用例只关心「保存之后回读了身份」，用 fireEvent 走最短路径：
      // userEvent 的用户事件模拟在 antd 弹窗上是真实计时，凑满五个用例会显著拖慢整套测试。
      fireEvent.click(await screen.findByRole('tab', { name: '角色与权限' }));
      fireEvent.click(await screen.findByRole('button', { name: '只读查看 编辑权限' }));

      // 勾上一个权限再保存：走后端且回读身份
      fireEvent.click(await screen.findByRole('checkbox', { name: '管理职工名单与导入' }));
      fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }));

      await vi.waitFor(
        () => {
          expect(vi.mocked(adminApi.roles.update)).toHaveBeenCalled();
        },
        { timeout: 5000 },
      );
      await vi.waitFor(
        () => {
          expect(reload).toHaveBeenCalled();
        },
        { timeout: 5000 },
      );
    },
    20000,
  );
});