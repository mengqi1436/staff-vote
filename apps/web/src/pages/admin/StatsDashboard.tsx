/**
 * 场次统计页（完全重写版）。
 *
 * 版式（ui-ux-pro-max 设计系统 + redesign-preserve 取舍：保留全局浅色
 * Apple 风 token，吸收数据仪表的质感要点）：
 *   1. 概览指标卡组——已提交表单 / 个人汇总 / 车间汇总 / 计算时间 + 刷新；
 *   2. 「各票种发放与使用」——发放/核销留痕口径，5 秒轮询（匿名原则下唯一
 *      可见的进度），使用率以细进度条呈现；
 *   3. 「个人问卷评价汇总」「车间问卷评价汇总」——参考样表形态
 *      （docs/附件文件包/参考样表.xlsx）：行 = 被评对象 × 票别（A/B/C/ABC汇总），
 *      列 = 各项点得分 + 1-5合计 + 综合评价得分 + 排序。数据来自
 *      GET /admin/stats/samples，与「结果导出」同一计分口径（lib/scoring.ts）；
 *      重计算不轮询，进入页签加载 + 手动刷新。
 *
 * 与旧版（StatsTables.tsx，保留作回滚参考）的差异：
 *   - 概览指标卡组新增（旧版只有一句「已提交 N 张」）；
 *   - 名次前三名显示金/银/铜徽标；「ABC汇总」行浅蓝底加粗（样式首次真正落地）；
 *   - 综合评价得分列主蓝加粗；使用率列附进度条；
 *   - 区块入场 stagger（stats-rise，reduced-motion 全局关停）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Empty, Progress, Skeleton, Table, Tag, Tooltip, Typography } from 'antd';
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

/** 区块入场延迟：按出现顺序 60ms 递增的 stagger。 */
function sectionDelay(index: number): React.CSSProperties {
  return { animationDelay: `${index * 60}ms` };
}

/** 排序列：前三名圆徽标（金/银/铜），其余灰字。 */
function RankCell({ rank }: { rank: number }) {
  if (rank >= 1 && rank <= 3) {
    return <span className={`rank-badge rank-${rank}`}>{rank}</span>;
  }
  return <span className="rank-plain">{rank}</span>;
}

/** 计算时间：接口给的 ISO 串转本地时间；解析失败就原样展示。 */
function formatGeneratedAt(value: string | undefined): string {
  if (!value) return '尚未计算';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('zh-CN');
}

/** 使用率＝已使用 ÷ 已发放；还没有发出任何码时记 0，不显示无意义的除式。 */
function usagePercent(issued: number, used: number): number {
  return issued > 0 ? Math.round((used / issued) * 100) : 0;
}

/** 取本场次票种统计的共用钩子：场次变化时 fetcher 换新，usePolling 自动重新拉取。 */
function useOverview() {
  const { sessionId } = useAdminSession();
  const fetchOverview = useCallback(() => adminApi.stats.overview({ sessionId }), [sessionId]);
  return usePolling(fetchOverview, 5000);
}

/** 参考样表统计：进入页签加载一次 + 手动刷新（重计算，不做 5 秒轮询）。 */
function useSamples() {
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

  return { data, loading, error, reload: load };
}

/** 概览指标卡组：四张卡呈现样表统计的全局轮廓，「刷新统计」动作常驻末卡。 */
function OverviewCards(props: {
  samples: StatsSamplesDto | undefined;
  loading: boolean;
  onRefresh: () => void;
}) {
  const { samples, loading, onRefresh } = props;
  const personalRows = samples?.personal.rows.length ?? 0;
  const workshopRows = samples?.workshop.rows.length ?? 0;
  return (
    <div className="stat-card-grid">
      <div className="stat-metric-card">
        <div className="stat-metric-label">已提交表单</div>
        <div className="stat-metric-value is-accent">{samples?.sheetCount ?? '—'}</div>
        <div className="stat-metric-caption">张 · 全部票别合计</div>
      </div>
      <div className="stat-metric-card">
        <div className="stat-metric-label">个人问卷汇总行</div>
        <div className="stat-metric-value">{samples ? personalRows : '—'}</div>
        <div className="stat-metric-caption">被评对象 × 票别</div>
      </div>
      <div className="stat-metric-card">
        <div className="stat-metric-label">车间问卷汇总行</div>
        <div className="stat-metric-value">{samples ? workshopRows : '—'}</div>
        <div className="stat-metric-caption">车间 × 票别</div>
      </div>
      <div className="stat-metric-card">
        <div className="stat-metric-label">计算时间</div>
        <div className="stat-metric-caption" style={{ marginTop: 6 }}>
          {formatGeneratedAt(samples?.generatedAt)}
        </div>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={onRefresh}
          style={{ marginTop: 8 }}
        >
          刷新统计
        </Button>
      </div>
    </div>
  );
}

