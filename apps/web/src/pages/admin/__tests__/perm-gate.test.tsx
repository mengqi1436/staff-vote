/**
 * 后台四页的权限门控测试。
 *
 * 只回答一个问题：`can(code)` 为假时，写操作入口在不在、能不能点。
 * 断言用「全部权限」与「[]（只读）」两组身份对照 —— 只测一组会把
 * 「按钮永远不渲染」当成通过。
 *
 * 注意：本文件只覆盖前端显隐。真实的 403 由后端 permission-gate.test.ts 覆盖，
 * 按钮藏起来不等于接口安全。
 */
import { configure, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { MemoryRouter } from 'react-router';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
// 后台页面用 useAuth() 判权限，独立渲染必须注入身份上下文
import { ALL_PERMISSIONS, renderWithAuth } from '../../../test-utils.js';

/**
 * 整套测试并行跑时机器负载高，默认 1 秒的异步断言超时太紧
 * （曾出现「单跑通过、整套失败」的抖动，与权限逻辑无关）。
 */
configure({ asyncUtilTimeout: 15000 });
// 同理：单条用例要渲染两次（有权限与只读对照），默认的用例超时也会抖
vi.setConfig({ testTimeout: 30_000 });

/**
 * jsdom 未实现 ResizeObserver，antd 6 的 Table 会用到；
 * 这里就地补一个空实现，不改共享的 src/test-setup.ts（不在本任务写作用域内）。
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

  const departments = [
    { id: 'd1', name: '办公室', sortOrder: 1, enabled: true },
    { id: 'd2', name: '财务科', sortOrder: 2, enabled: false },
  ];

  return {
    ...actual,
    adminApi: {
      departments: { list: vi.fn(async () => departments) },
      employees: {
        list: vi.fn(async () => [
          { id: 'e1', name: '张三', employeeNo: '001', sortOrder: 1, enabled: true },
        ]),
        create: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
        import: vi.fn(),
      },
      criteria: {
        list: vi.fn(async () => [
          { id: 'c1', name: '政治素质', minScore: 0, maxScore: 100, sortOrder: 1, enabled: true },
        ]),
        create: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
      },
      settings: {
        get: vi.fn(async () => ({
          'vote.open': 'true',
          'vote.startAt': '2026-09-19T00:00:00.000Z',
          'vote.endAt': '',
          'system.title': '某某单位职工素质评议',
        })),
        update: vi.fn(),
      },
    },
  };
});

const { ApiError } = await import('../../../lib/api.js');
const { AdminDepartments } = await import('../Departments.js');
const { AdminEmployees } = await import('../Employees.js');
const { AdminCriteria } = await import('../Criteria.js');
const { AdminSettings } = await import('../Settings.js');

/** 渲染单个页面并注入权限集合。 */
function renderPage(node: ReactElement, permissions: string[]) {
  return renderWithAuth(
    <ConfigProvider>
      <AntApp>
        <MemoryRouter initialEntries={['/admin']}>{node}</MemoryRouter>
      </AntApp>
    </ConfigProvider>,
    permissions,
  );
}

describe('后台四页写操作权限门控', () => {
  // ---------------------------------------------------------------------------
  // 主操作按钮：有权限在，无权限不渲染
  // ---------------------------------------------------------------------------

  it('部门页：有权限渲染「新增部门」，只读账号不渲染', async () => {
    const granted = renderPage(<AdminDepartments />, ALL_PERMISSIONS);
    expect(await screen.findByRole('button', { name: /新增部门/ })).toBeInTheDocument();
    granted.unmount();

    renderPage(<AdminDepartments />, []);
    // 先等数据到货，避免把「还在加载」误判成「按钮被隐藏」
    expect(await screen.findByText('办公室')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /新增部门/ })).not.toBeInTheDocument();
    // 读操作不受影响：刷新按钮仍在
    expect(screen.getByRole('button', { name: /刷\s*新/ })).toBeInTheDocument();
  });

  it('职工页：有权限渲染「新增职工」与导入入口，只读账号两者都不渲染', async () => {
    const granted = renderPage(<AdminEmployees />, ALL_PERMISSIONS);
    expect(await screen.findByRole('button', { name: /新增职工/ })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /导入 Excel\/CSV/ })).toBeInTheDocument();
    granted.unmount();

    renderPage(<AdminEmployees />, []);
    expect(await screen.findByText('张三')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /新增职工/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /导入 Excel\/CSV/ })).not.toBeInTheDocument();
  });

  it('项点页：有权限渲染「新增项点」，只读账号不渲染', async () => {
    const granted = renderPage(<AdminCriteria />, ALL_PERMISSIONS);
    expect(await screen.findByRole('button', { name: /新增项点/ })).toBeInTheDocument();
    granted.unmount();

    renderPage(<AdminCriteria />, []);
    expect(await screen.findByText('政治素质')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /新增项点/ })).not.toBeInTheDocument();
  });

  it('设置页：有权限渲染「保存设置」，只读账号不渲染', async () => {
    const granted = renderPage(<AdminSettings />, ALL_PERMISSIONS);
    expect(await screen.findAllByRole('button', { name: /保\s*存设置/ })).not.toHaveLength(0);
    granted.unmount();

    renderPage(<AdminSettings />, []);
    expect(await screen.findByText('三层条件全部满足才算开放')).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: /保\s*存设置/ })).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 行内操作：保留但禁用（整列消失会让表格看起来缺列）
  // ---------------------------------------------------------------------------

  it('部门页：只读账号的启停开关与编辑/删除保留在表格里但不可点', async () => {
    renderPage(<AdminDepartments />, []);

    const toggle = await screen.findByRole('switch', { name: /停用「办公室」/ });
    expect(toggle).toBeDisabled();
    // 两行数据各有一组行内操作，逐个断言
    const edits = screen.getAllByRole('button', { name: /编\s*辑/ });
    expect(edits).toHaveLength(2);
    for (const button of edits) expect(button).toBeDisabled();
    const removes = screen.getAllByRole('button', { name: /删\s*除/ });
    expect(removes).toHaveLength(2);
    for (const button of removes) expect(button).toBeDisabled();
    // 操作列仍然存在：列头不许消失（带横向滚动时 antd 会渲染多份列头）
    expect(screen.getAllByText('操作').length).toBeGreaterThan(0);
  });

  it('部门页：有权限账号的启停开关与编辑/删除可点', async () => {
    renderPage(<AdminDepartments />, ALL_PERMISSIONS);

    const toggle = await screen.findByRole('switch', { name: /停用「办公室」/ });
    expect(toggle).toBeEnabled();
    const edits = screen.getAllByRole('button', { name: /编\s*辑/ });
    expect(edits).toHaveLength(2);
    for (const button of edits) expect(button).toBeEnabled();
    const removes = screen.getAllByRole('button', { name: /删\s*除/ });
    expect(removes).toHaveLength(2);
    for (const button of removes) expect(button).toBeEnabled();
  });

  it('职工页与项点页：只读账号的行内开关同样保留但禁用', async () => {
    const employees = renderPage(<AdminEmployees />, []);
    expect(await screen.findByRole('switch', { name: /停用「张三」/ })).toBeDisabled();
    employees.unmount();

    renderPage(<AdminCriteria />, []);
    expect(await screen.findByRole('switch', { name: /停用「政治素质」/ })).toBeDisabled();
  });

  // ---------------------------------------------------------------------------
  // 后端 403 的 message 必须能在界面读出来
  // ---------------------------------------------------------------------------

  it('项点页：后端 403 的 message 原样显示在页面内提示里', async () => {
    const message = '当前账号没有「管理评分项点」权限，请联系超级管理员';
    const { adminApi } = await import('../../../lib/api.js');
    vi.mocked(adminApi.criteria.create).mockRejectedValueOnce(
      new ApiError(403, 'PERMISSION_DENIED', message),
    );

    const user = userEvent.setup();
    // 权限缓存是旧的（界面以为有权限），真正的拒绝来自后端
    renderPage(<AdminCriteria />, ALL_PERMISSIONS);

    await user.click(await screen.findByRole('button', { name: /新增项点/ }));
    await user.type(await screen.findByLabelText(/项点名称/), '德');
    await user.click(screen.getByRole('button', { name: /保\s*存/ }));

    // 必须落在页面内提示（Alert）里，而不是只弹一条全局提示
    const alert = (await screen.findByText('操作被拒绝')).closest('.ant-alert');
    expect(alert).not.toBeNull();
    expect(alert).toHaveTextContent(message);
  });
});