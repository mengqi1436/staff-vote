import { useCallback } from 'react';
import { Alert, Button, Card, Col, Empty, Row, Statistic, Table, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { TableColumnsType } from 'antd';
import { Link } from 'react-router';
import { adminApi, type StatsOverview } from '../../lib/api.js';
import { usePolling } from '../../lib/usePolling.js';
import { useAdminSession } from '../../lib/sessionContext.js';
import { formatDateTime, EMPTY_TEXT } from './lib.js';
import {
  ErrorState,
  LoadingState,
  NextStep,
  PageHeader,
  StaleDataAlert,
} from './shared.js';

type TicketTypeStat = StatsOverview['ticketTypes'][number];
type DepartmentStat = StatsOverview['departments'][number];

/** 表格空态：一句该去哪配置的说明。 */
function emptyRows(text: string) {
  return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={text} />;
}

/** 流程步骤卡的小标题（右上角步骤序号）。 */
function StepNo({ n }: { n: number }) {
  return <Typography.Text type="secondary">第 {n} 步</Typography.Text>;
}

/**
 * 概览页 —— 评议流程进度中枢 + 实时票况。
 *
 * 页首按工作流「评议准备 → 发票 → 开放投票 → 结果收尾」排四张可点击的步骤卡，
 * 每张卡展示该步骤的真实数据（全部来自已有的 stats.overview，不加新接口），
 * 点击直达对应页面；第一次组织评议的管理员照着走即可。
 *
 * 需求要求「后台能实时查看到发放票种的情况」，这里用 5 秒轮询 stats.overview。
 * usePolling 是链式 setTimeout，请求慢于间隔时不会堆积；轮询失败保留上一次数据，
 * 只在上方提示条里告知「可能不是最新」，不会把屏幕清空。
 */
export function AdminDashboard() {
  const { sessionId } = useAdminSession();
  // 当前场次变化时 fetchOverview 换新，usePolling 会按新场次重新拉取
  const fetchOverview = useCallback(() => adminApi.stats.overview({ sessionId }), [sessionId]);
  const { data, error, loading, refresh } = usePolling(fetchOverview, 5000);

  if (loading && !data) return <LoadingState rows={6} />;
  if (!data) return <ErrorState error={error ?? new Error('未能获取概览数据')} onRetry={refresh} />;

  const { totals, voteWindow, departments } = data;
  const departmentCount = departments.length;
  const employeeCount = departments.reduce((sum, item) => sum + item.employeeCount, 0);

  /** 使用率＝已使用 ÷ 已发放；还没有发出任何码时记 0，不显示无意义的除式。 */
  const usagePercent = (issued: number, used: number): number =>
    issued > 0 ? Math.round((used / issued) * 100) : 0;

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
    {
      title: '已领码',
      dataIndex: 'assignedCount',
      width: 96,
      align: 'right',
      className: 'tabular',
      // 未做选配的票种不返回该字段：显示「-」而不是误导性的 0
      render: (value: number | undefined) =>
        value === undefined ? EMPTY_TEXT : <span className="tabular">{value}</span>,
    },
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

  const departmentColumns: TableColumnsType<DepartmentStat> = [
    {
      title: '部门',
      dataIndex: 'name',
      render: (value: string, row: DepartmentStat) => (
        <span>
          {value}
          {row.enabled ? null : (
            <Tag style={{ marginInlineStart: 8 }} color="default">
              已停用
            </Tag>
          )}
        </span>
      ),
    },
    { title: '职工数', dataIndex: 'employeeCount', width: 100, align: 'right', className: 'tabular' },
    { title: '已提交', dataIndex: 'sheetCount', width: 100, align: 'right', className: 'tabular' },
    {
      title: '参与率',
      key: 'participation',
      width: 110,
      align: 'right',
      className: 'tabular',
      render: (_: unknown, row: DepartmentStat) =>
        row.employeeCount > 0
          ? `${Math.min(100, Math.round((row.sheetCount / row.employeeCount) * 100))}%`
          : '-',
    },
  ];

  return (
    <>
      <PageHeader
        title="概览"
        description={`每 5 秒自动刷新 · 最后更新 ${formatDateTime(data.generatedAt)}`}
        extra={
          <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>
            立即刷新
          </Button>
        }
      />

      {error ? <StaleDataAlert error={error} onRetry={refresh} /> : null}

      <Card title="评议流程进度" style={{ marginBottom: 16 }}>
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={12} xl={6}>
            <Link to="/admin/departments" className="pressable" style={{ display: 'block' }}>
              <Card size="small" hoverable title="评议准备" extra={<StepNo n={1} />}>
                <Statistic
                  title="部门 / 职工"
                  value={departmentCount}
                  suffix={`个 · ${employeeCount} 人`}
                />
              </Card>
            </Link>
          </Col>

          <Col xs={24} sm={12} xl={6}>
            <Link to="/admin/tickets" className="pressable" style={{ display: 'block' }}>
              <Card size="small" hoverable title="发票" extra={<StepNo n={2} />}>
                <Statistic title="已发放随机码" value={totals.issued} suffix="张" />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  已用 {totals.used} · 剩余 {totals.unused}
                </Typography.Text>
              </Card>
            </Link>
          </Col>

          <Col xs={24} sm={12} xl={6}>
            <Link to="/admin/settings" className="pressable" style={{ display: 'block' }}>
              <Card size="small" hoverable title="开放投票" extra={<StepNo n={3} />}>
                <div style={{ marginBottom: 8 }}>
                  {voteWindow.open ? <Tag color="success">开放中</Tag> : <Tag>未开放</Tag>}
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {voteWindow.startAt ? formatDateTime(voteWindow.startAt) : '开始不限'} ~{' '}
                  {voteWindow.endAt ? formatDateTime(voteWindow.endAt) : '结束不限'}
                </Typography.Text>
              </Card>
            </Link>
          </Col>

          <Col xs={24} sm={12} xl={6}>
            <Link to="/admin/results" className="pressable" style={{ display: 'block' }}>
              <Card size="small" hoverable title="结果收尾" extra={<StepNo n={4} />}>
                <Statistic title="已收到打分表" value={totals.sheets} suffix="张" />
              </Card>
            </Link>
          </Col>
        </Row>
      </Card>

      <Card
        title="各票种发放与使用"
        extra={<Typography.Text type="secondary">单位：张</Typography.Text>}
        style={{ marginBottom: 16 }}
      >
        <Table<TicketTypeStat>
          rowKey="id"
          size="small"
          columns={ticketColumns}
          dataSource={data.ticketTypes}
          pagination={false}
          scroll={{ x: 'max-content' }}
          expandable={{
            // 按票别选配人员发码后，后端返回 usedByAssignee：展开看该票种已投票的领码人名单
            rowExpandable: (row) => (row.usedByAssignee?.length ?? 0) > 0,
            expandedRowRender: (row) => (
              <Typography.Text type="secondary">
                {`已投票人员（${row.usedByAssignee?.length ?? 0} 人）：${
                  row.usedByAssignee?.map((item) => item.employeeName).join('、') ?? EMPTY_TEXT
                }`}
              </Typography.Text>
            ),
          }}
          locale={{ emptyText: emptyRows('尚未配置票种，请先到「票种权重」页配置') }}
        />
      </Card>

      <Card
        title="各部门提交进度"
        extra={<Typography.Text type="secondary">单位：张</Typography.Text>}
        style={{ marginBottom: 16 }}
      >
        <Table<DepartmentStat>
          rowKey="id"
          size="small"
          columns={departmentColumns}
          dataSource={departments}
          pagination={false}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: emptyRows('尚未配置部门，请先到「部门管理」页配置') }}
        />
      </Card>

      <Alert
        type="info"
        showIcon
        title="数据口径说明"
        description={
          <ul style={{ margin: 0, paddingInlineStart: 20 }}>
            <li>本页数据每 5 秒自动刷新一次；刷新失败时保留上一次成功的数据，并在顶部标出「最新一次刷新失败」。</li>
            <li>
              已发放＝已生成的随机码总数；已使用＝已提交投票并核销的码；已作废＝人工作废的码，不计入已使用；
              剩余可用＝已发放 − 已使用 − 已作废；使用率＝已使用 ÷ 已发放（已发放为 0 的票种记 0%）。
            </li>
            <li>
              计分口径：某票种一张票都没有（零票）时不参与计分，其余实际有票的票种按各自权重归一化后计算，
              因此「权重合计 100%」只在全部启用票种都有票时才完全成立。上报成绩以「结果与导出」页的快照为准。
            </li>
            <li>
              开放投票需同时满足三层条件：总开关打开、当前时间不早于开始时间、不晚于结束时间；
              停止或提前结束由后端强制，此处只是提示。
            </li>
            <li>
              参与率＝该部门已提交表数 ÷ 该部门在职职工数（职工数为 0 时记「-」）；
              已提交按打分表计，一码一票，提交即核销，不可修改；停用部门保留历史提交数据，不影响已收表数与导出。
            </li>
          </ul>
        }
        style={{ marginBottom: 8 }}
      />

      <NextStep to="/admin/departments">部门管理</NextStep>
    </>
  );
}
