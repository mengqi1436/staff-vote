import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tooltip,
  Typography,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { TableColumnsType } from 'antd';
import { ApiError, adminApi, type DepartmentAdminDto, type VoteColumnDto } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { usePolling } from '../../lib/usePolling.js';
import { describeError } from './lib.js';
import {
  ErrorState,
  LoadingState,
  NextStep,
  PageHeader,
  StaleDataAlert,
  useNotify,
} from './shared.js';

/**
 * 问卷配置（评议准备第 2 步）。
 *
 * 打分表的形状与 docs/参考表.xlsx 一一对应，本页配置的就是表上看得见的一切：
 *   - 抬头与说明：附件号（附件1-1）、表标题（xx车间负责人评价问卷）、填写说明；
 *   - 问卷类型：个人问卷（多列被评职务）或车间问卷（只有一列「得分」）；
 *   - 被评列：表头的各列（主任、党支部书记、党支部副书记、副主任…）。
 * 项点（表的行）在「评分项点」页配置，两页合起来就是整张表。
 *
 * 权限分两处：抬头属于部门配置（departments.write），被评列与项点同属问卷结构
 * （criteria.write）。前端只是体验层门控，真正的防线在后端。
 */

/** 抬头表单的字段。 */
interface HeaderForm {
  questionnaireType: string;
  headerNote: string;
  title: string;
  footerNote: string;
}

/** 被评列表单的字段。 */
interface ColumnForm {
  name: string;
  sortOrder: number;
}

const QUESTIONNAIRE_OPTIONS = [
  { value: 'person', label: '个人问卷（多列被评职务）' },
  { value: 'workshop', label: '车间问卷（单列「得分」）' },
];

