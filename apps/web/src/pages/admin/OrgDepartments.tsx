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
import { ApiError, adminApi, type OrgDepartmentDto } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { usePolling } from '../../lib/usePolling.js';
import { describeError, formatDateTime } from './lib.js';
import {
  ErrorState,
  LoadingState,
  PageHeader,
  StaleDataAlert,
  useNotify,
} from './shared.js';

interface OrgDepartmentForm {
  name: string;
  sortOrder: number;
}

/**
 * 全局部门管理（跨场次主数据，路由 /admin/departments）。
 *
 * 与场次工作台里那套「场内部门」不同：本页维护的是单位层面的部门字典，
 * 新建场次时从这里选定部门，场内部门由后端按所选字典自动落一条。
 * 删除被场次引用的部门会被后端拒绝（409 ORG_DEPARTMENT_IN_USE）——
 * 历史场次必须保留它建场时的部门名，停用（不再出现在建场下拉）是唯一安全的下线方式。
 */
export function AdminOrgDepartments() {
  const load = useCallback(() => adminApi.orgDepartments.list(), []);
  const { data, error, loading, refresh } = usePolling(load, 0);
  const notify = useNotify();
  const { can } = useAuth();
  const canWrite = can('departments.write');

  const [form] = Form.useForm<OrgDepartmentForm>();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<OrgDepartmentDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  // 后端 403 的文案要能在界面读出来：页面内用 Alert 摆出来，其余错误仍走全局提示
  const [denied, setDenied] = useState<string | null>(null);

  const departments = data?.departments ?? [];

  const handleFailure = (caught: unknown, fallback = '操作失败，请重试'): void => {
    if (caught instanceof ApiError && caught.status === 403) {
      setDenied(caught.message);
      return;
    }
    // 删除被场次引用（409 ORG_DEPARTMENT_IN_USE）时后端 message 已解释原因，原文透出
    notify.error(describeError(caught, fallback));
  };

  const openCreate = (): void => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ name: '', sortOrder: departments.length + 1 });
    setModalOpen(true);
  };

  const openEdit = (row: OrgDepartmentDto): void => {
    setEditing(row);
    form.setFieldsValue({ name: row.name, sortOrder: row.sortOrder });
    setModalOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    let values: OrgDepartmentForm;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      if (editing) await adminApi.orgDepartments.update(editing.id, values);
      else await adminApi.orgDepartments.create(values);
      notify.success(editing ? '部门已更新' : '部门已创建');
      setModalOpen(false);
      refresh();
    } catch (caught) {
      handleFailure(caught);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (row: OrgDepartmentDto, checked: boolean): Promise<void> => {
    setTogglingId(row.id);
    try {
      await adminApi.orgDepartments.update(row.id, { enabled: checked });
      notify.success(checked ? `已启用「${row.name}」` : `已停用「${row.name}」`);
      refresh();
    } catch (caught) {
      handleFailure(caught);
    } finally {
      setTogglingId(null);
    }
  };

  const handleRemove = async (row: OrgDepartmentDto): Promise<void> => {
    try {
      await adminApi.orgDepartments.remove(row.id);
      notify.success(`已删除「${row.name}」`);
      refresh();
    } catch (caught) {
      handleFailure(caught);
    }
  };

  const columns: TableColumnsType<OrgDepartmentDto> = [
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
      render: (value: boolean, row: OrgDepartmentDto) => (
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
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (value: string) => <span className="tabular">{formatDateTime(value)}</span>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      // 行内操作即使无权限也保留（禁用 + Tooltip）：整列消失会让表格看起来缺列
      render: (_: unknown, row: OrgDepartmentDto) => (
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
                description="若已被场次引用将删除失败，可改用「停用」。"
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
        description="全局部门字典（跨场次复用）：新建场次时从这里选定部门，场内部门随之自动生成。"
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
        <Card title="部门一览" extra={`共 ${departments.length} 个`}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            title="字典口径"
            description={
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                <li>这里维护的是单位层面的部门目录；每个场次实际参评的部门在建场时选定并自动落入该场次。</li>
                <li>删除被场次引用的部门会被拒绝（历史场次要保留它建场时的部门名），此时请改用「停用」。</li>
                <li>停用后不再出现在新建场次的部门下拉中；已建场次不受影响。</li>
                <li>排序数字小的排在前面，决定建场下拉中的顺序。</li>
              </ul>
            }
          />
          <Table<OrgDepartmentDto>
            rowKey="id"
            size="small"
            loading={loading}
            columns={columns}
            dataSource={departments}
            pagination={false}
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: '尚未配置部门，请先新增全局部门，再创建评议场次' }}
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
        <Form<OrgDepartmentForm> form={form} layout="vertical" requiredMark={false}>
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
    </>
  );
}
