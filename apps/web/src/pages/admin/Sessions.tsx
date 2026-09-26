import { useCallback, useState } from 'react';
import {
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Tooltip,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router';
import type { TableColumnsType } from 'antd';
import { adminApi, type AdminSessionDto } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { useAdminSession } from '../../lib/sessionContext.js';
import { usePolling } from '../../lib/usePolling.js';
import { describeError, formatDateTime } from './lib.js';
import { ErrorState, LoadingState, PageHeader, StaleDataAlert, useNotify } from './shared.js';
import {
  formatWindow,
  SESSION_STATUS_META,
  SessionWindowModal,
  sessionActions,
} from './sessionShared.js';

/**
 * 场次管理（评议工作流第 0 步：一场评议一个场次）。
 *
 * 状态机操作与开放窗口编辑弹窗来自 sessionShared（与场次工作台共用，不各写一份）；
 * 本页是列表形态：状态机按钮渲染为小号链接，行内另有「编辑窗口」与「进入工作台」。
 */

interface CreateForm {
  name: string;
}

export function AdminSessions() {
  const load = useCallback(() => adminApi.sessions.list(), []);
  const { data, error, loading, refresh } = usePolling(load, 0);
  const notify = useNotify();
  const { setSessionId } = useAdminSession();
  const { can } = useAuth();
  const navigate = useNavigate();
  const canWrite = can('settings.write');

  const [form] = Form.useForm<CreateForm>();
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  /** 正在流转中的场次 id：只让被操作的行进入 loading，其他行照常可点 */
  const [actingId, setActingId] = useState<string | null>(null);
  /** 正在编辑开放时间窗的场次；null 表示弹窗关闭 */
  const [windowRow, setWindowRow] = useState<AdminSessionDto | null>(null);

  const sessions = data?.sessions ?? [];

  const handleCreate = async (): Promise<void> => {
    let values: CreateForm;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setCreating(true);
    try {
      const result = await adminApi.sessions.create(values.name.trim());
      notify.success(`场次「${result.session.name}」已创建`);
      setCreateOpen(false);
      refresh();
    } catch (caught) {
      notify.error(describeError(caught, '创建场次失败，请重试'));
    } finally {
      setCreating(false);
    }
  };

  /** 流转的统一入口：start 同时承担 draft→voting 与 paused→voting。 */
  const transition = async (row: AdminSessionDto, action: 'start' | 'pause' | 'end'): Promise<void> => {
    setActingId(row.id);
    try {
      const result = await adminApi.sessions[action](row.id);
      notify.success(`场次「${row.name}」${SESSION_STATUS_META[result.session.status].text}`);
      refresh();
    } catch (caught) {
      // 409 INVALID_SESSION_TRANSITION 等错误统一走既有错误提示路径
      notify.error(describeError(caught, '操作失败，请重试'));
    } finally {
      setActingId(null);
    }
  };

  const columns: TableColumnsType<AdminSessionDto> = [
    { title: '场次名称', dataIndex: 'name' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 120,
      render: (value: AdminSessionDto['status']) => (
        <Tag color={SESSION_STATUS_META[value].color}>{SESSION_STATUS_META[value].text}</Tag>
      ),
    },
    {
      title: '开放时间窗',
      key: 'window',
      width: 240,
      render: (_: unknown, row: AdminSessionDto) => (
        <span className="tabular">{formatWindow(row.opensAt, row.closesAt)}</span>
      ),
    },
    {
      title: '开始时间',
      dataIndex: 'startAt',
      width: 160,
      render: (value: string | null) => <span className="tabular">{formatDateTime(value)}</span>,
    },
    {
      title: '结束时间',
      dataIndex: 'endedAt',
      width: 160,
      render: (value: string | null) => <span className="tabular">{formatDateTime(value)}</span>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 320,
      render: (_: unknown, row: AdminSessionDto) => {
        const actions = sessionActions(row.status);
        return (
          <Space size={8} wrap>
            {actions.map((action) =>
              canWrite ? (
                action.confirm ? (
                  <Popconfirm
                    key={action.key}
                    title={action.confirm.title}
                    description={action.confirm.description}
                    okText={action.confirm.okText}
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void transition(row, action.key)}
                  >
                    <Button
                      size="small"
                      type="link"
                      danger={action.danger}
                      style={{ padding: 0 }}
                      loading={actingId === row.id}
                    >
                      {action.label}
                    </Button>
                  </Popconfirm>
                ) : (
                  <Button
                    key={action.key}
                    size="small"
                    type="link"
                    style={{ padding: 0 }}
                    loading={actingId === row.id}
                    onClick={() => void transition(row, action.key)}
                  >
                    {action.label}
                  </Button>
                )
              ) : (
                <Tooltip key={action.key} title="无「修改开放时间与系统设置」权限">
                  <Button
                    size="small"
                    type="link"
                    danger={action.danger}
                    style={{ padding: 0 }}
                    disabled
                  >
                    {action.label}
                  </Button>
                </Tooltip>
              ),
            )}
            <Tooltip title="设为当前场次，后台数据将按该场次展示">
              <Button size="small" type="link" style={{ padding: 0 }} onClick={() => setSessionId(row.id)}>
                设为当前
              </Button>
            </Tooltip>
            {/* 行内操作：无权限时保留但禁用（整列消失会让表格看起来缺列） */}
            {canWrite ? (
              <Button size="small" type="link" style={{ padding: 0 }} onClick={() => setWindowRow(row)}>
                编辑窗口
              </Button>
            ) : (
              <Tooltip title="无「修改开放时间与系统设置」权限">
                <Button size="small" type="link" style={{ padding: 0 }} disabled>
                  编辑窗口
                </Button>
              </Tooltip>
            )}
            <Button size="small" type="link" style={{ padding: 0 }} onClick={() => void navigate(`/admin/sessions/${row.id}`)}>
              进入工作台
            </Button>
          </Space>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="场次管理"
        description="一场评议一个场次：先建场次，再为该场次配置部门、项点、票种并发码。场次结束后不可恢复。"
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>
              刷新
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                form.resetFields();
                setCreateOpen(true);
              }}
            >
              新建场次
            </Button>
          </>
        }
      />

      {error && data ? <StaleDataAlert error={error} onRetry={refresh} /> : null}
      {!data && error ? <ErrorState error={error} onRetry={refresh} /> : null}

      {data ? (
        <Card title="场次一览" extra={`共 ${sessions.length} 个`}>
          <Table<AdminSessionDto>
            rowKey="id"
            size="small"
            loading={loading}
            columns={columns}
            dataSource={sessions}
            pagination={false}
            scroll={{ x: 'max-content' }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="还没有场次，请点击右上角「新建场次」开始"
                />
              ),
            }}
          />
        </Card>
      ) : loading ? (
        <LoadingState />
      ) : null}

      <Modal
        title="新建场次"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void handleCreate()}
        confirmLoading={creating}
        okText="创建"
        cancelText="取消"
        destroyOnHidden
      >
        <Form<CreateForm> form={form} layout="vertical" requiredMark={false}>
          <Form.Item
            name="name"
            label="场次名称"
            rules={[{ required: true, message: '请输入场次名称' }]}
            extra="例如：内设机构、安顺车站、贵阳西车站"
          >
            <Input placeholder="请输入场次名称" maxLength={64} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 开放时间窗编辑弹窗：与场次工作台页头共用同一组件 */}
      <SessionWindowModal
        session={windowRow}
        open={windowRow !== null}
        onClose={() => setWindowRow(null)}
        onSaved={() => refresh()}
      />
    </>
  );
}
