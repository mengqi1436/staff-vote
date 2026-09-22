import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Empty,
  Form,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { DownloadOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { TableColumnsType } from 'antd';
import {
  adminApi,
  type TicketAssignment,
  type TicketBatchDto,
  type TicketDto,
  type TicketTypeDto,
} from '../../lib/api.js';
import { usePolling } from '../../lib/usePolling.js';
import { useAuth } from '../../lib/auth.js';
import { useAdminSession } from '../../lib/sessionContext.js';
import { describeError, formatDateTime, splitByWeight } from './lib.js';
import {
  ErrorState,
  LoadingState,
  NextStep,
  PageHeader,
  StaleDataAlert,
  useNotify,
} from './shared.js';

interface GenerateForm {
  ticketTypeId: string;
  count: number;
  /** 选配领码人（可选）：只对表单里选中的票种生效 */
  assignees?: string[];
}

/** 状态不靠颜色单独表意：文字才是表意手段，Tag 颜色只是辅助。 */
const STATUS_META: Record<TicketDto['status'], { text: string; color?: string }> = {
  unused: { text: '未使用' },
  used: { text: '已使用', color: 'success' },
  revoked: { text: '已作废', color: 'error' },
};

type PlanRow = { id: string; count: number; type: TicketTypeDto | undefined };
type CodePairRow = {
  key: number;
  left: { no: number; code: string };
  right: { no: number; code: string };
};

/**
 * 随机码发放与查询（评议工作流「发票与票种」组，第 5 步）。
 *
 * 一码一票：投票人凭码进入投票入口，提交后码即作废。
 * 发码支持两种方式：单票种指定数量，或按启用票种的权重占比一键拆分总数量
 * ——后者是常规操作（保证各票种票数结构与权重一致），因此单独做成一键入口。
 *
 * 随机码是敏感材料：导出按钮旁边常驻提示，不默认全量下载。
 * 新生成的一批码在码表块上做一次 400ms 的浅底淡出（信息性动效：告诉管理员
 * 「这几行是刚加的」），只动 background-color，且尊重 prefers-reduced-motion。
 */
export function AdminTickets() {
  const { token } = theme.useToken();
  const { sessionId } = useAdminSession();

  const loadTicketTypes = useCallback(() => adminApi.ticketTypes.list({ sessionId }), [sessionId]);
  const ticketTypes = usePolling(loadTicketTypes, 0);
  const enabledTypes = (ticketTypes.data ?? []).filter((type) => type.enabled);

  const [status, setStatus] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const loadTickets = useCallback(
    () =>
      adminApi.tickets.list({
        page,
        pageSize,
        status: status || undefined,
        ticketTypeId: typeFilter || undefined,
        sessionId: sessionId ?? undefined,
      }),
    [page, pageSize, status, typeFilter, sessionId],
  );
  const tickets = usePolling(loadTickets, 0);

  /**
   * 当前票种筛选下未使用码的总数：一键作废按钮是否可用、确认框里的 N 都由它决定。
   * pageSize 固定 1 —— 只要 total，不把码真的拉回来。
   */
  const loadUnusedTotal = useCallback(
    () =>
      adminApi.tickets.list({
        status: 'unused',
        ticketTypeId: typeFilter || undefined,
        pageSize: 1,
        sessionId: sessionId ?? undefined,
      }),
    [typeFilter, sessionId],
  );
  const unusedTotal = usePolling(loadUnusedTotal, 0);

  const loadBatches = useCallback(() => adminApi.batches.list({ sessionId }), [sessionId]);
  const batches = usePolling(loadBatches, 0);

  // 该场次职工名单：选配领码人的候选池（列表不按部门过滤——发码人自己按姓名找）
  const loadEmployees = useCallback(
    () => adminApi.employees.list(undefined, sessionId ?? undefined),
    [sessionId],
  );
  const employees = usePolling(loadEmployees, 0);
  const employeeOptions = (employees.data ?? []).map((item) => ({
    value: item.id,
    label: item.employeeNo ? `${item.name}（${item.employeeNo}）` : item.name,
  }));

  const notify = useNotify();
  const { can } = useAuth();
  /** 发码与作废是两条独立权限：各管各的按钮，互不牵连。 */
  const canGenerate = can('tickets.generate');
  const canRevoke = can('tickets.revoke');
  /** 数量还没拿到前不显示「没有未使用码」，避免把加载中误报成没有。 */
  const unusedKnown = unusedTotal.data !== null;
  const unusedCount = unusedTotal.data?.total ?? 0;
  const [form] = Form.useForm<GenerateForm>();
  // 选配领码人只对表单里选中的票种生效：没选票种前先禁用多选框
  const watchedTypeId = Form.useWatch('ticketTypeId', form);
  const [generating, setGenerating] = useState(false);
  const [generatedCodes, setGeneratedCodes] = useState<string[] | null>(null);
  /** 本批码表块的一次性浅底标记：挂载时亮起，下一帧熄灭，由 400ms 过渡淡出。 */
  const [freshCodes, setFreshCodes] = useState(false);

  const [weightOpen, setWeightOpen] = useState(false);
  const [weightTotal, setWeightTotal] = useState(100);
  const [weightGenerating, setWeightGenerating] = useState(false);

  useEffect(() => {
    if (!generatedCodes || generatedCodes.length === 0) {
      setFreshCodes(false);
      return;
    }
    setFreshCodes(true);
    const frame = requestAnimationFrame(() => setFreshCodes(false));
    return () => cancelAnimationFrame(frame);
  }, [generatedCodes]);

  const typeOptions = (ticketTypes.data ?? []).map((type) => ({
    value: type.id,
    label: `${type.name}（${type.code}，权重 ${type.weightPercent}%）${type.enabled ? '' : ' · 已停用'}`,
  }));
  // 发码下拉只列启用票种：直接从 enabledTypes 派生，不对 typeOptions 做 filter+some（O(n²)）
  const enabledTypeOptions = enabledTypes.map((type) => ({
    value: type.id,
    label: `${type.name}（${type.code}，权重 ${type.weightPercent}%）`,
  }));

  const weightPlan = splitByWeight(
    weightTotal,
    enabledTypes.map((type) => ({ id: type.id, weightPercent: type.weightPercent })),
  );
  const planRows: PlanRow[] = weightPlan.map((row) => ({
    id: row.id,
    count: row.count,
    type: enabledTypes.find((type) => type.id === row.id),
  }));

  /** 本次生成的码按两栏排布，便于打印后逐行核对。 */
  const codes = generatedCodes ?? [];
  const codesHalf = Math.ceil(codes.length / 2);
  const codePairs: CodePairRow[] = Array.from({ length: codesHalf }, (_, index) => ({
    key: index,
    left: { no: index + 1, code: codes[index] ?? '' },
    right: { no: index + codesHalf + 1, code: codes[index + codesHalf] ?? '' },
  }));

  const handleGenerate = async (): Promise<void> => {
    let values: GenerateForm;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setGenerating(true);
    try {
      // 选配了领码人时按契约带 assignments：生成时绑定领码人（仅对本次选中的票种生效）
      const assignments: TicketAssignment[] | undefined =
        values.assignees && values.assignees.length > 0
          ? [{ ticketTypeId: values.ticketTypeId, employeeIds: values.assignees }]
          : undefined;
      const result = await adminApi.tickets.generate(values.ticketTypeId, values.count, {
        sessionId: sessionId ?? undefined,
        assignments,
      });
      setGeneratedCodes(result.codes);
      notify.success(`已生成 ${result.count} 个随机码`);
      tickets.refresh();
      batches.refresh();
    } catch (caught) {
      notify.error(describeError(caught));
    } finally {
      setGenerating(false);
    }
  };

  const handleGenerateByWeight = async (): Promise<void> => {
    const rows = planRows.filter((row) => row.count > 0);
    if (!rows.length) {
      notify.error('没有可发放的数量，请先检查票种权重配置');
      return;
    }
    setWeightGenerating(true);
    const made: string[] = [];
    try {
      for (const row of rows) {
        const result = await adminApi.tickets.generate(row.id, row.count, {
          sessionId: sessionId ?? undefined,
        });
        made.push(...result.codes);
      }
      setGeneratedCodes(made);
      setWeightOpen(false);
      notify.success(`已按权重生成 ${made.length} 个随机码`);
      tickets.refresh();
      batches.refresh();
    } catch (caught) {
      // 逐票种调用，可能前面几个票种已经成功了：把已生成的码照样交给管理员，不能丢
      notify.error(`${describeError(caught)}${made.length ? `（已成功生成 ${made.length} 个，请先导出）` : ''}`);
      if (made.length) {
        setGeneratedCodes(made);
        tickets.refresh();
        batches.refresh();
      }
    } finally {
      setWeightGenerating(false);
    }
  };

  const handleRevoke = async (row: TicketDto): Promise<void> => {
    try {
      await adminApi.tickets.revoke(row.id);
      notify.success('该随机码已作废');
      tickets.refresh();
      unusedTotal.refresh();
    } catch (caught) {
      notify.error(describeError(caught));
    }
  };

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkCount, setBulkCount] = useState(0);
  const [bulkPreparing, setBulkPreparing] = useState(false);
  const [bulkRevoking, setBulkRevoking] = useState(false);

  /**
   * 打开一键作废确认框。
   *
   * 数量必须当场向库里问一次：列表的 total 带着当前状态筛选（可能是「已使用」），
   * 轮询缓存也可能已经过期 —— 确认框上的 N 是管理员点「确认作废」的唯一依据，
   * 报错一个数就是一次误操作。
   */
  const openBulkConfirm = async (): Promise<void> => {
    setBulkPreparing(true);
    try {
      const page = await adminApi.tickets.list({
        status: 'unused',
        ticketTypeId: typeFilter || undefined,
        pageSize: 1,
        sessionId: sessionId ?? undefined,
      });
      setBulkCount(page.total);
      setBulkOpen(true);
    } catch (caught) {
      notify.error(describeError(caught));
    } finally {
      setBulkPreparing(false);
    }
  };

  const handleRevokeBulk = async (): Promise<void> => {
    setBulkRevoking(true);
    try {
      const result = await adminApi.tickets.revokeBulk(typeFilter || undefined, sessionId ?? undefined);
      setBulkOpen(false);
      notify.success(`已作废 ${result.revoked} 张`);
      // 码列表、未使用数量、票种统计都变了，一起刷新
      tickets.refresh();
      unusedTotal.refresh();
      ticketTypes.refresh();
    } catch (caught) {
      notify.error(describeError(caught));
    } finally {
      setBulkRevoking(false);
    }
  };

  const ticketColumns: TableColumnsType<TicketDto> = [
    {
      title: '随机码',
      dataIndex: 'code',
      width: 132,
      render: (value: string) => <span className="tabular">{value}</span>,
    },
    {
      title: '票种',
      key: 'ticketType',
      width: 160,
      render: (_: unknown, row: TicketDto) => `${row.ticketType.name}（${row.ticketType.code}）`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (value: TicketDto['status']) => (
        <Tag color={STATUS_META[value].color}>{STATUS_META[value].text}</Tag>
      ),
    },
    {
      title: '生成时间',
      dataIndex: 'createdAt',
      width: 150,
      render: (value: string) => <span className="tabular">{formatDateTime(value)}</span>,
    },
    {
      title: '使用时间',
      dataIndex: 'usedAt',
      width: 150,
      render: (value: string | null) => <span className="tabular">{formatDateTime(value)}</span>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 88,
      fixed: 'right',
      render: (_: unknown, row: TicketDto) =>
        row.status !== 'unused' ? (
          <Typography.Text type="secondary">-</Typography.Text>
        ) : canRevoke ? (
          <Popconfirm
            title="作废该随机码？"
            description="作废后无法再用于登录投票。"
            okText="作废"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => void handleRevoke(row)}
          >
            <Button size="small" type="link" danger style={{ padding: 0 }}>
              作废
            </Button>
          </Popconfirm>
        ) : (
          // 无权限时整列不消失（否则表格看起来缺列），改为禁用并说明原因
          <Tooltip title="无「作废随机码（单张与一键）」权限">
            <Button size="small" type="link" danger disabled style={{ padding: 0 }}>
              作废
            </Button>
          </Tooltip>
        ),
    },
  ];

  const batchColumns: TableColumnsType<TicketBatchDto> = [
    {
      title: '批次号',
      dataIndex: 'id',
      width: 108,
      render: (value: string) => <span className="tabular">{value.slice(0, 8)}</span>,
    },
    {
      title: '票种',
      key: 'ticketType',
      width: 180,
      render: (_: unknown, row: TicketBatchDto) => `${row.ticketType.name}（${row.ticketType.code}）`,
    },
    {
      title: '数量',
      dataIndex: 'count',
      width: 96,
      align: 'right',
      render: (value: number) => <span className="tabular">{value} 张</span>,
    },
    { title: '操作人', dataIndex: 'operator', width: 140 },
    {
      title: '发放时间',
      dataIndex: 'createdAt',
      width: 150,
      render: (value: string) => <span className="tabular">{formatDateTime(value)}</span>,
    },
  ];

  const planColumns: TableColumnsType<PlanRow> = [
    {
      title: '票种',
      key: 'name',
      render: (_: unknown, row: PlanRow) =>
        row.type ? `${row.type.name}（${row.type.code}）` : row.id,
    },
    {
      title: '权重',
      key: 'weight',
      width: 84,
      align: 'right',
      render: (_: unknown, row: PlanRow) =>
        row.type ? <span className="tabular">{row.type.weightPercent}%</span> : '-',
    },
    {
      title: '将发放',
      dataIndex: 'count',
      width: 96,
      align: 'right',
      render: (value: number) => <span className="tabular">{value} 张</span>,
    },
  ];

  /** 本批码表：两栏「序号 + 随机码」，等宽字体便于逐行核对。 */
  const codePairColumns: TableColumnsType<CodePairRow> = [
    {
      title: '№',
      key: 'leftNo',
      width: 56,
      align: 'right',
      render: (_: unknown, row: CodePairRow) => <span className="tabular">{row.left.no}</span>,
    },
    {
      title: '随机码',
      key: 'leftCode',
      render: (_: unknown, row: CodePairRow) => <span className="tabular">{row.left.code}</span>,
    },
    {
      title: '№',
      key: 'rightNo',
      width: 56,
      align: 'right',
      render: (_: unknown, row: CodePairRow) =>
        row.right.code ? <span className="tabular">{row.right.no}</span> : '',
    },
    {
      title: '随机码',
      key: 'rightCode',
      render: (_: unknown, row: CodePairRow) => <span className="tabular">{row.right.code}</span>,
    },
  ];

  const codesTab = (
    <>
      <Card
        title="批量发码"
        extra={<Typography.Text type="secondary">单位：张</Typography.Text>}
        style={{ marginBottom: 16 }}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>单票种单次最多发放 2000 个，超过请分多次发放，或改用「按权重一键发码」按权重拆分。</li>
              <li>可选「选配领码人」：按票别勾选本场次职工后，生成的随机码绑定领码人，概览页可见已投票人员名单。</li>
              <li>生成的码即刻生效，可在下方随机码明细中按状态核对；请及时导出或打印发放给投票人。</li>
              <li>一码一票：一个码只能登录一次、只评一个部门，提交即核销，不可修改。</li>
            </ul>
          }
        />
        <Form<GenerateForm> form={form} layout="inline" onFinish={() => void handleGenerate()}>
          <Form.Item name="ticketTypeId" rules={[{ required: true, message: '请选择票种' }]}>
            <Select
              style={{ width: 300 }}
              placeholder="选择票种"
              aria-label="选择票种"
              options={enabledTypeOptions}
              loading={ticketTypes.loading}
            />
          </Form.Item>
          <Form.Item name="count" rules={[{ required: true, message: '请输入数量' }]} initialValue={100}>
            <InputNumber min={1} max={2000} precision={0} placeholder="数量" style={{ width: 140 }} />
          </Form.Item>
          {canGenerate ? (
            <Form.Item
              name="assignees"
              label="选配领码人"
              extra="可选。按票别勾选本场次职工后，生成的随机码将绑定领码人；不勾选即匿名发码。"
            >
              <Select
                mode="multiple"
                style={{ minWidth: 320 }}
                placeholder="按票别选配职工（可选）"
                aria-label="选配领码人"
                options={employeeOptions}
                disabled={!watchedTypeId}
                loading={employees.loading}
                maxTagCount="responsive"
                allowClear
              />
            </Form.Item>
          ) : null}
          {canGenerate ? (
            <>
              <Form.Item>
                <Button type="primary" htmlType="submit" loading={generating}>
                  生成随机码
                </Button>
              </Form.Item>
              <Form.Item>
                <Button
                  icon={<ThunderboltOutlined />}
                  disabled={!enabledTypes.length}
                  onClick={() => setWeightOpen(true)}
                >
                  按权重一键发码
                </Button>
              </Form.Item>
            </>
          ) : null}
          {canRevoke ? (
            <Form.Item>
              <Button
                danger
                loading={bulkPreparing}
                disabled={!unusedKnown || unusedCount === 0}
                onClick={() => void openBulkConfirm()}
              >
                一键作废未使用码
              </Button>
            </Form.Item>
          ) : null}
          {canRevoke && unusedKnown && unusedCount === 0 ? (
            <Form.Item>
              <Typography.Text type="secondary">当前筛选下没有未使用码</Typography.Text>
            </Form.Item>
          ) : null}
        </Form>
      </Card>

      <Card
        title="随机码明细"
        extra={
          <>
            <Button
              icon={<ReloadOutlined />}
              onClick={tickets.refresh}
              loading={tickets.loading}
              style={{ marginRight: 8 }}
            >
              刷新
            </Button>
            <Button
              icon={<DownloadOutlined />}
              href={adminApi.tickets.exportUrl({
                status: status || undefined,
                ticketTypeId: typeFilter || undefined,
                sessionId: sessionId ?? undefined,
              })}
            >
              导出当前筛选
            </Button>
          </>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>
                状态口径：未使用＝可登录投票；已使用＝已提交并核销，不可恢复；已作废＝人工作废，不可再登录。
              </li>
              <li>一码一票由后端原子核销，前端提示只是提示；已使用与已作废的码都不可恢复。</li>
              <li>
                数据来源：随机码列表接口，按状态与票种筛选后分页返回；作废与发码后自动刷新。
              </li>
              <li>
                导出的 Excel 含完整随机码，属于敏感材料：仅在有发放需要时导出，不要默认全量下载或长期留存。
              </li>
            </ul>
          }
        />

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 12,
            marginBottom: 12,
          }}
        >
          <Typography.Text type="secondary">筛选</Typography.Text>
          <Select
            style={{ width: 140 }}
            value={status}
            aria-label="按状态筛选"
            onChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
            options={[
              { value: '', label: '全部状态' },
              { value: 'unused', label: '未使用' },
              { value: 'used', label: '已使用' },
              { value: 'revoked', label: '已作废' },
            ]}
          />
          <Select
            style={{ width: 200 }}
            value={typeFilter}
            aria-label="按票种筛选"
            onChange={(value) => {
              setTypeFilter(value);
              setPage(1);
            }}
            options={[{ value: '', label: '全部票种' }, ...typeOptions]}
          />
        </div>

        <Table<TicketDto>
          rowKey="id"
          size="small"
          loading={tickets.loading}
          columns={ticketColumns}
          dataSource={tickets.data?.items ?? []}
          pagination={{
            current: page,
            pageSize,
            total: tickets.data?.total ?? 0,
            showSizeChanger: true,
            pageSizeOptions: [20, 50, 100],
            showTotal: (total) => `共 ${total} 个随机码`,
            onChange: (nextPage, nextSize) => {
              setPage(nextPage);
              setPageSize(nextSize);
            },
          }}
          scroll={{ x: 'max-content' }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  tickets.data && tickets.data.total === 0 && !status && !typeFilter
                    ? '还没有发放任何随机码，请在上方批量发码'
                    : '当前筛选条件下没有随机码'
                }
              />
            ),
          }}
        />
      </Card>
    </>
  );

  const batchesTab = (
    <Card
      title="批次一览"
      extra={<Typography.Text type="secondary">单位：张</Typography.Text>}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        description={
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>
              每调用一次发码接口产生一个批次；「按权重一键发码」会为每个票种各生成一个批次，
              因此一次操作可能出现多条记录。
            </li>
            <li>数量为该批次生成的随机码数；操作人取自当前登录管理员，用于审计留痕。</li>
            <li>批次号此处显示前 8 位；发码总数与明细以「随机码」页签为准。</li>
          </ul>
        }
      />
      <Table<TicketBatchDto>
        rowKey="id"
        size="small"
        loading={batches.loading}
        columns={batchColumns}
        dataSource={batches.data ?? []}
        pagination={{ pageSize: 20, showTotal: (total) => `共 ${total} 个批次` }}
        scroll={{ x: 'max-content' }}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="还没有发放批次；每次发码都会在这里留一条记录"
            />
          ),
        }}
      />
    </Card>
  );

  return (
    <>
      <PageHeader
        title="随机码发放"
        description="一码一票：投票人凭码进入投票入口，提交后该码即作废。可作废未使用的码，但已使用与已作废的码不可恢复。"
      />

      {ticketTypes.error && !ticketTypes.data ? (
        <ErrorState error={ticketTypes.error} onRetry={ticketTypes.refresh} />
      ) : null}
      {tickets.error && tickets.data ? (
        <StaleDataAlert error={tickets.error} onRetry={tickets.refresh} />
      ) : null}
      {tickets.error && !tickets.data ? (
        <ErrorState error={tickets.error} onRetry={tickets.refresh} />
      ) : null}

      {!ticketTypes.data && ticketTypes.loading ? (
        <LoadingState />
      ) : (
        <Tabs
          items={[
            { key: 'codes', label: '随机码', children: codesTab },
            { key: 'batches', label: '发放批次', children: batchesTab },
          ]}
        />
      )}

      <NextStep to="/admin/settings">开放时间</NextStep>

      <Modal
        title="按权重一键发码"
        open={weightOpen}
        onCancel={() => setWeightOpen(false)}
        onOk={() => void handleGenerateByWeight()}
        confirmLoading={weightGenerating}
        okText="开始发放"
        cancelText="取消"
      >
        <Typography.Paragraph type="secondary">
          按启用票种的权重占比拆分总数量，各票种数量之和恰好等于总数（余数给小数部分最大的票种）。
        </Typography.Paragraph>
        <Form layout="vertical">
          <Form.Item label="总发放数量">
            <InputNumber
              min={1}
              max={2000}
              precision={0}
              value={weightTotal}
              onChange={(value) => setWeightTotal(value ?? 0)}
              style={{ width: '100%' }}
            />
          </Form.Item>
        </Form>
        <Table<PlanRow>
          rowKey="id"
          size="small"
          columns={planColumns}
          dataSource={planRows}
          pagination={false}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="没有启用的票种，请先到「票种与权重」页配置"
              />
            ),
          }}
        />
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 16 }}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>单次每个票种最多 2000 个；总数超过上限时会被占满上限的票种截断，请分批发放。</li>
              <li>仅启用的票种参与分配，停用票种不计入；票种权重合计为 0 时不会分配出任何码。</li>
            </ul>
          }
        />
      </Modal>

      <Modal
        title="一键作废未使用码"
        open={bulkOpen}
        onCancel={() => setBulkOpen(false)}
        onOk={() => void handleRevokeBulk()}
        confirmLoading={bulkRevoking}
        okText="确认作废"
        cancelText="取消"
        okButtonProps={{ danger: true }}
      >
        <Typography.Paragraph>
          {`将作废当前筛选下 ${bulkCount} 张未使用码；已使用的码不受影响；作废后不可恢复，请确认`}
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          范围：{typeFilter ? '当前筛选的票种' : '全部票种'}；仅「未使用」状态受影响，已使用与已作废的码保持原样。
        </Typography.Paragraph>
      </Modal>

      <Modal
        title="本次生成的随机码"
        open={generatedCodes !== null}
        onCancel={() => setGeneratedCodes(null)}
        footer={
          <Button type="primary" onClick={() => setGeneratedCodes(null)}>
            我已保存
          </Button>
        }
        width={640}
      >
        {generatedCodes ? (
          <>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 16,
                marginBottom: 8,
              }}
            >
              <span>
                本次共生成 <span className="tabular">{generatedCodes.length}</span> 个随机码
              </span>
              <Typography.Text
                copyable={{ text: generatedCodes.join('\n'), tooltips: ['复制全部', '已复制'] }}
                type="secondary"
              >
                复制全部
              </Typography.Text>
            </div>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
              下表按序号排列，便于打印后逐行核对；关闭本窗口后仍可在「随机码明细」中查询、筛选与导出。
            </Typography.Paragraph>
            <div
              style={{
                maxHeight: 360,
                overflow: 'auto',
                // 新生成的一批：浅底 400ms 淡出，只动 background-color（信息性动画）
                backgroundColor: freshCodes ? token.blue1 : 'transparent',
                transition: 'background-color 400ms ease-out',
              }}
            >
              <Table<CodePairRow>
                rowKey="key"
                size="small"
                columns={codePairColumns}
                dataSource={codePairs}
                pagination={false}
              />
            </div>
          </>
        ) : null}
      </Modal>
    </>
  );
}
