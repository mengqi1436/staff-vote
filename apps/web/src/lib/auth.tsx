/**
 * 管理端身份与权限上下文。
 *
 * 权限只在进入后台时由 `/me` 拉一次并缓存在内存：会话期间不轮询 ——
 * 权限被改动后管理员刷新页面即可看到新的按钮状态。
 * 即使前端缓存是旧的也不会出安全问题：后端每次请求都重新查库校验权限，
 * 这里只决定「按钮显不显示」，不决定「操作能不能成」。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { adminApi, type AdminMe } from './api.js';

interface AuthState {
  admin: AdminMe | null;
  loading: boolean;
  error: Error | null;
  /**
   * 是否拥有某权限码。
   *
   * @param code 权限码，如 `tickets.revoke`
   * @returns 无身份或无该权限时返回 false（默认拒绝）
   */
  can: (code: string) => boolean;
  /** 重新拉取身份与权限（改完角色后用它刷新） */
  reload: () => Promise<void>;
}

/**
 * 身份上下文。导出是为了让测试注入固定权限集合（见 src/test-utils.tsx）：
 * 走真实 Provider 会让首次渲染处于「加载中」，按钮显隐断言变成竞态。
 * 生产代码请用 `useAuth()`，不要直接消费本 Context。
 */
export const AuthContext = createContext<AuthState | null>(null);

/** 后台的身份与权限提供者，包在 AdminLayout 外层。 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [admin, setAdmin] = useState<AdminMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setAdmin(await adminApi.me());
      setError(null);
    } catch (caught) {
      setAdmin(null);
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const value = useMemo<AuthState>(
    () => ({
      admin,
      loading,
      error,
      can: (code: string) => admin?.permissions.includes(code) ?? false,
      reload: load,
    }),
    [admin, loading, error, load],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * 读取当前管理员与权限。
 *
 * @returns 身份、加载态与 `can(code)`
 * @throws 在 AuthProvider 之外调用时抛错（属于编码错误，应尽早暴露）
 */
export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return context;
}