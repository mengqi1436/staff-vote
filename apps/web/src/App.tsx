import { Button, Result } from 'antd';
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router';
import { AdminAdmins } from './pages/admin/Admins.js';
import { AdminLayout } from './pages/admin/AdminLayout.js';
import { AdminCriteria } from './pages/admin/Criteria.js';
import { AdminDashboard } from './pages/admin/Dashboard.js';
import { AdminDepartments } from './pages/admin/Departments.js';
import { AdminEmployees } from './pages/admin/Employees.js';
import { AdminLogin } from './pages/admin/Login.js';
import { AdminPrintSheet } from './pages/admin/PrintSheet.js';
import { AdminQuestionnaire } from './pages/admin/Questionnaire.js';
import { AdminResults } from './pages/admin/Results.js';
import { AdminSessions } from './pages/admin/Sessions.js';
import { AdminSettings } from './pages/admin/Settings.js';
import { AdminTicketTypes } from './pages/admin/TicketTypes.js';
import { AdminTickets } from './pages/admin/Tickets.js';
import { AuthProvider } from './lib/auth.js';
import { VoteDone } from './pages/vote/Done.js';
import { VoteGate } from './pages/vote/Gate.js';
import { VoteSheet } from './pages/vote/Sheet.js';

/**
 * 路由表。
 *
 * 两条互不相干的入口：
 *   /        投票入口（匿名，凭随机码进入）
 *   /admin   后台管理（Cookie 会话）
 * 分开挂载而非共用一个外壳，是因为两者的会话模型与错误处理完全不同，
 * 强行共用布局只会让权限判断散落在各个页面上。
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
          <Route index element={<AdminDashboard />} />
          <Route path="sessions" element={<AdminSessions />} />
          <Route path="ticket-types" element={<AdminTicketTypes />} />
          <Route path="tickets" element={<AdminTickets />} />
          <Route path="departments" element={<AdminDepartments />} />
          <Route path="questionnaire" element={<AdminQuestionnaire />} />
          <Route path="employees" element={<AdminEmployees />} />
          <Route path="criteria" element={<AdminCriteria />} />
          <Route path="settings" element={<AdminSettings />} />
          <Route path="results" element={<AdminResults />} />
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