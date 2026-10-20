import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Empty, Select, Table, Tooltip, Typography } from 'antd';
import { DownloadOutlined, PrinterOutlined, ReloadOutlined } from '@ant-design/icons';
import { Link } from 'react-router';
import type { TableColumnsType } from 'antd';
import { adminApi, PERMISSION_RESULTS_EXPORT, type ResultRowDto, type ResultsDto } from '../../lib/api.js';
import { usePolling } from '../../lib/usePolling.js';
import { useAuth } from '../../lib/auth.js';
import { useAdminSession } from '../../lib/sessionContext.js';
import { EMPTY_TEXT, formatDateTime } from './lib.js';
import {
  ErrorState,
  HelpLabel,
  LoadingState,
  PageHeader,
  StaleDataAlert,
} from './shared.js';

/**
 * 结果汇总与导出（评议工作流「评议收尾」组）。
 *
 * 导出三件套：本页排名汇总、Excel、可打印的正式打分表。
 *
 * 说明必须写在页面上（产品原则 4「结果可复现、可解释」）：
 *   - 结果按人员类别分别统计，不做跨类合并；
 *   - 各项得分是该类别在本项的平均原始分，仍落在该项的 min/max 区间内；
 *   - 综合得分是各项归一化到百分制后的等权平均；
 *   - 排名是同一人员类别内的排名，不同类别之间不可比；
 *   - 某人员类别在本部门零票时没有行，所以必须标出「实际参与计算的人员类别」，
 *     否则管理员会以为结果算错了。
 * 计分说明收进「成绩排名」标题旁的说明图标，术语与后端 src/lib/scoring.ts 的实现一致。
 */
