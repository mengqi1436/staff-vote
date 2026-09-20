import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
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
  Upload,
} from 'antd';
import { PlusOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import type { TableColumnsType } from 'antd';
import { ApiError, adminApi, type EmployeeDto, type ImportFeedback } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { usePolling } from '../../lib/usePolling.js';
import { EMPTY_TEXT, describeError } from './lib.js';
import {
  ErrorState,
  LoadingState,
  NextStep,
  PageHeader,
  StaleDataAlert,
  useNotify,
} from './shared.js';

interface EmployeeForm {
  name: string;
  employeeNo: string;
  sortOrder: number;
}

const IMPORT_ERROR_COLUMNS: TableColumnsType<{ row: number; message: string }> = [
  {
    title: '文件行号',
    dataIndex: 'row',
    width: 110,
    align: 'right',
    className: 'tabular',
  },
  { title: '未导入的原因', dataIndex: 'message' },
];

/**
 * 职工名单（打分表的行，评议工作流第 2 步），按部门维护。
 *
 * 名单来源：后台手工维护 + Excel/CSV 导入（外部人事接口本期不对接）。
 * employeeNo 是将来对接外部接口时按 upsert 的键，可选但建议填写。
 * 列约定、行号口径等说明（产品原则 4）用 Alert 保留在导入卡片内。
 */
export function AdminEmployees() {
  const [departmentId, setDepartmentId] = useState('');
  const loadDepartments = useCallback(() => adminApi.departments.list(), []);
  const departments = usePolling(loadDepartments, 0);

  useEffect(() => {
    if (!departmentId && departments.data?.length) {
      setDepartmentId(departments.data[0]?.id ?? '');
    }
  }, [departments.data, departmentId]);

  const loadEmployees = useCallback(
    () => (departmentId ? adminApi.employees.list(departmentId) : Promise.resolve<EmployeeDto[]>([])),
    [departmentId],
  );
  const { data, error, loading, refresh } = usePolling(loadEmployees, 0);

  const notify = useNotify();
  const { can } = useAuth();
  const canWrite = can('employees.write');
  const [form] = Form.useForm<EmployeeForm>();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<EmployeeDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportFeedback | null>(null);
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
    form.setFieldsValue({ name: '', employeeNo: '', sortOrder: (data?.length ?? 0) + 1 });
    setModalOpen(true);
  };

  const openEdit = (row: EmployeeDto): void => {
    setEditing(row);
    form.setFieldsValue({
      name: row.name,
      employeeNo: row.employeeNo ?? '',
      sortOrder: row.sortOrder,
    });
    setModalOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    if (!departmentId) {
      notify.error('请先选择部门');
      return;
    }
    let values: EmployeeForm;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const payload = {
      name: values.name,
      employeeNo: values.employeeNo ? values.employeeNo : null,
      sortOrder: values.sortOrder,
    };
    setSaving(true);
    try {
      if (editing) await adminApi.employees.update(editing.id, payload);
      else await adminApi.employees.create({ departmentId, ...payload });
      notify.success(editing ? '职工信息已更新' : '职工已加入名单');
      setModalOpen(false);
      refresh();
    } catch (caught) {
      handleFailure(caught);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (row: EmployeeDto, checked: boolean): Promise<void> => {
    setTogglingId(row.id);
    try {
      await adminApi.employees.update(row.id, { enabled: checked });
      notify.success(checked ? `已启用「${row.name}」` : `已停用「${row.name}」`);
      refresh();
    } catch (caught) {
      handleFailure(caught);
    } finally {
      setTogglingId(null);
    }
  };

  const handleRemove = async (row: EmployeeDto): Promise<void> => {
    try {
      // 后端是软删除（enabled = false）：历史评分项仍指向该职工，报表不掉行
      await adminApi.employees.remove(row.id);
      notify.success(`已停用「${row.name}」`);
      refresh();
    } catch (caught) {
      handleFailure(caught);
    }
  };

  const handleImport = async (file: File): Promise<void> => {
    setImporting(true);
    try {
      const feedback = await adminApi.employees.import(file);
      notify.success('导入已完成，结果见下方「名单导入」卡片');
      setImportResult(feedback);
      refresh();
      // 名单里的部门名不存在时后端会自动创建，部门下拉需要同步
      departments.refresh();
    } catch (caught) {
      handleFailure(caught, '导入失败，请检查文件格式');
    } finally {
      setImporting(false);
    }
  };

  const columns: TableColumnsType<EmployeeDto> = [
    { title: '姓名', dataIndex: 'name', width: 160 },
    {
      title: '工号',
      dataIndex: 'employeeNo',
      width: 140,
      className: 'tabular',
      render: (value: string | null) => value ?? EMPTY_TEXT,
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
      render: (value: boolean, row: EmployeeDto) => (
        <Space size={8}>
          {/* 无权限时保留开关但禁用：整列消失会让表格看起来缺列，原因用 Tooltip 说明 */}
          <Tooltip title={canWrite ? undefined : '无「职工管理」权限'}>
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
      render: (_: unknown, row: EmployeeDto) => (
        <Space size={0}>
          <Tooltip title={canWrite ? undefined : '无「职工管理」权限'}>
            <span>
              <Button size="small" type="link" disabled={!canWrite} onClick={() => openEdit(row)}>
                编辑
              </Button>
            </span>
          </Tooltip>
          <Tooltip title={canWrite ? undefined : '无「职工管理」权限'}>
            <span>
              <Popconfirm
                title="从名单中移除该职工？"
                description="删除即停用（软删除）：历史评分保留可读，可随时再启用。"
                okText="移除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => void handleRemove(row)}
              >
                <Button size="small" type="link" danger disabled={!canWrite}>
                  移除
                </Button>
              </Popconfirm>
            </span>
          </Tooltip>
        </Space>
      ),
    },
  ];

  const disabledCount = (data ?? []).filter((row) => !row.enabled).length;
  const errors = importResult?.errors ?? [];
  const hasImportResult = importResult !== null;

  return (
    <>
      <PageHeader
        title="职工名单"
        description="名单是打分表的「行」：一个部门一张表，投票人只能给所选部门名单内的职工打分。"
        extra={
          <>
            <Select
              style={{ width: 220 }}
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
                新增职工
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
      ) : null}
      {error && data ? <StaleDataAlert error={error} onRetry={refresh} /> : null}
      {error && !data ? <ErrorState error={error} onRetry={refresh} /> : null}

      {data ? (
        <Card title="本部门名单" extra={`共 ${data.length} 人（含已停用 ${disabledCount} 人）`}>
          {/* 名单口径（产品原则 4）：内容保留，形式改为 Alert */}
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            title="名单口径"
            description={
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                <li>排序数字小的排在打分表上方（行顺序）。</li>
                <li>「停用」的职工不出现在投票入口的打分表，历史评分保留，可随时再启用。</li>
                <li>工号是识别同一个人的键：导入时优先按工号匹配；留空的行按「部门 + 姓名」匹配。</li>
              </ul>
            }
          />
          <Table<EmployeeDto>
            rowKey="id"
            loading={loading}
            columns={columns}
            dataSource={data}
            pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => `共 ${total} 人` }}
            scroll={{ x: 'max-content' }}
            locale={{
              emptyText: departmentId
                ? '该部门名单为空，可手工新增或导入 Excel/CSV'
                : '请先选择部门',
            }}
          />
        </Card>
      ) : loading ? (
        <LoadingState />
      ) : null}

      <Card
        title="名单导入"
        style={{ marginTop: 16 }}
        extra={
          // 主操作：无权限时不渲染导入入口
          canWrite ? (
            <Upload
              accept=".xlsx,.csv"
              showUploadList={false}
              disabled={importing}
              beforeUpload={(file) => {
                void handleImport(file);
                return false; // 阻止 antd 自动上传，由 adminApi.employees.import 处理
              }}
            >
              <Button icon={<UploadOutlined />} loading={importing}>
                导入 Excel/CSV
              </Button>
            </Upload>
          ) : null
        }
      >
        {/* 列约定与导入行为口径（产品原则 4）：内容保留，形式改为 Alert */}
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          title="列顺序固定：部门,姓名,工号（可空）"
          description={
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              <li>支持 .xlsx 与 .csv；首行可以是表头（首列为「部门」或 department 时按表头跳过）。</li>
              <li>第 1 列「部门」必填：后台不存在的部门名会按此名自动创建。</li>
              <li>第 2 列「姓名」必填：职工姓名，最多 64 字。</li>
              <li>第 3 列「工号」可空：有工号按工号匹配；留空按「部门 + 姓名」匹配。</li>
              <li>单行失败不会中断整份文件：其余行照常写入，「失败」行不写入，逐行原因见下方明细表。</li>
              <li>「跳过」指整行为空的行：既不计入新增，也不算失败。</li>
              <li>失败明细里的行号是文件中的行号（从 1 起，含表头行）。</li>
            </ul>
          }
        />

        {hasImportResult ? (
          <>
            <Descriptions
              size="small"
              bordered
              column={{ xs: 2, md: 3 }}
              items={[
                {
                  key: 'total',
                  label: '文件行数',
                  children: <span className="tabular">{importResult.total ?? 0} 行</span>,
                },
                {
                  key: 'created',
                  label: '新增',
                  children: <span className="tabular">{importResult.created ?? 0} 人</span>,
                },
                {
                  key: 'updated',
                  label: '更新',
                  children: <span className="tabular">{importResult.updated ?? 0} 人</span>,
                },
                {
                  key: 'skipped',
                  label: '跳过（空行）',
                  children: <span className="tabular">{importResult.skipped ?? 0} 行</span>,
                },
                {
                  key: 'departmentsCreated',
                  label: '自动创建部门',
                  children: <span className="tabular">{importResult.departmentsCreated ?? 0} 个</span>,
                },
                {
                  key: 'failed',
                  label: '失败',
                  children: <span className="tabular">{errors.length} 行</span>,
                },
              ]}
            />

            {errors.length ? (
              <Table<{ row: number; message: string }>
                rowKey={(item) => `${item.row}-${item.message}`}
                columns={IMPORT_ERROR_COLUMNS}
                dataSource={errors}
                pagination={false}
                scroll={{ y: 240 }}
                style={{ marginTop: 16 }}
              />
            ) : (
              <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>
                本次导入没有失败行。
              </Typography.Paragraph>
            )}
          </>
        ) : (
          <Typography.Text type="secondary">
            尚未导入过名单；导入完成后，新增 / 更新 / 跳过 / 失败的行数会在这里逐项列出。
          </Typography.Text>
        )}
      </Card>

      <Modal
        title={editing ? `编辑职工：${editing.name}` : '新增职工'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Form<EmployeeForm> form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入姓名' }]}>
            <Input placeholder="职工姓名" maxLength={64} />
          </Form.Item>
          <Form.Item name="employeeNo" label="工号" extra="可选，用于将来对接外部人事接口时识别同一个人">
            <Input placeholder="留空表示不填" maxLength={64} />
          </Form.Item>
          <Form.Item name="sortOrder" label="排序" extra="数字小的排在前面" style={{ marginBottom: 0 }}>
            <InputNumber min={0} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <NextStep to="/admin/criteria">评分项点</NextStep>
    </>
  );
}
