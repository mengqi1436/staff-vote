import { fireEvent, render, screen } from '@testing-library/react';
import { useCallback, useState } from 'react';
import type { CriterionDto, EmployeeDto } from '../../lib/api.js';
import { ScoreTable, cellKey, collectScoreErrors, validateScore } from './ScoreTable.js';
import type { CellError, ScoreValues } from './ScoreTable.js';

/**
 * 打分表的测试。
 *
 * 这里刻意用受控外壳（Harness）而不是直接渲染组件：打分表本身只负责渲染与即时标红，
 * 「填满且合法才能提交」是页面用 collectScoreErrors 做的门禁，两者一起才是职工真实走的路。
 */

const CRITERIA: CriterionDto[] = [
  { id: 'c1', name: '工作质量', minScore: 0, maxScore: 10, sortOrder: 1, enabled: true },
  { id: 'c2', name: '工作效率', minScore: 5, maxScore: 20, sortOrder: 2, enabled: true },
];

const EMPLOYEES: EmployeeDto[] = [
  { id: 'e1', name: '张三', employeeNo: 'A001', sortOrder: 1, enabled: true },
  { id: 'e2', name: '李四', employeeNo: null, sortOrder: 2, enabled: true },
];

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
  criteria?: CriterionDto[];
  employees?: EmployeeDto[];
  onSubmit?: () => void;
  revealTarget?: { row: number; col: number } | null;
}

