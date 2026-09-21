import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import type { VoteColumnBrief, VoteCriterionDto } from '../../lib/api.js';

/**
 * 打分表（与 docs/参考表.xlsx 的结构一一对应）。
 *
 * 表形来自参考表：抬头（附件号）→ 表标题 → 列头（序号 / 项点 / 各被评列）
 * → 项点行（序号 + 项点名称与描述 + 每列一个分数格）→ 表尾填写说明。
 *
 * 手感仍然是给普通职工用的：Tab 走原生顺序连续录入，方向键与 Enter 在网格内移动，
 * 所以用原生 table + 原生 input，而不是 antd 的受控表格组件（后者的键盘顺序与
 * 滚动容器都不受我们控制）。项点行通常只有几行，不再分页。
 *
 * 无障碍：每格都有固定 id（`cell-<被评列>-<项点>`），提交失败时的 error summary 用它
 * 逐条链接到出错的那一格；区间说明以 aria-describedby 关联，非法时 aria-invalid
 * 并把原因读给读屏听。标红只是给明眼人的提示，不是唯一表意手段。
 */

/** 打分表数据：被评列 id → 项点 id → 输入框原文（提交时才转成整数）。 */
export type ScoreValues = Record<string, Record<string, string>>;

/** 单元格唯一键，用于标红集合与定位。 */
export function cellKey(voteColumnId: string, criterionId: string): string {
  return `${voteColumnId}:${criterionId}`;
}

/**
 * 单元格的 DOM id，同时也是 error summary 里链接的锚点。
 *
 * 用 id 而不是行列号：行列号会随部门切换变化，被评列 + 项点才是稳定的，
 * 这样错误条目总能跳回正确的那一格。
 */
export function cellElementId(voteColumnId: string, criterionId: string): string {
  return `cell-${voteColumnId}-${criterionId}`;
}

/** 区间说明的 id：项点行里的隐藏说明与每格的 aria-describedby 必须指向同一个元素。 */
export function rangeElementId(criterionId: string): string {
  return `range-${criterionId}`;
}

/**
 * 校验单个分数输入。
 *
 * 后端同样只接受整数，前端先拦是为了让职工当场看到哪一格有问题，
 * 而不是填完几十格才被服务端整单退回。
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

/** 单个不合格单元格。行列均从 1 开始，与职工看到的序号、列序一致。 */
export interface CellError {
  row: number;
  col: number;
  voteColumnId: string;
  criterionId: string;
  voteColumnName: string;
  criterionName: string;
  reason: string;
}

/**
 * 全表校验，按表格顺序返回所有不合格单元格。
 *
 * 提交前调用；返回空数组表示可以提交。第一项即最该带用户去的位置。
 * @param criteria 行（项点）
 * @param voteColumns 列（被评列）
 * @param values 当前填写内容
 */
