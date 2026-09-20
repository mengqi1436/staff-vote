import { useCallback } from 'react';
import type { ReactNode } from 'react';
import { Button, Card } from 'antd';
import { ArrowLeftOutlined, PrinterOutlined } from '@ant-design/icons';
import { Link, useSearchParams } from 'react-router';
import { adminApi, type ResultsDto } from '../../lib/api.js';
import { usePolling } from '../../lib/usePolling.js';
import { EMPTY_TEXT, formatDate, formatDateTime } from './lib.js';
import { ErrorState, LoadingState } from './shared.js';

/**
 * 可打印的正式打分表（独立布局，无侧边栏）—— 产品的最终交付物。
 *
 * 评议会结束后这份表要签字归档，所以它必须是一份正式表格，而不是「网页的打印版」：
 *   抬头（单位，取 system.title）→ 表名 → 制表信息行
 *   → 表体（标准 1px 实线打印表格）→ 口径注（写清计分口径与参与票种）→ 签字栏。
 *
 * 打印靠浏览器原生「打印 / 另存为 PDF」，不引入 PDF 库；交互控件加 .no-print，
 * 由 @media print 隐藏（见 styles/global.css）。表格宽，默认按 A4 横向出纸。
 */

/**
 * 打印页面参数与表格样式，选择器限定在 .print-sheet 内（只有本页用它）。
 *
 * 必须保留的打印增强：
 *   - @page A4 横向、页边距 12mm（给签字栏留出书写空间）；
 *   - 表头跨页重复（thead display: table-header-group）；
 *   - 数据行不被跨页切断（tr break-inside: avoid）。
 * 表格线是 1px 实线边框，与打印对话框的「背景图形」开关无关。
 */
const PRINT_STYLE = `
@page { size: A4 landscape; margin: 12mm; }
@media print {
  .print-sheet thead { display: table-header-group; }
  .print-sheet tbody tr { break-inside: avoid; page-break-inside: avoid; }
}
.print-sheet .sheet-table {
  width: 100%;
  border-collapse: collapse;
}
.print-sheet .sheet-table th,
.print-sheet .sheet-table td {
  border: 1px solid #d9d9d9;
  padding: 6px 10px;
  font-size: 13px;
}
.print-sheet .sheet-table thead th {
  background: #fafafa;
  font-weight: 600;
  text-align: center;
}
.print-sheet .sheet-table .num {
  text-align: right;
}
`;

/** 制表信息行里的一项：标签 + 数值。 */
function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span>
      {label}
      {children}
    </span>
  );
}

