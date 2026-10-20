import { useCallback, useState } from 'react';
import {
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Switch,
  Table,
  Tooltip,
  Typography,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { TableColumnsType } from 'antd';
import { adminApi, type TicketTypeDto } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { useAdminSession } from '../../lib/sessionContext.js';
import { usePolling } from '../../lib/usePolling.js';
import { describeError } from './lib.js';
import {
  ErrorState,
  HelpLabel,
  LoadingState,
  PageHeader,
  StaleDataAlert,
  useNotify,
} from './shared.js';

interface TicketTypeForm {
  code: string;
  name: string;
  sortOrder: number;
  enabled: boolean;
}

/** 无写权限时行内操作与启用开关的理由文案（disabled + Tooltip）。 */
const NO_WRITE_TIP = '无「管理人员类别」权限';

/**
 * 人员类别管理（评议工作流「发票与人员类别」组，第 4 步）。
 *
 * 人员类别只决定「发哪一种随机码」：一码一票，码按类别分别发放。
 * 类别不再有计分占比，也不参与任何计分折算。
 */
export function AdminTicketTypes() {
  const { sessionId } = useAdminSession();
  const load = useCallback(() => adminApi.ticketTypes.list({ sessionId }), [sessionId]);
  const { data, error, loading, refresh } = usePolling(load, 0);
  const notify = useNotify();
  const { can } = useAuth();
  const canWrite = can('ticketTypes.write');
  const [form] = Form.useForm<TicketTypeForm>();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<TicketTypeDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const openCreate = (): void => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      code: '',
      name: '',
      sortOrder: (data?.length ?? 0) + 1,
      enabled: true,
    });
    setModalOpen(true);
  };

  const openEdit = (row: TicketTypeDto): void => {
    setEditing(row);
    form.setFieldsValue({
      code: row.code,
      name: row.name,
      sortOrder: row.sortOrder,
      enabled: row.enabled,
    });
    setModalOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    let values: TicketTypeForm;
    try {
      values = await form.validateFields();
    } catch {
      return; // 表单校验失败，antd 已在字段下方标红
    }
    setSaving(true);
    try {
      if (editing) await adminApi.ticketTypes.update(editing.id, values);
      else await adminApi.ticketTypes.create(values, sessionId);
      notify.success(editing ? '人员类别已更新' : '人员类别已创建');
      setModalOpen(false);
      refresh();
    } catch (caught) {
      notify.error(describeError(caught));
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (row: TicketTypeDto, checked: boolean): Promise<void> => {
    setTogglingId(row.id);
    try {
      await adminApi.ticketTypes.update(row.id, { enabled: checked });
      notify.success(checked ? `已启用「${row.name}」` : `已停用「${row.name}」`);
      refresh();
    } catch (caught) {
      notify.error(describeError(caught));
    } finally {
      setTogglingId(null);
    }
  };

  const handleRemove = async (row: TicketTypeDto): Promise<void> => {
    try {
      await adminApi.ticketTypes.remove(row.id);
      notify.success(`已停用「${row.name}」`);
      refresh();
    } catch (caught) {
      notify.error(describeError(caught));
    }
  };

  const columns: TableColumnsType<TicketTypeDto> = [
    { title: '编码', dataIndex: 'code', width: 96 },
    { title: '名称', dataIndex: 'name' },
    {
      title: '已发',
      dataIndex: 'issuedCount',
      width: 96,
      align: 'right',
      render: (value: number | undefined) =>
        value === undefined ? '-' : <span className="tabular">{value} 张</span>,
    },
    {
      title: '已用',
      dataIndex: 'usedCount',
      width: 96,
      align: 'right',
      render: (value: number | undefined) =>
        value === undefined ? '-' : <span className="tabular">{value} 张</span>,
    },
    {
      title: '未用',
      dataIndex: 'unusedCount',
      width: 96,
      align: 'right',
      render: (value: number | undefined) =>
        value === undefined ? '-' : <span className="tabular">{value} 张</span>,
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 120,
      render: (value: boolean, row: TicketTypeDto) => {
        const control = (
          <Switch
            size="small"
            checked={value}
            loading={togglingId === row.id}
            disabled={!canWrite}
            aria-label={`${row.name} 启用状态`}
            onChange={(checked) => void toggleEnabled(row, checked)}
          />
        );
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {canWrite ? control : (
              // disabled 的控件不触发鼠标事件，Tooltip 必须包一层可悬停容器
              <Tooltip title={NO_WRITE_TIP}>
                <span>{control}</span>
              </Tooltip>
            )}
            {/* 状态用文字表意，不靠 Switch 颜色单独传达 */}
            <Typography.Text type={value ? undefined : 'secondary'}>
              {value ? '启用' : '停用'}
            </Typography.Text>
          </span>
        );
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      fixed: 'right',
      render: (_: unknown, row: TicketTypeDto) => {
        const actions = (
          <span style={{ display: 'inline-flex', gap: 8 }}>
            <Button
              size="small"
              type="link"
              style={{ padding: 0 }}
              disabled={!canWrite}
              onClick={() => openEdit(row)}
            >
              编辑
            </Button>
            <Popconfirm
              title="删除该人员类别？"
              description="删除即停用：已发出的随机码与历史评分保留，可随时再启用。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              disabled={!canWrite}
              onConfirm={() => void handleRemove(row)}
            >
              <Button size="small" type="link" danger style={{ padding: 0 }} disabled={!canWrite}>
                删除
              </Button>
            </Popconfirm>
          </span>
        );
        // 行内操作保留但禁用并说明原因：整列消失会让表格看起来缺列
        return canWrite ? actions : <Tooltip title={NO_WRITE_TIP}>{actions}</Tooltip>;
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="人员类别"
        description="人员类别决定发放哪一种随机码：一个码只能评一个部门、提交一次。类别只影响发码数量，不参与计分折算。"
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>
              刷新
            </Button>
            {canWrite ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                新增人员类别
              </Button>
            ) : null}
          </>
        }
      />

      {error && data ? <StaleDataAlert error={error} onRetry={refresh} /> : null}
      {!data && error ? <ErrorState error={error} onRetry={refresh} /> : null}

      {data ? (
        <Card
          title={
            <HelpLabel help="停用的人员类别不再用于新的发码，但已发出的随机码和历史评分都保留，仍可导出。删除只是停用：历史随机码和评分表都还引用着它，所以列表里永久保留记录。已发＝已经生成多少张随机码；已用＝已经提交投票、用掉了多少张；未用＝已发 − 已用 − 已作废。">
              人员类别一览
            </HelpLabel>
          }
          extra={<Typography.Text type="secondary">单位：张</Typography.Text>}
        >
          <Table<TicketTypeDto>
            rowKey="id"
            size="small"
            loading={loading}
            columns={columns}
            dataSource={data}
            pagination={false}
            scroll={{ x: 'max-content' }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="尚未配置人员类别。至少需要配置一个人员类别，投票入口才能发码登录"
                />
              ),
            }}
          />
        </Card>
      ) : loading ? (
        <LoadingState />
      ) : null}

      <Modal
        title={editing ? `编辑人员类别：${editing.name}` : '新增人员类别'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Form<TicketTypeForm> form={form} layout="vertical" requiredMark={false}>
          <Form.Item
            name="code"
            label={<HelpLabel help="用于发放和统计时区分人员类别，建议用简短英文或数字，比如 A、B、01。">代码</HelpLabel>}
            rules={[{ required: true, message: '请输入人员类别代码' }]}
          >
            <Input placeholder="例如：A" maxLength={32} />
          </Form.Item>

          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: '请输入人员类别名称' }]}
          >
            <Input placeholder="例如：领导班子" maxLength={64} />
          </Form.Item>

          <Form.Item
            name="sortOrder"
            label={<HelpLabel help="数字小的排在前面，决定列表和发放时的先后顺序。">排序</HelpLabel>}
          >
            <InputNumber min={0} precision={0} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item name="enabled" label="启用" valuePropName="checked" style={{ marginBottom: 0 }}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
