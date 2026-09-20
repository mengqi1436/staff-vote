import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Alert, Button, Card, Flex, Result, Select, Spin, theme, Typography } from 'antd';
import { Navigate, useNavigate } from 'react-router';
import { ApiError, clearVoteToken, readVoteToken, voteApi } from '../../lib/api.js';
import type { SubmitItem, VoteSheetResult } from '../../lib/api.js';
import { ScoreTable, cellElementId, cellKey, collectScoreErrors } from '../../components/vote/ScoreTable.js';
import type { CellError, ScoreValues } from '../../components/vote/ScoreTable.js';
import { clearVoteSessionInfo, readVoteSessionInfo } from '../../components/vote/voteSession.js';
import { VoteSteps } from '../../components/vote/VoteSteps.js';
import { VoteSurface } from '../../components/VoteSurface.js';

/**
 * 打分表页（流程第 2 步：填写打分）。
 *
 * 流程：选部门（只有一个部门时直接进入）→ 拉该部门的项点列与职工行 →
 * 用类 Excel 表格录入 → 提交前全表校验（缺填、小数、越界都会被拦下并指到具体行列）。
 *
 * 三条纪律写在这里：一是不询问也不展示职工身份（职工可见文案也不出现后台术语），
 * 二是提交失败绝不清空已填内容（几百格重填一次，职工就会弃投），
 * 三是标红之外必须有可读的错误汇总 —— 键盘与读屏用户看不到「整张表红了一片」，
 * 他们需要一份能跳转的清单。
 */

/** 加载打分表失败的文案。 */
function loadErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return '当前未开放投票，请在开放时间内再来。';
    if (error.status === 0) return '网络连接失败，请检查网络后重试。';
  }
  return '打分表加载失败，请刷新页面重试。';
}

/** 提交失败的文案。 */
function submitErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return '当前未开放投票，暂时无法提交。已填写的分数仍保留在页面上，请等投票开放后重试。';
    }
    if (error.status === 400) return `提交被拒绝：${error.message}`;
    if (error.status === 0) return '网络连接失败，提交未生效。已填写的分数仍保留在页面上，请检查网络后重试。';
  }
  return '提交失败，请稍后重试。已填写的分数仍保留在页面上。';
}

/** 空集合常量：保持引用稳定，避免整表因新对象而无谓重渲染。 */
const EMPTY_SET: ReadonlySet<string> = new Set();

/** 提交后不可修改的提示，页面里只写一处文案。 */
const IRREVERSIBLE_HINT = '一码一票，提交即核销、不可再改。请核对无误后再提交；本页不记录您的姓名与身份。';

/** error summary 的标题 id：容器的 aria-labelledby 与聚焦目标都用它。 */
const ERROR_SUMMARY_TITLE_ID = 'score-error-summary-title';

/** 错误汇总入场的一次淡入：180ms、只用 opacity 与 transform，reduce 时由 global.css 压成瞬时。 */
const ENTER_MS = 180;

/**
 * 错误汇总：提交被拦下时出现在表单顶部。
 *
 * 它存在的唯一理由是让不用眼睛的人也能找到错在哪：容器是 role="alert" 且可聚焦，
 * 标题在提交后被聚焦，每条错误都是指向那一格的链接。表内标红与格内 title 同时保留，
 * 两者不是替代关系 —— 明眼人看红格，键盘与读屏用户走这份清单。
 *
 * 颜色取 antd 标准错误色 token（与 global.css 的 .cell-input.invalid 同一套）。
 */
