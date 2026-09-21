/**
 * 「问卷配置」页的行为测试。
 *
 * 这一页是打分表的唯一编辑入口：抬头（附件号/标题/填写说明）、问卷类型与被评列
 * 都要能改，并且真的把改动提交到对应的接口（部门 PATCH / 被评列 CRUD）。
 * 因此断言的重点不是「渲染出来了」，而是「改完之后调了哪个接口、带了什么参数」。
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_PERMISSIONS, renderWithAuth } from '../../../test-utils.js';

/** 参考表口径的部门配置：附件1-1 + 个人问卷 + 两个被评列。 */
function department() {
  return {
    id: 'd1',
    name: '办公室',
    sortOrder: 1,
    enabled: true,
    questionnaireType: 'person',
    headerNote: '附件1-1',
    title: 'xx车间负责人评价问卷',
    footerNote: '填写说明：每一条评价项点满分20分，弃权、不填视为0分。',
  };
}

function voteColumns() {
  return [
    { id: 'v1', departmentId: 'd1', name: '主任', sortOrder: 1, enabled: true },
    { id: 'v2', departmentId: 'd1', name: '党支部书记', sortOrder: 2, enabled: true },
  ];
}

const mocks = vi.hoisted(() => ({
  departmentList: vi.fn(),
  departmentUpdate: vi.fn(),
  columnList: vi.fn(),
  columnCreate: vi.fn(),
  columnUpdate: vi.fn(),
  columnRemove: vi.fn(),
}));

vi.mock('../../../lib/api.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../lib/api.js');
  return {
    ...actual,
    adminApi: {
      departments: { list: mocks.departmentList, update: mocks.departmentUpdate },
      voteColumns: {
        list: mocks.columnList,
        create: mocks.columnCreate,
        update: mocks.columnUpdate,
        remove: mocks.columnRemove,
      },
    },
  };
});

const { AdminQuestionnaire } = await import('../Questionnaire.js');

function renderQuestionnaire(permissions: string[] = ALL_PERMISSIONS) {
  return renderWithAuth(
    <ConfigProvider>
      <AntApp>
        <MemoryRouter>
          <AdminQuestionnaire />
        </MemoryRouter>
      </AntApp>
    </ConfigProvider>,
    permissions,
  );
}

/** 全量并发运行（多个测试文件同时渲染 antd 重页面）时，单用例可能超过 vitest 默认的 5 秒。 */
const TIMEOUT_MS = 20_000;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.departmentList.mockImplementation(async () => [department()]);
  mocks.departmentUpdate.mockImplementation(async (id: string, body: Record<string, unknown>) => ({
    ...department(),
    id,
    ...body,
  }));
  mocks.columnList.mockImplementation(async () => voteColumns());
  mocks.columnCreate.mockImplementation(
    async (body: { departmentId: string; name: string; sortOrder?: number }) => ({
      id: 'v3',
      departmentId: body.departmentId,
      name: body.name,
      sortOrder: body.sortOrder ?? 0,
      enabled: true,
    }),
  );
  mocks.columnUpdate.mockImplementation(async (id: string, body: Record<string, unknown>) => ({
    ...voteColumns().find((row) => row.id === id),
    ...body,
  }));
  mocks.columnRemove.mockImplementation(async () => undefined);
});

describe('问卷配置页', () => {
  it('带出当前部门的抬头与被评列，抬头即为参考表的附件号与表标题', async () => {
    renderQuestionnaire();

    // 抬头三项都从部门配置回填
    expect(await screen.findByLabelText('附件号')).toHaveValue('附件1-1');
    expect(screen.getByLabelText('表标题')).toHaveValue('xx车间负责人评价问卷');
    expect(screen.getByLabelText('填写说明')).toHaveValue(
      '填写说明：每一条评价项点满分20分，弃权、不填视为0分。',
    );

    // 被评列来自 /admin/vote-columns
    await waitFor(() => expect(mocks.columnList).toHaveBeenCalledWith('d1'));
    expect(await screen.findByText('主任')).toBeInTheDocument();
    expect(screen.getByText('党支部书记')).toBeInTheDocument();
  }, TIMEOUT_MS);

  it('改表标题与填写说明后保存，PATCH 提交到该部门', async () => {
    const user = userEvent.setup({ delay: null });
    renderQuestionnaire();
    await screen.findByLabelText('表标题');

    const title = screen.getByLabelText('表标题');
    await user.clear(title);
    await user.type(title, 'xx车间评价问卷');
    await user.click(screen.getByRole('button', { name: /保存抬头与说明/ }));

    await waitFor(() => expect(mocks.departmentUpdate).toHaveBeenCalledTimes(1));
    expect(mocks.departmentUpdate.mock.calls[0]?.[0]).toBe('d1');
    expect(mocks.departmentUpdate.mock.calls[0]?.[1]).toMatchObject({
      questionnaireType: 'person',
      headerNote: '附件1-1',
      title: 'xx车间评价问卷',
      footerNote: '填写说明：每一条评价项点满分20分，弃权、不填视为0分。',
    });
  }, TIMEOUT_MS);

  it('新增被评列时把部门与列名一起提交（同名允许，参考表的「副主任」出现两次）', async () => {
    const user = userEvent.setup({ delay: null });
    renderQuestionnaire();
    await screen.findByText('主任');

    await user.click(screen.getByRole('button', { name: /新增被评列/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('列名'), '副主任');
    await user.click(within(dialog).getByRole('button', { name: /保\s*存/ }));

    await waitFor(() => expect(mocks.columnCreate).toHaveBeenCalledTimes(1));
    expect(mocks.columnCreate.mock.calls[0]?.[0]).toMatchObject({
      departmentId: 'd1',
      name: '副主任',
    });
  }, TIMEOUT_MS);

  it('停用某一列时 PATCH 只带 enabled，不动列名', async () => {
    const user = userEvent.setup({ delay: null });
    renderQuestionnaire();
    const row = (await screen.findByText('主任')).closest('tr');
    expect(row).not.toBeNull();

    await user.click(within(row!).getByRole('switch', { name: /停用「主任」/ }));

    await waitFor(() => expect(mocks.columnUpdate).toHaveBeenCalledTimes(1));
    expect(mocks.columnUpdate.mock.calls[0]).toEqual(['v1', { enabled: false }]);
  }, TIMEOUT_MS);

  it('只读账号：不渲染新增按钮，抬头只能看（表单禁用）', async () => {
    renderQuestionnaire([]);

    expect(await screen.findByLabelText('表标题')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /保存抬头与说明/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /新增被评列/ })).toBeNull();
    expect(screen.getByText(/抬头与说明只能查看/)).toBeInTheDocument();
  }, TIMEOUT_MS);
});