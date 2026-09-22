/**
 * 测试专用工具：把被测页面放进带固定权限的身份上下文。
 *
 * 为什么不走真实 AuthProvider + mock /me：Provider 首次渲染时还在加载，
 * `can()` 会短暂返回 false，按钮显隐的断言会变成竞态（有时在有时不在）。
 * 这里直接注入确定的权限集合，测试只回答一个问题：有这个权限时按钮在不在。
 *
 * 注意：本工具只影响前端按钮显隐。真实权限判定在后端 requirePermission，
 * 所以「无权限调接口会被拒」必须用后端测试覆盖，不能靠这个工具。
 */
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { AdminMe } from './lib/api.js';
import { AuthContext } from './lib/auth.js';
import { SessionContext } from './lib/sessionContext.js';

/** 全部权限码，与后端 src/lib/permissions.ts 的目录保持一致。 */
export const ALL_PERMISSIONS: string[] = [
  'departments.write',
  'employees.write',
  'criteria.write',
  'ticketTypes.write',
  'tickets.generate',
  'tickets.revoke',
  'settings.write',
  'admins.manage',
];

/**
 * 造一个带指定权限的管理员身份。
 *
 * @param permissions 权限码；默认全部
 * @returns 可用于 AuthContext 的身份对象
 */
export function adminWith(permissions: string[] = ALL_PERMISSIONS): AdminMe {
  return {
    id: 'u1',
    username: 'admin',
    roleId: 'r-super',
    roleName: '超级管理员',
    permissions,
  };
}

/** 测试用的场次上下文缺省值：未选择场次、无场次列表。 */
const DEFAULT_SESSION_STATE = {
  sessionId: null as string | null,
  setSessionId: () => {},
  sessions: [],
  loading: false,
  reload: () => {},
};

/**
 * 渲染组件并注入权限上下文。
 *
 * @param ui 被测组件
 * @param permissions 授予的权限码；默认全部。传 `[]` 即为只读账号
 * @param sessionId 注入的当前场次 id；默认 null（未选择场次）。传 id 时也注入
 *   对应的单场次列表，供页面断言「带 sessionId 的请求参数」
 * @returns testing-library 的 render 结果
 */
export function renderWithAuth(ui: ReactElement, permissions: string[] = ALL_PERMISSIONS, sessionId: string | null = null) {
  const admin = adminWith(permissions);
  const sessionState = {
    ...DEFAULT_SESSION_STATE,
    sessionId,
    sessions: sessionId
      ? [{ id: sessionId, name: '测试场次', status: 'draft' as const, startAt: null, endedAt: null, createdAt: '' }]
      : [],
  };
  return render(
    <SessionContext.Provider value={sessionState}>
      <AuthContext.Provider
        value={{
          admin,
          loading: false,
          error: null,
          can: (code: string) => permissions.includes(code),
          reload: async () => {},
        }}
      >
        {ui}
      </AuthContext.Provider>
    </SessionContext.Provider>,
  );
}