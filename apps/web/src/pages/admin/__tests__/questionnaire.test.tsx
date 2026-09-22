/**
 * 「问卷配置」页的行为测试（附件8 Excel 所见即所得版式）。
 *
 * 页面主体是一张与 docs/附件文件包/附件8.问卷调查表.xlsx 同构的表：
 * 标题中的「xx」是内嵌的部门下拉框，抬头/列头/说明在表上内联编辑、失焦自动保存。
 * 断言重点不是「渲染出来了」，而是「改完之后调了哪个接口、带了什么参数」。
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntApp, ConfigProvider } from 'antd';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_PERMISSIONS, renderWithAuth } from '../../../test-utils.js';

/** 参考表口径的部门配置：附件1-1 + 个人问卷 + 标题含 xx 占位。 */
function departments() {
  return [
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
      enabled: true,
      questionnaireType: 'workshop',
      headerNote: '附件1-2',
      title: 'xx车间评价问卷',
      footerNote: '',
    },
  ];
}

function voteColumns() {
  return [
    {
      id: 'v1',
      departmentId: 'd1',
      name: '主任',
      employeeId: null,
      employeeName: null,
      sortOrder: 1,
      enabled: true,
    },
    {
      id: 'v2',
      departmentId: 'd1',
      name: '党支部书记',
      employeeId: null,
      employeeName: null,
      sortOrder: 2,
      enabled: true,
    },
  ];
}

function employees() {
  return [
    { id: 'e1', departmentId: 'd1', name: '张三', employeeNo: '001', sortOrder: 1, enabled: true },
    { id: 'e2', departmentId: 'd1', name: '李四', employeeNo: '002', sortOrder: 2, enabled: true },
    { id: 'e3', departmentId: 'd1', name: '王五', employeeNo: '003', sortOrder: 3, enabled: true },
  ];
}

function criteria() {
  return [
    {
      id: 'c1',
      name: '政治素质',
      description: '信念坚定、对党忠诚。',
      minScore: 0,
      maxScore: 20,
      sortOrder: 1,
      enabled: true,
    },
  ];
}

