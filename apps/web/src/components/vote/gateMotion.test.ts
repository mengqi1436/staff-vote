import { afterEach, describe, expect, it, vi } from 'vitest';
import { canPlayGateMotion, playGateMotion } from './gateMotion.js';

/**
 * gateMotion 的单元测试。
 *
 * jsdom 里 `matchMedia` 桩固定 matches:false、也没有 `CSS.supports`，
 * 因此 `canPlayGateMotion()` 恒为 false —— 与老内核、以及系统开启
 * 「减少动态效果」的机器是同一条路径。
 *
 * 真正会播放的分支由 GateScene.test.tsx 用受控替身覆盖：
 * 这里不假装测量 transform，也不在 jsdom 里跑真实补间。
 */

/** 按 GateScene 的结构造一个最小场景根节点。 */
function sceneRoot(): HTMLElement {
  const root = document.createElement('div');
  root.className = 'gate-scene';
  root.innerHTML = `<div class="gate-content"><p>内容</p></div>
    <div class="gate-stage">
      <div class="gate-platform"></div>
      <div class="gate-track"></div>
      <div class="gate-train"></div>
    </div>`;
  return root;
}

/** 让「这台机器能播动画」的两个前提同时成立。 */
function stubAnimationCapable(): void {
  vi.stubGlobal('matchMedia', ((query: string) => ({
    matches: query.includes(': no-preference'),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia);
  vi.stubGlobal('CSS', { supports: () => true });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('canPlayGateMotion', () => {
  it('jsdom 默认环境不播：老内核与「减少动效」走同一条路', () => {
    expect(canPlayGateMotion()).toBe(false);
  });

  it('内核认识 reduce 媒体查询且支持 dvh 时才播', () => {
    stubAnimationCapable();
    expect(canPlayGateMotion()).toBe(true);
  });

  it('系统要求减少动效时不播（no-preference 不匹配）', () => {
    stubAnimationCapable();
    // 用户关了「在 Windows 中显示动画」：reduce 命中，no-preference 不命中
    vi.stubGlobal('matchMedia', ((query: string) => ({
      matches: query.includes(': reduce'),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia);

    expect(canPlayGateMotion()).toBe(false);
  });

  it('认 reduce 但不认 dvh 的老内核（Chrome 108 以前）不播', () => {
    stubAnimationCapable();
    vi.stubGlobal('CSS', { supports: () => false });

    expect(canPlayGateMotion()).toBe(false);
  });

  it('没有 matchMedia 的环境不播，也不抛错', () => {
    vi.stubGlobal('matchMedia', undefined);

    expect(() => canPlayGateMotion()).not.toThrow();
    expect(canPlayGateMotion()).toBe(false);
  });
});

describe('playGateMotion', () => {
  it('舞台被 CSS 隐藏时立即交付内容，不让人干等（矮屏 / 窄屏）', () => {
    const onSettled = vi.fn();
    const root = sceneRoot();
    const stage = root.querySelector('.gate-stage') as HTMLElement;
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ display: 'none' } as unknown as CSSStyleDeclaration);

    const cleanup = playGateMotion({ root, onSettled });

    expect(stage).not.toBeNull();
    expect(onSettled).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('清理函数可重复调用，不会二次抛错', () => {
    const cleanup = playGateMotion({ root: sceneRoot() });

    cleanup();
    expect(() => cleanup()).not.toThrow();
  });

  it('场景元素缺失时也不抛错（容错：选择器为空集）', () => {
    const cleanup = playGateMotion({ root: document.createElement('div') });

    expect(() => cleanup()).not.toThrow();
  });

  it('挂上 visibilitychange 监听，清理时移除（后台节流收尾的入口）', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');

    const cleanup = playGateMotion({ root: sceneRoot() });

    const added = addSpy.mock.calls.filter(([type]) => type === 'visibilitychange');
    expect(added).toHaveLength(1);

    cleanup();

    const removed = removeSpy.mock.calls.filter(([type]) => type === 'visibilitychange');
    expect(removed).toHaveLength(1);
    // 移除的必须是当初挂上去的同一个函数，否则监听会泄漏
    expect(removed[0]![1]).toBe(added[0]![1]);
  });
});
