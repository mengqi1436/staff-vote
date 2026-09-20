import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { Button, Flex, theme, Typography } from 'antd';
import type { CriterionDto, EmployeeDto } from '../../lib/api.js';

/**
 * 类 Excel 打分表。
 *
 * 这家页面是给普通职工用的，手感比视觉重要：粘性表头让他向下滚时知道每列是什么，
 * 粘性姓名列让他向右滚时知道在给谁打分，Tab 走原生顺序连续录入，方向键与 Enter
 * 在网格内移动。所以用原生 table + 原生 input，而不是 antd 的受控表格组件
 * （后者的每格都是独立渲染单元，键盘顺序与滚动容器都不受我们控制）。
 *
 * 行数超过 PAGE_SIZE 时只渲染当前页：上千个输入框同屏会让低配电脑和手机明显卡顿，
 * 而跨页填写的值保存在页面级 state 里，翻页不会丢。
 *
 * 无障碍：每格都有固定 id（`cell-<职工>-<项点>`），提交失败时的 error summary 用它
 * 逐条链接到出错的那一格；区间说明以 aria-describedby 关联，非法时 aria-invalid
 * 并把原因读给读屏听。标红只是给明眼人的提示，不是唯一表意手段。
 */

/** 打分表数据：employeeId → criterionId → 输入框原文（提交时才转成整数）。 */
export type ScoreValues = Record<string, Record<string, string>>;

/** 一屏最多渲染的行数。固定值：没有任何调用方需要不同的分页大小，就不留配置口。 */
const PAGE_SIZE = 50;

/** 单元格唯一键，用于标红集合与定位。 */
export function cellKey(employeeId: string, criterionId: string): string {
  return `${employeeId}:${criterionId}`;
}

/**
 * 单元格的 DOM id，同时也是 error summary 里链接的锚点。
 *
 * 用 id 而不是行列号：行列号会随分页与部门切换变化，职工身份 + 项点才是稳定的，
 * 这样跨页的错误条目也能跳回正确的那一格。
 */
export function cellElementId(employeeId: string, criterionId: string): string {
  return `cell-${employeeId}-${criterionId}`;
}

/** 表头区间说明的 id：表头与每格的 aria-describedby 必须指向同一个元素，只在这里拼一次。 */
export function rangeElementId(criterionId: string): string {
  return `range-${criterionId}`;
}

/**
 * 校验单个分数输入。
 *
 * 后端同样只接受整数，前端先拦是为了让职工当场看到哪一格有问题，
 * 而不是填完几百格才被服务端整单退回。
 * @param raw 输入框原文
 * @param min 该项最低分（后台按部门配置）
 * @param max 该项最高分
 * @returns 合法返回 null，否则返回给职工看的中文原因
 */
export function validateScore(raw: string, min: number, max: number): string | null {
  const text = raw.trim();
  if (text === '') return '未填写';
  // 只认十进制整数写法：小数、科学计数法、残留符号一律拒绝
  if (!/^-?\d+$/.test(text)) return '只能填整数';
  const score = Number(text);
  if (score < min || score > max) return `需在 ${min}–${max} 之间`;
  return null;
}

/** 单个不合格单元格。行列均从 1 开始，与职工看到的行号、表头列序一致。 */
export interface CellError {
  row: number;
  col: number;
  employeeId: string;
  criterionId: string;
  employeeName: string;
  criterionName: string;
  reason: string;
}

/**
 * 全表校验，按表格顺序返回所有不合格单元格。
 *
 * 提交前调用；返回空数组表示可以提交。第一项即最该带用户去的位置。
 * @param criteria 列（项点）
 * @param employees 行（职工）
 * @param values 当前填写内容
 */
export function collectScoreErrors(
  criteria: CriterionDto[],
  employees: EmployeeDto[],
  values: ScoreValues,
): CellError[] {
  const errors: CellError[] = [];
  employees.forEach((employee, rowIndex) => {
    criteria.forEach((criterion, colIndex) => {
      const raw = values[employee.id]?.[criterion.id] ?? '';
      const reason = validateScore(raw, criterion.minScore, criterion.maxScore);
      if (reason === null) return;
      errors.push({
        row: rowIndex + 1,
        col: colIndex + 1,
        employeeId: employee.id,
        criterionId: criterion.id,
        employeeName: employee.name,
        criterionName: criterion.name,
        reason,
      });
    });
  });
  return errors;
}

/** 网格移动键 → [行增量, 列增量]。Enter 与 Excel 一致地向下走。 */
const MOVE_KEYS: Record<string, readonly [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
  Enter: [1, 0],
};

/** 未触碰的空集合常量：保持引用稳定，避免整表因新对象而无谓重渲染。 */
const NO_TOUCHED: ReadonlySet<string> = new Set();

/** 读屏专用：错误原因要念得出来，但不占版面（global.css 里没有 sr-only 类）。 */
const SR_ONLY: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
};