export function collectScoreErrors(
  criteria: VoteCriterionDto[],
  voteColumns: VoteColumnBrief[],
  values: ScoreValues,
): CellError[] {
  const errors: CellError[] = [];
  criteria.forEach((criterion, rowIndex) => {
    voteColumns.forEach((column, colIndex) => {
      const raw = values[column.id]?.[criterion.id] ?? '';
      const reason = validateScore(raw, criterion.minScore, criterion.maxScore);
      if (reason === null) return;
      errors.push({
        row: rowIndex + 1,
        col: colIndex + 1,
        voteColumnId: column.id,
        criterionId: criterion.id,
        voteColumnName: column.name,
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
  criteria: VoteCriterionDto[];
  voteColumns: VoteColumnBrief[];
  /** 问卷类型：person = 个人问卷（表头两行），workshop = 车间问卷（表头单行） */
  questionnaireType: string;
  /** 左上角附件号，如「附件1-1」 */
  headerNote: string;
  /** 表标题，如「xx车间负责人评价问卷」；留空则不渲染该行 */
  title: string;
  /** 表尾填写说明；留空则不渲染该行 */
  footerNote: string;
  values: ScoreValues;
  onChange: (voteColumnId: string, criterionId: string, raw: string) => void;
  /**
   * 提交被拦下后由页面传入的不合格单元格集合（含未填写）。
   * 平时不传：空格不标红，否则一进页面整张表全红，反而看不出真正填错的地方。
   */
  invalidCells?: ReadonlySet<string>;
  /** 请求把焦点移到某格（行列从 0 开始）；页面用它把职工带到具体某一格。 */
  focusTarget?: { row: number; col: number } | null;
}

/** 打分表：行 = 评价项点，列 = 被评列，单元格只能填整数。 */
export function ScoreTable({
  criteria,
  voteColumns,
  questionnaireType,
  headerNote,
  title,
  footerNote,
  values,
  onChange,
  invalidCells,
  focusTarget,
}: ScoreTableProps) {
  const tableRef = useRef<HTMLTableElement>(null);
  /**
   * 「已离开过」的格子（blur 校验）。
   *
   * 只登记离开时仍不合格的格子：合法的格子不必进集合，
   * 否则每切换一次格子都会让整张表重渲染。
   */
  const [touched, setTouched] = useState<ReadonlySet<string>>(NO_TOUCHED);

  // 换部门或换项点/被评列会整批换行，把「已触碰」记录清掉
  useEffect(() => {
    setTouched(NO_TOUCHED);
  }, [criteria, voteColumns]);

  useEffect(() => {
    if (focusTarget === null || focusTarget === undefined) return;
    focusCell(tableRef.current, focusTarget.row, focusTarget.col);
  }, [focusTarget]);

  /** 离开格子时才登记：空格的「未填写」属于 blur 校验，不打断正在输入的人。 */
  const handleBlur = useCallback((voteColumnId: string, criterionId: string) => {
    setTouched((prev) => {
      const key = cellKey(voteColumnId, criterionId);
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
      if (nextRow < 0 || nextRow >= criteria.length) return;
      if (nextCol < 0 || nextCol >= voteColumns.length) return;
      // 方向键会滚动页面、Enter 可能触发外层表单；进网格后这些键都归我们接管
      event.preventDefault();
      focusCell(tableRef.current, nextRow, nextCol);
    },
    [criteria.length, voteColumns.length],
  );

  const columnCount = 2 + voteColumns.length;
  /**
   * 个人问卷的表头是两行：各被评列的列名只占第一行，第二行留空
   * （参考表里 C..G 上下两格并未合并，列名落在上半格），
   * 「序号」与「职务与姓名 / 评价项点」则跨两行。
   * 车间问卷只有一行：`序号 | 项点 | 得分`。
   */
  const twoRowHeader = questionnaireType !== 'workshop';

  return (
    <div
      style={{
        overflowX: 'auto',
        // 参考表是全表黑色细实线框，格线由 global.css 的 .score-table 提供
        background: '#fff',
      }}
    >
      <table
        className={`score-table ${questionnaireType === 'workshop' ? 'workshop' : 'person'}`}
        ref={tableRef}
      >
        <thead>
          {headerNote.trim() === '' ? null : (
            // 参考表左上角的「附件1-1」：只占前两列宽、左对齐，且不带框线
            <tr>
              <th colSpan={2} className="sheet-caption">
                {headerNote}
              </th>
              {voteColumns.map((column) => (
                <th key={column.id} className="sheet-caption" aria-hidden="true" />
              ))}
            </tr>
          )}
          {title.trim() === '' ? null : (
            <tr>
              <th colSpan={columnCount} className="sheet-title">
                {title}
              </th>
            </tr>
          )}
          <tr>
            <th rowSpan={twoRowHeader ? 2 : 1} className="row-no">
              序号
            </th>
            <th rowSpan={twoRowHeader ? 2 : 1} className="criterion-head">
              {twoRowHeader ? (
                <>
                  {/* 参考表的写法：「职务与姓名」靠右、「评价项点」靠左，两行错开 */}
                  <span className="head-name">职务与姓名</span>
                  <span className="head-criterion">评价项点</span>
                </>
              ) : (
                '项点'
              )}
            </th>
            {voteColumns.map((column) => (
              <th key={column.id} className="num">
                {column.name}
              </th>
            ))}
          </tr>
          {twoRowHeader ? (
            <tr>
              {voteColumns.map((column) => (
                <th key={column.id} className="num">
                  {column.employeeName ?? ''}
                </th>
              ))}
            </tr>
          ) : null}
        </thead>
        <tbody>
          {criteria.map((criterion, rowIndex) => (
            <CriterionRow
              key={criterion.id}
              criterion={criterion}
              rowIndex={rowIndex}
              voteColumns={voteColumns}
              rowValues={values}
              invalidCells={invalidCells}
              touched={touched}
              onChange={onChange}
              onBlurCell={handleBlur}
              onKeyDown={handleKeyDown}
            />
          ))}
        </tbody>
        {footerNote.trim() === '' ? null : (
          <tfoot>
            <tr>
              <td colSpan={columnCount} className="sheet-footer">
                {footerNote}
              </td>
            </tr>
          </tfoot>
        )}
      </table>

      {/*
        允许区间：不占版面，每格的 aria-describedby 指向这里。
        刻意放在表格外：放进项点单元格会被算进 rowheader 的可访问名称，
        读屏念项点时会与 aria-describedby 重复播报一次。
      */}
      <div style={SR_ONLY}>
        {criteria.map((criterion) => (
          <span key={criterion.id} id={rangeElementId(criterion.id)}>
            {criterion.name}可填 {criterion.minScore} 到 {criterion.maxScore} 的整数
          </span>
        ))}
      </div>
    </div>
  );
}

interface CriterionRowProps {
  criterion: VoteCriterionDto;
  rowIndex: number;
  voteColumns: VoteColumnBrief[];
  rowValues: ScoreValues;
  invalidCells?: ReadonlySet<string>;
  touched: ReadonlySet<string>;
  onChange: (voteColumnId: string, criterionId: string, raw: string) => void;
  onBlurCell: (voteColumnId: string, criterionId: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>, row: number, col: number) => void;
}

/**
 * 一个项点行。用 memo 隔开：连续录入时只有正在输入的那一行重渲染，
 * 项点行多、被评列多时这是「不卡手」的前提。
 */
const CriterionRow = memo(function CriterionRow({
  criterion,
  rowIndex,
  voteColumns,
  rowValues,
  invalidCells,
  touched,
  onChange,
  onBlurCell,
  onKeyDown,
}: CriterionRowProps) {
  const rangeId = rangeElementId(criterion.id);
  const description = criterion.description?.trim() ?? '';
  return (
    <tr>
      <td className="row-no">
        <span className="tabular">{rowIndex + 1}</span>
      </td>
      <th scope="row" className="criterion-cell">
        {/*
          参考表的这一格是「政治素质：」换行后接缩进四格的描述，冒号属于项点名与描述之间的
          分隔符，不存进后台的项点名称里（否则管理员每配一项都要自己敲冒号）。
        */}
        <div className="criterion-name">
          {criterion.name}
          {description === '' ? '' : '：'}
        </div>
        {description === '' ? null : <div className="criterion-desc">{criterion.description}</div>}
      </th>
      {voteColumns.map((column, colIndex) => {
        const raw = rowValues[column.id]?.[criterion.id] ?? '';
        const key = cellKey(column.id, criterion.id);
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
        const errorId = `err-${column.id}-${criterion.id}`;
        return (
          <td key={column.id} className="num">
            <input
              id={cellElementId(column.id, criterion.id)}
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
              aria-label={`第 ${rowIndex + 1} 项 ${criterion.name} —— ${column.name}`}
              aria-describedby={invalid ? `${rangeId} ${errorId}` : rangeId}
              aria-invalid={invalid || undefined}
              // 格内错误说明：鼠标悬停能看到，读屏由 aria-describedby 念出来
              title={invalid ? (reason ?? undefined) : undefined}
              onChange={(event) => onChange(column.id, criterion.id, event.target.value)}
              onBlur={() => {
                // 合法就不登记，避免每次切格都让整张表重渲染
                if (reason !== null) onBlurCell(column.id, criterion.id);
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