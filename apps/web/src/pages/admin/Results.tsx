import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Empty, Select, Table, Tooltip, Typography } from 'antd';
import { DownloadOutlined, PrinterOutlined, ReloadOutlined } from '@ant-design/icons';
import { Link } from 'react-router';
import type { TableColumnsType } from 'antd';
import { adminApi, type ResultRowDto, type ResultsDto } from '../../lib/api.js';
import { usePolling } from '../../lib/usePolling.js';
import { EMPTY_TEXT, formatDateTime } from './lib.js';
import {
  ErrorState,
  LoadingState,
  NextStep,
  PageHeader,
  StaleDataAlert,
} from './shared.js';

/**
 * 结果汇总与导出（评议工作流「评议收尾」组）。
 *
 * 导出三件套：本页排名汇总、Excel、可打印的正式打分表。
 *
 * 口径必须写在页面上（产品原则 4「结果可复现、可解释」）：
 *   - 各项得分是「票种加权后的原始分」，仍落在该项的 min/max 区间内；
 *   - 综合得分是各项归一化到百分制后的等权平均；
 *   - 某票种在本部门零票时会被归一化排除，所以必须标出「实际参与计算的票种」，
 *     否则管理员会以为结果算错了。
 * 口径说明用 Alert type="info" 承载，术语与后端 src/lib/scoring.ts 的实现一致。
 */
export function AdminResults() {
  const [departmentId, setDepartmentId] = useState('');
  const loadDepartments = useCallback(() => adminApi.departments.list(), []);
  const departments = usePolling(loadDepartments, 0);

  useEffect(() => {
    if (!departmentId && departments.data?.length) {
      setDepartmentId(departments.data[0]?.id ?? '');
    }
  }, [departments.data, departmentId]);

  const loadResults = useCallback(
    () => (departmentId ? adminApi.results.list(departmentId) : Promise.resolve<ResultsDto | null>(null)),
    [departmentId],
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
          title: '排名',
          dataIndex: 'rank',
          width: 76,
          align: 'right',
          fixed: 'left',
          render: (value: number) => <span className="tabular">{value}</span>,
        },
        { title: '姓名', dataIndex: 'employeeName', width: 120, fixed: 'left' },
        {
          title: '工号',
          dataIndex: 'employeeNo',
          width: 108,
          align: 'right',
          render: (value: string | null) => value ?? EMPTY_TEXT,
        },
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
                title={`票种加权后的原始分 ${cell.rawScore}，归一化 ${cell.normalizedScore.toFixed(1)}；本项参与计算票种：${
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
        description="按综合得分排名。各项得分是票种加权后的原始分，综合得分是各项归一化到百分制后的等权平均；口径写在页面里，不做黑箱。"
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
            <Link to={hasDepartment ? `/admin/results/print?departmentId=${departmentId}` : '/admin/results'}>
              <Button icon={<PrinterOutlined />} disabled={!hasDepartment}>
                打印打分表
              </Button>
            </Link>
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              href={hasDepartment ? adminApi.results.exportUrl(departmentId) : undefined}
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
            description="请先选择部门：成绩按部门汇总，每个部门的项点与职工名单都是单独配置的，选定部门后才会出表。"
          />
        </Card>
      ) : null}

      {data ? (
        <Card
          title="成绩排名"
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
              项点 <span className="tabular">{data.criteria.length}</span> 项
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
            <Typography.Text type="secondary">实际参与计算的票种</Typography.Text>
            {data.ticketTypesInvolved.length ? (
              data.ticketTypesInvolved.map((type) => (
                <span key={type.id}>
                  <span className="tabular">{type.code}</span> {type.name}（权重{' '}
                  <span className="tabular">{type.weightPercent}%</span>）
                </span>
              ))
            ) : (
              <Typography.Text type="secondary">暂无：本部门还没有收到任何一张票</Typography.Text>
            )}
          </div>

          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            title="计分口径"
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                <li>
                  表中各项得分为「票种加权后的原始分」，仍落在该项点的起评分与满分之间：某项得分 =
                  Σ(该票种在该项的均分 × 票种权重) ÷ Σ(票种权重)，只取在该项点真正有票的票种。综合得分为百分制。
                </li>
                <li>
                  综合得分口径：各项先按自身区间归一化到百分制（(得分 − 起评分) ÷ (满分 − 起评分) ×
                  100），再取等权平均。某项点在本部门一张票都没有时，该项不参与平均，也不会按 0 分计入。
                </li>
                <li>
                  参与计算的票种：某票种在本部门此项点零票时会在该格被排除；未列出的启用票种即属此情况。
                  权重只决定票种之间的配比，不改变项点之间的等权关系。
                </li>
                <li>
                  排名按综合得分降序，同分并列（1、2、2、4 式），同分内按姓名排序；本页数字与「导出
                  Excel」同源。
                </li>
                <li>
                  数据来源：本部门已提交的评分记录；演示环境中的姓名、工号与成绩均为合成数据，不代表真实职工。
                </li>
              </ul>
            }
          />

          {noSubmissions ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="该部门尚无提交记录：投票入口还没有收到该部门的任何一张票"
            />
          ) : (
            <Table<ResultRowDto>
              rowKey="employeeId"
              size="small"
              loading={results.loading}
              columns={columns}
              dataSource={data.rows}
              pagination={
                data.rows.length > 30
                  ? {
                      pageSize: 30,
                      showTotal: (total) => `共 ${total} 人`,
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

      <NextStep to="/admin/results/print">打印打分表</NextStep>
    </>
  );
}