export function AdminResults() {
  const [departmentId, setDepartmentId] = useState('');
  const { sessionId } = useAdminSession();
  const { can } = useAuth();
  const canExport = can(PERMISSION_RESULTS_EXPORT);
  const loadDepartments = useCallback(() => adminApi.departments.list({ sessionId }), [sessionId]);
  const departments = usePolling(loadDepartments, 0);

  useEffect(() => {
    if (!departmentId && departments.data?.length) {
      setDepartmentId(departments.data[0]?.id ?? '');
    }
  }, [departments.data, departmentId]);

  const loadResults = useCallback(
    () =>
      departmentId
        ? adminApi.results.list(departmentId, sessionId)
        : Promise.resolve<ResultsDto | null>(null),
    [departmentId, sessionId],
  );
  const results = usePolling(loadResults, 0);
  const data = results.data;

  const departmentOptions = (departments.data ?? []).map((item) => ({
    value: item.id,
    label: item.enabled ? item.name : `${item.name}（已停用）`,
  }));

  const typeName = useCallback(
    (id: string) => data?.ticketTypesInvolved.find((type) => type.id === id)?.name ?? id,
    [data],
  );

  const columns: TableColumnsType<ResultRowDto> = data
    ? [
        {
          title: '人员类别',
          dataIndex: 'ticketTypeCode',
          width: 100,
          fixed: 'left',
          render: (value: string) => <span className="tabular">{value}</span>,
        },
        {
          title: '类别内排名',
          dataIndex: 'rank',
          width: 96,
          align: 'right',
          fixed: 'left',
          render: (value: number) => <span className="tabular">{value}</span>,
        },
        { title: '被评对象', dataIndex: 'voteColumnName', width: 160, fixed: 'left' },
        ...data.criteria.map((criterion) => ({
          title: (
            <>
              {criterion.name}
              <Typography.Text
                type="secondary"
                className="tabular"
                style={{ display: 'block', fontWeight: 400, fontSize: 12 }}
              >
                {criterion.minScore}-{criterion.maxScore}
              </Typography.Text>
            </>
          ),
          key: criterion.id,
          width: 140,
          align: 'right' as const,
          render: (_: unknown, row: ResultRowDto) => {
            const cell = row.criteria.find((item) => item.criterionId === criterion.id);
            if (!cell) return EMPTY_TEXT;
            const names = cell.participatingTicketTypeIds.map(typeName).join('、');
            return (
              <Tooltip
                title={`这项的原始分 ${cell.rawScore}，换算成百分制是 ${cell.normalizedScore.toFixed(1)}；这项有打分的人员类别：${
                  names || '无'
                }`}
              >
                <span className="tabular">{cell.rawScore}</span>
              </Tooltip>
            );
          },
        })),
        {
          title: '综合得分',
          dataIndex: 'comprehensiveScore',
          width: 116,
          align: 'right',
          fixed: 'right',
          render: (value: number) => (
            <span className="tabular" style={{ fontWeight: 600 }}>
              {value.toFixed(2)}
            </span>
          ),
        },
      ]
    : [];

  const hasDepartment = Boolean(departmentId);
  const noSubmissions = data ? data.sheetCount === 0 || data.rows.length === 0 : false;

  return (
    <>
      <PageHeader
        title="结果与导出"
        description="结果按人员类别分别统计，不做跨类合并；排名是同一人员类别内的排名，不同类别之间不可比。各项得分是该类别在本项的平均原始分，综合得分是把各项换算成百分制后的平均分。计算方法都写明在页面上，数字可以自己复算。"
        extra={
          <>
            <Select
              style={{ width: 220 }}
              placeholder="选择部门"
              value={departmentId || undefined}
              options={departmentOptions}
              loading={departments.loading}
              onChange={setDepartmentId}
            />
            <Button icon={<ReloadOutlined />} onClick={results.refresh} loading={results.loading}>
              刷新
            </Button>
            {hasDepartment ? (
              <Link
                to={
                  sessionId
                    ? `/admin/results/print?departmentId=${departmentId}&sessionId=${encodeURIComponent(sessionId)}`
                    : `/admin/results/print?departmentId=${departmentId}`
                }
              >
                <Button icon={<PrinterOutlined />}>打印打分表</Button>
              </Link>
            ) : (
              <Button icon={<PrinterOutlined />} disabled>
                打印打分表
              </Button>
            )}
            {canExport ? (
              <Button
                icon={<DownloadOutlined />}
                href={sessionId ? adminApi.sessions.exportFullUrl(sessionId) : undefined}
                disabled={!sessionId}
                title={sessionId ? undefined : '请先选择评议'}
              >
                整场整合导出
              </Button>
            ) : null}
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              href={hasDepartment ? adminApi.results.exportUrl(departmentId, sessionId) : undefined}
              disabled={!hasDepartment}
            >
              导出 Excel
            </Button>
          </>
        }
      />

      {departments.error && !departments.data ? (
        <ErrorState error={departments.error} onRetry={departments.refresh} />
      ) : null}
      {results.error && data ? <StaleDataAlert error={results.error} onRetry={results.refresh} /> : null}
      {results.error && !data ? <ErrorState error={results.error} onRetry={results.refresh} /> : null}

      {!data && results.loading ? <LoadingState rows={6} /> : null}
      {!data && !results.loading && !hasDepartment ? (
        <Card>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="请先选择部门：成绩按部门汇总，每个部门的评议项目与职工名单都是单独配置的，选定部门后才会出表。"
          />
        </Card>
      ) : null}

      {data ? (
        <Card
          title={
            <HelpLabel help="结果按人员类别分别统计：每行是一个人员类别在一个被评对象上的成绩，不做跨类合并。各项得分是该类别在本项的平均原始分，仍落在这项自己的分数区间里；综合得分是把每项换算成百分制再取平均。某项没有人打分就不参与平均，不会按 0 分算；弃权或没填的格子按 0 分算。某一类人员一张表都没交时，这类不参与计算（那是没发这类码，不算弃权）。排名只在同一人员类别内比较：同分并列，同一分数按被评对象名称排序。被评对象是职务或车间，不是具体职工。本页数字和导出的 Excel 一致。">
              成绩排名
            </HelpLabel>
          }
          extra={
            <Typography.Text type="secondary">
              部门：{data.department.name}｜单位：分
            </Typography.Text>
          }
        >
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
            {/* 这句「共收到 N 张提交表」保持在同一个元素里：已有冒烟测试按整句
                匹配（/共收到 1 张提交表/），拆成多个元素会让匹配落空。 */}
            <Typography.Text type="secondary">
              共收到 {data.sheetCount} 张提交表 · 生成时间 {formatDateTime(data.generatedAt)}
            </Typography.Text>
            <Typography.Text type="secondary">
              评议项目 <span className="tabular">{data.criteria.length}</span> 项
            </Typography.Text>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              flexWrap: 'wrap',
              gap: 12,
              marginBottom: 16,
            }}
          >
            <Typography.Text type="secondary">实际参与计算的人员类别</Typography.Text>
            {data.ticketTypesInvolved.length ? (
              data.ticketTypesInvolved.map((type) => (
                <span key={type.id}>
                  <span className="tabular">{type.code}</span> {type.name}
                </span>
              ))
            ) : (
              <Typography.Text type="secondary">暂无：本部门还没有收到任何一张票</Typography.Text>
            )}
          </div>

          {noSubmissions ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="该部门尚无提交记录：投票入口还没有收到该部门的任何一张票"
            />
          ) : (
            <Table<ResultRowDto>
              rowKey={(row) => `${row.ticketTypeId}|${row.voteColumnId ?? 'score'}`}
              size="small"
              loading={results.loading}
              columns={columns}
              dataSource={data.rows}
              pagination={
                data.rows.length > 30
                  ? {
                      pageSize: 30,
                      showTotal: (total) => `共 ${total} 项`,
                    }
                  : false
              }
              scroll={{ x: 'max-content' }}
              locale={{
                emptyText: (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有可展示的评分数据" />
                ),
              }}
            />
          )}
        </Card>
      ) : null}

    </>
  );
}
