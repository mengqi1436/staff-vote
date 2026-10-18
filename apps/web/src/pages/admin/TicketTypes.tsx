import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
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
  Typography,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { TableColumnsType } from 'antd';
import { adminApi, type TicketTypeDto } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { useAdminSession } from '../../lib/sessionContext.js';
import { usePolling } from '../../lib/usePolling.js';
import { describeError, summarizeWeights } from './lib.js';
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
  weightPercent: number;
  sortOrder: number;
  enabled: boolean;
}

/**
 * 人员类别与权重管理（评议工作流「发票与人员类别」组，第 4 步）。
 *
 * 关键约束：启用人员类别的 weightPercent 合计必须恰好为 100，后端保存时会校验。
 * 表格上方用 Alert 常驻合计与差额（达标 success / 不达标 error），
 * 让管理员在提交前就看到还差多少；后端拒绝时的差额错误仍经 message 原文回显。
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

  const summary = summarizeWeights(data ?? []);
  const balanced = summary.diff === 0;
  // 合计与差额说明保持在一句话里、同一个文本节点内：冒烟测试按整句匹配
  const summaryTail = balanced
    ? '符合要求'
    : summary.diff > 0
      ? `还差 ${summary.diff}%`
      : `超出 ${-summary.diff}%`;

  // ---- 权重分配：一次改完所有启用人员类别，再按「先降后升」逐条提交 ----
  const [edits, setEdits] = useState<Record<string, number | null>>({});
  const [savingWeights, setSavingWeights] = useState(false);

  // 列表刷新后丢弃本地草稿：保存失败或他处改动后，界面必须回到库里的实际权重
  useEffect(() => setEdits({}), [data]);

  const enabledRows = (data ?? [])
    .filter((type) => type.enabled)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  /** 该行当前表单里的权重；没改过就用库里的值。清空输入按 0 计（合计必然不达标）。 */
  const weightOf = (row: TicketTypeDto): number =>
    row.id in edits ? (edits[row.id] ?? 0) : row.weightPercent;

  const draftTotal = enabledRows.reduce((sum, row) => sum + weightOf(row), 0);
  const draftDiff = 100 - draftTotal;
  const draftBalanced = draftDiff === 0;
  const draftTail = draftBalanced
    ? '符合要求'
    : draftDiff > 0
      ? `还差 ${draftDiff}%`
      : `超出 ${-draftDiff}%`;

  /**
   * 本次要提交的改动：只含变化的人员类别，按 delta 升序 —— 降权（合计变小，后端恒通过）在前，
   * 升权在后。于是中间每一步的合计都不超过 100%，都不会撞上后端「升权后必须正好 100」的 409。
   */
  const collectChanges = (): Array<{ id: string; next: number }> =>
    enabledRows
      .map((row) => ({ row, next: weightOf(row), delta: weightOf(row) - row.weightPercent }))
      .filter((change) => change.delta !== 0)
      .sort((a, b) => a.delta - b.delta)
      .map((change) => ({ id: change.row.id, next: change.next }));

  const changes = collectChanges();
  const canSaveWeights = canWrite && draftBalanced && changes.length > 0 && !savingWeights;

  /**
   * 一次性保存全部权重改动。
   *
   * 逐条串行 await，不并发：并发会让中间态不可控，可能两条升权同时发出而合计破 100。
   * 中途失败即停，已完成的部分不回滚（后端就是这样设计的），只把已成功项数与后端原文
   * 一起给出；finally 里重新拉一次列表，保证界面与库一致。
   */
  const saveWeights = async (): Promise<void> => {
    if (changes.length === 0) return;
    setSavingWeights(true);
    let done = 0;
    try {
      for (const change of changes) {
        try {
          await adminApi.ticketTypes.update(change.id, { weightPercent: change.next });
        } catch (caught) {
          // 后端 409 的差额文案已含在 message 里，原文透出
          notify.error(`已成功 ${done} 项，第 ${done + 1} 项失败：${describeError(caught)}`);
          return;
        }
        done += 1;
      }
      notify.success(`已保存 ${done} 项权重调整`);
    } finally {
      setSavingWeights(false);
      refresh();
    }
  };

  const openCreate = (): void => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      code: '',
      name: '',
      weightPercent: 0,
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
      weightPercent: row.weightPercent,
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
      // 权重合计不等于 100 时后端会拒绝并回显差额，原文给管理员
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
      // 启停会改变启用人员类别权重合计，后端可能因此拒绝；把后端原文直接给管理员
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
      title: '权重',
      dataIndex: 'weightPercent',
      width: 96,
      align: 'right',
      render: (value: number) => <span className="tabular">{value}%</span>,
    },
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
      render: (value: boolean, row: TicketTypeDto) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Switch
            size="small"
            checked={value}
            loading={togglingId === row.id}
            aria-label={`${row.name} 启用状态`}
            onChange={(checked) => void toggleEnabled(row, checked)}
          />
          {/* 状态用文字表意，不靠 Switch 颜色单独传达 */}
          <Typography.Text type={value ? undefined : 'secondary'}>
            {value ? '启用' : '停用'}
          </Typography.Text>
        </span>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      fixed: 'right',
      render: (_: unknown, row: TicketTypeDto) => (
        <span style={{ display: 'inline-flex', gap: 8 }}>
          <Button size="small" type="link" style={{ padding: 0 }} onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该人员类别？"
            description="删除即停用：已发出的随机码与历史评分保留，可随时再启用。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => void handleRemove(row)}
          >
            <Button size="small" type="link" danger style={{ padding: 0 }}>
              删除
            </Button>
          </Popconfirm>
        </span>
      ),
    },
  ];

  const weightColumns: TableColumnsType<TicketTypeDto> = [
    {
      title: '人员类别',
      dataIndex: 'name',
      render: (_: unknown, row: TicketTypeDto) => (
        <>
          {row.name} <Typography.Text type="secondary">{row.code}</Typography.Text>
        </>
      ),
    },
    {
      title: '权重（%）',
      key: 'weight',
      width: 160,
      render: (_: unknown, row: TicketTypeDto) => (
        <InputNumber
          min={0}
          max={100}
          precision={0}
          suffix="%"
          style={{ width: 120 }}
          aria-label={`${row.name} 计分占比`}
          value={row.id in edits ? edits[row.id] : row.weightPercent}
          onChange={(value) => setEdits((prev) => ({ ...prev, [row.id]: value }))}
        />
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="人员类别与权重"
        description="人员类别决定计分比重：某一人员类别提交的分数在最终得分里占多少。所有启用人员类别的比重加起来必须正好 100%。"
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新增人员类别
            </Button>
          </>
        }
      />

      {error && data ? <StaleDataAlert error={error} onRetry={refresh} /> : null}
      {!data && error ? <ErrorState error={error} onRetry={refresh} /> : null}

      {data ? (
        <>
          <Alert
            type={balanced ? 'success' : 'error'}
            showIcon
            style={{ marginBottom: 16 }}
            title={`启用人员类别权重合计 ${summary.total}%，${summaryTail}`}
            description={`启用 ${summary.enabledCount} 个 · 停用 ${data.length - summary.enabledCount} 个不计入合计；合计正好 100% 才能提交，系统按同一条规则校验。`}
          />

          <Card
            title={
              <HelpLabel help="权重越高，这一人员类别提交的分数对最终得分影响越大。所有启用人员类别的权重加起来必须正好 100%。调整权重需「管理人员类别与权重」权限。改权重时一次改完所有类别再保存：保存时系统先降低、再提高，中途合计不会超过 100%，所以不会触发「合计不得超过 100%」的限制。">
                权重分配
              </HelpLabel>
            }
            style={{ marginBottom: 16 }}
            extra={<Typography.Text type="secondary">合计必须恰好 100%</Typography.Text>}
          >
            <Table<TicketTypeDto>
              rowKey="id"
              size="small"
              columns={weightColumns}
              dataSource={enabledRows}
              pagination={false}
              locale={{
                emptyText: (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="没有启用的人员类别。先在下方一览里启用人员类别，才能分配权重"
                  />
                ),
              }}
            />

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                flexWrap: 'wrap',
                marginTop: 16,
              }}
            >
              <Typography.Text>
                合计 {draftTotal}%，{draftTail}
              </Typography.Text>
              <Typography.Text type="secondary">本次改动 {changes.length} 项</Typography.Text>
              {canWrite ? (
                <Button
                  type="primary"
                  disabled={!canSaveWeights}
                  loading={savingWeights}
                  onClick={() => void saveWeights()}
                >
                  保存权重
                </Button>
              ) : (
                <Typography.Text type="secondary">当前账号只能查看权重</Typography.Text>
              )}
            </div>
          </Card>

          <Card
            title={
              <HelpLabel help="停用的人员类别不计入权重合计、也不参与计分，但已发出的随机码和历史评分都保留，仍可导出。新建人员类别时权重可以先低于 100%，把人员类别建齐后再逐个调整。删除只是停用：历史随机码和评分表都还引用着它，所以列表里永久保留记录。已发＝已经生成多少张随机码；已用＝已经提交投票、用掉了多少张；未用＝已发 − 已用 − 已作废。">
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

        </>
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
            name="weightPercent"
            label={
              <HelpLabel help="比重越高，这类投票人的打分对最终得分影响越大。只有启用的人员类别计入合计，所有启用人员类别的权重加起来要正好 100%。">
                权重（%）
              </HelpLabel>
            }
            rules={[{ required: true, message: '请输入权重' }]}
          >
            <InputNumber min={0} max={100} precision={0} style={{ width: '100%' }} suffix="%" />
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
