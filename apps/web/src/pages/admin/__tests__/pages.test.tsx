import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
// 后台页面用 useAuth() 判权限，独立渲染必须注入身份上下文（默认给全部权限）
import { renderWithAuth } from '../../../test-utils.js';

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
      startAt: '2026-09-19T00:00:00.000Z',
      endAt: null,
    },
    generatedAt: '2026-09-19T02:00:00.000Z',
  };

  const settings = {
    'vote.open': 'true',
    'vote.startAt': '2026-09-19T00:00:00.000Z',
    'vote.endAt': '',
    'system.title': '某某单位职工素质评议',
  };

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
          { id: 'e1', name: '张三', employeeNo: '001', sortOrder: 1, enabled: true },
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
const { AdminDashboard } = await import('../Dashboard.js');
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

  it('后台外壳渲染工作流分组导航与当前管理员', async () => {
    renderWithAuth(
      <ConfigProvider>
        <AntApp>
          <MemoryRouter initialEntries={['/admin']}>
            <Routes>
              <Route path="/admin" element={<AdminLayout />}>
                <Route index element={<div>概览占位</div>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </AntApp>
      </ConfigProvider>,
    );

    expect(await screen.findByText('票种权重')).toBeInTheDocument();
    // 导航按评议工作流分组：准备 → 发票 → 执行 → 收尾
    expect(await screen.findByText('评议准备')).toBeInTheDocument();
    expect(screen.getByText('发票与票种')).toBeInTheDocument();
    expect(screen.getByText('评议执行')).toBeInTheDocument();
    expect(screen.getByText('评议收尾')).toBeInTheDocument();
    expect(await screen.findByText('admin')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /退出登录/ })).toBeInTheDocument();
  });

  it('概览页渲染流程进度中枢与票况数据', async () => {
    renderPage(<AdminDashboard />);

    // 流程进度中枢：四个步骤
    expect(await screen.findByText('评议准备')).toBeInTheDocument();
    expect(screen.getByText('发票')).toBeInTheDocument();
    expect(screen.getByText('开放投票')).toBeInTheDocument();
    expect(screen.getByText('结果收尾')).toBeInTheDocument();
    // 开放投票步骤展示真实开放状态
    expect(screen.getByText('开放中')).toBeInTheDocument();
    // 发票步骤展示 totals 真实数据
    expect(screen.getByText('已发放随机码')).toBeInTheDocument();
    // 票种表与部门表
    expect(await screen.findByText('领导班子')).toBeInTheDocument();
    expect(screen.getByText('办公室')).toBeInTheDocument();
  });

  it('票种页实时显示启用票种权重合计与差额（停用票种不计入）', async () => {
    renderPage(<AdminTicketTypes />);

    // 60 + 30 为启用票种，停用的 20 不计入 → 还差 10%
    const summary = await screen.findByText('启用票种权重合计 90%，还差 10%');
    expect(summary).toBeInTheDocument();
    // 企业风：合计不足 100 时用 error 型 Alert 警示
    expect(summary.closest('.ant-alert-error')).not.toBeNull();
    expect(await screen.findByText('职工代表')).toBeInTheDocument();
    // 工作流串联：底部引导去随机码发放
    expect(screen.getByRole('link', { name: /下一步：随机码发放/ })).toBeInTheDocument();
  });

  it('发码页渲染批量发码表单、码明细与批次页签', async () => {
    renderPage(<AdminTickets />);

    expect(await screen.findByText('批量发码')).toBeInTheDocument();
    expect(await screen.findByText('ABCD2345')).toBeInTheDocument();
    expect(await screen.findByText('发放批次')).toBeInTheDocument();
    // 状态列文字表意（Tag 颜色仅辅助）
    expect(await screen.findByText('未使用')).toBeInTheDocument();
    // 工作流串联：底部引导去开放时间
    expect(screen.getByRole('link', { name: /下一步：开放时间/ })).toBeInTheDocument();
  });

  it('部门页渲染部门列表、软删除口径与下一步引导', async () => {
    renderPage(<AdminDepartments />);

    expect(await screen.findByText('办公室')).toBeInTheDocument();
    expect(await screen.findByText('财务科')).toBeInTheDocument();
    // 软删除语义说明（产品原则 4）：形式可换，内容不许丢
    expect(
      await screen.findByText(/停用后不再出现在投票入口，历史评分仍可导出/),
    ).toBeInTheDocument();
    // 评议工作流串联
    expect(screen.getByRole('link', { name: /下一步：职工名单/ })).toBeInTheDocument();
  });

  it('职工页渲染名单、导入入口与列约定、下一步引导', async () => {
    renderPage(<AdminEmployees />);

    expect(await screen.findByText('张三')).toBeInTheDocument();
    expect(await screen.findByText('导入 Excel/CSV')).toBeInTheDocument();
    // 导入列约定说明（部门,姓名,工号）
    expect(await screen.findByText(/列顺序固定：部门,姓名,工号/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /下一步：评分项点/ })).toBeInTheDocument();
  });

  it('项点页渲染列配置与归一化口径说明', async () => {
    renderPage(<AdminCriteria />);

    expect(await screen.findByText('政治素质')).toBeInTheDocument();
    expect(await screen.findByText('各项满分不同时的综合得分口径')).toBeInTheDocument();
    // 三行示例保留：90 与 62.5 归一化后等权平均得 76.25
    expect(await screen.findByText(/76\.25/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /下一步：票种权重/ })).toBeInTheDocument();
  });

  it('设置页渲染三层开放条件、无内嵌文字的开关与下一步引导', async () => {
    renderPage(<AdminSettings />);

    expect(await screen.findByText('三层条件全部满足才算开放')).toBeInTheDocument();
    expect(await screen.findByText(/当前状态：/)).toBeInTheDocument();
    // 非开放时段投票入口的提示口径保留
    expect(
      await screen.findByText(/非开放时段，投票入口显示「当前未开放投票」/),
    ).toBeInTheDocument();
    // 无障碍修复：Switch 内不放文字，开/关状态由旁边文字表达
    const master = await screen.findByRole('switch', { name: /投票总开关/ });
    expect(master.textContent).toBe('');
    expect(screen.getByRole('link', { name: /下一步：概览/ })).toBeInTheDocument();
  });

  it('结果页渲染排名、参与票种与导出入口', async () => {
    renderPage(<AdminResults />);

    // 结果是按被评列出的：被评对象是职务/车间，不是职工
    expect(await screen.findByText('主任')).toBeInTheDocument();
    expect(await screen.findByRole('columnheader', { name: '被评对象' })).toBeInTheDocument();
    expect(await screen.findByText(/共收到 1 张提交表/)).toBeInTheDocument();
    // Button 带 href 时渲染成 a 标签，角色是 link 而不是 button
    expect(screen.getByRole('link', { name: /导\s*出\s*Excel/ })).toBeInTheDocument();
    // 口径说明（产品原则 4）：info Alert 写清票种加权与归一化口径
    // （页头描述也含「票种加权后的原始分」短语，断言用口径条目全句避免多重匹配）
    expect(await screen.findByText(/表中各项得分为「票种加权后的原始分」/)).toBeInTheDocument();
    expect(screen.getByText(/实际参与计算的票种/)).toBeInTheDocument();
    // 工作流串联：底部引导去打印打分表
    expect(screen.getByRole('link', { name: /下一步：打印打分表/ })).toBeInTheDocument();
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

  it('票种页可打开新增弹窗（弹窗内的表单只有打开时才渲染）', async () => {
    const user = userEvent.setup();
    renderPage(<AdminTicketTypes />);

    await user.click(await screen.findByRole('button', { name: /新增票种/ }));

    expect(await screen.findByLabelText(/代码/)).toBeInTheDocument();
    expect(await screen.findByLabelText(/权重/)).toBeInTheDocument();
  });

  it('发码页可打开按权重发码弹窗并给出各票种拆分预览', async () => {
    const user = userEvent.setup();
    renderPage(<AdminTickets />);

    await user.click(await screen.findByRole('button', { name: /按权重一键发码/ }));

    expect(await screen.findByText('将发放')).toBeInTheDocument();
    expect(await screen.findByText(/拆分总数量/)).toBeInTheDocument();
  });

  it('发码页可切换到发放批次页签', async () => {
    const user = userEvent.setup();
    renderPage(<AdminTickets />);

    await user.click(await screen.findByRole('tab', { name: '发放批次' }));

    // 批次号显示 id 前 8 位
    expect(await screen.findByText('batch123')).toBeInTheDocument();
  });
});