import { useEffect, useMemo } from 'react';
import { Button, Layout, Menu, Spin, theme } from 'antd';
import type { MenuProps } from 'antd';
import {
  ApartmentOutlined,
  BarChartOutlined,
  DashboardOutlined,
  FieldTimeOutlined,
  LogoutOutlined,
  OrderedListOutlined,
  PieChartOutlined,
  QrcodeOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { adminApi } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';

/**
 * 后台外壳：登录态守卫 + 按评议工作流分组的侧边导航 + 退出登录。
 *
 * 菜单按「评议准备 → 发票与票种 → 评议执行 → 评议收尾」的工作流分组
 * （antd Menu type: 'group'），第一次组织评议的管理员从上往下走一遍即可；
 * 末尾的「系统管理」不属于评议流程，单独成组。
 * 视觉全部用 antd 默认 token：深色侧栏 + 浅色内容区，不自定义颜色。
 *
 * 守卫：身份来自 AuthProvider 的 `useAuth()`（全后台只拉一次 `/me`，
 * 不再由本组件重复请求）；未登录（401）即跳登录页。
 * 这只是体验层拦截，真正的权限在后端 adminAuth 中间件 ——
 * 前端跳转永远不能作为防线。
 */

/** 各路由的页面标题：页头展示当前页，与菜单文案一致。 */
const PAGE_TITLES: Record<string, string> = {
  '/admin': '概览',
  '/admin/departments': '部门管理',
  '/admin/employees': '职工名单',
  '/admin/criteria': '评分项点',
  '/admin/ticket-types': '票种权重',
  '/admin/tickets': '随机码',
  '/admin/settings': '开放时间与系统设置',
  '/admin/results': '结果与导出',
  '/admin/admins': '账号与权限',
};

/** 侧边导航：顶部独立「概览」，其下按评议工作流分四组。 */
const MENU_ITEMS: MenuProps['items'] = [
  { key: '/admin', icon: <DashboardOutlined />, label: <Link to="/admin">概览</Link> },
  {
    type: 'group',
    label: '评议准备',
    children: [
      {
        key: '/admin/departments',
        icon: <ApartmentOutlined />,
        label: <Link to="/admin/departments">部门管理</Link>,
      },
      {
        key: '/admin/employees',
        icon: <TeamOutlined />,
        label: <Link to="/admin/employees">职工名单</Link>,
      },
      {
        key: '/admin/criteria',
        icon: <OrderedListOutlined />,
        label: <Link to="/admin/criteria">评分项点</Link>,
      },
    ],
  },
  {
    type: 'group',
    label: '发票与票种',
    children: [
      {
        key: '/admin/ticket-types',
        icon: <PieChartOutlined />,
        label: <Link to="/admin/ticket-types">票种权重</Link>,
      },
      {
        key: '/admin/tickets',
        icon: <QrcodeOutlined />,
        label: <Link to="/admin/tickets">随机码</Link>,
      },
    ],
  },
  {
    type: 'group',
    label: '评议执行',
    children: [
      {
        key: '/admin/settings',
        icon: <FieldTimeOutlined />,
        label: <Link to="/admin/settings">开放时间</Link>,
      },
    ],
  },
  {
    type: 'group',
    label: '评议收尾',
    children: [
      {
        key: '/admin/results',
        icon: <BarChartOutlined />,
        label: <Link to="/admin/results">结果与导出</Link>,
      },
    ],
  },
  {
    type: 'group',
    label: '系统管理',
    children: [
      {
        key: '/admin/admins',
        icon: <SafetyCertificateOutlined />,
        label: <Link to="/admin/admins">账号与权限</Link>,
      },
    ],
  },
];

export function AdminLayout() {
  const { admin, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { token } = theme.useToken();

  useEffect(() => {
    // 身份由 AuthProvider 拉取：未登录（401）或会话失效时送管理员回登录页
    if (!loading && !admin) void navigate('/admin/login', { replace: true });
  }, [loading, admin, navigate]);

  // 当前选中项：/admin 精确匹配（否则任何子页都会点亮概览），其余按前缀匹配
  const selectedKey = useMemo(() => {
    const { pathname } = location;
    if (pathname === '/admin' || pathname === '/admin/') return '/admin';
    return (
      Object.keys(PAGE_TITLES)
        .filter((key) => key !== '/admin')
        .find((key) => pathname.startsWith(key)) ?? '/admin'
    );
  }, [location]);

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
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider width={220} theme="dark">
        <div
          style={{
            height: 64,
            display: 'flex',
            alignItems: 'center',
            padding: '0 24px',
            color: token.colorTextLightSolid,
            fontSize: 16,
            fontWeight: 600,
          }}
        >
          职工素质评议 · 后台
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={MENU_ITEMS}
          style={{ borderInlineEnd: 'none' }}
        />
      </Layout.Sider>

      <Layout>
        <Layout.Header
          style={{
            background: token.colorBgContainer,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            padding: '0 24px',
          }}
        >
          <span style={{ fontSize: 16, fontWeight: 600 }}>
            {PAGE_TITLES[selectedKey] ?? '后台管理'}
          </span>
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
  );
}
