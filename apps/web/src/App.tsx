import { Button, Result } from 'antd';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router';
import { AdminAdmins } from './pages/admin/Admins.js';
import { AdminEmployees } from './pages/admin/Employees.js';
import { AdminLayout } from './pages/admin/AdminLayout.js';
import { AdminLogin } from './pages/admin/Login.js';
import { AdminOrgDepartments } from './pages/admin/OrgDepartments.js';
import { AdminPrintSheet } from './pages/admin/PrintSheet.js';
import { AdminSessions } from './pages/admin/Sessions.js';
import { SessionWorkspace } from './pages/admin/SessionWorkspace.js';
import { AdminSettings } from './pages/admin/Settings.js';
import { AuthProvider } from './lib/auth.js';
import { VoteDone } from './pages/vote/Done.js';
import { VoteGate } from './pages/vote/Gate.js';
import { VoteSheet } from './pages/vote/Sheet.js';

/**
 * 路由表。
 *
 * 两条互不相干的入口：
 *   /        投票入口（匿名，凭随机码进入）
 *   /admin   后台管理（Cookie 登录状态）
 * 分开挂载而非共用一个外壳，是因为两者的登录状态模型与错误处理完全不同，
 * 强行共用布局只会让权限判断散落在各个页面上。
 *
 * 后台信息架构：/admin/sessions 评议列表 → /admin/sessions/:id 单页评议工作台
 * （部门、评议项目、打分表、人员类别、随机码、统计、结果导出都在工作台页签里）。
 * 跨评议复用的数据独立成页：/admin/departments 部门列表、/admin/employees 人员管理。
 * 原独立管理页的路由已并入工作台，组件文件保留供工作台复用。
 */
export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<VoteGate />} />
        <Route path="/vote/sheet" element={<VoteSheet />} />
        <Route path="/vote/done" element={<VoteDone />} />

        <Route path="/admin/login" element={<AdminLogin />} />
        <Route path="/admin/results/print" element={<AdminPrintSheet />} />
        {/* AuthProvider 只管后台：投票端是匿名的，不需要身份与权限上下文 */}
        <Route
          path="/admin"
          element={
            <AuthProvider>
              <AdminLayout />
            </AuthProvider>
          }
        >
          <Route index element={<Navigate to="/admin/sessions" replace />} />
          <Route path="sessions" element={<AdminSessions />} />
          <Route path="sessions/:id" element={<SessionWorkspace />} />
          <Route path="departments" element={<AdminOrgDepartments />} />
          {/* 人员管理：全局人员目录，跨评议复用；外部系统定期同步 */}
          <Route path="employees" element={<AdminEmployees />} />
          <Route path="settings" element={<AdminSettings />} />
          <Route path="admins" element={<AdminAdmins />} />
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}

/**
 * 404 页。原先放在 components/Placeholder.tsx，所有页面实现完成后
 * 那里只剩这一个用途，就地内联，避免留下一个名不副实的组件文件。
 */
function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <Result
      status="404"
      title="页面不存在"
      subTitle="请检查地址是否正确"
      extra={
        <Button type="primary" onClick={() => void navigate('/')}>
          返回投票入口
        </Button>
      }
    />
  );
}