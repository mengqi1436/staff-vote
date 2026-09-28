import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App as AntApp,
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
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import type { TableColumnsType } from 'antd';
import {
  adminApi,
  type TicketBatchDto,
  type TicketDto,
  type TicketTypeDto,
} from '../../lib/api.js';
import { usePolling } from '../../lib/usePolling.js';
import { useAuth } from '../../lib/auth.js';
import { useAdminSession } from '../../lib/sessionContext.js';
import { describeError, formatDateTime } from './lib.js';
import {
  ErrorState,
  LoadingState,
  PageHeader,
  StaleDataAlert,
  useNotify,
} from './shared.js';

/** 「不限定（全部部门）」的哨兵值；不用空串——rc-select 对空 value 的选中语义不可靠。 */
const ALL_DEPARTMENTS = '__ALL__';

type CodePairRow = {
  key: number;
  left: { no: number; code: string };
  right: { no: number; code: string };
};

/**
 * 随机码发放与查询（评议工作流「发票与票种」组，第 5 步）。
 *
 * 一码一票：投票人凭码进入投票入口，提交后码即作废。
 * 发码按票种单独进行：选票种、填数量、一次一批，各票种数量自由掌握。
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

  const [typeFilter, setTypeFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // 匿名边界（设计要求第 1 条「不记名投票」）：明细固定只拉未使用的码，
  // 已使用/已作废的码不进入管理员视野 —— 能看到「哪个码已核销」就能反推投票到人。
  const loadTickets = useCallback(
    () =>
      adminApi.tickets.list({
        page,
        pageSize,
        status: 'unused',
        ticketTypeId: typeFilter || undefined,
        sessionId: sessionId ?? undefined,
      }),
    [page, pageSize, typeFilter, sessionId],
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

  // 发码选项：本场次全部启用部门（发码绑定按「启用」口径，停用部门后端也会拒绝）
  const loadDepartments = useCallback(() => adminApi.departments.list({ sessionId }), [sessionId]);
  const departments = usePolling(loadDepartments, 0);

  const notify = useNotify();
  const { modal } = AntApp.useApp();
  const { can } = useAuth();
  /** 发码与作废是两条独立权限：各管各的按钮，互不牵连。 */
  const canGenerate = can('tickets.generate');
  const canRevoke = can('tickets.revoke');
  /** 数量还没拿到前不显示「没有未使用码」，避免把加载中误报成没有。 */
  const unusedKnown = unusedTotal.data !== null;
  const unusedCount = unusedTotal.data?.total ?? 0;
  /** 各票种本批发放数量（票种 id → 张数）；不填 = 该票种本批不发。 */
  const [counts, setCounts] = useState<Record<string, number | undefined>>({});
  /**
   * 本批发码的评议部门：null = 未选（必选，防静默发出万能码）；
   * '__ALL__' 哨兵 = 显式选择「不限定（全部部门）」，提交前还要过一次确认弹窗。
   */
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generatedCodes, setGeneratedCodes] = useState<string[] | null>(null);
  /** 本批码表块的一次性浅底标记：挂载时亮起，下一帧熄灭，由 400ms 过渡淡出。 */
  const [freshCodes, setFreshCodes] = useState(false);

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

  /** 本次生成的码按两栏排布，便于打印后逐行核对。 */
  const codes = generatedCodes ?? [];
  const codesHalf = Math.ceil(codes.length / 2);
  const codePairs: CodePairRow[] = Array.from({ length: codesHalf }, (_, index) => ({
    key: index,
    left: { no: index + 1, code: codes[index] ?? '' },
    right: { no: index + codesHalf + 1, code: codes[index + codesHalf] ?? '' },
  }));

  /** 评议部门选项：显式「不限定」哨兵 + 本场次启用部门（选中「不限定」提交需确认）。 */
  const departmentOptions = [
    { value: ALL_DEPARTMENTS, label: '不限定（全部部门）' },
    ...(departments.data ?? [])
      .filter((dept) => dept.enabled)
      .map((dept) => ({ value: dept.id, label: dept.name })),
  ];

  /** 一次生成所有填了数量的票种；逐票种调用，中途失败时已生成的码照样交给管理员。 */
  const runGenerate = async (deptId: string | undefined): Promise<void> => {
    const rows = enabledTypes
      .map((type) => ({ type, count: counts[type.id] ?? 0 }))
      .filter((row) => row.count > 0);
    if (!rows.length) {
      notify.error('请先在要发放的票种行里填写数量');
      return;
    }
    setGenerating(true);
    const made: string[] = [];
    try {
      for (const row of rows) {
        const result = await adminApi.tickets.generate(row.type.id, row.count, {
          sessionId: sessionId ?? undefined,
          departmentId: deptId,
        });
        made.push(...result.codes);
      }
      setGeneratedCodes(made);
      setCounts({});
      setDepartmentId(null);
      notify.success(`已生成 ${made.length} 个随机码`);
      tickets.refresh();
      batches.refresh();
    } catch (caught) {
      notify.error(`${describeError(caught)}${made.length ? `（已成功生成 ${made.length} 个，请先导出）` : ''}`);
      if (made.length) {
        setGeneratedCodes(made);
        tickets.refresh();
        batches.refresh();
      }
    } finally {
      setGenerating(false);
    }
  };

  /**
   * 发码入口：先过评议部门这道必选闸（防静默发出万能码）。
   * 「不限定」是显式选项，选中提交时再用确认弹窗二次警示，确认后才不带 departmentId。
   */
  const handleGenerate = (): void => {
    if (departmentId === null) {
      notify.error('请先选择本批随机码可评议的部门');
      return;
    }
    if (departmentId === ALL_DEPARTMENTS) {
      modal.confirm({
        title: '不限定部门发码',
        content: '不限定部门发出的随机码可评议全部部门，确认继续？',
        okText: '继续生成',
        cancelText: '取消',
        onOk: () => void runGenerate(undefined),
      });
      return;
    }
    void runGenerate(departmentId);
  };

  const handleRevoke = async (row: TicketDto): Promise<void> => {
    try {
      await adminApi.tickets.revoke(row.id);
      notify.success('该随机码已作废');
      tickets.refresh();
      unusedTotal.refresh();
      ticketTypes.refresh();
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
    // 作废范围必须限定在场次内：没有场次上下文时不发起请求（工作台内不会发生）
    if (!sessionId) {
      notify.error('请先选择场次');
      return;
    }
    setBulkRevoking(true);
    try {
      const result = await adminApi.tickets.revokeBulk(sessionId, typeFilter || undefined);
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

  /**
   * 明细列：只描述「发放对账」需要的信息（码、票种、生成时间、作废操作）。
   *
   * 刻意没有状态列与使用时间列：列表本身只含未使用的码，而单码核销状态的任何
   * 展示都会破坏不记名投票（设计要求第 1 条）—— 使用进度只在「票种使用统计」
   * 里以聚合计数披露。同理不提供行内「导出答卷」：按码取答卷等于按码查投票。
   */
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
      title: '生成时间',
      dataIndex: 'createdAt',
      width: 150,
      render: (value: string) => <span className="tabular">{formatDateTime(value)}</span>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      fixed: 'right',
      render: (_: unknown, row: TicketDto) =>
        canRevoke ? (
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

  /**
   * 票种使用统计列：使用情况只到票种级聚合（已发放/已使用/未使用/已作废），
   * 这是管理员能看到的唯一核销进度口径。
   */
  const typeStatsColumns: TableColumnsType<TicketTypeDto> = [
    {
      title: '票种',
      key: 'name',
      render: (_: unknown, row: TicketTypeDto) => `${row.name}（${row.code}）`,
    },
    {
      title: '已发放',
      key: 'issued',
      width: 110,
      align: 'right',
      render: (_: unknown, row: TicketTypeDto) => (
        <span className="tabular">{row.issuedCount ?? '-'}</span>
      ),
    },
    {
      title: '已使用',
      key: 'used',
      width: 110,
      align: 'right',
      render: (_: unknown, row: TicketTypeDto) => (
        <span className="tabular">{row.usedCount ?? '-'}</span>
      ),
    },
    {
      title: '未使用',
      key: 'unused',
      width: 110,
      align: 'right',
      render: (_: unknown, row: TicketTypeDto) => (
        <span className="tabular">{row.unusedCount ?? '-'}</span>
      ),
    },
    {
      title: '已作废',
      key: 'revoked',
      width: 110,
      align: 'right',
      render: (_: unknown, row: TicketTypeDto) => {
        const revoked =
          row.issuedCount !== undefined && row.usedCount !== undefined && row.unusedCount !== undefined
            ? row.issuedCount - row.usedCount - row.unusedCount
            : null;
        return <span className="tabular">{revoked ?? '-'}</span>;
      },
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
      title: '评议部门',
      key: 'department',
      width: 140,
      render: (_: unknown, row: TicketBatchDto) =>
        row.departmentName ?? <Typography.Text type="secondary">全部部门</Typography.Text>,
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
              <li>几种启用的票种就有几行：在要发放的票种行里填数量，一次生成；留空的行不发。</li>
              <li>评议部门必选：本批随机码只能评议所选部门；如确需不限部门，选择「不限定（全部部门）」并确认。</li>
              <li>生成的码即刻生效，可在下方「未使用随机码」中核对；请及时导出或打印发放给投票人。</li>
              <li>一码一票：一个码只能登录一次、只评一个部门，提交即核销，不可修改；码只能在所属场次使用。</li>
            </ul>
          }
        />
        <Table<TicketTypeDto>
          rowKey="id"
          size="small"
          loading={ticketTypes.loading}
          dataSource={enabledTypes}
          pagination={false}
          columns={[
            {
              title: '票种',
              key: 'name',
              render: (_: unknown, row: TicketTypeDto) =>
                `${row.name}（${row.code} · 权重 ${row.weightPercent}%）`,
            },
            {
              title: '本批发放数量',
              width: 200,
              align: 'right',
              render: (_: unknown, row: TicketTypeDto) => (
                <InputNumber
                  min={0}
                  max={2000}
                  precision={0}
                  value={counts[row.id]}
                  placeholder="不填则不发"
                  aria-label={`「${row.name}」发放数量`}
                  onChange={(value) => setCounts((prev) => ({ ...prev, [row.id]: value ?? undefined }))}
                  style={{ width: 140 }}
                />
              ),
            },
          ]}
          locale={{ emptyText: '没有启用的票种，请先到「票种权重」页签配置' }}
        />
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 8,
            marginTop: 12,
            marginBottom: 12,
          }}
        >
          <Typography.Text>评议部门</Typography.Text>
          <Select
            style={{ width: 260 }}
            placeholder="请选择本批可评议的部门"
            aria-label="评议部门"
            value={departmentId ?? undefined}
            loading={departments.loading}
            onChange={(value) => setDepartmentId(value)}
            options={departmentOptions}
            notFoundContent={departments.loading ? '加载中…' : '本场次还没有启用部门'}
          />
        </div>
        <div style={{ marginTop: 12 }}>
          {canGenerate ? (
            <Button type="primary" loading={generating} onClick={handleGenerate}>
              生成随机码
            </Button>
          ) : null}
          {canRevoke ? (
            <Button
              danger
              loading={bulkPreparing}
              disabled={!unusedKnown || unusedCount === 0}
              onClick={() => void openBulkConfirm()}
              style={{ marginLeft: 8 }}
            >
              一键作废未使用码
            </Button>
          ) : null}
          {canRevoke && unusedKnown && unusedCount === 0 ? (
            <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
              当前筛选下没有未使用码
            </Typography.Text>
          ) : null}
        </div>
      </Card>

      <Card
        title="票种使用统计"
        style={{ marginBottom: 16 }}
        extra={
          <Typography.Text type="secondary">单位：张</Typography.Text>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>
                匿名原则（不记名投票）：单个随机码是否已核销不可查询、不可导出，使用进度只提供票种级汇总。
              </li>
              <li>口径：已发放＝已生成的随机码数；已使用＝已提交投票并核销的码数；已作废＝人工作废的码数；未使用＝已发放 − 已使用 − 已作废。</li>
            </ul>
          }
        />
        <Table<TicketTypeDto>
          rowKey="id"
          size="small"
          loading={ticketTypes.loading}
          columns={typeStatsColumns}
          dataSource={ticketTypes.data ?? []}
          pagination={false}
          locale={{ emptyText: '还没有票种，请先到「票种权重」页签配置' }}
        />
      </Card>

      <Card
        title="未使用随机码"
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
                status: 'unused',
                ticketTypeId: typeFilter || undefined,
                sessionId: sessionId ?? undefined,
              })}
            >
              导出未使用码
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
                本表只显示未使用的码，用于发放对账；已使用与已作废的码不再列出，单码核销状态不可查询。
              </li>
              <li>使用进度只提供票种级汇总，见上方「票种使用统计」——这是匿名投票的硬边界。</li>
              <li>数据来源：未使用随机码列表，按票种筛选后分页显示；发码与作废后自动刷新。</li>
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
                  tickets.data && tickets.data.total === 0 && !typeFilter
                    ? '还没有发放任何随机码，请在上方批量发码'
                    : '当前筛选条件下没有未使用的随机码'
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
            <li>每发放一次随机码产生一个批次，一次操作对应一条批次记录。</li>
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
        description="一码一票：投票人凭码进入投票入口，提交后该码即核销。匿名原则下单码使用状态不可查询，使用进度只提供票种级统计；未使用的码可作废，已核销的码不可恢复。"
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
          {`将作废本场次当前筛选下 ${bulkCount} 张未使用码；已使用的码不受影响；作废后不可恢复，请确认`}
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          范围：本场次{typeFilter ? '当前筛选的票种' : '全部票种'}；仅「未使用」状态受影响，已使用与已作废的码保持原样。
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
                // 新生成的一批：浅底 400ms 淡出，只动 background-color（信息性动画）。
                // 用 colorPrimaryBg 而非固定色板 blue1：高亮跟随主题主色，换成 Apple 蓝后仍是同族浅底。
                backgroundColor: freshCodes ? token.colorPrimaryBg : 'transparent',
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
