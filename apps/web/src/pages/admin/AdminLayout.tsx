import { useEffect, useMemo } from 'react';
import { Button, Layout, Menu, Select, Spin, theme } from 'antd';
import type { MenuProps } from 'antd';
import {
  LogoutOutlined,
  PartitionOutlined,
  SettingOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { adminApi } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { AdminSessionProvider, useAdminSession } from '../../lib/sessionContext.js';

/**
 * 后台外壳：登录态守卫 + 侧边导航 + 退出登录。
 *
 * 管理页已整合为「场次工作台」（/admin/sessions/:id），侧栏四个入口：
 * 场次管理（列表与工作台）、部门管理（全局部门字典）、系统设置、账号权限；
 * 评议配置都在工作台的页签里。
 * 视觉遵循 Apple 风契约 v1：浅色磨砂侧栏 + sticky 半透明顶栏，
 * 只动材质与样式值，不引入自造组件。
 *
 * 守卫：身份来自 AuthProvider 的 `useAuth()`（全后台只拉一次 `/me`，
 * 不再由本组件重复请求）；未登录（401）即跳登录页。
 * 这只是体验层拦截，真正的权限在后端 adminAuth 中间件 ——
 * 前端跳转永远不能作为防线。
 */

/** 各路由的页面标题：页头展示当前页，与菜单文案一致。 */
const PAGE_TITLES: Record<string, string> = {
  '/admin/sessions': '场次管理',
  '/admin/departments': '部门管理',
  '/admin/settings': '系统设置',
  '/admin/admins': '账号与权限',
  '/admin/sessions/:id': '场次工作台',
};

/** 工作台路由：/admin/sessions/<场次 id>。 */
const WORKSPACE_PATH = /^\/admin\/sessions\/[^/]+$/;

/** 侧边导航：四个入口平铺（全局部门字典独立于场次管理）。 */
const MENU_ITEMS: MenuProps['items'] = [
  {
    key: '/admin/sessions',
    icon: <PartitionOutlined />,
    label: <Link to="/admin/sessions">场次管理</Link>,
  },
  {
    key: '/admin/departments',
    icon: <TeamOutlined />,
    label: <Link to="/admin/departments">部门管理</Link>,
  },
  {
    key: '/admin/settings',
    icon: <SettingOutlined />,
    label: <Link to="/admin/settings">系统设置</Link>,
  },
  {
    key: '/admin/admins',
    icon: <SafetyCertificateOutlined />,
    label: <Link to="/admin/admins">账号与权限</Link>,
  },
];

/**
 * 头部「当前场次」选择器。
 *
 * 切换后当前场次 id 存入 SessionContext（并持久化到 localStorage），
 * 各管理端页面的取数函数依赖 sessionId，会自动按新场次重新拉取。
 * 场次接口不可用或还没有任何场次时选择器不出现（单场行为，不需要选择）。
 * 场次工作台的路由即场次，页签数据跟着路由走，顶栏不显示选择器。
 */
function SessionPicker({ visible }: { visible: boolean }) {
  const { sessionId, setSessionId, sessions, loading } = useAdminSession();
  if (!visible || (!loading && sessions.length === 0)) return null;
  return (
    <Select
      style={{ width: 200 }}
      aria-label="当前场次"
      placeholder="选择场次"
      loading={loading}
      value={sessionId ?? undefined}
      onChange={(value: string) => setSessionId(value)}
      options={sessions.map((item) => ({ value: item.id, label: item.name }))}
      notFoundContent="暂无场次"
    />
  );
}

export function AdminLayout() {
  const { admin, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { token } = theme.useToken();
  useEffect(() => {
    // 身份由 AuthProvider 拉取：未登录（401）或会话失效时送管理员回登录页
    if (!loading && !admin) void navigate('/admin/login', { replace: true });
  }, [loading, admin, navigate]);

  // 当前选中项：其余按前缀匹配（工作台路由 /admin/sessions/:id 高亮「场次管理」）
  const selectedKey = useMemo(
    () =>
      Object.keys(PAGE_TITLES)
        .filter((key) => !key.includes(':'))
        .find((key) => location.pathname.startsWith(key)) ?? '/admin/sessions',
    [location],
  );
  const isWorkspace = WORKSPACE_PATH.test(location.pathname);

  if (!admin) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
        }}
      >
        <Spin size="large" />
        <span style={{ color: token.colorTextSecondary }}>正在校验登录状态…</span>
      </div>
    );
  }

  const handleLogout = async (): Promise<void> => {
    try {
      await adminApi.logout();
    } catch {
      // 会话本来就可能已经失效；退出失败也必须离开后台，不能把管理员卡在页面里
    }
    void navigate('/admin/login', { replace: true });
  };

  return (
    <AdminSessionProvider>
      <Layout style={{ minHeight: '100vh' }}>
        {/* 浅色材质侧栏：半透明浅灰 + 背景模糊。Menu 用 theme="light" 并把
            自身白底设为 transparent，否则 Menu 会用 colorBgContainer 盖住侧栏材质。
            不再 sticky——内容长时菜单随页面滚动是既有行为，契约未要求固定。 */}
        <Layout.Sider
          width={220}
          theme="light"
          style={{
            background: 'rgba(245, 245, 245, 0.85)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
          }}
        >
          <div
            style={{
              height: 64,
              display: 'flex',
              alignItems: 'center',
              padding: '0 24px',
              color: token.colorText,
              fontSize: 16,
              fontWeight: 600,
            }}
          >
            职工素质评议 · 后台
          </div>
          <Menu
            theme="light"
            mode="inline"
            selectedKeys={[selectedKey]}
            items={MENU_ITEMS}
            style={{ borderInlineEnd: 'none', background: 'transparent' }}
          />
        </Layout.Sider>

        <Layout>
          {/* sticky 顶栏：本结构下外层 Layout 仅 minHeight:100vh、无 overflow 祖先，
              右列高度随内容拉伸，故 sticky top:0 相对视口悬浮成立；内容区滚动时
              顶栏保持在前。不画 1px 分隔线，用极淡阴影提示分层；
              zIndex 50：盖过内容区粘性表头（z≤3），低于 antd 弹层（≥1000）。 */}
          <Layout.Header
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 50,
              background: 'rgba(255, 255, 255, 0.72)',
              backdropFilter: 'blur(20px) saturate(180%)',
              WebkitBackdropFilter: 'blur(20px) saturate(180%)',
              boxShadow: '0 1px 4px rgba(0, 0, 0, 0.04)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
              padding: '0 24px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <span style={{ fontSize: 16, fontWeight: 600 }}>
                {isWorkspace ? PAGE_TITLES['/admin/sessions/:id'] : (PAGE_TITLES[selectedKey] ?? '后台管理')}
              </span>
              <SessionPicker visible={!isWorkspace} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ color: token.colorTextSecondary }}>
                管理员 <span className="tabular">{admin.username}</span>
              </span>
              <Button size="small" icon={<LogoutOutlined />} onClick={() => void handleLogout()}>
                退出登录
              </Button>
            </div>
          </Layout.Header>

          <Layout.Content style={{ padding: 24 }}>
            <Outlet />
          </Layout.Content>
        </Layout>
      </Layout>
    </AdminSessionProvider>
  );
}
