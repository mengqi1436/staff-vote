import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { HelpLabel, HelpTip } from '../shared.js';

/**
 * 说明图标的可读性契约：长说明不能挤成一坨。
 * 多句按句末标点分行；超长句按分号再拆；传数组时一项一段。
 */
describe('HelpTip 断句与触发', () => {
  it('多句说明按句号分行渲染', async () => {
    const user = userEvent.setup();
    render(<HelpTip text="第一句。第二句。第三句。" />);

    await user.hover(screen.getByRole('button', { name: '查看说明' }));

    expect(await screen.findByText('第一句。')).toBeInTheDocument();
    expect(screen.getByText('第二句。')).toBeInTheDocument();
    expect(screen.getByText('第三句。')).toBeInTheDocument();
  });

  it('超过 60 字的长句按分号再拆', async () => {
    const user = userEvent.setup();
    const long = `${'甲'.repeat(40)}；${'乙'.repeat(40)}。`;
    render(<HelpTip text={long} />);

    await user.hover(screen.getByRole('button', { name: '查看说明' }));

    expect(await screen.findByText(`${'甲'.repeat(40)}；`)).toBeInTheDocument();
    expect(screen.getByText(`${'乙'.repeat(40)}。`)).toBeInTheDocument();
  });

  it('键盘可打开说明（不是只有鼠标能用）', async () => {
    const user = userEvent.setup();
    render(<HelpTip text="仅一句。" />);

    await user.tab();
    expect(await screen.findByText('仅一句。')).toBeInTheDocument();
  });

  it('HelpLabel 同时渲染标签文字与说明入口', async () => {
    render(<HelpLabel help="字段含义。">字段名</HelpLabel>);

    expect(screen.getByText('字段名')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看说明' })).toBeInTheDocument();
  });
});
