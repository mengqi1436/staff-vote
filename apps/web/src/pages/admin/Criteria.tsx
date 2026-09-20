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
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ReactNode } from 'react';
import type { TableColumnsType } from 'antd';
import { ApiError, adminApi, type CriterionDto } from '../../lib/api.js';
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

interface CriterionForm {
  name: string;
  minScore: number;
  maxScore: number;
  sortOrder: number;
  enabled: boolean;
}

/** 口径示例表的行（产品原则 4：三行示例保留）。 */
interface FormulaRow {
  step: string;
  formula: string;
  note: ReactNode;
}

const FORMULA_ROWS: FormulaRow[] = [
  {
    step: '① 单项归一化分',
    formula: '(该项得分 − 起评分) ÷ (满分 − 起评分) × 100',
    note: '把不同满分的项点折算到同一把尺子（百分制）上；越界时夹紧到 0～100。',
  },
  {
    step: '② 综合得分',
    formula: 'Σ(各项归一化分) ÷ 参与计算的项点数',
    note: '每项权重相同，与项点满分大小无关；没有收到票的项点不进入分母。',
  },
  {
    step: '③ 举例',
    formula: '政治素质 90（0～100）→ 90；业务能力 85（60～100）→ 62.5',
    note: (
      <>
        综合得分 =（90 + 62.5）÷ 2 = <span className="tabular">76.25</span>
        ，不是 90 + 85 = 175，也不是（90 + 85）÷ 2 = 87.5。
      </>
    ),
  },
];

const FORMULA_COLUMNS: TableColumnsType<FormulaRow> = [
  { title: '步骤', dataIndex: 'step', width: 150 },
  {
    title: '算式',
    dataIndex: 'formula',
    width: 320,
    render: (value: string) => <span className="tabular">{value}</span>,
  },
  { title: '口径说明', dataIndex: 'note' },
];

/**
 * 评分项点（打分表的列，评议工作流第 3 步），按部门分别配置。
 *
 * 每个部门一套列：同一个项点在不同部门可以有不同的名称与分值区间，
 * 因为不同部门的业务差别很大，强行共用一套列会让打分表失去意义。
 * 每项单独设 min/max，且必须 max > min（后端校验）。
 *
 * 页面上必须写明计分口径（产品原则 4）：各项满分不同时，综合得分是「各自归一化到
 * 百分制后等权平均」，不是原始分相加。这是管理者最容易误读的地方。
 */
