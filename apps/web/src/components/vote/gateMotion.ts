import gsap from 'gsap';

/**
 * 投票入口的高铁进站动画。
 *
 * 编排：站台与轨道展开 → 整列从左驶入、减速停在屏幕中央 → 停稳后
 * 才把卡片内容交给 React 渲染（`onSettled`）。只动 transform / opacity。
 *
 * 内容可见性永远优先于动画完整播放，因此以下任一情况都必须交付内容：
 *   1. `prefers-reduced-motion: reduce`：不建补间，立即交付；
 *   2. 舞台被 CSS 隐藏（矮屏 / 窄屏，动画根本看不见）：立即交付；
 *   3. 补间正常播完（`onComplete`）；
 *   4. 兜底超时（matchMedia 两个分支都不命中、浏览器节流等）。
 * `onSettled` 保证**最多调用一次**（三条路径竞争）。
 */

/** 进站时长与缓动：power3.out 对应真实制动的减速感。 */
const TRAIN_ENTRY = { duration: 1.6, ease: 'power3.out' } as const;
/** 进站起点：负值表示列车整体在视口左侧外。 */
const TRAIN_START_X_PERCENT = -58;
/** 兜底超时 = 进站时长 + 余量。改动画时长时这里自动跟随，不会失配。 */
const SETTLE_FALLBACK_MS = (TRAIN_ENTRY.duration + 0.3) * 1000;

export interface GateMotionOptions {
  /** 场景根节点：内部所有选择器都限定在它下面。 */
  root: HTMLElement;
  /** 是否播放列车场景。false（正常投票页）时立即交付内容。 */
  withTrain: boolean;
  /** 内容可以挂载时调用，最多一次。 */
  onSettled?: () => void;
}

/**
 * 播放 Gate 入场动画，返回清理函数（调用方在 unmount 时执行）。
 *
 * 每次调用都创建独立的 matchMedia 实例、清理时只 revert 自己，
 * 因此 StrictMode 的「挂载 → 清理 → 再挂载」不会把第二次的动画撤掉。
 */
export function playGateMotion({ root, withTrain, onSettled }: GateMotionOptions): () => void {
  const q = gsap.utils.selector(root);
  let tl: gsap.core.Timeline | null = null;
  let fallbackId = 0;
  let delivered = false;

  /** 交付内容：幂等，并顺手撤掉兜底定时器。 */
  const deliver = () => {
    if (delivered) return;
    delivered = true;
    window.clearTimeout(fallbackId);
    onSettled?.();
  };

  // 兜底先注册：下面的 gsap 调用一旦抛错（例如环境缺 matchMedia），
  // 内容才不会永久空白——那时用户连「未开放」都看不到。
  fallbackId = window.setTimeout(deliver, SETTLE_FALLBACK_MS);

  /*
   * 舞台被 CSS 隐藏时（矮屏 max-height、窄屏 max-width）动画看不见，
   * 没必要让人对着空白页等 1.6 秒。用计算样式判断，语义就是「它真的显示了吗」，
   * CSS 改媒体查询条件时这里自动跟随，不需要在 JS 里重复一份断点。
   */
  const stage = root.querySelector('.gate-stage');
  const stageHidden = stage !== null && window.getComputedStyle(stage).display === 'none';
  if (!withTrain || stageHidden) {
    deliver();
    return () => window.clearTimeout(fallbackId);
  }

  const mm = gsap.matchMedia();

  mm.add('(prefers-reduced-motion: no-preference)', () => {
    const timeline = gsap.timeline({ onComplete: deliver });
    tl = timeline;

    timeline
      // 站台与轨道先到位，给列车一个可以停靠的空间
      .from(q('.gate-track'), { scaleX: 0, opacity: 0, duration: 0.5, ease: 'power2.out' }, 0)
      .from(q('.gate-platform'), { xPercent: -6, opacity: 0, duration: 0.6, ease: 'power2.out' }, 0.08)
      // 进站：从左驶入，终点 xPercent 0 = 停在舞台中央（舞台 justify-content: center）
      .fromTo(
        q('.gate-train'),
        { xPercent: TRAIN_START_X_PERCENT },
        { xPercent: 0, ...TRAIN_ENTRY },
        0.1,
      );

    return () => {
      timeline.kill();
      tl = null;
    };
  });

  // 反向查询：不建补间，直接交付（这里不需要 clearProps，本来就没写内联值）
  mm.add('(prefers-reduced-motion: reduce)', deliver);

  /*
   * 回到前台时补一次收尾：后台 rAF 被节流，timeline 会停在半途。
   * progress(1) 是同步渲染并会触发 onComplete，因此视觉与内容一并交付。
   */
  const settleIfUnfinished = () => {
    if (document.visibilityState !== 'visible') return;
    if (tl !== null && tl.progress() < 1) tl.progress(1);
    deliver();
  };
  document.addEventListener('visibilitychange', settleIfUnfinished);

  return () => {
    document.removeEventListener('visibilitychange', settleIfUnfinished);
    window.clearTimeout(fallbackId);
    mm.revert();
  };
}
