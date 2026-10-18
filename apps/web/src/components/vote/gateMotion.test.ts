import { describe, expect, it, vi, afterEach } from 'vitest';
import { playGateMotion } from './gateMotion.js';

/**
 * gateMotion 的单元测试。
 *
 * jsdom 的 matchMedia 桩（src/test-setup.ts）固定返回 matches: false，
 * 所以 `no-preference` 分支不会真正创建补间——这里验证的是：
 * 场景元素存在时调用不抛错、返回可执行且幂等的清理函数、
 * 缺少场景元素时同样安全（正常投票页只有 .gate-content），
 * 以及 visibilitychange 监听被正确挂上并在清理时移除。
 *
 * 真实的动画编排与 reduced-motion 行为由浏览器端验证，
 * 不在 jsdom 里假装测量 transform。
 */

/** 按 GateScene 的结构造一个最小场景根节点。 */
function sceneRoot(withTrain: boolean): HTMLElement {
  const root = document.createElement('div');
  root.className = 'gate-scene';
  root.innerHTML = '<div class="gate-content"><p>内容</p></div>';
  if (withTrain) {
    root.insertAdjacentHTML(
      'beforeend',
      `<div class="gate-stage">
         <div class="gate-platform"></div>
         <div class="gate-track"></div>
         <div class="gate-train">
           <div class="gate-headlight"></div>
           <div class="gate-nose"></div>
           <div class="gate-door gate-door-left"></div>
           <div class="gate-door gate-door-right"></div>
           <div class="gate-lights">
             <span class="gate-light"></span><span class="gate-light"></span>
             <span class="gate-light"></span><span class="gate-light"></span>
           </div>
         </div>
       </div>`,
    );
  }
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('playGateMotion', () => {
  it('带列车场景时创建动画并返回清理函数', () => {
    const root = sceneRoot(true);
    const cleanup = playGateMotion({ root, withTrain: true });

    expect(typeof cleanup).toBe('function');
    expect(() => cleanup()).not.toThrow();
  });

  it('不带列车时同样可用（正常投票页只有内容入场）', () => {
    const root = sceneRoot(false);
    const cleanup = playGateMotion({ root, withTrain: false });

    expect(typeof cleanup).toBe('function');
    expect(() => cleanup()).not.toThrow();
  });

  it('清理函数可重复调用，不会二次抛错', () => {
    const root = sceneRoot(true);
    const cleanup = playGateMotion({ root, withTrain: true });

    cleanup();
    expect(() => cleanup()).not.toThrow();
  });

  it('场景元素缺失时也不抛错（容错：选择器为空集）', () => {
    const root = document.createElement('div');
    const cleanup = playGateMotion({ root, withTrain: true });

    expect(() => cleanup()).not.toThrow();
  });

  it('挂上 visibilitychange 监听，清理时移除（后台节流收尾的入口）', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');

    const cleanup = playGateMotion({ root: sceneRoot(true), withTrain: true });

    const added = addSpy.mock.calls.filter(([type]) => type === 'visibilitychange');
    expect(added).toHaveLength(1);

    cleanup();

    const removed = removeSpy.mock.calls.filter(([type]) => type === 'visibilitychange');
    expect(removed).toHaveLength(1);
    // 移除的必须是当初挂上去的同一个函数，否则监听会泄漏
    expect(removed[0]![1]).toBe(added[0]![1]);
  });
});
