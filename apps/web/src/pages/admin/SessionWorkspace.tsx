import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Popconfirm, Result, Space, Spin, Tabs, Tag, Tooltip, Typography } from 'antd';
import { FieldTimeOutlined } from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router';
import { adminApi, type AdminSessionDto } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { useAdminSession } from '../../lib/sessionContext.js';
import { describeError } from './lib.js';
import { PageHeader, useNotify } from './shared.js';
import { formatWindow, SESSION_STATUS_META, SessionWindowModal, sessionActions } from './sessionShared.js';
import { AdminQuestionnaire } from './Questionnaire.js';
import { AdminTicketTypes } from './TicketTypes.js';
import { AdminTickets } from './Tickets.js';
import { AdminResults } from './Results.js';
import { SessionStats } from './StatsDashboard.js';

/**
 * 单页评议工作台（/admin/sessions/:id）。
 *
 * 把原多个管理页整合到一个页面：页头常驻本场的开放控制（状态 Tag + 状态机按钮 +
 * 开放窗口展示与编辑），页签按评议工作流排列打分表 → 人员类别 → 随机码 →
 * 结果导出。「部门」「评议项目」「职工」页签已移除：场内部门在建场时按全局部门列表
 * 自动落一条，评议项目的增删与上下移由打分表网格承接，职工名单迁到全局人员管理。
 *
 * 复用方式：路由参数 id 同步进「当前评议」上下文（setSessionId），现有页面组件
 * 依旧按上下文里的 sessionId 取数，组件本身零改动。同步只在评议确实存在时进行，
 * 否则上下文的「清理失效评议」逻辑会与这里的同步互相触发、来回抖动。
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
  /** 当前页签。职工名单已迁到全局人员管理，默认停在打分表配置。 */
  const [activeTab, setActiveTab] = useState('questionnaire');

  const session = useMemo(() => sessions.find((item) => item.id === id), [sessions, id]);

  /** 统计只在投票结束后开放：进行中/暂停/草稿时页签禁用（需求：统计在投票未结束时无法使用） */
  const statsEnabled = session?.status === 'ended';

  // 评议从未结束变为已结束（或反向重开）时，若用户正好停在统计页签则切回「打分表」，
  // 避免禁用页签仍作为 activeKey 残留导致内容区空白
  useEffect(() => {
    if (!statsEnabled && activeTab === 'stats') setActiveTab('questionnaire');
  }, [statsEnabled, activeTab]);

  // 路由评议 id → 评议上下文。列表尚未加载完或评议不存在时不同步：
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
        notify.success(`评议「${row.name}」${SESSION_STATUS_META[result.session.status].text}`);
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
        title="评议不存在或已被删除"
        subTitle="请返回评议列表确认这条评议，或在列表里新建一条。"
        extra={
          <Button type="primary" onClick={() => void navigate('/admin/sessions')}>
            返回评议列表
          </Button>
        }
      />
    );
  }

  if (sessionId !== id) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }

  const statusMeta = SESSION_STATUS_META[session.status];

  return (
    <>
      <PageHeader
        title={session.name}
        description="点右上角「编辑开放时间」可以调整这次评议什么时候能打分：开始时间留空表示不限开始，结束时间留空表示一直开放。"
        extra={
          <>
            {/* 主操作按钮：无权限时不渲染，而不是给一个点不动的按钮 */}
            {canWrite
              ? sessionActions(session.status, session.startBlockers).map((action) =>
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
                  ) : action.disabled ? (
                    // 配置未完成时禁用并说明缺什么（DESIGN.md：行内操作 disabled+Tooltip）。
                    // disabled 按钮会吞掉鼠标事件，pointerEvents:none 让事件穿透到
                    // 外层 span，Tooltip 的 onMouseEnter 才能触发。
                    <Tooltip key={action.key} title={action.disabledReason}>
                      <span>
                        <Button type="primary" disabled style={{ pointerEvents: 'none' }}>
                          {action.label}
                        </Button>
                      </span>
                    </Tooltip>
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
                )
              : null}
            {canWrite ? (
              <Button icon={<FieldTimeOutlined />} onClick={() => setWindowOpen(true)}>
                编辑开放时间
              </Button>
            ) : null}
          </>
        }
      />

      {/* 状态与开放时间必须直接可见：状态 Tag 的文字才是表意手段，颜色只是辅助 */}
      <Space wrap size={12} style={{ marginBottom: 16 }}>
        <Tag color={statusMeta.color}>{statusMeta.text}</Tag>
        <Typography.Text type="secondary">
          开放时间：
          <span className="tabular">{formatWindow(session.opensAt, session.closesAt)}</span>
        </Typography.Text>
      </Space>

      <Card>
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            // 「部门」「评议项目」「职工」页签已移除：场内部门在建场时按全局部门列表自动落一条，
            // 评议项目的增删与上下移由打分表网格承接（components/admin/QuestionnaireGrid），
            // 职工名单已迁到全局人员管理（/admin/employees）
            { key: 'questionnaire', label: '打分表', children: <AdminQuestionnaire /> },
            { key: 'ticket-types', label: '人员类别', children: <AdminTicketTypes /> },
            { key: 'tickets', label: '随机码', children: <AdminTickets /> },
            {
              key: 'stats',
              label: statsEnabled ? (
                '统计'
              ) : (
                <Tooltip title="投票结束后开放统计">统计</Tooltip>
              ),
              // 投票未结束时禁用（含 Tooltip 提示开放条件）；结束后才可进入
              disabled: !statsEnabled,
              // 统计页签切走即卸载：样表统计的加载与人员类别的 5 秒轮询不在后台空跑；
              // 其余页签用条件渲染会丢编辑态，保持 antd 的常驻挂载
              children: activeTab === 'stats' && statsEnabled ? <SessionStats /> : null,
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
