import { fireEvent, render, screen } from '@testing-library/react';
import { useCallback, useState } from 'react';
import type { VoteColumnBrief } from '../../lib/api.js';
import { ScoreTable, cellKey, collectScoreErrors, validateScore } from './ScoreTable.js';
import type { CellError, ScoreValues } from './ScoreTable.js';
import type { VoteCriterionDto } from '../../lib/api.js';

/**
 * 打分表的测试。
 *
 * 表形与 docs/参考表.xlsx 一致：行 = 评价项点，列 = 被评列。
 * 这里刻意用受控外壳（Harness）而不是直接渲染组件：打分表本身只负责渲染与即时标红，
 * 「填满且合法才能提交」是页面用 collectScoreErrors 做的门禁，两者一起才是职工真实走的路。
 */

const CRITERIA: VoteCriterionDto[] = [
  { id: 'c1', name: '政治素质', description: '信念坚定、对党忠诚。', minScore: 0, maxScore: 10 },
  { id: 'c2', name: '敬业担当', description: null, minScore: 5, maxScore: 20 },
];

const VOTE_COLUMNS: VoteColumnBrief[] = [
  { id: 'v1', name: '主任' },
  { id: 'v2', name: '党支部书记' },
];

/** 单元格位置：[项点行, 被评列]。 */
function cellAt(row: number, col: number): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(`[data-row="${row}"][data-col="${col}"]`);
  if (input === null) throw new Error(`没有找到第 ${row} 行第 ${col} 列的输入框`);
  return input;
}

function cellInputs(): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>('.cell-input')];
}

function fill(row: number, col: number, value: string): void {
  fireEvent.change(cellAt(row, col), { target: { value } });
}

interface HarnessProps {
  criteria?: VoteCriterionDto[];
  voteColumns?: VoteColumnBrief[];
  questionnaireType?: string;
  headerNote?: string;
  title?: string;
  footerNote?: string;
  onSubmit?: () => void;
}