function ErrorSummary({ errors, onJump }: { errors: CellError[]; onJump: (error: CellError) => void }) {
  const { token } = theme.useToken();
  const titleRef = useRef<HTMLHeadingElement>(null);
  // 挂载后再切到静止态，180ms 的淡入才真的发生
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    setEntered(true);
    titleRef.current?.focus();
  }, []);

  return (
    <div
      role="alert"
      tabIndex={-1}
      aria-labelledby={ERROR_SUMMARY_TITLE_ID}
      style={{
        padding: '12px 16px',
        border: `1px solid ${token.colorErrorBorder}`,
        borderRadius: token.borderRadiusLG,
        background: token.colorErrorBg,
        opacity: entered ? 1 : 0,
        transform: entered ? 'none' : 'translateY(-4px)',
        transition: `opacity ${ENTER_MS}ms ease-out, transform ${ENTER_MS}ms ease-out`,
      }}
    >
      <h2
        id={ERROR_SUMMARY_TITLE_ID}
        ref={titleRef}
        tabIndex={-1}
        style={{ margin: 0, fontSize: token.fontSize, color: token.colorError }}
      >
        有 {errors.length} 处需要修正，尚未提交
      </h2>
      <p style={{ margin: '4px 0 8px', color: token.colorTextSecondary }}>
        逐条点开可跳到对应的格子；这些格子也已在表内标红。修正后再提交。
      </p>
      <ol style={{ margin: 0, paddingLeft: '1.6em', display: 'grid', gap: 4 }}>
        {errors.map((item) => (
          <li key={cellKey(item.employeeId, item.criterionId)}>
            <a
              className="pressable"
              href={`#${cellElementId(item.employeeId, item.criterionId)}`}
              onClick={(event) => {
                // 锚点照常写在 href 里（读屏可读、可复制），跳转交给表格处理，跨页也能落到那一格
                event.preventDefault();
                onJump(item);
              }}
              style={{ color: token.colorError }}
            >
              第 {item.row} 行第 {item.col} 列（{item.employeeName} · {item.criterionName}）：{item.reason}
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * 静态提示条（常驻的警示与说明）。
 *
 * 不用 antd Alert：v6 的 Alert 固定渲染 role="alert" 且无法覆盖，常驻提示带上
 * 这个 role 既会抢掉 error summary 的「唯一 alert」语义（键盘与读屏用户靠它定位
 * 提交被拦下的原因），也会让读屏把非紧急内容当紧急播报。这里用与 Alert 同一套
 * antd 标准提示色 token，外观一致、语义安静。
 */
function StaticNotice({ tone, title, children }: { tone: 'warning' | 'info'; title: string; children?: ReactNode }) {
  const { token } = theme.useToken();
  const warning = tone === 'warning';
  return (
    <div
      style={{
        padding: '12px 16px',
        border: `1px solid ${warning ? token.colorWarningBorder : token.colorInfoBorder}`,
        borderRadius: token.borderRadiusLG,
        background: warning ? token.colorWarningBg : token.colorInfoBg,
        display: 'grid',
        gap: 4,
      }}
    >
      <Typography.Text strong style={{ color: warning ? token.colorWarning : token.colorInfo }}>
        {title}
      </Typography.Text>
      {children}
    </div>
  );
}

export function VoteSheet() {
  const navigate = useNavigate();
  const [token] = useState(readVoteToken);
  const [sessionInfo] = useState(readVoteSessionInfo);
  // 只有一个部门时直接进入，少一次点击
  const [deptId, setDeptId] = useState<string | null>(() =>
    sessionInfo !== null && sessionInfo.departments.length === 1 ? sessionInfo.departments[0]!.id : null,
  );

  const [sheet, setSheet] = useState<VoteSheetResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 重新拉取的序号：加载失败后「重新加载」用它再触发一次 effect。 */
  const [reloadSeq, setReloadSeq] = useState(0);
  /** 不可恢复的终态（凭据失效、票已核销）：显示说明并引导回入口，不再渲染表格。 */
  const [fatal, setFatal] = useState<string | null>(null);

  const [values, setValues] = useState<ScoreValues>({});
  const [invalidCells, setInvalidCells] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [errors, setErrors] = useState<CellError[]>([]);
  /** 每次提交被拦下都 +1：让 error summary 重新入场并重新拿焦点。 */
  const [attempt, setAttempt] = useState(0);
  const [focusTarget, setFocusTarget] = useState<{ row: number; col: number } | null>(null);
  const [revealTarget, setRevealTarget] = useState<{ row: number; col: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // 拉取该部门的打分表；切部门时把上一份填写内容与校验结果一起丢掉
  useEffect(() => {
    if (token === null || deptId === null) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setSheet(null);
    setValues({});
    setInvalidCells(EMPTY_SET);
    setErrors([]);
    setSubmitError(null);
    voteApi
      .sheet(deptId, token)
      .then((result) => {
        if (!cancelled) setSheet(result);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          clearVoteToken();
          clearVoteSessionInfo();
          setFatal('本轮投票凭据已失效，请回到入口重新输入随机码。');
          return;
        }
        setLoadError(loadErrorText(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, deptId, reloadSeq]);

  const handleChange = useCallback((employeeId: string, criterionId: string, raw: string) => {
    setValues((prev) => ({ ...prev, [employeeId]: { ...prev[employeeId], [criterionId]: raw } }));
  }, []);

  const stats = useMemo(() => {
    if (sheet === null) return { filled: 0, total: 0 };
    let filled = 0;
    for (const employee of sheet.employees) {
      const row = values[employee.id];
      if (row === undefined) continue;
      for (const criterion of sheet.criteria) {
        if ((row[criterion.id] ?? '').trim() !== '') filled += 1;
      }
    }
    return { filled, total: sheet.employees.length * sheet.criteria.length };
  }, [sheet, values]);

  // 填了但没提交时挡住误刷新：令牌还在，但没人愿意把几百格重填一遍
  const hasUnsentInput = stats.filled > 0 && !submitting;
  useEffect(() => {
    if (!hasUnsentInput) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsentInput]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (sheet === null || token === null) return;

      const found = collectScoreErrors(sheet.criteria, sheet.employees, values);
      if (found.length > 0) {
        setErrors(found);
        setInvalidCells(new Set(found.map((item) => cellKey(item.employeeId, item.criterionId))));
        setAttempt((current) => current + 1);
        const first = found[0]!;
        // 表格翻到第一处错误所在页，但焦点留给顶部的 error summary（键盘用户先拿到清单）
        setRevealTarget({ row: first.row - 1, col: first.col - 1 });
        setSubmitError(null);
        return;
      }

      setErrors([]);
      setSubmitError(null);
      setSubmitting(true);
      try {
        const items: SubmitItem[] = [];
        for (const employee of sheet.employees) {
          for (const criterion of sheet.criteria) {
            items.push({
              employeeId: employee.id,
              criterionId: criterion.id,
              // 已通过整数与范围校验，这里直接转成数字
              score: Number(values[employee.id]?.[criterion.id]),
            });
          }
        }
        await voteApi.submit({ departmentId: sheet.department.id, items }, token);
        // 提交成功：凭据与缓存立刻清掉（公用电脑上更要清干净），再进成功页
        clearVoteToken();
        clearVoteSessionInfo();
        setValues({});
        void navigate('/vote/done', { replace: true });
      } catch (error: unknown) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 409)) {
          clearVoteToken();
          clearVoteSessionInfo();
          setFatal(
            error.status === 409
              ? '该随机码已经提交过评分，一码一票不能重复提交。'
              : '本轮投票凭据已失效，请回到入口重新输入随机码。',
          );
          return;
        }
        setSubmitError(submitErrorText(error));
      } finally {
        setSubmitting(false);
      }
    },
    [sheet, token, values, navigate],
  );

  if (token === null) return <Navigate to="/" replace />;

  if (fatal !== null) {
    return (
      <VoteSurface>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '48px 16px' }}>
          <Card>
            <VoteSteps current={1} />
            <Result
              status="warning"
              title="无法继续打分"
              subTitle={fatal}
              extra={
                <Button type="primary" onClick={() => void navigate('/')}>
                  返回投票入口
                </Button>
              }
            />
          </Card>
        </div>
      </VoteSurface>
    );
  }

  if (sessionInfo === null) return <Navigate to="/" replace />;

  return (
    <VoteSurface>
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 16px 48px' }}>
        <Card>
          <VoteSteps current={1} />

          {/* 页头：表名在左，当前部门在右（职工不需要也看不到任何后台术语） */}
          <Flex align="baseline" justify="space-between" wrap gap={8} style={{ marginBottom: 16 }}>
            <Typography.Title level={3} style={{ margin: 0 }}>
              职工素质评议打分表
            </Typography.Title>
            {sheet === null ? null : (
              <Typography.Text type="secondary">部门：{sheet.department.name}</Typography.Text>
            )}
          </Flex>

          <div style={{ marginBottom: 16 }}>
            <StaticNotice tone="warning" title="提交后不可修改">
              <Typography.Text type="secondary">{IRREVERSIBLE_HINT}</Typography.Text>
            </StaticNotice>
          </div>

          {sessionInfo.departments.length > 1 ? (
            <div style={{ marginBottom: 16 }}>
              <label htmlFor="vote-department" style={{ display: 'block', marginBottom: 8 }}>
                请选择您要评议的部门
              </label>
              <Select
                id="vote-department"
                style={{ width: '100%', maxWidth: 320 }}
                placeholder="请选择部门"
                value={deptId ?? undefined}
                onChange={(value: string) => setDeptId(value)}
                options={sessionInfo.departments.map((department) => ({
                  value: department.id,
                  label: department.name,
                }))}
              />
            </div>
          ) : null}

          {deptId === null ? (
            <Alert type="info" showIcon title="请先选择部门" description="选择部门后才会显示该部门的打分表。" />
          ) : loading ? (
            <div style={{ padding: '32px 0', textAlign: 'center' }}>
              <Spin size="large" />
              <p style={{ margin: '16px 0 0' }}>
                <Typography.Text type="secondary">正在取回打分表，请稍候。</Typography.Text>
              </p>
            </div>
          ) : loadError !== null ? (
            <Alert
              type="error"
              showIcon
              title="打分表加载失败"
              description={loadError}
              action={
                <Button size="small" onClick={() => setReloadSeq((current) => current + 1)}>
                  重新加载
                </Button>
              }
            />
          ) : sheet === null ? null : sheet.employees.length === 0 || sheet.criteria.length === 0 ? (
            <Alert
              type="info"
              showIcon
              title="本部门暂未配置打分表"
              description="请联系评议组织者确认后再来。"
            />
          ) : (
            <form onSubmit={(event) => void handleSubmit(event)} style={{ display: 'grid', gap: 16 }}>
              {errors.length > 0 ? (
                <ErrorSummary
                  key={attempt}
                  errors={errors}
                  onJump={(item) => {
                    // 精确聚焦某一格：表格会自己翻页并选中已有内容
                    setFocusTarget({ row: item.row - 1, col: item.col - 1 });
                  }}
                />
              ) : null}

              {submitError === null ? null : (
                // antd Alert 自带 role="alert"，读屏会立即播报；已填内容不会被清掉，文案里已说明
                <Alert type="error" showIcon title="提交未成功" description={submitError} />
              )}

              <ScoreTable
                criteria={sheet.criteria}
                employees={sheet.employees}
                values={values}
                onChange={handleChange}
                invalidCells={invalidCells}
                focusTarget={focusTarget}
                revealTarget={revealTarget}
              />

              {/* 填写说明：口径写在表下，不让职工去猜 */}
              <StaticNotice tone="info" title="填写说明">
                <ol style={{ margin: 0, paddingLeft: '1.4em' }}>
                  <li>每格只能填整数，允许的区间写在各列表头上。</li>
                  <li>所有格子填完才能提交；离开格子时就发现的问题会和提交时发现的一样被指出。</li>
                  <li>本页只汇总分数，不记录您的姓名与身份。</li>
                </ol>
              </StaticNotice>

              <Flex className="no-print" align="center" gap={16} wrap>
                <Button type="primary" htmlType="submit" loading={submitting}>
                  提交评分（提交后不可修改）
                </Button>
                <Typography.Text type="secondary">
                  已填写 {stats.filled} / {stats.total} 项
                  {errors.length > 0 ? `，还有 ${errors.length} 处需要修正` : ''}
                </Typography.Text>
              </Flex>
            </form>
          )}
        </Card>
      </div>
    </VoteSurface>
  );
}
