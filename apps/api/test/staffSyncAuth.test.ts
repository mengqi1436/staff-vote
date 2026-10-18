import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

/**
 * 外部同步鉴权的单元测试（不连数据库，任何环境可跑）。
 *
 * 三条边界：
 *   - 服务端没配 STAFF_SYNC_TOKEN → 503（默认不开放无鉴权写入口）；
 *   - 令牌缺失或不等 → 401；
 *   - 令牌匹配 → 放行到 next()。
 *
 * env 用 `vi.doMock` 注入：本机 `.env` 里可能真的配了令牌，
 * 直接改 process.env 会被 dotenv 再加载回去，测不出「未配置」这条分支。
 */
async function loadMiddleware(token: string | undefined) {
  vi.resetModules();
  vi.doMock('../src/env.js', () => ({
    env: { STAFF_SYNC_TOKEN: token },
    isProduction: false,
  }));
  const { staffSyncAuth } = await import('../src/middleware/staffSyncAuth.js');
  return staffSyncAuth;
}

function fakeRequest(providedToken?: string): Request {
  return {
    header: (name: string) =>
      name.toLowerCase() === 'x-sync-token' ? providedToken : undefined,
  } as unknown as Request;
}

afterEach(() => {
  vi.doUnmock('../src/env.js');
  vi.resetModules();
});

describe('staffSyncAuth', () => {
  it('未配置令牌时关闭端点（503），不走到 next', async () => {
    const staffSyncAuth = await loadMiddleware(undefined);
    const next = vi.fn() as NextFunction;

    expect(() => staffSyncAuth(fakeRequest('anything'), {} as Response, next)).toThrowError(
      expect.objectContaining({ status: 503, code: 'SYNC_DISABLED' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('缺少令牌或令牌不匹配时 401', async () => {
    const staffSyncAuth = await loadMiddleware('the-expected-token-123456');
    const next = vi.fn() as NextFunction;

    expect(() => staffSyncAuth(fakeRequest(undefined), {} as Response, next)).toThrowError(
      expect.objectContaining({ status: 401, code: 'SYNC_TOKEN_INVALID' }),
    );
    expect(() =>
      staffSyncAuth(fakeRequest('a-different-token-123456'), {} as Response, next),
    ).toThrowError(expect.objectContaining({ status: 401 }));
    expect(next).not.toHaveBeenCalled();
  });

  it('令牌匹配时放行', async () => {
    const staffSyncAuth = await loadMiddleware('the-expected-token-123456');
    const next = vi.fn() as NextFunction;

    staffSyncAuth(fakeRequest('the-expected-token-123456'), {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
