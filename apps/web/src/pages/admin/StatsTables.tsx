/**
 * 场次统计页签。
 *
 * 三块内容：
 *   1. 「各票种发放与使用」——发放/核销留痕口径，5 秒轮询（匿名原则下唯一可见的进度）；
 *   2. 「个人问卷评价汇总」——参考样表形态（docs/附件文件包/参考样表.xlsx）：
 *      行 = 被评对象 × 票别（A/B/C/ABC汇总），列 = 各项点得分 + 1-5合计 +
 *      综合评价得分 + 排序。数据来自 GET /admin/stats/samples，与「结果导出」
 *      同一计分口径（lib/scoring.ts）；重计算不轮询，进入页签加载 + 手动刷新；
 *   3. 「车间问卷评价汇总」——同上，行 = 车间 × 票别。
 *
 * 「各部门提交进度」表已按需求移除：匿名投票下它揭示各部门回收节奏，
 * 且样表口径的统计只关心已提交表单的计算结果。
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Empty, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import {
  adminApi,
  type SampleStatRowDto,
  type SampleStatTableDto,
  type StatsOverview,
  type StatsSamplesDto,
} from '../../lib/api.js';
import { usePolling } from '../../lib/usePolling.js';
import { useAdminSession } from '../../lib/sessionContext.js';
import { describeError } from './lib.js';
import { StaleDataAlert } from './shared.js';

type TicketTypeStat = StatsOverview['ticketTypes'][number];

/** 表格空态：一句该去哪配置的说明。 */
function emptyRows(text: string) {
  return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={text} />;
}

/** 取本场次统计的共用钩子：场次变化时 fetcher 换新，usePolling 自动重新拉取。 */
function useOverview() {
  const { sessionId } = useAdminSession();
  const fetchOverview = useCallback(() => adminApi.stats.overview({ sessionId }), [sessionId]);
  return usePolling(fetchOverview, 5000);
}

type OverviewState = ReturnType<typeof useOverview>;

/** 使用率＝已使用 ÷ 已发放；还没有发出任何码时记 0，不显示无意义的除式。 */
function usagePercent(issued: number, used: number): number {
  return issued > 0 ? Math.round((used / issued) * 100) : 0;
}

/** 「各票种发放与使用」表（原概览页同名列定义）。 */
export function TicketTypeStatsTable({ overview }: { overview: OverviewState }) {
  const { data, error, loading, refresh } = overview;

  const ticketColumns: TableColumnsType<TicketTypeStat> = [
    { title: '编码', dataIndex: 'code', width: 84 },
    { title: '票种名称', dataIndex: 'name' },
    {
      title: '权重',
      dataIndex: 'weightPercent',
      width: 88,
      align: 'right',
      className: 'tabular',
      render: (value: number) => `${value}%`,
    },
    { title: '已发放', dataIndex: 'issued', width: 96, align: 'right', className: 'tabular' },
    { title: '已使用', dataIndex: 'used', width: 96, align: 'right', className: 'tabular' },
    { title: '剩余可用', dataIndex: 'unused', width: 100, align: 'right', className: 'tabular' },
    { title: '已作废', dataIndex: 'revoked', width: 96, align: 'right', className: 'tabular' },
    {
      title: '使用率',
      key: 'usage',
      width: 92,
      align: 'right',
      className: 'tabular',
      render: (_: unknown, row: TicketTypeStat) => `${usagePercent(row.issued, row.used)}%`,
    },
  ];

  return (
    <Card
      title="各票种发放与使用"
      extra={<Typography.Text type="secondary">单位：张 · 每 5 秒自动刷新</Typography.Text>}
      style={{ marginBottom: 16 }}
    >
      {error && data ? <StaleDataAlert error={error} onRetry={refresh} /> : null}
      <Table<TicketTypeStat>
        rowKey="id"
        size="small"
        loading={loading}
        columns={ticketColumns}
        dataSource={data?.ticketTypes ?? []}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: emptyRows('尚未配置票种，请先到本工作台「票种权重」页签配置') }}
      />
      {/* 口径说明（产品原则 4）：静默文字，不用 Alert 承载常驻提示 */}
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 12 }}>
        已发放＝已生成的随机码总数；已使用＝已提交投票并核销的码；已作废＝人工作废的码，不计入已使用；
        剩余可用＝已发放 − 已使用 − 已作废；使用率＝已使用 ÷ 已发放（已发放为 0 的票种记 0%）。
        计分口径：某票种一张票都没有（零票）时不参与计分，其余实际有票的票种按各自权重归一化后计算，
        因此「权重合计 100%」只在全部启用票种都有票时才完全成立。
      </Typography.Paragraph>
    </Card>
  );
}