export function AdminPrintSheet() {
  const [searchParams] = useSearchParams();
  const departmentId = searchParams.get('departmentId') ?? '';

  const loadResults = useCallback(
    () => (departmentId ? adminApi.results.list(departmentId) : Promise.resolve<ResultsDto | null>(null)),
    [departmentId],
  );
  const results = usePolling(loadResults, 0);

  // 抬头用系统标题；设置读取失败（例如会话过期）不该阻塞打印，退化为默认文案
  const loadSettings = useCallback(() => adminApi.settings.get(), []);
  const settings = usePolling(loadSettings, 0);
  const systemTitle = settings.data?.['system.title'] || '职工素质评议';

  const data = results.data;

  const toolbar = (
    <div
      className="no-print"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '12px 24px',
        background: '#fff',
        borderBottom: '1px solid #f0f0f0',
      }}
    >
      <Link to={departmentId ? `/admin/results?departmentId=${departmentId}` : '/admin/results'}>
        <Button icon={<ArrowLeftOutlined />}>返回结果页</Button>
      </Link>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span style={{ fontSize: 12, color: 'rgba(0, 0, 0, 0.45)' }}>
          打印建议：A4 横向、页边距「窄」；表格线是边框，与「背景图形」开关无关。
        </span>
        <Button type="primary" icon={<PrinterOutlined />} onClick={() => window.print()}>
          打印 / 另存为 PDF
        </Button>
      </div>
    </div>
  );

  if (!departmentId) {
    return (
      <>
        <style>{PRINT_STYLE}</style>
        {toolbar}
        <div style={{ maxWidth: 720, margin: '0 auto', padding: 32 }}>
          <Card title="缺少部门参数">
            <p style={{ margin: '0 0 16px' }}>
              正式打分表按部门生成：请先在「结果与导出」页选定部门，再点「打印打分表」进入本页。
            </p>
            <Link to="/admin/results">
              <Button type="primary">前往结果与导出</Button>
            </Link>
          </Card>
        </div>
      </>
    );
  }

  if (results.error && !data) {
    return (
      <>
        <style>{PRINT_STYLE}</style>
        {toolbar}
        <div style={{ maxWidth: 720, margin: '0 auto', padding: 32 }}>
          <ErrorState error={results.error} onRetry={results.refresh} />
        </div>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <style>{PRINT_STYLE}</style>
        {toolbar}
        <div style={{ maxWidth: 720, margin: '0 auto', padding: 32 }}>
          <LoadingState rows={8} />
        </div>
      </>
    );
  }

  const involvedText = data.ticketTypesInvolved.length
    ? data.ticketTypesInvolved
        .map((type) => `${type.name}（${type.code}，权重 ${type.weightPercent}%）`)
        .join('、')
    : '暂无（本部门尚未收到任何一张票）';

  return (
    <>
      <style>{PRINT_STYLE}</style>
      {toolbar}

      <div className="print-sheet" style={{ maxWidth: 1080, margin: '0 auto', padding: '32px 32px 24px' }}>
        {/* 抬头：单位名取 system.title */}
        <header style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 15 }}>{systemTitle}</div>
          <h1 style={{ margin: '8px 0 0', fontSize: 22, fontWeight: 600 }}>
            职工素质评议打分表
          </h1>
        </header>

        {/* 制表信息行 */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            gap: 16,
            marginTop: 16,
            marginBottom: 12,
            fontSize: 12,
          }}
        >
          <MetaItem label="制表单位：">{data.department.name}</MetaItem>
          <MetaItem label="提交表数：">
            <span className="tabular">{data.sheetCount}</span> 张
          </MetaItem>
          <MetaItem label="项点数：">
            <span className="tabular">{data.criteria.length}</span> 项
          </MetaItem>
          <MetaItem label="制表日期：">
            <span className="tabular">{formatDate(data.generatedAt)}</span>
          </MetaItem>
        </div>

        {data.ticketTypesInvolved.length === 0 ? (
          <p style={{ margin: '12px 0 0', fontSize: 12 }}>
            本表尚未收到任何票：参与计算的票种为空，各项得分与综合得分一栏均为空。
          </p>
        ) : null}

        {data.rows.length === 0 ? (
          <div
            style={{
              marginTop: 12,
              border: '1px solid #d9d9d9',
              padding: '24px 0',
              textAlign: 'center',
              fontSize: 13,
            }}
          >
            该部门尚无提交记录，本页无法生成正式打分表。
          </div>
        ) : (
          <table className="sheet-table">
            <thead>
              <tr>
                <th className="num" style={{ width: 64 }}>
                  排名
                </th>
                <th style={{ width: 104 }}>姓名</th>
                <th className="num" style={{ width: 104 }}>
                  工号
                </th>
                {data.criteria.map((criterion) => (
                  <th key={criterion.id} className="num">
                    {criterion.name}
                    <span style={{ display: 'block', fontWeight: 400, fontSize: 12 }}>
                      {criterion.minScore}-{criterion.maxScore}
                    </span>
                  </th>
                ))}
                <th className="num" style={{ width: 104 }}>
                  综合得分
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.employeeId}>
                  <td className="num">
                    <span className="tabular">{row.rank}</span>
                  </td>
                  <td>{row.employeeName}</td>
                  <td className="num">{row.employeeNo ?? EMPTY_TEXT}</td>
                  {data.criteria.map((criterion) => {
                    const cell = row.criteria.find((item) => item.criterionId === criterion.id);
                    return (
                      <td key={criterion.id} className="num">
                        {cell ? <span className="tabular">{cell.rawScore}</span> : EMPTY_TEXT}
                      </td>
                    );
                  })}
                  <td className="num" style={{ fontWeight: 600 }}>
                    <span className="tabular">{row.comprehensiveScore.toFixed(2)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* 口径注：产品原则 4，计分口径必须落在归档纸面上 */}
        <div style={{ marginTop: 16, fontSize: 12, fontWeight: 600 }}>口径注</div>
        <ol style={{ margin: '4px 0 0', paddingLeft: 20, fontSize: 12, lineHeight: 1.8 }}>
          <li>
            表中各项得分为「票种加权后的原始分」，仍落在该项点表头标注的区间内：某项得分 =
            Σ(该票种在该项的均分 × 票种权重) ÷ Σ(票种权重)，只取在该项点真正有票的票种。综合得分为百分制。
          </li>
          <li>
            综合得分口径：各项先按自身区间归一化到百分制（(得分 − 起评分) ÷ (满分 − 起评分) ×
            100），再取等权平均。某项点在本部门一张票都没有时，该项不参与平均，也不会按 0
            分计入；各项满分一致时即为算术平均。
          </li>
          <li>
            实际参与计算的票种：{involvedText}
            。某票种在本部门某项点零票时会在该格被排除；未列出的启用票种即属此情况。
          </li>
          <li>
            本表数据取自本部门已提交的评分记录，与「导出 Excel」同源；演示环境中的姓名、工号与成绩均为合成数据，不代表真实职工。
          </li>
        </ol>

        {/* 签字栏：归档凭证 */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            gap: 24,
            marginTop: 32,
            fontSize: 12,
          }}
        >
          <span>考评人签字：______________</span>
          <span>部门负责人签字：______________</span>
          <span>日期：______年____月____日</span>
        </div>

        <div style={{ marginTop: 16, fontSize: 12 }}>
          数据生成时间：<span className="tabular">{formatDateTime(data.generatedAt)}</span>
          {'　'}本页由系统生成，数字口径与「导出 Excel」一致。
        </div>
      </div>
    </>
  );
}