/** 聚焦某格并选中已有内容，方便直接覆盖录入。 */
function focusCell(container: HTMLElement | null, row: number, col: number): void {
  const input = container?.querySelector<HTMLInputElement>(`[data-row="${row}"][data-col="${col}"]`);
  if (!input) return;
  input.focus();
  try {
    input.select();
  } catch {
    // type="number" 不支持 select()（浏览器抛 InvalidStateError）；焦点已到位，忽略即可
  }
}

export interface ScoreTableProps {
  criteria: CriterionDto[];
  employees: EmployeeDto[];
  values: ScoreValues;
  onChange: (employeeId: string, criterionId: string, raw: string) => void;
  /**
   * 提交被拦下后由页面传入的不合格单元格集合（含未填写）。
   * 平时不传：空格不标红，否则一进页面整张表全红，反而看不出真正填错的地方。
   */
  invalidCells?: ReadonlySet<string>;
  /** 请求把焦点移到某格（行列从 0 开始）；页面用它把职工带到具体某一格。 */
  focusTarget?: { row: number; col: number } | null;
  /**
   * 只把该行所在的页翻到眼前，不抢焦点。
   *
   * 提交失败时焦点归 error summary 的标题，但表格仍要翻到有错的那一页，
   * 职工点 summary 里的链接时再走 focusTarget 精确聚焦。
   */
  revealTarget?: { row: number; col: number } | null;
}

