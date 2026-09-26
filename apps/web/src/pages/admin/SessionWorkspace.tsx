import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Popconfirm, Result, Space, Spin, Tabs, Tag, Typography } from 'antd';
import { FieldTimeOutlined } from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router';
import { adminApi, type AdminSessionDto } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { useAdminSession } from '../../lib/sessionContext.js';
import { describeError } from './lib.js';
import { PageHeader, useNotify } from './shared.js';
import { formatWindow, SESSION_STATUS_META, SessionWindowModal, sessionActions } from './sessionShared.js';
import { AdminDepartments } from './Departments.js';
import { AdminCriteria } from './Criteria.js';
import { AdminEmployees } from './Employees.js';
import { AdminQuestionnaire } from './Questionnaire.js';
import { AdminTicketTypes } from './TicketTypes.js';
import { AdminTickets } from './Tickets.js';
import { AdminResults } from './Results.js';
import { DepartmentProgressTable, TicketTypeStatsTable } from './StatsTables.js';

/**
 * 单页场次工作台（/admin/sessions/:id）。
 *
 * 把原多个管理页整合到一个页面：页头常驻本场的开放控制（状态 Tag + 状态机按钮 +
 * 开放窗口展示与编辑），页签按评议工作流排列部门 → 项点 → 职工 → 问卷 → 票种权重 →
 * 随机码 → 统计 → 结果导出。
 *
 * 复用方式：路由参数 id 同步进「当前场次」上下文（setSessionId），现有页面组件
 * 依旧按上下文里的 sessionId 取数，组件本身零改动。同步只在场次确实存在时进行，
 * 否则上下文的「清理失效场次」逻辑会与这里的同步互相触发、来回抖动。
 */
export function SessionWorkspace() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { sessionId, setSessionId, sessions, loading, reload } = useAdminSession();
  const { can } = useAuth();
  const canWrite = can('settings.write');
  const notify = useNotify();

  /** 状态机流转请求进行中：所有状态机按钮共用一个 busy */
  const [acting, setActing] = useState(false);
  const [windowOpen, setWindowOpen] = useState(false);

  const session = useMemo(() => sessions.find((item) => item.id === id), [sessions, id]);

  // 路由场次 id → 场次上下文。列表尚未加载完或场次不存在时不同步：
  // 不存在的 id 一旦写进上下文，会被 Provider 的失效清理逻辑清掉，形成循环。
  useEffect(() => {
    if (!id || loading || !session) return;
    if (sessionId !== id) setSessionId(id);
  }, [id, loading, session, sessionId, setSessionId]);

  /** 状态机流转的统一入口：start 同时承担 draft→voting 与 paused→voting。 */
  const transition = useCallback(
    async (row: AdminSessionDto, action: 'start' | 'pause' | 'end'): Promise<void> => {
      setActing(true);
      try {
        const result = await adminApi.sessions[action](row.id);
        notify.success(`场次「${row.name}」${SESSION_STATUS_META[result.session.status].text}`);
        reload();
      } catch (caught) {
        // 409 INVALID_SESSION_TRANSITION 等错误统一走既有错误提示路径
        notify.error(describeError(caught, '操作失败，请重试'));
      } finally {
        setActing(false);
      }
    },
    [notify, reload],
  );

  if (loading && sessions.length === 0) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!session) {
    return (
      <Result
        status="warning"
        title="场次不存在或已被删除"
        subTitle="请返回场次列表确认场次，或在列表中新建场次。"
        extra={
          <Button type="primary" onClick={() => void navigate('/admin/sessions')}>
            返回场次列表
          </Button>
        }
      />
    );
  }

  const statusMeta = SESSION_STATUS_META[session.status];

  return (
    <>
      <PageHeader
        title={session.name}
        description={
          <Space wrap size={12}>
            {/* 状态不靠颜色单独表意：文字才是表意手段，Tag 颜色只是辅助 */}
            <Tag color={statusMeta.color}>{statusMeta.text}</Tag>
            <Typography.Text type="secondary">
              开放窗口：
              <span className="tabular">{formatWindow(session.opensAt, session.closesAt)}</span>
              （结束时间为空视为长期开放）
            </Typography.Text>
          </Space>
        }
        extra={
          <>
            {sessionActions(session.status).map((action) =>
              action.confirm ? (
                <Popconfirm
                  key={action.key}
                  title={action.confirm.title}
                  description={action.confirm.description}
                  okText={action.confirm.okText}
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void transition(session, action.key)}
                >
                  <Button danger={action.danger} loading={acting}>
                    {action.label}
                  </Button>
                </Popconfirm>
              ) : (
                <Button
                  key={action.key}
                  type={action.key === 'start' ? 'primary' : 'default'}
                  loading={acting}
                  onClick={() => void transition(session, action.key)}
                >
                  {action.label}
                </Button>
              ),
            )}
            {/* 主操作按钮：无权限时不渲染，而不是给一个点不动的按钮 */}
            {canWrite ? (
              <Button icon={<FieldTimeOutlined />} onClick={() => setWindowOpen(true)}>
                编辑窗口
              </Button>
            ) : null}
          </>
        }
      />

      <Card>
        <Tabs
          items={[
            { key: 'departments', label: '部门', children: <AdminDepartments /> },
            { key: 'criteria', label: '项点', children: <AdminCriteria /> },
            { key: 'employees', label: '职工', children: <AdminEmployees /> },
            { key: 'questionnaire', label: '问卷', children: <AdminQuestionnaire /> },
            { key: 'ticket-types', label: '票种权重', children: <AdminTicketTypes /> },
            { key: 'tickets', label: '随机码', children: <AdminTickets /> },
            {
              key: 'stats',
              label: '统计',
              children: (
                <>
                  <TicketTypeStatsTable />
                  <DepartmentProgressTable />
                </>
              ),
            },
            { key: 'results', label: '结果导出', children: <AdminResults /> },
          ]}
        />
      </Card>

      <SessionWindowModal
        session={session}
        open={windowOpen}
        onClose={() => setWindowOpen(false)}
        onSaved={() => reload()}
      />
    </>
  );
}
