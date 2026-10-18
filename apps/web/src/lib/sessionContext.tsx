/**
 * 管理端「当前评议」上下文。
 *
 * 多场评议后，后台数据按评议隔离：所有列表请求带 `?sessionId=`、创建请求 body 带 `sessionId`。
 * 当前评议 id 由本 Provider 统一持有（AdminLayout 挂载时拉取评议列表供头部选择器使用），
 * 并写入 localStorage —— 刷新页面不丢选择。
 *
 * 容错：后端未提供评议接口（旧版本）或尚未创建任何评议时，sessionId 保持 null，
 * 各页请求不带 sessionId，行为与单场版完全一致。
 * 单评议时自动选中：单场数据无需管理员手动选择，选了也与后端过滤说明一致。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { adminApi, type AdminSessionDto } from './api.js';

const STORAGE_KEY = 'staff_vote_admin_session_id';

interface SessionState {
  /** 当前评议 id；null 表示未选择（或后端还没有评议数据） */
  sessionId: string | null;
  /** 切换当前评议（选择器 onChange 用） */
  setSessionId: (id: string | null) => void;
  /** 评议列表（头部选择器与页面提示用） */
  sessions: AdminSessionDto[];
  /** 评议列表是否仍在加载 */
  loading: boolean;
  /** 手动重新拉取评议列表（新建/流转评议后刷新） */
  reload: () => void;
}

/**
 * 评议上下文。导出是为了让测试注入固定的评议集合与选中值
 * （与 AuthContext 同一惯例：走真实 Provider 会让首渲染处于加载中，断言变成竞态）。
 * 生产代码请用 `useAdminSession()`，不要直接消费本 Context。
 */
export const SessionContext = createContext<SessionState | null>(null);

/** 后台的当前评议提供者，包在 AdminLayout 内层（需要已登录身份）。 */
export function AdminSessionProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<AdminSessionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [sessionId, setSessionIdState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      // localStorage 不可用（隐私模式等）时退化为内存态：本次登录状态内仍可工作
      return null;
    }
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    adminApi.sessions
      .list()
      .then((result) => {
        if (!cancelled) setSessions(result.sessions);
      })
      .catch(() => {
        // 评议接口不可用（旧后端 404 等）按「没有评议」处理，页面退回单场行为
        if (!cancelled) setSessions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const setSessionId = useCallback((id: string | null) => {
    setSessionIdState(id);
    try {
      if (id === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // 同上：存储不可用只影响刷新后的记忆，不影响本次登录状态
    }
  }, []);

  // 恰好只有一个评议时自动选中：单场数据没有「选错」的风险，省一次点击
  useEffect(() => {
    if (sessionId === null && sessions.length === 1) setSessionId(sessions[0]!.id);
  }, [sessionId, sessions, setSessionId]);

  // 持久化的评议已被删除时清掉，避免带着一个不存在的 sessionId 发请求。
  // 必须等加载结束再判断：sessions 初值是空数组，加载中清空会误删本次选择；
  // 列表变空（唯一评议被删）同样要清，否则会残留一个已删除的 id。
  useEffect(() => {
    if (loading || sessionId === null) return;
    if (!sessions.some((item) => item.id === sessionId)) setSessionId(null);
  }, [loading, sessionId, sessions, setSessionId]);

  const value = useMemo<SessionState>(
    () => ({ sessionId, setSessionId, sessions, loading, reload: () => setTick((n) => n + 1) }),
    [sessionId, setSessionId, sessions, loading],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/**
 * 读取当前评议状态。
 *
 * @throws 在 AdminSessionProvider 之外调用时抛错（属于编码错误，应尽早暴露）
 */
export function useAdminSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useAdminSession 必须在 AdminSessionProvider 内使用');
  return context;
}