/** 受控外壳：值与校验结果放在父级，模拟打分表页的真实用法。 */
function Harness({
  criteria = CRITERIA,
  employees = EMPLOYEES,
  onSubmit = () => undefined,
  revealTarget = null,
}: HarnessProps) {
  const [values, setValues] = useState<ScoreValues>({});
  const [invalidCells, setInvalidCells] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<CellError[]>([]);

  const onChange = useCallback((employeeId: string, criterionId: string, raw: string) => {
    setValues((prev) => ({ ...prev, [employeeId]: { ...prev[employeeId], [criterionId]: raw } }));
  }, []);

  const submit = () => {
    const found = collectScoreErrors(criteria, employees, values);
    setErrors(found);
    setInvalidCells(new Set(found.map((item) => cellKey(item.employeeId, item.criterionId))));
    if (found.length === 0) onSubmit();
  };

  return (
    <div>
      <ScoreTable
        criteria={criteria}
        employees={employees}
        values={values}
        onChange={onChange}
        invalidCells={invalidCells}
        revealTarget={revealTarget}
      />
      <button type="button" onClick={submit}>
        提交
      </button>
      <ul data-testid="errors">
        {errors.map((item) => (
          <li key={cellKey(item.employeeId, item.criterionId)}>
            第 {item.row} 行第 {item.col} 列（{item.employeeName} · {item.criterionName}）：{item.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

describe('ScoreTable 渲染', () => {
  it('按项点渲染列、按职工渲染行，每格带 min/max/step', () => {
    render(<Harness />);

    expect(screen.getByRole('columnheader', { name: /工作质量/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /工作效率/ })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: /张三/ })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: /李四/ })).toBeInTheDocument();

    // 2 行 × 2 列
    expect(cellInputs()).toHaveLength(4);

    const first = cellAt(0, 0);
    expect(first).toHaveAttribute('type', 'number');
    expect(first).toHaveAttribute('step', '1');
    expect(first).toHaveAttribute('min', '0');
    expect(first).toHaveAttribute('max', '10');

    const second = cellAt(0, 1);
    expect(second).toHaveAttribute('min', '5');
    expect(second).toHaveAttribute('max', '20');
  });

  it('超过每页行数时只渲染当前页，翻页不丢已填内容', () => {
    const many: EmployeeDto[] = Array.from({ length: 60 }, (_, index) => ({
      id: `e${index}`,
      name: `职工${index + 1}`,
      employeeNo: null,
      sortOrder: index + 1,
      enabled: true,
    }));
    render(<Harness employees={many} />);

    // 第一页 50 行 × 2 列
    expect(cellInputs()).toHaveLength(100);
    expect(screen.queryByRole('rowheader', { name: /职工60/ })).not.toBeInTheDocument();

    fill(0, 0, '7');
    fireEvent.click(screen.getByRole('button', { name: /下一页/ }));

    expect(screen.getByText(/第 2 \/ 2 页/)).toBeInTheDocument();
    expect(cellInputs()).toHaveLength(20);

    fireEvent.click(screen.getByRole('button', { name: /上一页/ }));
    expect(cellAt(0, 0)).toHaveValue(7);
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

    fill(0, 1, '4');
    expect(cellAt(0, 1)).toHaveClass('invalid');
    fill(0, 1, '5');
    expect(cellAt(0, 1)).not.toHaveClass('invalid');
    fill(0, 1, '20');
    expect(cellAt(0, 1)).not.toHaveClass('invalid');
  });

  it('空格平时不标红，提交被拦下后才标红', () => {
    render(<Harness />);

    expect(cellAt(0, 0)).not.toHaveClass('invalid');
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    expect(cellAt(0, 0)).toHaveClass('invalid');
    expect(cellAt(0, 0)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('errors').textContent).toContain('第 1 行第 1 列（张三 · 工作质量）：未填写');
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

    fill(0, 0, '8');
    fill(0, 1, '12');
    fill(1, 0, '6');
    fill(1, 1, '9');
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('errors')).toBeEmptyDOMElement();
    expect(cellInputs().some((input) => input.classList.contains('invalid'))).toBe(false);
  });

  it('有小数或越界时拦下提交并指到具体行列', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);

    fill(0, 0, '3.5');
    fill(0, 1, '12');
    fill(1, 0, '6');
    fill(1, 1, '9');
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId('errors').textContent).toContain('第 1 行第 1 列（张三 · 工作质量）：只能填整数');
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
  it('每格有稳定的锚点 id，并用 aria-describedby 关联表头的区间说明', () => {
    render(<Harness />);

    const cell = cellAt(0, 0);
    expect(cell).toHaveAttribute('id', 'cell-e1-c1');
    expect(cell).toHaveAttribute('aria-describedby', 'range-c1');

    const hint = document.getElementById('range-c1');
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toBe('0–10 分');
    expect(screen.getByRole('columnheader', { name: /工作质量/ })).toContainElement(hint);
  });

  it('非法时把错误原因也挂进 aria-describedby，并保留格内 title 作 inline 错误', () => {
    render(<Harness />);

    fireEvent.change(cellAt(0, 0), { target: { value: '3.5' } });

    const cell = cellAt(0, 0);
    expect(cell).toHaveAttribute('aria-describedby', 'range-c1 err-e1-c1');
    expect(cell).toHaveAttribute('title', '只能填整数');
    expect(document.getElementById('err-e1-c1')?.textContent).toBe('只能填整数');

    // 修好后关联退化回区间说明，标红与 title 一起撤销
    fireEvent.change(cell, { target: { value: '3' } });
    expect(cell).toHaveAttribute('aria-describedby', 'range-c1');
    expect(cell).not.toHaveAttribute('title');
    expect(document.getElementById('err-e1-c1')).toBeNull();
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

describe('只翻页不抢焦点', () => {
  it('revealTarget 把目标行所在的页翻出来，但焦点留在原地', () => {
    const many: EmployeeDto[] = Array.from({ length: 60 }, (_, index) => ({
      id: `e${index}`,
      name: `职工${index + 1}`,
      employeeNo: null,
      sortOrder: index + 1,
      enabled: true,
    }));
    render(<Harness employees={many} revealTarget={{ row: 55, col: 0 }} />);

    expect(screen.getByText(/第 2 \/ 2 页/)).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: /职工60/ })).toBeInTheDocument();
    // 焦点归页面的 error summary，表格不许把焦点抢走
    expect(document.activeElement).toBe(document.body);
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