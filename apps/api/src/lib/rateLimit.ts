import rateLimit from 'express-rate-limit';

/**
 * 限流器。
 *
 * `ponytail:` 三个限流器都用默认的内存存储，仅适用于单进程部署。
 * 多实例或负载均衡部署时，各进程计数互不相通，实际放行量为限额 × 实例数，
 * 届时需换成共享存储（rate-limit-redis 等）。
 *
 * 生效前提：app 已设置 `trust proxy`（见 app.ts）。
 * 在 Nginx 反代之后若不设置，所有请求的 IP 都是 127.0.0.1，
 * 限流会把全体用户当成同一个人。
 */

/** 通用接口限流：正常翻页与轮询远低于此额度。 */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' } },
});

/**
 * 随机码登录限流。
 *
 * 这是安全边界而非体验优化：8 位码虽有约 1.1e12 组合，但限流让枚举在
 * 现实时间内不可行，也顺带压制同一 IP 的大量无效尝试。
 */
export const voteLoginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: '尝试过于频繁，请稍后再试' } },
});

/** 管理端登录限流：防口令爆破。 */
export const adminLoginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: '尝试过于频繁，请稍后再试' } },
});