const mocks = vi.hoisted(() => ({
  departmentList: vi.fn(),
  departmentUpdate: vi.fn(),
  columnList: vi.fn(),
  columnCreate: vi.fn(),
  columnUpdate: vi.fn(),
  columnRemove: vi.fn(),
  criteriaList: vi.fn(),
  criteriaUpdate: vi.fn(),
  employeesList: vi.fn(),
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
      criteria: { list: mocks.criteriaList, update: mocks.criteriaUpdate },
      employees: { list: mocks.employeesList },
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
  // 部门数据带可变状态：PATCH 真正改掉 store，refresh 回来的就是新配置
  const deptStore = departments();
  mocks.departmentList.mockImplementation(async () => deptStore);
  mocks.departmentUpdate.mockImplementation(async (id: string, body: Record<string, unknown>) => {
    const index = deptStore.findIndex((item) => item.id === id);
    deptStore[index] = { ...deptStore[index], ...body } as (typeof deptStore)[number];
    return deptStore[index];
  });
  // 被评列同样带可变状态（选人 / 改名后 refresh 回显）
  const columnStore = voteColumns();
  mocks.columnList.mockImplementation(async () => columnStore);
  mocks.columnUpdate.mockImplementation(async (id: string, body: Record<string, unknown>) => {
    const index = columnStore.findIndex((row) => row.id === id);
    columnStore[index] = {
      ...columnStore[index],
      ...body,
      employeeName:
        body.employeeId === null
          ? null
          : (employees().find((item) => item.id === body.employeeId)?.name ?? null),
    } as (typeof columnStore)[number];
    return columnStore[index];
  });
  mocks.columnCreate.mockImplementation(
    async (body: { departmentId: string; name: string; sortOrder?: number }) => ({
      id: 'v3',
      departmentId: body.departmentId,
      name: body.name,
      employeeId: null,
      employeeName: null,
      sortOrder: body.sortOrder ?? 0,
      enabled: true,
    }),
  );
  mocks.columnRemove.mockImplementation(async () => undefined);
  const criterionStore = criteria();
  mocks.criteriaList.mockImplementation(async () => criterionStore);
  mocks.criteriaUpdate.mockImplementation(async (id: string, body: Record<string, unknown>) => {
    const index = criterionStore.findIndex((row) => row.id === id);
    criterionStore[index] = { ...criterionStore[index], ...body } as (typeof criterionStore)[number];
    return criterionStore[index];
  });
  mocks.employeesList.mockImplementation(async () => employees());
});

describe('问卷配置页（附件8 Excel 版式）', () => {
  it('按附件8版式渲染：附件号、标题（xx 为部门下拉）、斜线表头、被评列、项点行、填写说明', async () => {
    renderQuestionnaire();

    // 抬头与被评列都从部门/问卷配置回填；多场后列表请求带场次过滤（未选场次为 null）
    expect(await screen.findByLabelText('附件号')).toHaveValue('附件1-1');
    await waitFor(() => expect(mocks.columnList).toHaveBeenCalledWith('d1', null));
    await waitFor(() => expect(mocks.criteriaList).toHaveBeenCalledWith('d1', null));

    // 标题中的「xx」渲染为部门下拉，默认选中第一个部门；其余文字原样展示
    expect(screen.getByRole('combobox', { name: '选择部门' })).toHaveValue('');
    expect(screen.getByText('办公室')).toBeInTheDocument();
    expect(screen.getByText('车间负责人评价问卷')).toBeInTheDocument();

    // 斜线表头与被评列
    expect(screen.getByText('职务与姓名')).toBeInTheDocument();
    expect(screen.getByText('评价项点')).toBeInTheDocument();
    expect(screen.getByLabelText('被评列：主任')).toHaveValue('主任');
    expect(screen.getByLabelText('被评列：党支部书记')).toHaveValue('党支部书记');

    // 项点行：名称与描述是表上的内联输入（可直接编辑）
    expect(screen.getByLabelText('项点名称：政治素质')).toHaveValue('政治素质');
    expect(screen.getByLabelText('项点描述：政治素质')).toHaveValue('信念坚定、对党忠诚。');

    // 填写说明：关键词富文本
    expect(screen.getByText('满分20分')).toHaveClass('note-red');
    expect(screen.getByText('0分')).toHaveClass('note-red');
  }, TIMEOUT_MS);

  it('标题下拉切换部门后，重新加载该部门的被评列与项点', async () => {
    const user = userEvent.setup({ delay: null });
    renderQuestionnaire();
    await screen.findByText('办公室');
    mocks.columnList.mockClear();
    mocks.criteriaList.mockClear();

    await user.click(screen.getByRole('combobox', { name: '选择部门' }));
    await user.click(await screen.findByTitle('财务科'));

    await waitFor(() => expect(mocks.columnList).toHaveBeenCalledWith('d2', null));
    expect(mocks.criteriaList).toHaveBeenCalledWith('d2', null);
  }, TIMEOUT_MS);

  it('附件号内联编辑，失焦自动 PATCH 到该部门', async () => {
    const user = userEvent.setup({ delay: null });
    renderQuestionnaire();
    const input = await screen.findByLabelText('附件号');

    await user.clear(input);
    await user.type(input, '附件1-2');
    await user.tab();

    await waitFor(() => expect(mocks.departmentUpdate).toHaveBeenCalledTimes(1));
    expect(mocks.departmentUpdate.mock.calls[0]?.[0]).toBe('d1');
    expect(mocks.departmentUpdate.mock.calls[0]?.[1]).toEqual({ headerNote: '附件1-2' });
  }, TIMEOUT_MS);

  it('标题通过铅笔进入编辑，保存含 xx 占位的完整标题', async () => {
    const user = userEvent.setup({ delay: null });
    renderQuestionnaire();
    await screen.findByText('办公室');

    await user.click(screen.getByRole('button', { name: '编辑标题' }));
    const input = screen.getByLabelText('表标题');
    expect(input).toHaveValue('xx车间负责人评价问卷');

    await user.clear(input);
    await user.type(input, 'xx车间评价问卷');
    await user.tab();

    await waitFor(() => expect(mocks.departmentUpdate).toHaveBeenCalledTimes(1));
    expect(mocks.departmentUpdate.mock.calls[0]?.[1]).toEqual({ title: 'xx车间评价问卷' });
  }, TIMEOUT_MS);

  it('填写说明通过铅笔编辑，失焦保存 footerNote', async () => {
    const user = userEvent.setup({ delay: null });
    renderQuestionnaire();
    await screen.findByText('办公室');

    await user.click(screen.getByRole('button', { name: '编辑填写说明' }));
    const input = screen.getByLabelText('填写说明');

    await user.clear(input);
    await user.type(input, '填写说明：每项满分20分。');
    await user.tab();

    await waitFor(() => expect(mocks.departmentUpdate).toHaveBeenCalledTimes(1));
    expect(mocks.departmentUpdate.mock.calls[0]?.[1]).toEqual({
      footerNote: '填写说明：每项满分20分。',
    });
  }, TIMEOUT_MS);

  it('新增被评列把部门与列名一起提交（同名允许，参考表的「副主任」出现两次）', async () => {
    const user = userEvent.setup({ delay: null });
    renderQuestionnaire();
    await screen.findByLabelText('被评列：主任');

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

  it('列头悬停 × 并确认后删除该列', async () => {
    const user = userEvent.setup({ delay: null });
    renderQuestionnaire();
    await screen.findByLabelText('被评列：主任');

    await user.click(screen.getByRole('button', { name: '删除「主任」' }));
    await user.click(await screen.findByRole('button', { name: /^删\s*除$/ }));

    await waitFor(() => expect(mocks.columnRemove).toHaveBeenCalledWith('v1'));
  }, TIMEOUT_MS);

  it('列名内联编辑，失焦 PATCH 只带 name', async () => {
    const user = userEvent.setup({ delay: null });
    renderQuestionnaire();
    const input = await screen.findByLabelText('被评列：主任');

    await user.clear(input);
    await user.type(input, '副主任');
    await user.tab();

    await waitFor(() => expect(mocks.columnUpdate).toHaveBeenCalledTimes(1));
    expect(mocks.columnUpdate.mock.calls[0]?.[0]).toBe('v1');
    expect(mocks.columnUpdate.mock.calls[0]?.[1]).toEqual({ name: '副主任' });
  }, TIMEOUT_MS);

  it('切换问卷类型即保存（车间问卷表头为单行「序号 | 项点 | …」）', async () => {
    const user = userEvent.setup({ delay: null });
    renderQuestionnaire();
    await screen.findByText('办公室');

    await user.click(screen.getByText('车间问卷'));

    await waitFor(() => expect(mocks.departmentUpdate).toHaveBeenCalledTimes(1));
    expect(mocks.departmentUpdate.mock.calls[0]?.[1]).toEqual({ questionnaireType: 'workshop' });

    // 车间问卷没有斜线表头
    await waitFor(() => expect(screen.queryByText('职务与姓名')).not.toBeInTheDocument());
    expect(screen.getByText('项点')).toBeInTheDocument();
  }, TIMEOUT_MS);

  it('表头第二行「职务与姓名」：为职务列选择具体人员并保存到被评列', async () => {
    const user = userEvent.setup({ delay: null });
    renderQuestionnaire();
    const combo = await screen.findByRole('combobox', { name: '主任被评人' });
    expect(combo).toHaveValue('');

    await user.click(combo);
    await user.click(await screen.findByTitle('张三'));

    await waitFor(() => expect(mocks.columnUpdate).toHaveBeenCalledTimes(1));
    expect(mocks.columnUpdate.mock.calls[0]?.[0]).toBe('v1');
    expect(mocks.columnUpdate.mock.calls[0]?.[1]).toEqual({ employeeId: 'e1' });

    // 选人后下拉回显所选姓名（下拉浮层与选中框里都会出现该姓名）
    const shown = await screen.findAllByText('张三');
    expect(shown.length).toBeGreaterThan(0);
  }, TIMEOUT_MS);

  it('项点名称在表上直接编辑，失焦 PATCH 只带 name', async () => {
    const user = userEvent.setup({ delay: null });
    renderQuestionnaire();
    const input = await screen.findByLabelText('项点名称：政治素质');

    await user.clear(input);
    await user.type(input, '安全素质');
    await user.tab();

    await waitFor(() => expect(mocks.criteriaUpdate).toHaveBeenCalledTimes(1));
    expect(mocks.criteriaUpdate.mock.calls[0]?.[0]).toBe('c1');
    expect(mocks.criteriaUpdate.mock.calls[0]?.[1]).toEqual({ name: '安全素质' });
  }, TIMEOUT_MS);

  it('项点描述在表上直接编辑，清空后保存为 null', async () => {
    const user = userEvent.setup({ delay: null });
    renderQuestionnaire();
    const input = await screen.findByLabelText('项点描述：政治素质');
    expect(input).toHaveValue('信念坚定、对党忠诚。');

    await user.clear(input);
    await user.tab();
    await waitFor(() => expect(mocks.criteriaUpdate).toHaveBeenCalledTimes(1));
    expect(mocks.criteriaUpdate.mock.calls[0]?.[1]).toEqual({ description: null });
  }, TIMEOUT_MS);

  it('已被其他职务选中的人员从本列下拉中排除，且下拉支持输入搜索', async () => {
    const user = userEvent.setup({ delay: null });
    // 党支部书记列已绑定李四
    mocks.columnList.mockImplementationOnce(async () =>
      voteColumns().map((column) =>
        column.id === 'v2' ? { ...column, employeeId: 'e2', employeeName: '李四' } : column,
      ),
    );
    renderQuestionnaire();

    const combo = await screen.findByRole('combobox', { name: '主任被评人' });
    await user.click(combo);
    const listbox = await screen.findByRole('listbox');

    // 李四已被党支部书记列占用：主任列的下拉里只剩张三（option 的可访问名是姓名）
    expect(within(listbox).getByRole('option', { name: '张三' })).toBeInTheDocument();
    expect(within(listbox).queryByRole('option', { name: '李四' })).toBeNull();

    // 输入搜索：输入「张」过滤后仍能定位到张三
    await user.type(combo, '张');
    expect(within(listbox).getByRole('option', { name: '张三' })).toBeInTheDocument();
    expect(within(listbox).queryByRole('option', { name: '王五' })).toBeNull();
  }, TIMEOUT_MS);

  it('只读账号：表上无编辑入口，内容仍完整展示', async () => {
    renderQuestionnaire([]);

    expect(await screen.findByLabelText('附件号')).toBeDisabled();
    expect(screen.getByLabelText('被评列：主任')).toBeDisabled();
    expect(screen.getByLabelText('项点名称：政治素质')).toBeDisabled();
    expect(screen.getByLabelText('项点描述：政治素质')).toBeDisabled();
    expect(screen.getByRole('combobox', { name: '主任被评人' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '编辑标题' })).toBeNull();
    expect(screen.queryByRole('button', { name: '编辑填写说明' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除「主任」' })).toBeNull();
    expect(screen.queryByRole('button', { name: /新增被评列/ })).toBeNull();
    expect(screen.getByText('办公室')).toBeInTheDocument();
  }, TIMEOUT_MS);
});