/** 「各票种发放与使用」：发放/核销留痕口径，5 秒轮询；使用率附细进度条。 */
function TicketTypeStatsCard({ overview }: { overview: ReturnType<typeof useOverview> }) {
  const { data, error, loading, refresh } = overview;

  const columns: TableColumnsType<TicketTypeStat> = [
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
      width: 150,
      align: 'right',
      render: (_: unknown, row: TicketTypeStat) => {
        const percent = usagePercent(row.issued, row.used);
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Progress
              percent={percent}
              size="small"
              showInfo={false}
              style={{ width: 64, marginBottom: 0 }}
            />
            <span className="tabular">{percent}%</span>
          </span>
        );
      },
    },
  ];

  return (
    <Card
      title="各票种发放与使用"
      extra={<Typography.Text type="secondary">单位：张 · 每 5 秒自动刷新</Typography.Text>}
    >
      {error && data ? <StaleDataAlert error={error} onRetry={refresh} /> : null}
      <Table<TicketTypeStat>
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={data?.ticketTypes ?? []}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="尚未配置票种，请先到本工作台「票种权重」页签配置"
            />
          ),
        }}
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

/** 参考样表两张汇总表共用的列构造：部门 / 被评对象 / 票别 / 动态项点 / 合计 / 综合 / 排序。 */
function sampleColumns(criteriaNames: string[]): TableColumnsType<SampleStatRowDto> {
  const criterionColumns: TableColumnsType<SampleStatRowDto> = criteriaNames.map((name, index) => ({
    title: name,
    key: `criterion-${index}`,
    width: 96,
    align: 'right',
    className: 'tabular',
    render: (_: unknown, row: SampleStatRowDto) => row.scores[index] ?? '-',
  }));
  return [
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
      onHeaderCell: () => ({ style: { color: '#0066cc' } }),
      render: (value: number) => <span className="col-comprehensive">{value}</span>,
    },
    {
      title: '排序',
      dataIndex: 'rank',
      width: 72,
      align: 'center',
      render: (rank: number) => <RankCell rank={rank} />,
    },
  ];
}

/** 参考样表形态的一张汇总表：personal（被评对象=被评列）或 workshop（被评对象=车间）。 */
function SampleStatsCard(props: {
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
    >
      {loading && !table ? (
        <Skeleton active paragraph={{ rows: 5 }} title={false} />
      ) : (
        <Table<SampleStatRowDto>
          rowKey={(row) => `${row.departmentId}|${row.voteColumnId}|${row.ticketTypeId ?? 'summary'}`}
          size="small"
          loading={loading}
          columns={hasRows ? sampleColumns(table!.criteriaNames) : []}
          dataSource={table?.rows ?? []}
          pagination={false}
          scroll={{ x: 'max-content' }}
          rowClassName={(row) => (row.ticketTypeId === null ? 'sample-summary-row' : '')}
          locale={{
            emptyText: (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />
            ),
          }}
        />
      )}
      {hasRows ? (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 12 }}>
          口径与「结果导出」一致（弃权、不填视为 0 分；某票别在该对象上没有表时该行不出现）：
          单票别行的项点得分＝该票别对被评对象的均分，综合评价得分＝票别内各项点均分的等权平均；
          「ABC汇总」行的项点得分＝票种加权后的原始分，综合评价得分＝加权归一化后的最终得分；
          排序为综合得分降序、同分并列，前三名以徽标标识。「1-5合计」＝各项点得分之和，项点满分不一致时仅作参考。
        </Typography.Paragraph>
      ) : null}
    </Card>
  );
}

/** 统计页签：概览指标卡 + 发放/使用留痕（5 秒轮询）+ 参考样表统计（按需加载）。 */
export function SessionStats() {
  const overview = useOverview();
  const samples = useSamples();
  const hasAnyRows =
    (samples.data?.personal.rows.length ?? 0) + (samples.data?.workshop.rows.length ?? 0) > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {samples.error ? (
        <Alert
          type="error"
          showIcon
          message={samples.error}
          action={
            <Button size="small" onClick={() => void samples.reload()}>
              重试
            </Button>
          }
        />
      ) : null}

      <div className="stats-section" style={sectionDelay(0)}>
        <OverviewCards samples={samples.data} loading={samples.loading} onRefresh={() => void samples.reload()} />
      </div>

      {!samples.loading && samples.data && !hasAnyRows ? (
        <Alert
          type="info"
          showIcon
          message="本场次还没有已提交的评分表，暂无可计算的统计结果。"
        />
      ) : null}

      <div className="stats-section" style={sectionDelay(1)}>
        <TicketTypeStatsCard overview={overview} />
      </div>

      <div className="stats-section" style={sectionDelay(2)}>
        <SampleStatsCard
          title="个人问卷评价汇总"
          emptyText="该类型部门暂无已提交的评分表；投票结束后可在此查看汇总"
          table={samples.data?.personal}
          loading={samples.loading}
        />
      </div>

      <div className="stats-section" style={sectionDelay(3)}>
        <SampleStatsCard
          title="车间问卷评价汇总"
          emptyText="该类型部门暂无已提交的评分表；投票结束后可在此查看汇总"
          table={samples.data?.workshop}
          loading={samples.loading}
        />
      </div>
    </div>
  );
}
