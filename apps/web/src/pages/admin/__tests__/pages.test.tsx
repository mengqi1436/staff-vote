import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
// 后台页面用 useAuth() 判权限，独立渲染必须注入身份上下文（默认给全部权限）
import { renderWithAuth } from '../../../test-utils.js';
// 断言接口调用参数用（走 vi.mock 的 mock 版本）
import { adminApi } from '../../../lib/api.js';

/**
 * 十个后台页面的渲染冒烟测试。
 *
 * 编译期查不出「antd 6 组件在运行时是否正确渲染」，也查不出「需求点是否真的
 * 出现在界面上」。这里用一组固定的假数据把每个页面都渲染一遍：
 * 任何运行时异常、废弃 API 警告都会在读测试输出时暴露出来。
 * 业务逻辑的断言在 lib.test.ts，这里不重复。
 *
 * 注：jsdom 未实现 ResizeObserver，而 antd 6 的 Table/Statistic 会用到；
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
    {
      id: 'd1',
      name: '办公室',
      sortOrder: 1,
      enabled: true,
      questionnaireType: 'person',
      headerNote: '附件1-1',
      title: 'xx车间负责人评价问卷',
      footerNote: '填写说明：每一条评价项点满分20分，弃权、不填视为0分。',
    },
    {
      id: 'd2',
      name: '财务科',
      sortOrder: 2,
      enabled: false,
      questionnaireType: 'workshop',
      headerNote: '附件1-2',
      title: 'xx车间评价问卷',
      footerNote: '',
    },
  ];

  const ticketTypes = [
    {
      id: 'a',
      code: 'A',
      name: '领导班子',
      weightPercent: 60,
      sortOrder: 1,
      enabled: true,
      issuedCount: 10,
      usedCount: 4,
    },
    { id: 'b', code: 'B', name: '中层干部', weightPercent: 30, sortOrder: 2, enabled: true },
    { id: 'c', code: 'C', name: '职工代表', weightPercent: 20, sortOrder: 3, enabled: false },
  ];

  const overview = {
    ticketTypes: [
      {
        id: 'a',
        code: 'A',
        name: '领导班子',
        weightPercent: 60,
        issued: 10,
        used: 4,
        unused: 5,
        revoked: 1,
      },
    ],
    totals: { issued: 10, used: 4, unused: 5, revoked: 1, sheets: 3 },
    departments: [{ id: 'd1', name: '办公室', employeeCount: 8, sheetCount: 3 }],
    voteWindow: {
      open: true,
      message: '投票开放中',
      opensAt: '2026-09-19T00:00:00.000Z',
      closesAt: null,
      status: 'voting',
    },
    generatedAt: '2026-09-19T02:00:00.000Z',
  };

  const settings = {
    'system.title': '某某单位职工素质评议',
  };

  const sessions = [
    {
      id: 's1',
      name: '内设机构',
      status: 'voting' as const,
      opensAt: null,
      closesAt: null,
      startAt: '2026-09-19T00:00:00.000Z',
      endedAt: null,
      createdAt: '2026-09-19T00:00:00.000Z',
    },
  ];

  const results = {
    department: { id: 'd1', name: '办公室' },
    criteria: [{ id: 'c1', name: '政治素质', minScore: 0, maxScore: 100 }],
    rows: [
      {
        rank: 1,
        voteColumnId: 'v1',
        voteColumnName: '主任',
        enabled: true,
        comprehensiveScore: 88.5,
        criteria: [
          {
            criterionId: 'c1',
            criterionName: '政治素质',
            rawScore: 88,
            normalizedScore: 88,
            participatingTicketTypeIds: ['a'],
          },
        ],
      },
    ],
    ticketTypesInvolved: [{ id: 'a', code: 'A', name: '领导班子', weightPercent: 100 }],
    sheetCount: 1,
    generatedAt: '2026-09-19T02:00:00.000Z',
  };

  return {
    ...actual,
    adminApi: {
      login: vi.fn(async () => ({
        id: 'u1',
        username: 'admin',
        roleId: 'r-super',
        roleName: '超级管理员',
        permissions: [
          'departments.write',
          'employees.write',
          'criteria.write',
          'ticketTypes.write',
          'tickets.generate',
          'tickets.revoke',
          'settings.write',
          'admins.manage',
        ],
      })),
      logout: vi.fn(async () => undefined),
      sessions: {
        list: vi.fn(async () => ({ sessions })),
        create: vi.fn(async (name: string) => ({
          session: { ...sessions[0], id: 's2', name, status: 'draft' as const, startAt: null, endedAt: null },
        })),
        update: vi.fn(async (id: string, body: Record<string, unknown>) => ({
          session: { ...sessions[0], id, ...body },
        })),
        start: vi.fn(async () => ({ session: { ...sessions[0], status: 'voting' as const } })),
        pause: vi.fn(async () => ({ session: { ...sessions[0], status: 'paused' as const } })),
        end: vi.fn(async () => ({ session: { ...sessions[0], status: 'ended' as const } })),
      },
      me: vi.fn(async () => ({
        id: 'u1',
        username: 'admin',
        roleId: 'r-super',
        roleName: '超级管理员',
        permissions: [
          'departments.write',
          'employees.write',
          'criteria.write',
          'ticketTypes.write',
          'tickets.generate',
          'tickets.revoke',
          'settings.write',
          'admins.manage',
        ],
      })),
      ticketTypes: { list: vi.fn(async () => ticketTypes) },
      tickets: {
        list: vi.fn(async () => ({
          items: [
            {
              id: 'k1',
              code: 'ABCD2345',
              status: 'unused',
              usedAt: null,
              createdAt: '2026-09-19T02:00:00.000Z',
              ticketType: { id: 'a', code: 'A', name: '领导班子' },
              batchId: 'batch1',
            },
          ],
          total: 1,
          page: 1,
          pageSize: 20,
        })),
        exportUrl: () => '/api/admin/tickets/export',
      },
      batches: {
        list: vi.fn(async () => [
          {
            id: 'batch12345678',
            count: 10,
            operator: 'admin',
            createdAt: '2026-09-19T02:00:00.000Z',
            ticketType: { id: 'a', code: 'A', name: '领导班子' },
          },
        ]),
      },
      departments: {
        list: vi.fn(async () => departments),
        update: vi.fn(async (id: string, body: Record<string, unknown>) => ({
          ...departments[0],
          id,
          ...body,
        })),
      },
      voteColumns: {
        list: vi.fn(async () => [
          { id: 'v1', departmentId: 'd1', name: '主任', sortOrder: 1, enabled: true },
          { id: 'v2', departmentId: 'd1', name: '副主任', sortOrder: 2, enabled: true },
        ]),
        create: vi.fn(async (body: { departmentId: string; name: string; sortOrder?: number }) => ({
          id: 'v3',
          departmentId: body.departmentId,
          name: body.name,
          sortOrder: body.sortOrder ?? 0,
          enabled: true,
        })),
        update: vi.fn(async (id: string, body: Record<string, unknown>) => ({
          id,
          departmentId: 'd1',
          name: '主任',
          sortOrder: 1,
          enabled: true,
          ...body,
        })),
        remove: vi.fn(async () => undefined),
      },
      employees: {
        list: vi.fn(async () => [
          { id: 'e1', name: '张三', gender: '男', age: 35, title: '高级工程师', sortOrder: 1, enabled: true },
        ]),
      },
      criteria: {
        list: vi.fn(async () => [
          {
            id: 'c1',
            name: '政治素质',
            description: '信念坚定、对党忠诚。',
            minScore: 0,
            maxScore: 20,
            sortOrder: 1,
            enabled: true,
          },
        ]),
      },
      settings: { get: vi.fn(async () => settings) },
      stats: { overview: vi.fn(async () => overview) },
      results: {
        list: vi.fn(async () => results),
        exportUrl: () => '/api/admin/results/export.xlsx?departmentId=d1',
      },
    },
  };
});

const { AdminLogin } = await import('../Login.js');
const { AdminLayout } = await import('../AdminLayout.js');
const { AdminTicketTypes } = await import('../TicketTypes.js');
const { AdminTickets } = await import('../Tickets.js');
const { AdminDepartments } = await import('../Departments.js');
const { AdminEmployees } = await import('../Employees.js');
const { AdminCriteria } = await import('../Criteria.js');
const { AdminQuestionnaire } = await import('../Questionnaire.js');
const { AdminSettings } = await import('../Settings.js');
const { AdminResults } = await import('../Results.js');
const { AdminPrintSheet } = await import('../PrintSheet.js');

function renderPage(node: ReactElement, path = '/admin') {
  return renderWithAuth(
    <ConfigProvider>
      <AntApp>
        <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
      </AntApp>
    </ConfigProvider>,
  );
}

describe('后台页面渲染', () => {
  it('登录页渲染用户名与口令表单', () => {
    renderPage(<AdminLogin />, '/admin/login');

    expect(screen.getByLabelText(/用户名/)).toBeInTheDocument();
    expect(screen.getByLabelText(/口令/)).toBeInTheDocument();
    // antd 会在两个汉字之间自动插入空格（autoInsertSpace），所以用正则匹配
    expect(screen.getByRole('button', { name: /登\s*录/ })).toBeInTheDocument();
  });

  it('后台外壳渲染三项目导航与当前管理员，工作台路由隐藏场次选择器', async () => {
    renderWithAuth(
      <ConfigProvider>
        <AntApp>
          <MemoryRouter initialEntries={['/admin/sessions']}>
            <Routes>
              <Route path="/admin" element={<AdminLayout />}>
                <Route path="sessions" element={<div>场次列表占位</div>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </AntApp>
      </ConfigProvider>,
    );

    // 菜单重组后只剩三项；顶栏标题与菜单文案相同，用计数断言避免重复匹配
    expect((await screen.findAllByText('场次管理')).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('系统设置')).toBeInTheDocument();
    expect(screen.getByText('账号与权限')).toBeInTheDocument();
    // 旧的工作流分组导航不再存在
    expect(screen.queryByText('评议准备')).not.toBeInTheDocument();
    // 顶栏当前页标题与管理员
    expect(await screen.findByText('admin')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /退出登录/ })).toBeInTheDocument();
    // 非工作台路由显示场次选择器
    expect(screen.getByRole('combobox', { name: '当前场次' })).toBeInTheDocument();
  });

  it('场次工作台路由：顶栏标题为工作台且隐藏场次选择器', async () => {
    renderWithAuth(
      <ConfigProvider>
        <AntApp>
          <MemoryRouter initialEntries={['/admin/sessions/s1']}>
            <Routes>
              <Route path="/admin" element={<AdminLayout />}>
                <Route path="sessions/:id" element={<div>工作台占位</div>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </AntApp>
      </ConfigProvider>,
    );

    expect(await screen.findByText('场次工作台')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '当前场次' })).not.toBeInTheDocument();
  });

  it('票种页实时显示启用票种权重合计与差额（停用票种不计入）', async () => {
    renderPage(<AdminTicketTypes />);

    // 60 + 30 为启用票种，停用的 20 不计入 → 还差 10%
    const summary = await screen.findByText('启用票种权重合计 90%，还差 10%');
    expect(summary).toBeInTheDocument();
    // 企业风：合计不足 100 时用 error 型 Alert 警示
    expect(summary.closest('.ant-alert-error')).not.toBeNull();
    expect(await screen.findByText('职工代表')).toBeInTheDocument();
  });

  it('发码页渲染批量发码表单、码明细与批次页签', async () => {
    renderPage(<AdminTickets />);

    expect(await screen.findByText('批量发码')).toBeInTheDocument();
    expect(await screen.findByText('ABCD2345')).toBeInTheDocument();
    expect(await screen.findByText('发放批次')).toBeInTheDocument();
    // 状态列文字表意（Tag 颜色仅辅助）
    expect(await screen.findByText('未使用')).toBeInTheDocument();
  });

  it('部门页渲染部门列表与软删除口径', async () => {
    renderPage(<AdminDepartments />);

    expect(await screen.findByText('办公室')).toBeInTheDocument();
    expect(await screen.findByText('财务科')).toBeInTheDocument();
    // 软删除语义说明（产品原则 4）：形式可换，内容不许丢
    expect(
      await screen.findByText(/停用后不再出现在投票入口，历史评分仍可导出/),
    ).toBeInTheDocument();
  });

  it('职工页渲染名单、导入入口与列约定', async () => {
    renderPage(<AdminEmployees />);

    expect(await screen.findByText('张三')).toBeInTheDocument();
    expect(await screen.findByText('模板下载')).toBeInTheDocument();
    expect(await screen.findByText('导入 Excel/CSV')).toBeInTheDocument();
    // 导入列约定说明（部门,姓名,性别,年龄,职称）
    expect(await screen.findByText(/列顺序固定：部门,姓名,性别,年龄,职称/)).toBeInTheDocument();
  });

  it('项点页渲染列配置与归一化口径说明', async () => {
    renderPage(<AdminCriteria />);

    expect(await screen.findByText('政治素质')).toBeInTheDocument();
    expect(await screen.findByText('各项满分不同时的综合得分口径')).toBeInTheDocument();
    // 三行示例保留：90 与 62.5 归一化后等权平均得 76.25
    expect(await screen.findByText(/76\.25/)).toBeInTheDocument();
  });

  it('设置页渲染系统标题表单', async () => {
    renderPage(<AdminSettings />);

    const titleInput = await screen.findByLabelText('系统标题');
    // 开放时间窗已下沉到场次：设置页不再有总开关与时间窗
    expect(screen.queryByRole('switch', { name: /投票总开关/ })).not.toBeInTheDocument();
    expect(screen.queryByText('三层条件全部满足才算开放')).not.toBeInTheDocument();
    // 首次取数后表单灌入服务端值（轮询不覆盖编辑中内容，用 waitFor 等灌值完成）
    await waitFor(() =>
      expect((titleInput as HTMLInputElement).value).toBe('某某单位职工素质评议'),
    );
  });

  it('结果页渲染排名、参与票种与导出入口', async () => {
    renderPage(<AdminResults />);

    // 结果是按被评列出的：被评对象是职务/车间，不是职工
    expect(await screen.findByText('主任')).toBeInTheDocument();
    expect(await screen.findByRole('columnheader', { name: '被评对象' })).toBeInTheDocument();
    expect(await screen.findByText(/共收到 1 张提交表/)).toBeInTheDocument();
    // Button 带 href 时渲染成 a 标签，角色是 link 而不是 button
    expect(screen.getByRole('link', { name: /导\s*出\s*Excel/ })).toBeInTheDocument();
    // 整场整合导出需要场次上下文：未选场次时按钮存在但禁用
    expect(screen.getByRole('button', { name: /整场整合导出/ })).toBeDisabled();
    // 口径说明（产品原则 4）：info Alert 写清票种加权与归一化口径
    // （页头描述也含「票种加权后的原始分」短语，断言用口径条目全句避免多重匹配）
    expect(await screen.findByText(/表中各项得分为「票种加权后的原始分」/)).toBeInTheDocument();
    expect(screen.getByText(/实际参与计算的票种/)).toBeInTheDocument();
  });

  it('打印页渲染正式打分表与签字栏', async () => {
    renderPage(<AdminPrintSheet />, '/admin/results/print?departmentId=d1');

    expect(await screen.findByText('职工素质评议打分表')).toBeInTheDocument();
    expect(await screen.findByText('某某单位职工素质评议')).toBeInTheDocument();
    // 表体按被评列出结果（不再有姓名与工号列）
    expect(await screen.findByText('主任')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: '工号' })).not.toBeInTheDocument();
    expect(await screen.findByText(/考评人签字/)).toBeInTheDocument();
    // 最终交付物的打印增强必须保留：A4 横向、表头跨页重复、行不切断
    const styles = Array.from(document.querySelectorAll('style'))
      .map((node) => node.textContent ?? '')
      .join('\n');
    expect(styles).toContain('A4 landscape');
    expect(styles).toContain('table-header-group');
    expect(styles).toContain('break-inside');
  });

  it('打印页把场次查询串透传给 results.list（防串场次）', async () => {
    renderPage(<AdminPrintSheet />, '/admin/results/print?departmentId=d1&sessionId=s9');

    await screen.findByText('职工素质评议打分表');
    await waitFor(() =>
      expect(vi.mocked(adminApi.results.list)).toHaveBeenCalledWith('d1', 's9'),
    );
  });

  it('票种页可打开新增弹窗（弹窗内的表单只有打开时才渲染）', async () => {
    const user = userEvent.setup();
    renderPage(<AdminTicketTypes />);

    await user.click(await screen.findByRole('button', { name: /新增票种/ }));

    expect(await screen.findByLabelText(/代码/)).toBeInTheDocument();
    expect(await screen.findByLabelText(/权重/)).toBeInTheDocument();
  });

  it('发码页可切换到发放批次页签', async () => {
    const user = userEvent.setup();
    renderPage(<AdminTickets />);

    await user.click(await screen.findByRole('tab', { name: '发放批次' }));

    // 批次号显示 id 前 8 位
    expect(await screen.findByText('batch123')).toBeInTheDocument();
  });
});