/** 类 Excel 打分表：行 = 职工，列 = 素质项点，单元格只能填整数。 */
export function ScoreTable({
  criteria,
  employees,
  values,
  onChange,
  invalidCells,
  focusTarget,
  revealTarget,
}: ScoreTableProps) {
  const { token } = theme.useToken();
  const containerRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  // 翻页后要等新一页渲染出来才能聚焦，所以先把目标存下来交给 effect
  const [pendingFocus, setPendingFocus] = useState<{ row: number; col: number } | null>(null);
  /**
   * 「已离开过」的格子（blur 校验）。
   *
   * 只登记离开时仍不合格的格子：合法的格子不必进集合，
   * 否则每切换一次格子都会让整张表重渲染。
   */
  const [touched, setTouched] = useState<ReadonlySet<string>>(NO_TOUCHED);

  const pageCount = Math.max(1, Math.ceil(employees.length / PAGE_SIZE));
  const start = Math.min(page, pageCount - 1) * PAGE_SIZE;
  const pageEmployees = employees.slice(start, start + PAGE_SIZE);

  // 换部门或换项点会整批换行，页码与「已触碰」记录一起清掉
  useEffect(() => {
    setPage(0);
    setTouched(NO_TOUCHED);
  }, [employees, criteria]);

  useEffect(() => {
    if (focusTarget === null || focusTarget === undefined) return;
    setPage(Math.min(Math.floor(focusTarget.row / PAGE_SIZE), pageCount - 1));
    setPendingFocus(focusTarget);
  }, [focusTarget, pageCount]);

  // 只翻页、不聚焦：焦点留给页面顶部的 error summary；滚到该页页首，别让错误行留在视野外
  useEffect(() => {
    if (revealTarget === null || revealTarget === undefined) return;
    setPage(Math.min(Math.floor(revealTarget.row / PAGE_SIZE), pageCount - 1));
    if (containerRef.current !== null) containerRef.current.scrollTop = 0;
  }, [revealTarget, pageCount]);

  useEffect(() => {
    if (pendingFocus === null) return;
    focusCell(containerRef.current, pendingFocus.row, pendingFocus.col);
    setPendingFocus(null);
  }, [pendingFocus, page]);

  /** 离开格子时才登记：空格的「未填写」属于 blur 校验，不打断正在输入的人。 */
  const handleBlur = useCallback((employeeId: string, criterionId: string) => {
    setTouched((prev) => {
      const key = cellKey(employeeId, criterionId);
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>, row: number, col: number) => {
      const move = MOVE_KEYS[event.key];
      if (move === undefined) return;
      const nextRow = row + move[0];
      const nextCol = col + move[1];
      if (nextRow < 0 || nextRow >= employees.length) return;
      if (nextCol < 0 || nextCol >= criteria.length) return;
      // 方向键会滚动页面、Enter 可能触发外层表单；进网格后这些键都归我们接管
      event.preventDefault();
      const nextPage = Math.floor(nextRow / PAGE_SIZE);
      if (nextPage === page) {
        focusCell(containerRef.current, nextRow, nextCol);
        return;
      }
      // 跨页移动：先切页，等渲染完成再由 effect 聚焦
      setPage(nextPage);
      setPendingFocus({ row: nextRow, col: nextCol });
    },
    [criteria.length, employees.length, page],
  );

  return (
    <div>
      <div
        ref={containerRef}
        style={{
          overflow: 'auto',
          maxHeight: '68vh',
          // antd 标准边框色 + 大圆角；格线由 global.css 的 .score-table 提供
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadiusLG,
          background: token.colorBgContainer,
        }}
      >
        <table className="score-table">
          <thead>
            <tr>
              <th scope="col" className="sticky-col">
                职工
              </th>
              {criteria.map((criterion) => (
                <th key={criterion.id} scope="col" className="num">
                  <div>{criterion.name}</div>
                  {/* 允许区间写在表头，职工不用去别处找；也是每格 aria-describedby 的目标 */}
                  <span className="range-hint" id={rangeElementId(criterion.id)}>
                    {criterion.minScore}–{criterion.maxScore} 分
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageEmployees.map((employee, index) => (
              <ScoreRow
                key={employee.id}
                employee={employee}
                rowIndex={start + index}
                criteria={criteria}
                rowValues={values[employee.id]}
                invalidCells={invalidCells}
                touched={touched}
                onChange={onChange}
                onBlurCell={handleBlur}
                onKeyDown={handleKeyDown}
              />
            ))}
          </tbody>
        </table>
      </div>

      {pageCount > 1 ? (
        <Flex className="no-print" align="center" gap={12} wrap style={{ marginTop: 12 }}>
          <Button disabled={page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>
            上一页
          </Button>
          <Typography.Text type="secondary">
            第 {page + 1} / {pageCount} 页 · 共 {employees.length} 人 · 已填内容跨页保留
          </Typography.Text>
          <Button
            disabled={page >= pageCount - 1}
            onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
          >
            下一页
          </Button>
        </Flex>
      ) : null}
    </div>
  );
}

interface ScoreRowProps {
  employee: EmployeeDto;
  rowIndex: number;
  criteria: CriterionDto[];
  rowValues: Record<string, string> | undefined;
  invalidCells?: ReadonlySet<string>;
  touched: ReadonlySet<string>;
  onChange: (employeeId: string, criterionId: string, raw: string) => void;
  onBlurCell: (employeeId: string, criterionId: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>, row: number, col: number) => void;
}

/**
 * 一行职工。用 memo 隔开：连续录入时只有正在输入的那一行重渲染，
 * 50 行 × 十几列的场景下这是「不卡手」的前提。
 */
const ScoreRow = memo(function ScoreRow({
  employee,
  rowIndex,
  criteria,
  rowValues,
  invalidCells,
  touched,
  onChange,
  onBlurCell,
  onKeyDown,
}: ScoreRowProps) {
  return (
    <tr>
      <th scope="row" className="sticky-col">
        <div style={{ fontWeight: 500 }}>
          {rowIndex + 1}. {employee.name}
        </div>
        {employee.employeeNo === null ? null : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            工号 {employee.employeeNo}
          </Typography.Text>
        )}
      </th>
      {criteria.map((criterion, colIndex) => {
        const raw = rowValues?.[criterion.id] ?? '';
        const key = cellKey(employee.id, criterion.id);
        const reason = validateScore(raw, criterion.minScore, criterion.maxScore);
        /**
         * 标红有三个来源（顺序即优先级）：
         *   1. 提交被拦下（页面传入 invalidCells）—— 全表一次性标出；
         *   2. blur 校验：离开格子时仍不合格，空格也算（不再等到提交才发现漏填）；
         *   3. 输入即时报错：已经写了内容却不合法，当场纠正比填完再返工省事。
         * 修好后 reason 变 null，标红与 aria-invalid 立刻撤销。
         */
        const invalid =
          reason !== null && (invalidCells?.has(key) === true || raw.trim() !== '' || touched.has(key));
        const rangeId = rangeElementId(criterion.id);
        const errorId = `err-${employee.id}-${criterion.id}`;
        return (
          <td key={criterion.id} className="num">
            <input
              id={cellElementId(employee.id, criterion.id)}
              // 44px 触摸高度（WCAG 2.5.5）由 global.css 的 .cell-input 保证，不再内联
              className={invalid ? 'cell-input invalid' : 'cell-input'}
              type="number"
              step={1}
              min={criterion.minScore}
              max={criterion.maxScore}
              inputMode="numeric"
              autoComplete="off"
              value={raw}
              data-row={rowIndex}
              data-col={colIndex}
              aria-label={`第 ${rowIndex + 1} 行 ${employee.name} 的${criterion.name}`}
              aria-describedby={invalid ? `${rangeId} ${errorId}` : rangeId}
              aria-invalid={invalid || undefined}
              // 格内错误说明：鼠标悬停能看到，读屏由 aria-describedby 念出来
              title={invalid ? (reason ?? undefined) : undefined}
              onChange={(event) => onChange(employee.id, criterion.id, event.target.value)}
              onBlur={() => {
                // 合法就不登记，避免每次切格都让整张表重渲染
                if (reason !== null) onBlurCell(employee.id, criterion.id);
              }}
              onKeyDown={(event) => onKeyDown(event, rowIndex, colIndex)}
            />
            {invalid ? (
              <span id={errorId} style={SR_ONLY}>
                {reason}
              </span>
            ) : null}
          </td>
        );
      })}
    </tr>
  );
});