export function AdminCriteria() {
  const [departmentId, setDepartmentId] = useState('');
  const loadDepartments = useCallback(() => adminApi.departments.list(), []);
  const departments = usePolling(loadDepartments, 0);

  // 部门列表到货后默认选中第一个，避免管理员每次都要手点
  useEffect(() => {
    if (!departmentId && departments.data?.length) {
      setDepartmentId(departments.data[0]?.id ?? '');
    }
  }, [departments.data, departmentId]);

  const loadCriteria = useCallback(
    () => (departmentId ? adminApi.criteria.list(departmentId) : Promise.resolve<CriterionDto[]>([])),
    [departmentId],
  );
  const { data, error, loading, refresh } = usePolling(loadCriteria, 0);

  const notify = useNotify();
  const { can } = useAuth();
  const canWrite = can('criteria.write');
  const [form] = Form.useForm<CriterionForm>();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CriterionDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  // 后端 403 的文案要能在界面读出来：页面内用 Alert 摆出来，其余错误仍走全局提示
  const [denied, setDenied] = useState<string | null>(null);

  /**
   * 统一的失败处理：403 单独呈现在页面内（权限问题要让管理员读到后端给的原因），
   * 其余错误仍走全局提示，并保留各调用点原先的兜底文案。
   */
  const handleFailure = (caught: unknown, fallback = '操作失败，请重试'): void => {
    if (caught instanceof ApiError && caught.status === 403) {
      setDenied(caught.message);
      return;
    }
    notify.error(describeError(caught, fallback));
  };

  const departmentOptions = (departments.data ?? []).map((item) => ({
    value: item.id,
    label: item.enabled ? item.name : `${item.name}（已停用）`,
  }));

  const openCreate = (): void => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      name: '',
      minScore: 0,
      maxScore: 100,
      sortOrder: (data?.length ?? 0) + 1,
      enabled: true,
    });
    setModalOpen(true);
  };

  const openEdit = (row: CriterionDto): void => {
    setEditing(row);
    form.setFieldsValue({
      name: row.name,
      minScore: row.minScore,
      maxScore: row.maxScore,
      sortOrder: row.sortOrder,
      enabled: row.enabled,
    });
    setModalOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    if (!departmentId) {
      notify.error('请先选择部门');
      return;
    }
    let values: CriterionForm;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      if (editing) await adminApi.criteria.update(editing.id, values);
      else await adminApi.criteria.create({ departmentId, ...values });
      notify.success(editing ? '项点已更新' : '项点已创建');
      setModalOpen(false);
      refresh();
    } catch (caught) {
      handleFailure(caught);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (row: CriterionDto, checked: boolean): Promise<void> => {
    setTogglingId(row.id);
    try {
      await adminApi.criteria.update(row.id, { enabled: checked });
      notify.success(checked ? `已启用「${row.name}」` : `已停用「${row.name}」`);
      refresh();
    } catch (caught) {
      handleFailure(caught);
    } finally {
      setTogglingId(null);
    }
  };

  const handleRemove = async (row: CriterionDto): Promise<void> => {
    try {
      await adminApi.criteria.remove(row.id);
      notify.success(`已停用「${row.name}」`);
      refresh();
    } catch (caught) {
      handleFailure(caught);
    }
  };

  const columns: TableColumnsType<CriterionDto> = [
    { title: '项点名称', dataIndex: 'name' },
    {
      title: '起评分',
      dataIndex: 'minScore',
      width: 96,
      align: 'right',
      className: 'tabular',
    },
    {
      title: '满分',
      dataIndex: 'maxScore',
      width: 96,
      align: 'right',
      className: 'tabular',
    },
    {
      title: '分值区间',
      key: 'range',
      width: 128,
      align: 'right',
      className: 'tabular',
      render: (_: unknown, row: CriterionDto) => `${row.minScore} ~ ${row.maxScore}`,
    },
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
      render: (value: boolean, row: CriterionDto) => (
        <Space size={8}>
          {/* 无权限时保留开关但禁用：整列消失会让表格看起来缺列，原因用 Tooltip 说明 */}
          <Tooltip title={canWrite ? undefined : '无「评分项点」权限'}>
            <span>
              <Switch
                size="small"
                checked={value}
                disabled={!canWrite}
                loading={togglingId === row.id}
                aria-label={`${value ? '停用' : '启用'}「${row.name}」`}
                onChange={(checked) => void toggleEnabled(row, checked)}
              />
            </span>
          </Tooltip>
          {/* 状态另有文字，不靠颜色单独表意 */}
          <span>{value ? '启用' : '停用'}</span>
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      // 行内操作即使无权限也保留（禁用 + Tooltip）：整列消失会让表格看起来缺列
      render: (_: unknown, row: CriterionDto) => (
        <Space size={0}>
          <Tooltip title={canWrite ? undefined : '无「评分项点」权限'}>
            <span>
              <Button size="small" type="link" disabled={!canWrite} onClick={() => openEdit(row)}>
                编辑
              </Button>
            </span>
          </Tooltip>
          <Tooltip title={canWrite ? undefined : '无「评分项点」权限'}>
            <span>
              <Popconfirm
                title="删除该项点？"
                description="删除即停用（软删除）：该项点不再出现在打分表，历史评分保留，可随时再启用。"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => void handleRemove(row)}
              >
                <Button size="small" type="link" danger disabled={!canWrite}>
                  删除
                </Button>
              </Popconfirm>
            </span>
          </Tooltip>
        </Space>
      ),
    },
  ];

  const enabledCount = (data ?? []).filter((row) => row.enabled).length;

  return (
    <>
      <PageHeader
        title="评分项点"
        description="每个部门单独配置一套打分表的列。项点顺序即打分表中的列顺序；每项单独设起评分与满分。"
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
            <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>
              刷新
            </Button>
            {/* 主操作：无权限时不渲染，而不是给一个点不动的按钮 */}
            {canWrite ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={!departmentId}>
                新增项点
              </Button>
            ) : null}
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
      ) : error && data ? (
        <StaleDataAlert error={error} onRetry={refresh} />
      ) : null}
      {error && !data ? <ErrorState error={error} onRetry={refresh} /> : null}

      {/* 计分口径必须写在页面上（产品原则 4）：不然管理员会以为综合得分是各项原始分直接相加 */}
      <Card title="各项满分不同时的综合得分口径" style={{ marginBottom: 16 }}>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          title="各项满分不同时，综合得分按各自区间归一化到百分制后等权平均，不是原始分相加"
          description={
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              <li>单项归一化分 =（该项得分 − 起评分）÷（满分 − 起评分）× 100；超出区间时夹紧到 0～100。</li>
              <li>综合得分 = Σ(各项归一化分) ÷ 参与计算的项点数；各项满分一致时，才恰好等于算术平均。</li>
              <li>某项点在某位职工上没有任何票时，该项不进入综合得分的分母（不按 0 分计入）。</li>
              <li>口径由后端统一计算，结果页与导出文件同源；分值一律取整数，保留 2 位小数。</li>
            </ul>
          }
        />
        <Table<FormulaRow>
          rowKey="step"
          columns={FORMULA_COLUMNS}
          dataSource={FORMULA_ROWS}
          pagination={false}
          scroll={{ x: 'max-content' }}
        />
      </Card>

      {data ? (
        <Card title="项点一览" extra={`共 ${data.length} 项（启用 ${enabledCount} 项）`}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            title="项点配置口径"
            description={
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                <li>分值只接受整数；满分必须大于起评分，否则该项没有打分空间，后端会拒绝保存。</li>
                <li>起评分可以不是 0（例如按 60～100 的评分习惯），归一化以该区间为基准。</li>
                <li>排序数字小的排在打分表靠左的列；停用项点不进入打分表，也不参与计分。</li>
                <li>删除即软删除（停用）：历史评分保留，可随时再启用。</li>
              </ul>
            }
          />
          <Table<CriterionDto>
            rowKey="id"
            loading={loading}
            columns={columns}
            dataSource={data}
            pagination={false}
            scroll={{ x: 'max-content' }}
            locale={{
              emptyText: departmentId
                ? '该部门尚未配置项点。没有项点时投票入口会显示空表'
                : '请先选择部门',
            }}
          />
        </Card>
      ) : loading ? (
        <LoadingState />
      ) : null}

      <Modal
        title={editing ? `编辑项点：${editing.name}` : '新增项点'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Form<CriterionForm> form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="name" label="项点名称" rules={[{ required: true, message: '请输入项点名称' }]}>
            <Input placeholder="例如：政治素质" maxLength={50} />
          </Form.Item>

          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item
              name="minScore"
              label="起评分"
              rules={[
                { required: true, message: '请输入起评分' },
                {
                  validator(_rule, value) {
                    if (value === undefined || value === null) return Promise.resolve();
                    return Number.isInteger(value)
                      ? Promise.resolve()
                      : Promise.reject(new Error('分值必须是整数'));
                  },
                },
              ]}
              style={{ flex: 1 }}
            >
              <InputNumber precision={0} style={{ width: '100%' }} />
            </Form.Item>

            <Form.Item
              name="maxScore"
              label="满分"
              dependencies={['minScore']}
              rules={[
                { required: true, message: '请输入满分' },
                ({ getFieldValue }) => ({
                  validator(_rule, value) {
                    if (value === undefined || value === null) return Promise.resolve();
                    if (!Number.isInteger(value)) {
                      return Promise.reject(new Error('分值必须是整数'));
                    }
                    const min = getFieldValue('minScore');
                    if (typeof min === 'number' && value <= min) {
                      return Promise.reject(new Error('满分必须大于起评分'));
                    }
                    return Promise.resolve();
                  },
                }),
              ]}
              style={{ flex: 1 }}
            >
              <InputNumber precision={0} style={{ width: '100%' }} />
            </Form.Item>
          </Space>

          <Form.Item name="sortOrder" label="排序" extra="数字小的排在前面，即打分表靠左的列">
            <InputNumber min={0} precision={0} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item name="enabled" label="启用" valuePropName="checked" style={{ marginBottom: 0 }}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <NextStep to="/admin/ticket-types">票种权重</NextStep>
    </>
  );
}
