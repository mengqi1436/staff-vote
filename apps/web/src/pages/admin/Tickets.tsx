import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  App as AntApp,
  Button,
  Card,
  Empty,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import type { TableColumnsType } from 'antd';
import {
  adminApi,
  downloadFile,
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
  HelpLabel,
  LoadingState,
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
 * 本次生成的一个码。
 *
 * 必须带人员类别：一次发码可以同时给多个人员类别生成，只记码的字符串会让管理员
 * 面对一堆码却分不清哪个属于哪个人员类别（发错人员类别等于发错权重）。
 */
type GeneratedCode = {
  code: string;
  ticketTypeName: string;
  ticketTypeCode: string;
};

/**
 * 随机码发放与查询（评议工作流「发票与人员类别」组，第 5 步）。
 *
 * 一码一票：投票人凭码进入投票入口，提交后码即作废。
 * 发码按人员类别单独进行：选人员类别、填数量、一次一批，各人员类别数量自由掌握。
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
  // 已使用/已作废的码不进入管理员视野 —— 能看到「哪个码已使用」就能反推投票到人。
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
   * 未使用码总数 = 当前列表的 total（同说明：status=unused + 同一人员类别/评议筛选）。
   *
   * 不要再单独取一次「只要 total」的请求：两个数据源必须手工同步，
   * 漏刷一次就会让「一键作废」按旧值禁用（曾经的线上问题）。
   */
  const unusedKnown = tickets.data !== null;
  const unusedCount = tickets.data?.total ?? 0;

  const loadBatches = useCallback(() => adminApi.batches.list({ sessionId }), [sessionId]);
  const batches = usePolling(loadBatches, 0);

  /**
   * 码数量变化后要一起刷新的数据源。
   *
   * 列表（含未使用总数）、批次、人员类别统计各走各的 usePolling（interval=0，不轮询），
   * 漏刷任何一个都会让页面上的某个计数停在旧值。
   */
  const refreshTicketViews = (): void => {
    tickets.refresh();
    batches.refresh();
    ticketTypes.refresh();
  };

  // 发码选项：本评议全部启用部门（发码绑定按「启用」说明，停用部门后端也会拒绝）
  const loadDepartments = useCallback(() => adminApi.departments.list({ sessionId }), [sessionId]);
  const departments = usePolling(loadDepartments, 0);

  const notify = useNotify();
  const { modal } = AntApp.useApp();
  const { can } = useAuth();
  /** 发码与作废是两条独立权限：各管各的按钮，互不牵连。 */
  const canGenerate = can('tickets.generate');
  const canRevoke = can('tickets.revoke');
  /** 各人员类别本批发放数量（人员类别 id → 张数）；不填 = 该人员类别本批不发。 */
  const [counts, setCounts] = useState<Record<string, number | undefined>>({});
  /**
   * 本批发码的评议部门：null = 未选（必选，防静默发出万能码）；
   * '__ALL__' 哨兵 = 显式选择「不限定（全部部门）」，提交前还要过一次确认弹窗。
   */
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generatedCodes, setGeneratedCodes] = useState<GeneratedCode[] | null>(null);
  /** 本次生成涉及的批次（每个人员类别一个），下载「一列一人员类别」Excel 时按它取码。 */
  const [generatedBatchIds, setGeneratedBatchIds] = useState<string[]>([]);
  const [downloadingGenerated, setDownloadingGenerated] = useState(false);
  const [exporting, setExporting] = useState(false);
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

  /** 本次生成的码按人员类别分组；组内两栏排布，便于按人员类别打印后逐组核对。 */
  const generated = generatedCodes ?? [];
  const codeGroups = useMemo(() => {
    const groups = new Map<string, GeneratedCode[]>();
    for (const item of generated) {
      const label = `${item.ticketTypeName}（${item.ticketTypeCode}）`;
      const list = groups.get(label) ?? [];
      list.push(item);
      groups.set(label, list);
    }
    return [...groups.entries()].map(([label, items]) => {
      const half = Math.ceil(items.length / 2);
      const pairs: CodePairRow[] = Array.from({ length: half }, (_, index) => ({
        key: index,
        left: { no: index + 1, code: items[index]?.code ?? '' },
        right: { no: index + half + 1, code: items[index + half]?.code ?? '' },
      }));
      return { label, items, pairs };
    });
  }, [generated]);

  /** 评议部门选项：显式「不限定」哨兵 + 本评议启用部门（选中「不限定」提交需确认）。 */
  const departmentOptions = [
    { value: ALL_DEPARTMENTS, label: '不限定（全部部门）' },
    ...(departments.data ?? [])
      .filter((dept) => dept.enabled)
      .map((dept) => ({ value: dept.id, label: dept.name })),
  ];

  /** 一次生成所有填了数量的人员类别；逐人员类别调用，中途失败时已生成的码照样交给管理员。 */
  const runGenerate = async (deptId: string | undefined): Promise<void> => {
    const rows = enabledTypes
      .map((type) => ({ type, count: counts[type.id] ?? 0 }))
      .filter((row) => row.count > 0);
    if (!rows.length) {
      notify.error('请先在要发放的人员类别行里填写数量');
      return;
    }
    setGenerating(true);
    const made: GeneratedCode[] = [];
    const batchIds: string[] = [];
    try {
      for (const row of rows) {
        const result = await adminApi.tickets.generate(row.type.id, row.count, {
          sessionId: sessionId ?? undefined,
          departmentId: deptId,
        });
        batchIds.push(result.batchId);
        // 人员类别随码一起带出：后面的分组展示与提示都依赖它
        made.push(
          ...result.codes.map((code) => ({
            code,
            ticketTypeName: row.type.name,
            ticketTypeCode: row.type.code,
          })),
        );
      }
      setGeneratedCodes(made);
      setGeneratedBatchIds(batchIds);
      setCounts({});
      setDepartmentId(null);
      // 提示按人员类别汇总：只报总数会让管理员对不上「哪个人员类别发了多少」
      const byType = new Map<string, number>();
      for (const item of made) {
        const label = `${item.ticketTypeName}（${item.ticketTypeCode}）`;
        byType.set(label, (byType.get(label) ?? 0) + 1);
      }
      const summary = [...byType.entries()].map(([label, count]) => `${label} ${count} 张`).join('，');
      notify.success(`已生成 ${made.length} 个随机码（${summary}）`);
    } catch (caught) {
      notify.error(`${describeError(caught)}${made.length ? `（已成功生成 ${made.length} 个，请先导出）` : ''}`);
      if (made.length) {
        setGeneratedCodes(made);
        setGeneratedBatchIds(batchIds);
      }
    } finally {
      setGenerating(false);
      // 刷新放在 finally：请求抛错不等于后端没写入（超时、响应丢失、网关 502 时
      // 事务可能已提交），只刷新成功路径会让页面与库长期不一致。
      refreshTicketViews();
    }
  };

  /**
   * 导出整场的未使用码清单（行式：码 / 人员类别 / 批次 / 时间）。
   *
   * 与发码结果的「下载 Excel」走同一条下载路径（fetch + 评议名文件名）：
   * 直链 `<a href>` 遇到 401/500 会把错误 JSON 存成 .xlsx，用户只会看到「文件打不开」。
   */
  const handleExportUnused = async (): Promise<void> => {
    setExporting(true);
    try {
      await downloadFile(
        adminApi.tickets.exportUrl({
          ticketTypeId: typeFilter || undefined,
          sessionId: sessionId ?? undefined,
        }),
      );
    } catch (caught) {
      notify.error(describeError(caught, '导出失败，请重试'));
    } finally {
      setExporting(false);
    }
  };

  /**
   * 下载本批发码结果，并结束这次发码。
   *
   * 下载是唯一的收尾动作：不再提供「复制全部」与「我已保存」两步，
   * 取到文件即视为交付完成，弹窗自动关闭（列表已在 runGenerate 里刷新）。
   */
  const handleDownloadGenerated = async (): Promise<void> => {
    if (generatedBatchIds.length === 0) return;
    setDownloadingGenerated(true);
    try {
      await downloadFile(adminApi.tickets.exportByTicketTypeUrl(generatedBatchIds));
      setGeneratedCodes(null);
      notify.success('发码完成，已下载随机码');
    } catch (caught) {
      notify.error(describeError(caught, '下载失败，请重试'));
    } finally {
      setDownloadingGenerated(false);
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
      refreshTicketViews();
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
    // 作废范围必须限定在评议内：没有评议上下文时不发起请求（工作台内不会发生）
    if (!sessionId) {
      notify.error('请先选择评议');
      return;
    }
    setBulkRevoking(true);
    try {
      const result = await adminApi.tickets.revokeBulk(sessionId, typeFilter || undefined);
      setBulkOpen(false);
      notify.success(`已作废 ${result.revoked} 张`);
      refreshTicketViews();
    } catch (caught) {
      notify.error(describeError(caught));
    } finally {
      setBulkRevoking(false);
    }
  };

  /**
   * 明细列：只描述「发放对账」需要的信息（码、人员类别、生成时间、作废操作）。
   *
   * 刻意没有状态列与使用时间列：列表本身只含未使用的码，而单码使用状态的任何
   * 展示都会破坏不记名投票（设计要求第 1 条）—— 使用进度只在「人员类别使用统计」
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
      title: '人员类别',
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
   * 人员类别使用统计列：使用情况只到人员类别级聚合（已发放/已使用/未使用/已作废），
   * 这是管理员能看到的唯一使用进度说明。
   */
  const typeStatsColumns: TableColumnsType<TicketTypeDto> = [
    {
      title: '人员类别',
      key: 'name',
      render: (_: unknown, row: TicketTypeDto) => `${row.name}（${row.code}）`,
    },
    {
      title: '已发放',
      key: 'issued',
      width: 96,
      align: 'right',
      render: (_: unknown, row: TicketTypeDto) => (
        <span className="tabular">{row.issuedCount ?? '-'}</span>
      ),
    },
    {
      title: '已使用',
      key: 'used',
      width: 96,
      align: 'right',
      render: (_: unknown, row: TicketTypeDto) => (
        <span className="tabular">{row.usedCount ?? '-'}</span>
      ),
    },
    {
      title: '未使用',
      key: 'unused',
      width: 96,
      align: 'right',
      render: (_: unknown, row: TicketTypeDto) => (
        <span className="tabular">{row.unusedCount ?? '-'}</span>
      ),
    },
    {
      title: '已作废',
      key: 'revoked',
      width: 96,
      align: 'right',
      render: (_: unknown, row: TicketTypeDto) => {
        const revoked =
          row.issuedCount !== undefined && row.usedCount !== undefined && row.unusedCount !== undefined
            ? // 计算值，数据异常时也不显示负数
              Math.max(0, row.issuedCount - row.usedCount - row.unusedCount)
            : null;
        return <span className="tabular">{revoked ?? '-'}</span>;
      },
    },
  ];

  const batchColumns: TableColumnsType<TicketBatchDto> = [
    {
      title: '人员类别',
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
      width: 110,
      align: 'center',
      render: (value: number) => <span className="tabular">{value} 张</span>,
    },
    { title: '操作人', dataIndex: 'operator', width: 160 },
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

  /**
   * 本批已填数量合计：生成前核对，避免多发或少发。
   * 只累加当前启用的人员类别——停用类别残留的旧输入不会被真的发出去，
   * 合计必须和 runGenerate 实际提交的行保持一致。
   */
  const batchTotal = enabledTypes.reduce((sum, type) => sum + (counts[type.id] ?? 0), 0);

  const codesTab = (
    <>
      <Card
        title={
          <HelpLabel help="启用了几个人员类别就有几行：在要发放的类别行里填数量，一次生成；留空的不发。评议部门必选：这批随机码只能评议所选部门，一个码只评一个部门；确实要评全部部门时，选「不限定（全部部门）」并确认。一个码只能用一次，提交后失效；未使用的码可以作废，已使用的不能恢复。生成的码马上可用，可在下方「未使用随机码」里核对；请及时导出或打印发给职工。">
            批量发码
          </HelpLabel>
        }
        style={{ marginBottom: 24 }}
      >
        {/* 先定范围再填数量：部门是必选项，放在表格之前，与人的填写顺序一致 */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 8,
            marginBottom: 16,
          }}
        >
          <Typography.Text>评议部门（必选）</Typography.Text>
          <Select
            style={{ width: 260 }}
            placeholder="请选择本批可评议的部门"
            aria-label="评议部门"
            value={departmentId ?? undefined}
            loading={departments.loading}
            onChange={(value) => setDepartmentId(value)}
            options={departmentOptions}
            notFoundContent={departments.loading ? '加载中…' : '本次评议还没有启用部门'}
          />
        </div>
        <Table<TicketTypeDto>
          rowKey="id"
          size="small"
          loading={ticketTypes.loading}
          dataSource={enabledTypes}
          pagination={false}
          columns={[
            {
              title: '人员类别',
              key: 'name',
              render: (_: unknown, row: TicketTypeDto) =>
                `${row.name}（${row.code} · 权重 ${row.weightPercent}%）`,
            },
            {
              title: '已发放（张）',
              key: 'issued',
              width: 128,
              align: 'right',
              render: (_: unknown, row: TicketTypeDto) => (
                <span className="tabular">{row.issuedCount ?? '-'}</span>
              ),
            },
            {
              title: '本批发放数量（张）',
              width: 176,
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
                  style={{ width: 120 }}
                />
              ),
            },
          ]}
          locale={{ emptyText: '没有启用的人员类别，请先到「人员类别权重」页签配置' }}
        />
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            marginTop: 16,
          }}
        >
          <Typography.Text
            className="tabular"
            type={batchTotal > 0 ? undefined : 'secondary'}
            strong={batchTotal > 0}
          >
            {batchTotal > 0 ? `本批共 ${batchTotal} 张` : '填写数量后生成'}
          </Typography.Text>
          {canGenerate ? (
            <Button type="primary" loading={generating} onClick={handleGenerate}>
              生成随机码
            </Button>
          ) : null}
        </div>
      </Card>

      <Card
        title={
          <HelpLabel help="只列出还没用过的随机码，用于核对发放；已使用和已作废的码不列出。发放或作废后本表会自动刷新，也可以按人员类别筛选。为保护匿名：查不到也导不出单个随机码是否已被使用，使用情况见下方「人员类别使用统计」。导出的 Excel 含完整随机码，请只在需要发放时导出，用完及时删除，不要长期留存。">
            未使用随机码
          </HelpLabel>
        }
        style={{ marginBottom: 24 }}
        extra={
          <Space size={8}>
            {/* 刷新是次要动作：只留图标，把版面让给导出这个真正的任务 */}
            <Tooltip title="刷新列表">
              <Button
                icon={<ReloadOutlined />}
                aria-label="刷新"
                onClick={refreshTicketViews}
                loading={tickets.loading}
              />
            </Tooltip>
            <Button
              icon={<DownloadOutlined />}
              loading={exporting}
              onClick={() => void handleExportUnused()}
            >
              导出未使用码
            </Button>
          </Space>
        }
      >
        {/* 筛选决定下面列表与「一键作废」的范围，两者放在同一块区域 */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            marginBottom: 16,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Typography.Text type="secondary">筛选</Typography.Text>
            <Select
              style={{ width: 200 }}
              value={typeFilter}
              aria-label="按人员类别筛选"
              onChange={(value) => {
                setTypeFilter(value);
                setPage(1);
              }}
              options={[{ value: '', label: '全部人员类别' }, ...typeOptions]}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {canRevoke && unusedKnown && unusedCount === 0 ? (
              <Typography.Text type="secondary">当前筛选下没有未使用码</Typography.Text>
            ) : null}
            {canRevoke ? (
              <Button
                danger
                loading={bulkPreparing}
                disabled={!unusedKnown || unusedCount === 0}
                onClick={() => void openBulkConfirm()}
              >
                一键作废未使用码
              </Button>
            ) : null}
          </div>
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

      {/* 统计是监控信息，放在发码与核对之后，不打断操作流 */}
      <Card
        title={
          <HelpLabel help="已发放＝生成出来的随机码数量；已使用＝职工提交打分表用掉的码；已作废＝被作废、不能再用；未使用＝已发放 − 已使用 − 已作废；使用率＝已使用 ÷ 已发放。为保护匿名：查不到也导不出单个随机码是否已被使用，使用情况只按人员类别汇总。">
            人员类别使用统计
          </HelpLabel>
        }
        extra={<Typography.Text type="secondary">单位：张</Typography.Text>}
        style={{ marginBottom: 24 }}
      >
        <Table<TicketTypeDto>
          rowKey="id"
          size="small"
          loading={ticketTypes.loading}
          columns={typeStatsColumns}
          dataSource={ticketTypes.data ?? []}
          pagination={false}
          locale={{ emptyText: '还没有人员类别，请先到「人员类别权重」页签配置' }}
        />
      </Card>
    </>
  );

  const batchesTab = (
    <Card
      title={
        <HelpLabel help="每发放一次随机码记一条批次：数量是这批生成的数量，操作人是当时登录的管理员，用于事后核对。">
          批次一览
        </HelpLabel>
      }
    >
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
        <>
          {codesTab}
          {batchesTab}
        </>
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
          {`将作废本评议当前筛选下 ${bulkCount} 张未使用码；已使用的码不受影响；作废后不可恢复，请确认`}
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          范围：本评议{typeFilter ? '当前筛选的人员类别' : '全部人员类别'}；仅「未使用」状态受影响，已使用与已作废的码保持原样。
        </Typography.Paragraph>
      </Modal>

      <Modal
        title="本次生成的随机码"
        open={generatedCodes !== null}
        onCancel={() => setGeneratedCodes(null)}
        destroyOnHidden
        footer={
          <Button
            type="primary"
            icon={<DownloadOutlined />}
            loading={downloadingGenerated}
            disabled={generatedBatchIds.length === 0}
            onClick={() => void handleDownloadGenerated()}
          >
            下载 Excel（每列一个人员类别）
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
                本次共生成 <span className="tabular">{generatedCodes.length}</span> 个随机码，按人员类别分{' '}
                <span className="tabular">{codeGroups.length}</span> 组
              </span>
            </div>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
              按人员类别分组、组内两栏排列，方便打印后逐组核对。点「下载 Excel」后，每列是一个人员类别，
              列下是该类别的随机码，打印后剪开就能分别发放；下载完成本窗口自动关闭，
              之后仍可在「未使用随机码」里按人员类别筛选与导出。
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
              {codeGroups.map((group, index) => (
                <div key={group.label} style={{ marginBottom: index === codeGroups.length - 1 ? 0 : 16 }}>
                  <div style={{ marginBottom: 6 }}>
                    <Typography.Text strong>{group.label}</Typography.Text>
                    <Typography.Text type="secondary" className="tabular">
                      {' '}
                      · {group.items.length} 张
                    </Typography.Text>
                  </div>
                  <Table<CodePairRow>
                    rowKey="key"
                    size="small"
                    columns={codePairColumns}
                    dataSource={group.pairs}
                    pagination={false}
                  />
                </div>
              ))}
            </div>
          </>
        ) : null}
      </Modal>
    </>
  );
}
