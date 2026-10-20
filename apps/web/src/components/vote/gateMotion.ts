import gsap from 'gsap';

/**
 * 投票入口的高铁进站动画。
 *
 * 编排：站台与轨道展开 → 整列从左驶入、减速停在屏幕中央 → 停稳后
 * 才把卡片内容交给 React 渲染（`onSettled`）。只动 transform / opacity。
 *
 * **能不能播**由 `canPlayGateMotion()` 判定：判定不过时 GateScene 连列车舞台
 * 都不渲染，文字立即出现。播放期间的兜底：
 *   1. 舞台被 CSS 隐藏（矮屏 / 窄屏，动画根本看不见）：立即交付；
 *   2. 补间正常播完（`onComplete`）；
 *   3. 兜底超时（浏览器节流、rAF 被暂停等）。
 * `onSettled` 保证**最多调用一次**（三条路径竞争）。
 */

/** 进站时长与缓动：power3.out 对应真实制动的减速感。 */
const TRAIN_ENTRY = { duration: 1.6, ease: 'power3.out' } as const;
/** 进站起点：负值表示列车整体在视口左侧外。 */
const TRAIN_START_X_PERCENT = -58;
/** 兜底超时 = 进站时长 + 余量。改动画时长时这里自动跟随，不会失配。 */
const SETTLE_FALLBACK_MS = (TRAIN_ENTRY.duration + 0.3) * 1000;

/**
 * 这台电脑能不能播列车动画。两个前提必须同时成立：
 *
 *   1. 内核认识 `prefers-reduced-motion`，且用户没有要求减少动效。
 *      老内核（Chrome 74 以前一类）两个互斥查询都返回 false，GSAP 的媒体
 *      查询分支永远不命中：动画不播，人还得对着空白页等约 1.9 秒兜底超时。
 *   2. 内核支持 `min-height: 100dvh`。这是同一批老内核（Chrome 108 以前）的
 *      分界线：它们的布局要走 global.css 里的 100vh 回退，动画一并关掉。
 *
 * 判定不过时 GateScene 只渲染文字——用户要的是「不播动画」，不是「停一辆
 * 不动的车在页面上」。
 *
 * ponytail: 用布局能力代理「内核新旧」，不嗅探 UA、不猜硬件。真需要按性能
 * 降级时换成实测掉帧（首帧超出两帧预算就 kill timeline），不要加版本表。
 */
export function canPlayGateMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  if (!window.matchMedia('(prefers-reduced-motion: no-preference)').matches) return false;
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return false;
  return CSS.supports('min-height', '100dvh');
}

export interface GateMotionOptions {
  /** 场景根节点：内部所有选择器都限定在它下面。 */
  root: HTMLElement;
  /** 内容可以挂载时调用，最多一次。 */
  onSettled?: () => void;
}

/**
 * 播放 Gate 入场动画，返回清理函数（调用方在 unmount 时执行）。
 *
 * 只负责「播」：要不要播由调用方的 `canPlayGateMotion()` 决定。
 * 每次调用都创建独立的时间线、清理时只 kill 自己，
 * 因此 StrictMode 的「挂载 → 清理 → 再挂载」不会把第二次的动画撤掉。
 */
export function playGateMotion({ root, onSettled }: GateMotionOptions): () => void {
  const q = gsap.utils.selector(root);
  let fallbackId = 0;
  let delivered = false;

  /** 交付内容：幂等，并顺手撤掉兜底定时器。 */
  const deliver = () => {
    if (delivered) return;
    delivered = true;
    window.clearTimeout(fallbackId);
    onSettled?.();
  };

  // 兜底先注册：下面的 gsap 调用一旦抛错，内容才不会永久空白——
  // 那时用户连「未开放」都看不到。
  fallbackId = window.setTimeout(deliver, SETTLE_FALLBACK_MS);

  /*
   * 舞台被 CSS 隐藏时（矮屏 max-height、窄屏 max-width）动画看不见，
   * 没必要让人对着空白页等 1.6 秒。用计算样式判断，语义就是「它真的显示了吗」，
   * CSS 改媒体查询条件时这里自动跟随，不需要在 JS 里重复一份断点。
   */
  const stage = root.querySelector('.gate-stage');
  const stageHidden = stage !== null && window.getComputedStyle(stage).display === 'none';
  if (stageHidden) {
    deliver();
    return () => window.clearTimeout(fallbackId);
  }

  const timeline = gsap.timeline({ onComplete: deliver });

  timeline
    // 站台与轨道先到位，给列车一个可以停靠的空间。
    // 一律 fromTo（两端都写死）而不是 from：from 把「当前值」当终点，
    // StrictMode 重挂载时当前值已被上次写成起点，补间会原地不动——
    // 表现就是「轨道和站台不展开」或「列车不动」。
    .fromTo(
      q('.gate-track'),
      { scaleX: 0, opacity: 0 },
      { scaleX: 1, opacity: 1, duration: 0.5, ease: 'power2.out' },
      0,
    )
    .fromTo(
      q('.gate-platform'),
      { xPercent: -6, opacity: 0 },
      { xPercent: 0, opacity: 1, duration: 0.6, ease: 'power2.out' },
      0.08,
    )
    // 进站：从左驶入，终点 xPercent 0 = 停在舞台中央（舞台 justify-content: center）
    .fromTo(
      q('.gate-train'),
      { xPercent: TRAIN_START_X_PERCENT },
      { xPercent: 0, ...TRAIN_ENTRY },
      0.1,
    );

  /*
   * 回到前台时补一次收尾：后台 rAF 被节流，timeline 会停在半途。
   * progress(1) 是同步渲染并会触发 onComplete，因此视觉与内容一并交付。
   */
  const settleIfUnfinished = () => {
    if (document.visibilityState !== 'visible') return;
    if (timeline.progress() < 1) timeline.progress(1);
    deliver();
  };
  document.addEventListener('visibilitychange', settleIfUnfinished);

  return () => {
    document.removeEventListener('visibilitychange', settleIfUnfinished);
    window.clearTimeout(fallbackId);
    timeline.kill();
  };
}
