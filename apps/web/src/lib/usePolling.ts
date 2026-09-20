import { useCallback, useEffect, useState } from 'react';

/**
 * 轮询取数。
 *
 * 后台概览需要「实时」看到发码与提交进度，用轮询即可：
 * 5 秒粒度足够，且不需要在 Nginx 上为 SSE 加额外配置与长连接保活。
 *
 * 刻意不使用 window.setInterval：请求慢于间隔时 interval 会堆积请求。
 * 这里用「上一次完成后 setTimeout 下一次」的链式调度，天然背压。
 *
 * @param fetcher 取数函数；务必用 useCallback 包裹，否则每次渲染都会重启轮询
 * @param intervalMs 间隔毫秒；传 0 或负数表示不轮询，只取一次
 * @returns 数据、错误、加载态与手动刷新函数
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
): {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refresh: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const run = async (): Promise<void> => {
      try {
        const result = await fetcher();
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught : new Error(String(caught)));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          if (intervalMs > 0) {
            timer = setTimeout(() => void run(), intervalMs);
          }
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetcher, intervalMs, tick]);

  const refresh = useCallback(() => {
    setTick((value) => value + 1);
  }, []);

  return { data, error, loading, refresh };
}