/** 参考样表的两张表共用的列构造：部门 / 被评对象 / 票别 / 动态项点 / 合计 / 综合 / 排序。 */
function sampleColumns(
  criteriaNames: string[],
): TableColumnsType<SampleStatRowDto> {
  const criterionColumns: TableColumnsType<SampleStatRowDto> = criteriaNames.map((name, index) => ({
    title: name,
    key: `criterion-${index}`,
    width: 96,
    align: 'right',
    className: 'tabular',
    render: (_: unknown, row: SampleStatRowDto) => row.scores[index] ?? '-',
  }));
  const columns: TableColumnsType<SampleStatRowDto> = [
    { title: '部门', dataIndex: 'departmentName', width: 150 },
    { title: '被评对象', dataIndex: 'targetName', width: 120 },
    {
      title: '票别',
      dataIndex: 'ticketCode',
      width: 96,
      render: (value: string, row: SampleStatRowDto) =>
        row.ticketTypeId === null ? <Tag color="blue">{value}</Tag> : value,
    },
    ...criterionColumns,
    { title: '1-5合计', dataIndex: 'total', width: 96, align: 'right', className: 'tabular' },
    {
      title: '综合评价得分',
      dataIndex: 'comprehensiveScore',
      width: 116,
      align: 'right',
      className: 'tabular',
    },
    { title: '排序', dataIndex: 'rank', width: 72, align: 'right', className: 'tabular' },
  ];
  return columns;
}

/** 参考样表形态的一张汇总表：personal（被评对象=被评列）或 workshop（被评对象=车间）。 */
function SampleStatsTable(props: {
  title: string;
  emptyText: string;
  table: SampleStatTableDto | undefined;
  loading: boolean;
}) {
  const { title, emptyText, table, loading } = props;
  const hasRows = (table?.rows.length ?? 0) > 0;
  return (
    <Card
      title={title}
      extra={<Typography.Text type="secondary">行 = 被评对象 × 票别 · 按已提交表单计算</Typography.Text>}
      style={{ marginBottom: 16 }}
    >
      <Table<SampleStatRowDto>
        rowKey={(row) => `${row.departmentId}|${row.voteColumnId}|${row.ticketTypeId ?? 'summary'}`}
        size="small"
        loading={loading}
        columns={hasRows ? sampleColumns(table!.criteriaNames) : []}
        dataSource={table?.rows ?? []}
        pagination={false}
        scroll={{ x: 'max-content' }}
        rowClassName={(row) => (row.ticketTypeId === null ? 'sample-summary-row' : '')}
        locale={{ emptyText: emptyRows(emptyText) }}
      />
      {hasRows ? (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 12 }}>
          口径与「结果导出」一致（弃权、不填视为 0 分；某票别在该对象上没有表时该行不出现）：
          单票别行的项点得分＝该票别对被评对象的均分，综合评价得分＝票别内各项点均分的等权平均；
          「ABC汇总」行的项点得分＝票种加权后的原始分，综合评价得分＝加权归一化后的最终得分；
          排序为综合得分降序、同分并列。「1-5合计」＝各项点得分之和，项点满分不一致时仅作参考。
        </Typography.Paragraph>
      ) : null}
    </Card>
  );
}

/** 参考样表统计：进入页签加载一次 + 手动刷新（重计算，不做 5 秒轮询）。 */
export function SampleStatsTables() {
  const { sessionId } = useAdminSession();
  const [data, setData] = useState<StatsSamplesDto | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await adminApi.stats.samples({ sessionId }));
    } catch (caught) {
      setError(describeError(caught, '统计计算失败，请重试'));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // 进入页签自动加载一次；之后靠「刷新统计」手动重算（重计算不轮询）
  useEffect(() => {
    void load();
  }, [load]);

  const hasAnyRows =
    (data?.personal.rows.length ?? 0) + (data?.workshop.rows.length ?? 0) > 0;

  return (
    <>
      {error ? (
        <Alert
          type="error"
          showIcon
          message={error}
          action={
            <Button size="small" onClick={() => void load()}>
              重试
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      ) : null}
      <div style={{ marginBottom: 12 }}>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          刷新统计
        </Button>
        <Typography.Text type="secondary" style={{ marginInlineStart: 12 }}>
          按参考样表口径对已提交表单计算{data ? ` · 已提交 ${data.sheetCount} 张` : ''}
        </Typography.Text>
      </div>
      <SampleStatsTable
        title="个人问卷评价汇总"
        emptyText="该类型部门暂无已提交的评分表；投票结束后可在此查看汇总"
        table={data?.personal}
        loading={loading && !data}
      />
      <SampleStatsTable
        title="车间问卷评价汇总"
        emptyText="该类型部门暂无已提交的评分表；投票结束后可在此查看汇总"
        table={data?.workshop}
        loading={loading && !data}
      />
      {!loading && data && !hasAnyRows ? (
        <Alert
          type="info"
          showIcon
          message="本场次还没有已提交的评分表，暂无可计算的统计结果。"
          style={{ marginBottom: 16 }}
        />
      ) : null}
    </>
  );
}

/** 统计页签：发放/使用留痕 5 秒轮询 + 参考样表统计按需加载。 */
export function SessionStats() {
  const overview = useOverview();
  return (
    <>
      <TicketTypeStatsTable overview={overview} />
      <SampleStatsTables />
    </>
  );
}