export function AdminQuestionnaire() {
  const [departmentId, setDepartmentId] = useState('');
  const loadDepartments = useCallback(() => adminApi.departments.list(), []);
  const departments = usePolling(loadDepartments, 0);

  // 部门列表到货后默认选中第一个，避免管理员每次都要手点
  useEffect(() => {
    if (!departmentId && departments.data?.length) {
      setDepartmentId(departments.data[0]?.id ?? '');
    }
  }, [departments.data, departmentId]);

  const loadColumns = useCallback(
    () => (departmentId ? adminApi.voteColumns.list(departmentId) : Promise.resolve<VoteColumnDto[]>([])),
    [departmentId],
  );
  const columns = usePolling(loadColumns, 0);

  const notify = useNotify();
  const { can } = useAuth();
  const canWriteDepartment = can('departments.write');
  const canWriteColumn = can('criteria.write');

  const [form] = Form.useForm<HeaderForm>();
  const [savingHeader, setSavingHeader] = useState(false);
  const [columnForm] = Form.useForm<ColumnForm>();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<VoteColumnDto | null>(null);
  const [savingColumn, setSavingColumn] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  // 后端 403 的文案要能在界面读出来：页面内用 Alert 摆出来，其余错误仍走全局提示
  const [denied, setDenied] = useState<string | null>(null);

  const current: DepartmentAdminDto | null =
    departments.data?.find((item) => item.id === departmentId) ?? null;

  // 切换部门时把该部门的抬头配置填进表单
  useEffect(() => {
    if (!current) return;
    form.setFieldsValue({
      questionnaireType: current.questionnaireType,
      headerNote: current.headerNote,
      title: current.title,
      footerNote: current.footerNote,
    });
  }, [current, form]);

  const handleFailure = (caught: unknown, fallback = '操作失败，请重试'): void => {
    if (caught instanceof ApiError && caught.status === 403) {
      setDenied(caught.message);
      return;
    }
    notify.error(describeError(caught, fallback));
  };

  const handleSaveHeader = async (): Promise<void> => {
    if (!departmentId) {
      notify.error('请先选择部门');
      return;
    }
    let values: HeaderForm;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSavingHeader(true);
    try {
      await adminApi.departments.update(departmentId, values);
      notify.success('问卷抬头与说明已保存');
      departments.refresh();
    } catch (caught) {
      handleFailure(caught);
    } finally {
      setSavingHeader(false);
    }
  };

  const openCreate = (): void => {
    setEditing(null);
    columnForm.resetFields();
    columnForm.setFieldsValue({ name: '', sortOrder: (columns.data?.length ?? 0) + 1 });
    setModalOpen(true);
  };

  const openEdit = (row: VoteColumnDto): void => {
    setEditing(row);
    columnForm.setFieldsValue({ name: row.name, sortOrder: row.sortOrder });
    setModalOpen(true);
  };

  const handleColumnSubmit = async (): Promise<void> => {
    if (!departmentId) {
      notify.error('请先选择部门');
      return;
    }
    let values: ColumnForm;
    try {
      values = await columnForm.validateFields();
    } catch {
      return;
    }
    setSavingColumn(true);
    try {
      if (editing) await adminApi.voteColumns.update(editing.id, values);
      else await adminApi.voteColumns.create({ departmentId, ...values });
      notify.success(editing ? '被评列已更新' : '被评列已创建');
      setModalOpen(false);
      columns.refresh();
    } catch (caught) {
      handleFailure(caught);
    } finally {
      setSavingColumn(false);
    }
  };

  const toggleEnabled = async (row: VoteColumnDto, checked: boolean): Promise<void> => {
    setTogglingId(row.id);
    try {
      await adminApi.voteColumns.update(row.id, { enabled: checked });
      notify.success(checked ? `已启用「${row.name}」` : `已停用「${row.name}」`);
      columns.refresh();
    } catch (caught) {
      handleFailure(caught);
    } finally {
      setTogglingId(null);
    }
  };

  const handleColumnRemove = async (row: VoteColumnDto): Promise<void> => {
    try {
      await adminApi.voteColumns.remove(row.id);
      notify.success(`已删除「${row.name}」`);
      columns.refresh();
    } catch (caught) {
      handleFailure(caught);
    }
  };

  const columnTableColumns: TableColumnsType<VoteColumnDto> = [
    { title: '列名（表头显示）', dataIndex: 'name' },
    {
      title: '排序',
      dataIndex: 'sortOrder',
      width: 96,
      align: 'right',
      className: 'tabular',
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      width: 140,
      render: (value: boolean, row: VoteColumnDto) => (
        <Space size={8}>
          <Tooltip title={canWriteColumn ? undefined : '无「评分项点」权限'}>
            <span>
              <Switch
                size="small"
                checked={value}
                disabled={!canWriteColumn}
                loading={togglingId === row.id}
                aria-label={`${value ? '停用' : '启用'}「${row.name}」`}
                onChange={(checked) => void toggleEnabled(row, checked)}
              />
            </span>
          </Tooltip>
          <span>{value ? '启用' : '停用'}</span>
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_: unknown, row: VoteColumnDto) => (
        <Space size={0}>
          <Tooltip title={canWriteColumn ? undefined : '无「评分项点」权限'}>
            <span>
              <Button size="small" type="link" disabled={!canWriteColumn} onClick={() => openEdit(row)}>
                编辑
              </Button>
            </span>
          </Tooltip>
          <Tooltip title={canWriteColumn ? undefined : '无「评分项点」权限'}>
            <span>
              <Popconfirm
                title="删除该列？"
                description="删除即停用（软删除）：该列不再出现在打分表，历史评分保留，可随时再启用。"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => void handleColumnRemove(row)}
              >
                <Button size="small" type="link" danger disabled={!canWriteColumn}>
                  删除
                </Button>
              </Popconfirm>
            </span>
          </Tooltip>
        </Space>
      ),
    },
  ];

  const departmentOptions = (departments.data ?? []).map((item) => ({
    value: item.id,
    label: item.enabled ? item.name : `${item.name}（已停用）`,
  }));

  return (
    <>
      <PageHeader
        title="问卷配置"
        description="配置打分表的抬头、说明与被评列。表上的每一处文字都能在这里改；项点（表的行）在「评分项点」页配置。"
        extra={
          <>
            <Select
              style={{ width: 240 }}
              placeholder="选择部门"
              value={departmentId || undefined}
              options={departmentOptions}
              loading={departments.loading}
              onChange={setDepartmentId}
            />
            <Button
              icon={<ReloadOutlined />}
              loading={departments.loading || columns.loading}
              onClick={() => {
                departments.refresh();
                columns.refresh();
              }}
            >
              刷新
            </Button>
          </>
        }
      />

      {denied ? (
        <Alert
          type="error"
          showIcon
          closable
          style={{ marginBottom: 16 }}
          title="操作被拒绝"
          description={denied}
          onClose={() => setDenied(null)}
        />
      ) : null}

      {departments.error && !departments.data ? (
        <ErrorState error={departments.error} onRetry={departments.refresh} />
      ) : null}
      {columns.error && columns.data ? (
        <StaleDataAlert error={columns.error} onRetry={columns.refresh} />
      ) : null}
      {columns.error && !columns.data ? <ErrorState error={columns.error} onRetry={columns.refresh} /> : null}

      {departments.data === null ? (
        <LoadingState />
      ) : departmentId === '' ? (
        <Alert type="info" showIcon title="请先选择部门" description="每个部门各有一套问卷配置。" />
      ) : (
        <Space direction="vertical" size={16} style={{ display: 'flex' }}>
          <Card title="问卷抬头与说明">
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              title="这些文字会原样出现在打分表的表头与表尾"
              description={
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  <li>附件号显示在表格左上角（参考表里是「附件1-1」）；留空则不显示该行。</li>
                  <li>表标题居中显示在表格上方（例如「xx车间负责人评价问卷」）；留空则不显示。</li>
                  <li>
                    填写说明合并显示在表格最下方，参考表的写法是「问卷调查采用无记名投票的方式开展，每一条评价项点满分20分，弃权、不填视为0分」。
                  </li>
                </ul>
              }
            />
            <Form<HeaderForm> form={form} layout="vertical" requiredMark={false} disabled={!canWriteDepartment}>
              <Form.Item name="questionnaireType" label="问卷类型" extra="个人问卷是多列被评职务；车间问卷只有一列「得分」">
                <Select options={QUESTIONNAIRE_OPTIONS} style={{ maxWidth: 360 }} />
              </Form.Item>
              <Form.Item name="headerNote" label="附件号" extra="例如：附件1-1">
                <Input maxLength={50} style={{ maxWidth: 360 }} placeholder="附件1-1" />
              </Form.Item>
              <Form.Item name="title" label="表标题" extra="例如：xx车间负责人评价问卷">
                <Input maxLength={100} style={{ maxWidth: 540 }} placeholder="xx车间负责人评价问卷" />
              </Form.Item>
              <Form.Item name="footerNote" label="填写说明" extra="显示在表格最下方，可写满分口径与投票方式">
                <Input.TextArea
                  autoSize={{ minRows: 2, maxRows: 6 }}
                  maxLength={500}
                  showCount
                  placeholder="填写说明：问卷调查采用无记名投票的方式开展，每一条评价项点满分20分，弃权、不填视为0分。"
                />
              </Form.Item>
              {canWriteDepartment ? (
                <Button type="primary" loading={savingHeader} onClick={() => void handleSaveHeader()}>
                  保存抬头与说明
                </Button>
              ) : (
                <Typography.Text type="secondary">无「部门管理」权限，抬头与说明只能查看。</Typography.Text>
              )}
            </Form>
          </Card>

          <Card
            title="被评列（表头各列）"
            extra={
              canWriteColumn ? (
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  disabled={!departmentId}
                  onClick={openCreate}
                >
                  新增被评列
                </Button>
              ) : null
            }
          >
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              title="被评列就是打分表表头的各列"
              description={
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  <li>参考表的个人问卷是「主任 / 党支部书记 / 党支部副书记 / 副主任」；车间问卷只有一列「得分」。</li>
                  <li>列与职工名单无关：打分对象是职务或车间，不是具体职工。</li>
                  <li>排序数字小的排在左边；停用的列不进入打分表，历史评分保留。</li>
                </ul>
              }
            />
            <Table<VoteColumnDto>
              rowKey="id"
              loading={columns.loading}
              columns={columnTableColumns}
              dataSource={columns.data ?? []}
              pagination={false}
              scroll={{ x: 'max-content' }}
              locale={{
                emptyText: departmentId
                  ? '该部门尚未配置被评列。没有列时打分表只有项点、没有可填的格子'
                  : '请先选择部门',
              }}
            />
          </Card>

          <Modal
            title={editing ? `编辑被评列：${editing.name}` : '新增被评列'}
            open={modalOpen}
            onCancel={() => setModalOpen(false)}
            onOk={() => void handleColumnSubmit()}
            confirmLoading={savingColumn}
            okText="保存"
            cancelText="取消"
            destroyOnHidden
          >
            <Form<ColumnForm> form={columnForm} layout="vertical" requiredMark={false}>
              <Form.Item
                name="name"
                label="列名"
                rules={[{ required: true, message: '请输入列名' }]}
                extra="表头原样显示这个名字，例如：主任"
              >
                <Input placeholder="例如：主任" maxLength={50} />
              </Form.Item>
              <Form.Item name="sortOrder" label="排序" extra="数字小的排在前面，即打分表靠左的列">
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Form>
          </Modal>
        </Space>
      )}

      <NextStep to="/admin/criteria">评分项点</NextStep>
    </>
  );
}