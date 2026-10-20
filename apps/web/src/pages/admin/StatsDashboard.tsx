/**
 * 评议统计页（完全重写版）。
 *
 * 版式（ui-ux-pro-max 设计系统 + redesign-preserve 取舍：保留全局浅色
 * Apple 风 token，吸收数据仪表的质感要点）：
 *   1. 概览指标卡组——已提交表单 / 个人汇总 / 车间汇总 / 计算时间 + 刷新；
 *   2. 「各人员类别发放与使用」——发放/使用留痕说明，5 秒轮询（匿名原则下唯一
 *      可见的进度），使用率以细进度条呈现；
 *   3. 「个人打分表评价汇总」「车间打分表评价汇总」——参考样表形态
 *      （docs/附件文件包/参考样表.xlsx）：行 = 被评对象 × 人员类别（A/B/C），
 *      列 = 各评议项目得分 + 1-5合计 + 综合评价得分 + 排序。数据来自
 *      GET /admin/stats/samples，与「结果导出」同一计分说明（lib/scoring.ts）；
 *      重计算不轮询，进入页签加载 + 手动刷新。
 *
 * 版式要点：
 *   - 概览指标卡组新增（旧版只有一句「已提交 N 张」）；
 *   - 名次前三名显示金/银/铜徽标；
 *   - 综合评价得分列主蓝加粗；使用率列附进度条；
 *   - 区块入场 stagger（stats-rise，reduced-motion 全局关停）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Empty, Progress, Skeleton, Table, Typography } from 'antd';
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
import { HelpLabel, StaleDataAlert } from './shared.js';

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

/** 取本评议人员类别统计的共用钩子：评议变化时 fetcher 换新，usePolling 自动重新拉取。 */
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
        <div className="stat-metric-label">已提交打分表</div>
        <div className="stat-metric-value is-accent">{samples?.sheetCount ?? '—'}</div>
        <div className="stat-metric-caption">张 · 全部人员类别合计</div>
      </div>
      <div className="stat-metric-card">
        <div className="stat-metric-label">个人打分表汇总行</div>
        <div className="stat-metric-value">{samples ? personalRows : '—'}</div>
        <div className="stat-metric-caption">被评对象 × 人员类别</div>
      </div>
      <div className="stat-metric-card">
        <div className="stat-metric-label">车间打分表汇总行</div>
        <div className="stat-metric-value">{samples ? workshopRows : '—'}</div>
        <div className="stat-metric-caption">车间 × 人员类别</div>
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

/** 「各人员类别发放与使用」：发放/使用留痕说明，5 秒轮询；使用率附细进度条。 */
function TicketTypeStatsCard({ overview }: { overview: ReturnType<typeof useOverview> }) {
  const { data, error, loading, refresh } = overview;

  const columns: TableColumnsType<TicketTypeStat> = [
    { title: '编码', dataIndex: 'code', width: 84 },
    { title: '人员类别名称', dataIndex: 'name' },
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
      title={
        <HelpLabel help="已发放＝生成出来的随机码数量；已使用＝职工提交打分表用掉的码；已作废＝被作废、不能再用；剩余可用＝已发放 − 已使用 − 已作废；使用率＝已使用 ÷ 已发放（这一类还没发放时记 0%）。某人员类别一张表都没交时，该类不出现在成绩里；各类分别统计，不做跨类合并。">
          各人员类别发放与使用
        </HelpLabel>
      }
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
              description="尚未配置人员类别，请先到本工作台「人员类别」页签配置"
            />
          ),
        }}
      />
    </Card>
  );
}

/** 参考样表两张汇总表共用的列构造：部门 / 被评对象 / 人员类别 / 动态评议项目 / 合计 / 综合 / 排序。 */
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
      title: '人员类别',
      dataIndex: 'ticketCode',
      width: 96,
      render: (value: string) => value,
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

/** 参考样表两张汇总表共用的说明：收进标题旁的「?」。 */
const SAMPLE_HELP =
  '只看已提交的打分表，弃权或没填的格子按 0 分算；某一类人员在一个对象上没有交表，这一行就不会出现。不同人员类别分别统计、不做跨类合并：每行是一个人员类别在一个对象上的成绩，每项得分＝这类人员对该对象的平均分，综合评价得分＝这类人员各项归一化后的等权平均。排序只在同一人员类别内比较，从高到低、同分并列，前三名带徽标。「1-5合计」是各项得分相加，各项满分不一致时只作参考。';

/** 参考样表形态的一张汇总表：personal（被评对象=被评议人列）或 workshop（被评对象=车间）。 */
function SampleStatsCard(props: {
  title: string;
  help: string;
  emptyText: string;
  table: SampleStatTableDto | undefined;
  loading: boolean;
}) {
  const { title, help, emptyText, table, loading } = props;
  const hasRows = (table?.rows.length ?? 0) > 0;
  return (
    <Card
      title={<HelpLabel help={help}>{title}</HelpLabel>}
      extra={<Typography.Text type="secondary">每行：被评对象 × 人员类别 · 按已提交的打分表计算</Typography.Text>}
    >
      {loading && !table ? (
        <Skeleton active paragraph={{ rows: 5 }} title={false} />
      ) : (
        <Table<SampleStatRowDto>
          rowKey={(row) => `${row.departmentId}|${row.voteColumnId}|${row.ticketTypeId}`}
          size="small"
          loading={loading}
          columns={hasRows ? sampleColumns(table!.criteriaNames) : []}
          dataSource={table?.rows ?? []}
          pagination={false}
          scroll={{ x: 'max-content' }}
          locale={{
            emptyText: (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />
            ),
          }}
        />
      )}
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
        <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
          本次评议还没有已提交的打分表，暂时没有可统计的数据。
        </Typography.Text>
      ) : null}

      <div className="stats-section" style={sectionDelay(1)}>
        <TicketTypeStatsCard overview={overview} />
      </div>

      <div className="stats-section" style={sectionDelay(2)}>
        <SampleStatsCard
          title="个人打分表评价汇总"
          help={SAMPLE_HELP}
          emptyText="这类部门还没有已提交的打分表；投票结束后可在这里查看汇总"
          table={samples.data?.personal}
          loading={samples.loading}
        />
      </div>

      <div className="stats-section" style={sectionDelay(3)}>
        <SampleStatsCard
          title="车间打分表评价汇总"
          help={SAMPLE_HELP}
          emptyText="这类部门还没有已提交的打分表；投票结束后可在这里查看汇总"
          table={samples.data?.workshop}
          loading={samples.loading}
        />
      </div>
    </div>
  );
}
