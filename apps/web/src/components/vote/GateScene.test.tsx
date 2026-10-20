import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GateScene 的组件级测试。
 *
 * 舞台渲染条件与「内容何时挂载」都不依赖真实渲染循环：`playGateMotion` 被换成
 * 受控替身，由用例决定动画何时落定。真实补间只在浏览器里验证（jsdom 里既没有
 * 合成层也没有 60fps，断言内联 transform 只会测到 GSAP 的实现细节）。
 */

const motion = vi.hoisted(() => ({
  canPlay: vi.fn<() => boolean>(),
  play: vi.fn<(options: { root: HTMLElement; onSettled?: () => void }) => () => void>(),
}));

vi.mock('./gateMotion.js', () => ({
  canPlayGateMotion: motion.canPlay,
  playGateMotion: motion.play,
}));

import { GateScene } from './GateScene.js';

/** 捕获 playGateMotion 拿到的落定回调，让用例自己决定动画何时结束。 */
function captureSettled(): { settled: () => void } {
  const box: { settled: () => void } = { settled: () => undefined };
  motion.play.mockImplementation((options) => {
    box.settled = () => {
      options.onSettled?.();
    };
    return () => undefined;
  });
  return box;
}

beforeEach(() => {
  motion.canPlay.mockReset();
  motion.play.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GateScene 的平台降级', () => {
  it('不播动画时连列车舞台都不渲染，文字立即出现（老内核 / 减少动效）', () => {
    motion.canPlay.mockReturnValue(false);
    const { container } = render(
      <GateScene withTrain>
        <p>投票尚未开始</p>
      </GateScene>,
    );

    // 之前 reduce 分支只交付内容、舞台照旧渲染，用户看到的是「停在终点的车」
    expect(container.querySelector('.gate-stage')).toBeNull();
    expect(screen.getByText('投票尚未开始')).toBeInTheDocument();
    expect(container.querySelector('.gate-scene')).toHaveAttribute('aria-busy', 'false');
    // 不播就不要再走一遍编排（没有需要收尾的补间）
    expect(motion.play).not.toHaveBeenCalled();
  });

  it('正常投票页（withTrain=false）不渲染舞台，即便机器能播', () => {
    motion.canPlay.mockReturnValue(true);
    const { container } = render(
      <GateScene withTrain={false}>
        <p>请输入随机码</p>
      </GateScene>,
    );

    expect(container.querySelector('.gate-stage')).toBeNull();
    expect(screen.getByText('请输入随机码')).toBeInTheDocument();
    expect(motion.play).not.toHaveBeenCalled();
  });

  it('能播时内容在动画落定前不挂载，落定后才出现', () => {
    motion.canPlay.mockReturnValue(true);
    const box = captureSettled();
    const { container } = render(
      <GateScene withTrain>
        <p>投票尚未开始</p>
      </GateScene>,
    );

    expect(container.querySelector('.gate-stage')).not.toBeNull();
    // 纯视觉装饰：不参与读屏（aria-hidden 在父级声明，子树不必重复）
    expect(container.querySelector('.gate-stage')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('.gate-train')).not.toBeNull();
    expect(screen.queryByText('投票尚未开始')).not.toBeInTheDocument();
    expect(container.querySelector('.gate-scene')).toHaveAttribute('aria-busy', 'true');

    act(() => box.settled());

    expect(screen.getByText('投票尚未开始')).toBeInTheDocument();
    expect(container.querySelector('.gate-scene')).toHaveAttribute('aria-busy', 'false');
  });
});

describe('GateScene 的列车造型', () => {
  beforeEach(() => {
    motion.canPlay.mockReturnValue(true);
    captureSettled();
  });

  it('8 辆编组：两端车头 + 6 节车厢 + 两个受电弓，且不画车门', () => {
    const { container } = render(<GateScene withTrain>{null}</GateScene>);
    const svg = container.querySelector('svg.gate-train-body');
    expect(svg).not.toBeNull();

    const headGroups = [...svg!.querySelectorAll('g[transform]')].filter(
      (g) => g.querySelector(':scope > path.gate-body') !== null,
    );
    expect(headGroups).toHaveLength(2);

    const carGroups = [...svg!.querySelectorAll('g[transform]')].filter(
      (g) => g.querySelector(':scope > rect.gate-body') !== null,
    );
    expect(carGroups).toHaveLength(6);

    expect(svg!.querySelectorAll('.gate-pantograph')).toHaveLength(2);
    // 缩略侧视里不画车门：1:20 比例下门只是一排小黑块，会破坏车身完整性
    expect(svg!.querySelectorAll('.gate-door')).toHaveLength(0);
    expect(svg!.querySelectorAll('.gate-doorway')).toHaveLength(0);
  });

  it('车头平直端贴车厢、鼻锥朝车外（两端镜像方向相反）', () => {
    const { container } = render(<GateScene withTrain>{null}</GateScene>);
    const svg = container.querySelector('svg.gate-train-body');
    const heads = [...svg!.querySelectorAll('g[transform]')].filter(
      (g) => g.querySelector(':scope > path.gate-body') !== null,
    );

    const transforms = heads.map((g) => g.getAttribute('transform') ?? '');
    expect(transforms.filter((t) => t.includes('scale(-1')).length).toBe(1);
    expect(transforms.filter((t) => !t.includes('scale(-1')).length).toBe(1);
    expect(svg!.querySelectorAll('.gate-headlight')).toHaveLength(2);
  });
});

describe('老内核的布局回退', () => {
  it('global.css 给 .gate-scene 写了 100vh 回退，且 dvh 在其后覆盖', () => {
    // vitest 的 root 是 apps/web，import.meta.url 在 jsdom 环境里不是 file 协议
    const css = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8');
    const block = css.match(/\.gate-scene\s*\{[^}]*\}/)?.[0];
    expect(block).toBeDefined();

    const vh = block!.indexOf('min-height: 100vh');
    const dvh = block!.indexOf('min-height: 100dvh');
    // 缺 vh 回退时，Chrome 108 以前丢弃 dvh，容器塌成 0 高，
    // absolute 的 .gate-stage 就会跑到内容上方（列车压字）
    expect(vh).toBeGreaterThan(-1);
    expect(dvh).toBeGreaterThan(vh);
  });
});
