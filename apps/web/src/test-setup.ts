import '@testing-library/jest-dom/vitest';

/**
 * vitest 全局前置：补齐 jsdom 未实现、而 antd 会调用的浏览器 API。
 *
 * 这些都是 jsdom 的已知缺口，不是被测代码的问题；缺任何一个都会让
 * 渲染测试随机失败（表现为「单独跑通过、全量跑报错」）。
 * 放在共享 setup 里而非各测试文件内，避免每个文件各自 copy 一份。
 */

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// antd 的 Table / Statistic / 响应式栅格在挂载时观察尺寸变化
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

// 表格滚动定位、错误格聚焦等场景会调用；jsdom 未实现
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}

// 导出下载路径会用到；jsdom 未实现
if (!URL.createObjectURL) {
  URL.createObjectURL = () => 'blob:vitest-stub';
  URL.revokeObjectURL = () => undefined;
}