/** 受控外壳：值与校验结果放在父级，模拟打分表页的真实用法。 */
function Harness({
  criteria = CRITERIA,
  voteColumns = VOTE_COLUMNS,
  questionnaireType = 'person',
  headerNote = '附件1-1',
  title = 'xx车间负责人评价问卷',
  footerNote = '填写说明：每一条评价项点满分20分，弃权、不填视为0分。',
  onSubmit = () => undefined,
}: HarnessProps) {
  const [values, setValues] = useState<ScoreValues>({});
  const [invalidCells, setInvalidCells] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<CellError[]>([]);

  const onChange = useCallback((voteColumnId: string, criterionId: string, raw: string) => {
    setValues((prev) => ({ ...prev, [voteColumnId]: { ...prev[voteColumnId], [criterionId]: raw } }));
  }, []);

  const submit = () => {
    const found = collectScoreErrors(criteria, voteColumns, values);
    setErrors(found);
    setInvalidCells(new Set(found.map((item) => cellKey(item.voteColumnId, item.criterionId))));
    if (found.length === 0) onSubmit();
  };

  return (
    <div>
      <ScoreTable
        criteria={criteria}
        voteColumns={voteColumns}
        questionnaireType={questionnaireType}
        headerNote={headerNote}
        title={title}
        footerNote={footerNote}
        values={values}
        onChange={onChange}
        invalidCells={invalidCells}
      />
      <button type="button" onClick={submit}>
        提交
      </button>
      <ul data-testid="errors">
        {errors.map((item) => (
          <li key={cellKey(item.voteColumnId, item.criterionId)}>
            第 {item.row} 项「{item.criterionName}」的「{item.voteColumnName}」：{item.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

describe('ScoreTable 渲染（参考表版式）', () => {
  it('抬头、表标题、序号列、项点行、填写说明都按参考表渲染', () => {
    render(<Harness />);

    // 抬头与标题（都在表格上方，无框线）
    expect(screen.getByText('附件1-1')).toBeInTheDocument();
    expect(screen.getByText('xx车间负责人评价问卷')).toBeInTheDocument();
    // 序号列 + 项点列表头（由两行文字组成）
    expect(screen.getByRole('columnheader', { name: '序号' })).toBeInTheDocument();
    expect(screen.getByText('职务与姓名')).toBeInTheDocument();
    expect(screen.getByText('评价项点')).toBeInTheDocument();
    // 被评列就是列头
    expect(screen.getByRole('columnheader', { name: '主任' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '党支部书记' })).toBeInTheDocument();
    // 行 = 项点（含描述）
    expect(screen.getByRole('rowheader', { name: /政治素质/ })).toBeInTheDocument();
    expect(screen.getByText('信念坚定、对党忠诚。')).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: /敬业担当/ })).toBeInTheDocument();
    // 填写说明合并整行
    expect(screen.getByText(/弃权、不填视为0分/)).toBeInTheDocument();
    // 序号 1、2
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('个人问卷的表头是两行：列名只占第一行，第二行留空；序号与项点跨两行', () => {
    const { container } = render(<Harness />);
    const headRows = container.querySelectorAll('.score-table thead tr');
    // 附件行 + 标题行 + 表头两行
    expect(headRows).toHaveLength(4);

    const [captionRow, titleRow, firstHeadRow, secondHeadRow] = headRows;
    expect(captionRow?.querySelector('th')?.textContent).toBe('附件1-1');
    expect(titleRow?.querySelector('th')?.textContent).toBe('xx车间负责人评价问卷');

    // 第一行：序号(rowSpan=2) + 项点(rowSpan=2) + 各被评列
    const first = [...(firstHeadRow?.children ?? [])] as HTMLTableCellElement[];
    expect(first.map((cell) => cell.textContent)).toEqual([
      '序号',
      '职务与姓名评价项点',
      '主任',
      '党支部书记',
    ]);
    expect(first[0]?.rowSpan).toBe(2);
    expect(first[1]?.rowSpan).toBe(2);
    expect(first[2]?.rowSpan).toBe(1);

    // 第二行只有各被评列的空格，数量与列数一致
    expect(secondHeadRow?.children).toHaveLength(2);

    // 「职务与姓名」靠右、「评价项点」靠左（参考表用两行错位代替斜线）
    expect(first[1]?.querySelector('.head-name')).not.toBeNull();
    expect(first[1]?.querySelector('.head-criterion')).not.toBeNull();
  });

  it('车间问卷的表头是单行「序号 / 项点 / 得分」', () => {
    const { container } = render(
      <Harness questionnaireType="workshop" voteColumns={[{ id: 'v9', name: '得分' }]} />,
    );

    const headRows = container.querySelectorAll('.score-table thead tr');
    expect(headRows).toHaveLength(3);
    const headCells = [...(headRows[2]?.children ?? [])] as HTMLTableCellElement[];
    expect(headCells.map((cell) => cell.textContent)).toEqual(['序号', '项点', '得分']);
    expect(headCells.every((cell) => cell.rowSpan === 1)).toBe(true);
    // 车间问卷的表格带 workshop 类（列头字号用 12pt 那一档）
    expect(container.querySelector('.score-table')?.classList.contains('workshop')).toBe(true);
  });

  it('抬头、标题、填写说明留空时不渲染对应行', () => {
    render(<Harness headerNote="" title="" footerNote="   " />);

    expect(screen.queryByText('附件1-1')).not.toBeInTheDocument();
    expect(screen.queryByText('xx车间负责人评价问卷')).not.toBeInTheDocument();
    // 表头仍然是完整的：序号 + 项点 + 被评列
    expect(screen.getByRole('columnheader', { name: '序号' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '主任' })).toBeInTheDocument();
  });

  it('按项点渲染行、按被评列渲染列，每格带 min/max/step', () => {
    render(<Harness />);

    // 2 行 × 2 列
    expect(cellInputs()).toHaveLength(4);

    const first = cellAt(0, 0);
    expect(first).toHaveAttribute('type', 'number');
    expect(first).toHaveAttribute('step', '1');
    expect(first).toHaveAttribute('min', '0');
    expect(first).toHaveAttribute('max', '10');

    const second = cellAt(1, 0);
    expect(second).toHaveAttribute('min', '5');
    expect(second).toHaveAttribute('max', '20');
  });

  it('每格的可访问名称同时点明项点与被评列', () => {
    render(<Harness />);

    expect(cellAt(0, 0)).toHaveAttribute('aria-label', '第 1 项 政治素质 —— 主任');
    expect(cellAt(1, 1)).toHaveAttribute('aria-label', '第 2 项 敬业担当 —— 党支部书记');
  });
});

describe('ScoreTable 校验与标红', () => {
  it('输入小数判为非法并标红，改成整数后恢复', () => {
    render(<Harness />);

    expect(cellAt(0, 0)).not.toHaveClass('invalid');
    fill(0, 0, '3.5');
    expect(cellAt(0, 0)).toHaveClass('invalid');
    expect(cellAt(0, 0)).toHaveAttribute('aria-invalid', 'true');

    fill(0, 0, '3');
    expect(cellAt(0, 0)).not.toHaveClass('invalid');
    expect(cellAt(0, 0)).not.toHaveAttribute('aria-invalid');
  });

  it('越界判为非法，边界值合法', () => {
    render(<Harness />);

    fill(0, 0, '11');
    expect(cellAt(0, 0)).toHaveClass('invalid');
    fill(0, 0, '-1');
    expect(cellAt(0, 0)).toHaveClass('invalid');

    fill(0, 0, '0');
    expect(cellAt(0, 0)).not.toHaveClass('invalid');
    fill(0, 0, '10');
    expect(cellAt(0, 0)).not.toHaveClass('invalid');

    fill(1, 0, '4');
    expect(cellAt(1, 0)).toHaveClass('invalid');
    fill(1, 0, '5');
    expect(cellAt(1, 0)).not.toHaveClass('invalid');
    fill(1, 0, '20');
    expect(cellAt(1, 0)).not.toHaveClass('invalid');
  });

  it('空格平时不标红，提交被拦下后才标红', () => {
    render(<Harness />);

    expect(cellAt(0, 0)).not.toHaveClass('invalid');
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    expect(cellAt(0, 0)).toHaveClass('invalid');
    expect(cellAt(0, 0)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('errors').textContent).toContain(
      '第 1 项「政治素质」的「主任」：未填写',
    );
  });
});

describe('ScoreTable 键盘导航', () => {
  it('方向键与 Enter 在网格内移动焦点，到边界不动', () => {
    render(<Harness />);

    cellAt(0, 0).focus();
    expect(document.activeElement).toBe(cellAt(0, 0));

    fireEvent.keyDown(cellAt(0, 0), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cellAt(0, 1));

    fireEvent.keyDown(cellAt(0, 1), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cellAt(1, 1));

    // 最后一行按 Enter 不应跳出行外
    fireEvent.keyDown(cellAt(1, 1), { key: 'Enter' });
    expect(document.activeElement).toBe(cellAt(1, 1));

    fireEvent.keyDown(cellAt(1, 1), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(cellAt(1, 0));

    fireEvent.keyDown(cellAt(1, 0), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(cellAt(0, 0));

    // 最上行与最左列都停在原地
    fireEvent.keyDown(cellAt(0, 0), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(cellAt(0, 0));
    fireEvent.keyDown(cellAt(0, 0), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(cellAt(0, 0));
  });
});

describe('填满且合法才能提交', () => {
  it('全部填满且合法时提交成功', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);

    // 行是项点、列是被评列：c1 区间 0–10，c2 区间 5–20
    fill(0, 0, '8');
    fill(0, 1, '10');
    fill(1, 0, '6');
    fill(1, 1, '9');
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('errors')).toBeEmptyDOMElement();
    expect(cellInputs().some((input) => input.classList.contains('invalid'))).toBe(false);
  });

  it('有小数或越界时拦下提交并指到具体项点与被评列', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);

    fill(0, 0, '3.5');
    fill(0, 1, '12');
    fill(1, 0, '6');
    fill(1, 1, '9');
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId('errors').textContent).toContain(
      '第 1 项「政治素质」的「主任」：只能填整数',
    );
  });
});

describe('validateScore', () => {
  it('只接受区间内的整数写法', () => {
    expect(validateScore('', 0, 10)).toBe('未填写');
    expect(validateScore('3.5', 0, 10)).toBe('只能填整数');
    expect(validateScore('1e2', 0, 10)).toBe('只能填整数');
    expect(validateScore('abc', 0, 10)).toBe('只能填整数');
    expect(validateScore('11', 0, 10)).toBe('需在 0–10 之间');
    expect(validateScore(' 7 ', 0, 10)).toBeNull();
    expect(validateScore('0', 0, 10)).toBeNull();
    expect(validateScore('10', 0, 10)).toBeNull();
  });
});

describe('打分表的无障碍关联', () => {
  it('每格有稳定的锚点 id，并用 aria-describedby 关联该项点的区间说明', () => {
    render(<Harness />);

    const cell = cellAt(0, 0);
    expect(cell).toHaveAttribute('id', 'cell-v1-c1');
    expect(cell).toHaveAttribute('aria-describedby', 'range-c1');

    const hint = document.getElementById('range-c1');
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toBe('政治素质可填 0 到 10 的整数');
  });

  it('非法时把错误原因也挂进 aria-describedby，并保留格内 title 作 inline 错误', () => {
    render(<Harness />);

    fireEvent.change(cellAt(0, 0), { target: { value: '3.5' } });

    const cell = cellAt(0, 0);
    expect(cell).toHaveAttribute('aria-describedby', 'range-c1 err-v1-c1');
    expect(cell).toHaveAttribute('title', '只能填整数');
    expect(document.getElementById('err-v1-c1')?.textContent).toBe('只能填整数');

    // 修好后关联退化回区间说明，标红与 title 一起撤销
    fireEvent.change(cell, { target: { value: '3' } });
    expect(cell).toHaveAttribute('aria-describedby', 'range-c1');
    expect(cell).not.toHaveAttribute('title');
    expect(document.getElementById('err-v1-c1')).toBeNull();
  });
});

describe('打分表的 blur 校验', () => {
  it('空格平时不标红，离开格子后当场标红，填上合法值即撤销', () => {
    render(<Harness />);

    expect(cellAt(0, 0)).not.toHaveClass('invalid');

    fireEvent.blur(cellAt(0, 0));
    expect(cellAt(0, 0)).toHaveClass('invalid');
    expect(cellAt(0, 0)).toHaveAttribute('aria-invalid', 'true');
    expect(cellAt(0, 0)).toHaveAttribute('title', '未填写');

    fill(0, 0, '6');
    expect(cellAt(0, 0)).not.toHaveClass('invalid');
    expect(cellAt(0, 0)).not.toHaveAttribute('aria-invalid');
  });

  it('离开时合法的格子不进标红集合', () => {
    render(<Harness />);

    fill(0, 0, '6');
    fireEvent.blur(cellAt(0, 0));

    expect(cellAt(0, 0)).not.toHaveClass('invalid');
    expect(cellInputs().some((input) => input.classList.contains('invalid'))).toBe(false);
  });
});

describe('投票端的触摸目标', () => {
  it('每格输入都挂 .cell-input，44px 触摸高度由 global.css 保证（不再内联 minHeight）', () => {
    render(<Harness />);

    const inputs = cellInputs();
    expect(inputs).toHaveLength(4);
    for (const input of inputs) {
      expect(input).toHaveClass('cell-input');
      expect(input.style.minHeight).toBe('');
    }
  });
});