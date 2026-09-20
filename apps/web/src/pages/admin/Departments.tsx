import { useCallback, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tooltip,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { TableColumnsType } from 'antd';
import { ApiError, adminApi, type DepartmentBrief } from '../../lib/api.js';
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

/** 列表接口除 id/name 外还会带回排序与启停状态（api.ts 的 DepartmentBrief 只声明了最小集）。 */
type DepartmentRow = DepartmentBrief & { sortOrder: number; enabled: boolean };

interface DepartmentForm {
  name: string;
  sortOrder: number;
}

/**
 * 部门管理（评议工作流第 1 步）。
 *
 * 部门是打分表的范围（一码只评一个部门）。已产生评分数据的部门不能物理删除，
 * 后端会返回冲突；因此删除即「停用」（软删除）：停用后历史评分仍可读、
 * 结果页仍可导出，可随时再启用。口径用 Alert 写在表格上方（产品原则 4）。
 */
export function AdminDepartments() {
  const load = useCallback(() => adminApi.departments.list(), []);
  const { data, error, loading, refresh } = usePolling(load, 0);
  const notify = useNotify();
  const { can } = useAuth();
  const canWrite = can('departments.write');

  const [form] = Form.useForm<DepartmentForm>();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<DepartmentRow | null>(null);
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

  const openCreate = (): void => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ name: '', sortOrder: (data?.length ?? 0) + 1 });
    setModalOpen(true);
  };

  const openEdit = (row: DepartmentRow): void => {
    setEditing(row);
    form.setFieldsValue({ name: row.name, sortOrder: row.sortOrder });
    setModalOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    let values: DepartmentForm;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      if (editing) await adminApi.departments.update(editing.id, values);
      else await adminApi.departments.create(values);
      notify.success(editing ? '部门已更新' : '部门已创建');
      setModalOpen(false);
      refresh();
    } catch (caught) {
      handleFailure(caught);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (row: DepartmentRow, checked: boolean): Promise<void> => {
    setTogglingId(row.id);
    try {
      await adminApi.departments.update(row.id, { enabled: checked });
      notify.success(checked ? `已启用「${row.name}」` : `已停用「${row.name}」`);
      refresh();
    } catch (caught) {
      handleFailure(caught);
    } finally {
      setTogglingId(null);
    }
  };

  const handleRemove = async (row: DepartmentRow): Promise<void> => {
    try {
      // 后端是软删除（enabled = false）：部门与历史评分都保留，只是不再出现在投票入口
      await adminApi.departments.remove(row.id);
      notify.success(`已停用「${row.name}」`);
      refresh();
    } catch (caught) {
      handleFailure(caught);
    }
  };

  const columns: TableColumnsType<DepartmentRow> = [
    { title: '部门名称', dataIndex: 'name' },
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
      render: (value: boolean, row: DepartmentRow) => (
        <Space size={8}>
          {/* 无权限时保留开关但禁用：整列消失会让表格看起来缺列，原因用 Tooltip 说明 */}
          <Tooltip title={canWrite ? undefined : '无「部门管理」权限'}>
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
      render: (_: unknown, row: DepartmentRow) => (
        <Space size={0}>
          <Tooltip title={canWrite ? undefined : '无「部门管理」权限'}>
            <span>
              <Button size="small" type="link" disabled={!canWrite} onClick={() => openEdit(row)}>
                编辑
              </Button>
            </span>
          </Tooltip>
          <Tooltip title={canWrite ? undefined : '无「部门管理」权限'}>
            <span>
              <Popconfirm
                title="删除该部门？"
                description="删除即停用（软删除），可随时再启用。"
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

  return (
    <>
      <PageHeader
        title="部门管理"
        description="部门是被评议的集合，同时也是投票时选择的范围（一张票只评一个部门）。"
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>
              刷新
            </Button>
            {/* 主操作：无权限时不渲染，而不是给一个点不动的按钮 */}
            {canWrite ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                新增部门
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

      {error && data ? <StaleDataAlert error={error} onRetry={refresh} /> : null}
      {!data && error ? <ErrorState error={error} onRetry={refresh} /> : null}

      {data ? (
        <Card title="部门一览" extra={`共 ${data.length} 个`}>
          {/* 软删除语义与排序口径（产品原则 4）：内容保留，形式改为 Alert */}
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            title="删除即停用（软删除）"
            description={
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                <li>停用后不再出现在投票入口，历史评分仍可导出，可随时再启用。</li>
                <li>重命名不影响已有评分数据的归属。</li>
                <li>排序数字小的排在前面，决定部门在投票入口与结果页中的顺序。</li>
              </ul>
            }
          />
          <Table<DepartmentRow>
            rowKey="id"
            loading={loading}
            columns={columns}
            dataSource={data}
            pagination={false}
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: '尚未配置部门，请先新增部门再导入职工名单' }}
          />
        </Card>
      ) : loading ? (
        <LoadingState />
      ) : null}

      <Modal
        title={editing ? `编辑部门：${editing.name}` : '新增部门'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Form<DepartmentForm> form={form} layout="vertical" requiredMark={false}>
          <Form.Item
            name="name"
            label="部门名称"
            rules={[{ required: true, message: '请输入部门名称' }]}
          >
            <Input placeholder="例如：办公室" maxLength={64} />
          </Form.Item>
          <Form.Item name="sortOrder" label="排序" extra="数字小的排在前面" style={{ marginBottom: 0 }}>
            <InputNumber min={0} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <NextStep to="/admin/employees">职工名单</NextStep>
    </>
  );
}
