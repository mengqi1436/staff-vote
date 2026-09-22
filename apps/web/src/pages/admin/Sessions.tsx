import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
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
  Typography,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { TableColumnsType } from 'antd';
import { adminApi, type AdminSessionDto } from '../../lib/api.js';
import { useAdminSession } from '../../lib/sessionContext.js';
import { usePolling } from '../../lib/usePolling.js';
import { describeError, EMPTY_TEXT, formatDateTime } from './lib.js';
import { ErrorState, LoadingState, PageHeader, StaleDataAlert, useNotify } from './shared.js';

/**
 * 场次管理（评议工作流第 0 步：一场评议一个场次）。
 *
 * 状态机：draft → voting → paused ⇄ voting → ended（终态，不可逆）。
 * - draft：开始投票；voting：暂停 / 结束；paused：继续 / 结束；ended：无操作。
 * - paused → voting 也走 start 接口（「继续投票」）。
 * 非法流转后端返回 409 INVALID_SESSION_TRANSITION，走统一的 describeError 错误提示路径。
 * 后端负责真正的状态机校验，前端按钮显隐只是体验层。
 */

/** 状态不靠颜色单独表意：文字才是表意手段，Tag 颜色只是辅助。 */
const STATUS_META: Record<AdminSessionDto['status'], { text: string; color?: string }> = {
  draft: { text: '未开始' },
  voting: { text: '投票中', color: 'success' },
  paused: { text: '已暂停', color: 'warning' },
  ended: { text: '已结束' },
};

/** 各状态下的操作按钮：返回 undefined 表示该状态没有可用操作（ended 终态）。 */
function statusActions(
  status: AdminSessionDto['status'],
  handlers: {
    onStart: () => void;
    onPause: () => void;
    onEnd: () => void;
    busy: boolean;
  },
): Array<{ key: string; node: ReactNode }> {
  switch (status) {
    case 'draft':
      return [{ key: 'start', node: <Button size="small" type="link" style={{ padding: 0 }} loading={handlers.busy} onClick={handlers.onStart}>开始投票</Button> }];
    case 'voting':
      return [
        { key: 'pause', node: <Button size="small" type="link" style={{ padding: 0 }} loading={handlers.busy} onClick={handlers.onPause}>暂停投票</Button> },
        {
          key: 'end',
          node: (
            <Popconfirm
              title="结束本场投票？"
              description="结束后不可恢复，本场次将无法再接收投票。"
              okText="结束投票"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={handlers.onEnd}
            >
              <Button size="small" type="link" danger style={{ padding: 0 }} loading={handlers.busy}>
                结束投票
              </Button>
            </Popconfirm>
          ),
        },
      ];
    case 'paused':
      return [
        { key: 'start', node: <Button size="small" type="link" style={{ padding: 0 }} loading={handlers.busy} onClick={handlers.onStart}>继续投票</Button> },
        {
          key: 'end',
          node: (
            <Popconfirm
              title="结束本场投票？"
              description="结束后不可恢复，本场次将无法再接收投票。"
              okText="结束投票"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={handlers.onEnd}
            >
              <Button size="small" type="link" danger style={{ padding: 0 }} loading={handlers.busy}>
                结束投票
              </Button>
            </Popconfirm>
          ),
        },
      ];
    case 'ended':
      return [];
  }
}

interface CreateForm {
  name: string;
}

export function AdminSessions() {
  const load = useCallback(() => adminApi.sessions.list(), []);
  const { data, error, loading, refresh } = usePolling(load, 0);
  const notify = useNotify();
  const { setSessionId } = useAdminSession();

  const [form] = Form.useForm<CreateForm>();
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  /** 正在流转中的场次 id：只让被操作的行进入 loading，其他行照常可点 */
  const [actingId, setActingId] = useState<string | null>(null);

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
      notify.success(`场次「${row.name}」${STATUS_META[result.session.status].text}`);
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
        <Tag color={STATUS_META[value].color}>{STATUS_META[value].text}</Tag>
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
      width: 200,
      render: (_: unknown, row: AdminSessionDto) => {
        const actions = statusActions(row.status, {
          busy: actingId === row.id,
          onStart: () => void transition(row, 'start'),
          onPause: () => void transition(row, 'pause'),
          onEnd: () => void transition(row, 'end'),
        });
        if (actions.length === 0) return <Typography.Text type="secondary">{EMPTY_TEXT}</Typography.Text>;
        return (
          <Space size={8}>
            {actions.map((action) => (
              <span key={action.key}>{action.node}</span>
            ))}
            <Tooltip title="设为当前场次，后台数据将按该场次展示">
              <Button size="small" type="link" style={{ padding: 0 }} onClick={() => setSessionId(row.id)}>
                设为当前
              </Button>
            </Tooltip>
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
    </>
  );
}
