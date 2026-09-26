/**
 * 场次统计的两张进度表（原概览页抽出的组件）。
 *
 * 每张表自带取数：按「当前场次」（场次上下文）轮询 stats.overview，
 * 5 秒一轮、失败保留旧数据只提示 —— 与原概览页同一套行为。
 * 口径说明（产品原则 4：结果可复现、可解释）随表保留。
 */
import { useCallback } from 'react';
import { Card, Empty, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { adminApi, type StatsOverview } from '../../lib/api.js';
import { usePolling } from '../../lib/usePolling.js';
import { useAdminSession } from '../../lib/sessionContext.js';
import { EMPTY_TEXT } from './lib.js';
import { StaleDataAlert } from './shared.js';

type TicketTypeStat = StatsOverview['ticketTypes'][number];
type DepartmentStat = StatsOverview['departments'][number];

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

/** 使用率＝已使用 ÷ 已发放；还没有发出任何码时记 0，不显示无意义的除式。 */
function usagePercent(issued: number, used: number): number {
  return issued > 0 ? Math.round((used / issued) * 100) : 0;
}

/** 「各票种发放与使用」表（原概览页同名列定义）。 */
export function TicketTypeStatsTable() {
  const { data, error, loading, refresh } = useOverview();

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

/** 「各部门提交进度」表（原概览页同名列定义）。 */
export function DepartmentProgressTable() {
  const { data, error, loading, refresh } = useOverview();

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
    <Card
      title="各部门提交进度"
      extra={<Typography.Text type="secondary">单位：张 · 每 5 秒自动刷新</Typography.Text>}
      style={{ marginBottom: 16 }}
    >
      {error && data ? <StaleDataAlert error={error} onRetry={refresh} /> : null}
      <Table<DepartmentStat>
        rowKey="id"
        size="small"
        loading={loading}
        columns={departmentColumns}
        dataSource={data?.departments ?? []}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: emptyRows('尚未配置部门，请先到本工作台「部门」页签配置') }}
      />
      {/* 口径说明（产品原则 4）：静默文字，不用 Alert 承载常驻提示 */}
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 12 }}>
        参与率＝该部门已提交表数 ÷ 该部门在职职工数（职工数为 0 时记「-」）；
        已提交按打分表计，一码一票，提交即核销，不可修改；停用部门保留历史提交数据，不影响已收表数与导出。
      </Typography.Paragraph>
    </Card>
  );
}
