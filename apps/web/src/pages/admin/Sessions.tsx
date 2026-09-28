import { useCallback, useState } from 'react';
import {
  App as AntApp,
  Button,
  Card,
  Empty,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Tooltip,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router';
import type { TableColumnsType } from 'antd';
import { adminApi, ApiError, type AdminSessionDto } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { useAdminSession } from '../../lib/sessionContext.js';
import { usePolling } from '../../lib/usePolling.js';
import { describeError, formatDateTime } from './lib.js';
import { ErrorState, LoadingState, PageHeader, StaleDataAlert, useNotify } from './shared.js';
import { SessionCreateWizard } from './SessionCreateWizard.js';
import {
  formatWindow,
  SESSION_STATUS_META,
  SessionWindowModal,
  sessionActions,
} from './sessionShared.js';

/**
 * 场次管理（评议工作流第 0 步：一场评议一个场次）。
 *
 * 新建走三步向导（SessionCreateWizard：基本信息 → 问卷基础表 → 票别分配），
 * 不再是单字段弹窗。状态机操作与开放窗口编辑弹窗来自 sessionShared（与工作台共用）；
 * 本页是列表形态：状态机按钮渲染为小号链接，行内另有「编辑窗口」与「进入工作台」。
 * draft 场次的行内入口文案是「继续配置」——进工作台补齐问卷与票别才能开始投票。
 */

export function AdminSessions() {
  const load = useCallback(() => adminApi.sessions.list(), []);
  const { data, error, loading, refresh } = usePolling(load, 0);
  const notify = useNotify();
  const modal = AntApp.useApp().modal;
  const { setSessionId, reload } = useAdminSession();
  const { can } = useAuth();
  const navigate = useNavigate();
  const canWrite = can('settings.write');

  const [wizardOpen, setWizardOpen] = useState(false);
  /** 正在流转中的场次 id：只让被操作的行进入 loading，其他行照常可点 */
  const [actingId, setActingId] = useState<string | null>(null);
  /** 正在编辑开放时间窗的场次；null 表示弹窗关闭 */
  const [windowRow, setWindowRow] = useState<AdminSessionDto | null>(null);

  const sessions = data?.sessions ?? [];

  /**
   * 配置未完成的提示（契约 M 的「提示」侧）：弹窗列出后端给的中文缺项清单，
   * 并引导回工作台补配置。start 被拒的行内按钮同时恢复可点。
   */
  const showIncomplete = (row: AdminSessionDto, detail: string): void => {
    modal.warning({
      title: `场次「${row.name}」配置未完成，还不能开始投票`,
      content: (
        <div style={{ whiteSpace: 'pre-wrap' }}>
          {detail}
          <div style={{ marginTop: 8, color: 'rgba(0, 0, 0, 0.45)' }}>
            在工作台补齐问卷与票别后即可开始投票。
          </div>
        </div>
      ),
      okText: '去工作台继续配置',
      cancelText: '关闭',
      onOk: () => void navigate(`/admin/sessions/${row.id}`),
    });
  };

  /** 流转的统一入口：start 同时承担 draft→voting 与 paused→voting。 */
  const transition = async (row: AdminSessionDto, action: 'start' | 'pause' | 'end'): Promise<void> => {
    setActingId(row.id);
    try {
      const result = await adminApi.sessions[action](row.id);
      notify.success(`场次「${row.name}」${SESSION_STATUS_META[result.session.status].text}`);
      refresh();
      reload();
    } catch (caught) {
      // 配置未完成（409 SESSION_INCOMPLETE）：后端 detail 是中文缺项清单，
      // 内容多行，用弹窗展示比一闪而过的 message 更读得清；其余错误走既有提示路径
      if (caught instanceof ApiError && caught.code === 'SESSION_INCOMPLETE') {
        showIncomplete(row, caught.message);
      } else {
        notify.error(describeError(caught, '操作失败，请重试'));
      }
    } finally {
      setActingId(null);
    }
  };

  const columns: TableColumnsType<AdminSessionDto> = [
    { title: '场次名称', dataIndex: 'name' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 120,
      render: (value: AdminSessionDto['status']) => (
        <Tag color={SESSION_STATUS_META[value].color}>{SESSION_STATUS_META[value].text}</Tag>
      ),
    },
    {
      title: '开放时间窗',
      key: 'window',
      width: 240,
      render: (_: unknown, row: AdminSessionDto) => (
        <span className="tabular">{formatWindow(row.opensAt, row.closesAt)}</span>
      ),
    },
    {
      title: '开始时间',
      dataIndex: 'startAt',
      width: 160,
      render: (value: string | null) => <span className="tabular">{formatDateTime(value)}</span>,
    },
    {
      title: '结束时间',
      dataIndex: 'endedAt',
      width: 160,
      render: (value: string | null) => <span className="tabular">{formatDateTime(value)}</span>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 320,
      render: (_: unknown, row: AdminSessionDto) => {
        const actions = sessionActions(row.status, row.startBlockers);
        return (
          <Space size={8} wrap>
            {actions.map((action) =>
              canWrite ? (
                action.confirm ? (
                  <Popconfirm
                    key={action.key}
                    title={action.confirm.title}
                    description={action.confirm.description}
                    okText={action.confirm.okText}
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void transition(row, action.key)}
                  >
                    <Button
                      size="small"
                      type="link"
                      danger={action.danger}
                      style={{ padding: 0 }}
                      loading={actingId === row.id}
                    >
                      {action.label}
                    </Button>
                  </Popconfirm>
                ) : action.disabled ? (
                  // 配置未完成时禁用并说明缺什么（DESIGN.md：行内操作 disabled+Tooltip）。
                  // disabled 按钮会吞掉鼠标事件，pointerEvents:none 让事件穿透到
                  // 外层 span，Tooltip 的 onMouseEnter 才能触发。
                  <Tooltip key={action.key} title={action.disabledReason}>
                    <span>
                      <Button size="small" type="link" style={{ padding: 0, pointerEvents: 'none' }} disabled>
                        {action.label}
                      </Button>
                    </span>
                  </Tooltip>
                ) : (
                  <Button
                    key={action.key}
                    size="small"
                    type="link"
                    style={{ padding: 0 }}
                    loading={actingId === row.id}
                    onClick={() => void transition(row, action.key)}
                  >
                    {action.label}
                  </Button>
                )
              ) : (
                <Tooltip key={action.key} title="无「修改开放时间与系统设置」权限">
                  <Button
                    size="small"
                    type="link"
                    danger={action.danger}
                    style={{ padding: 0 }}
                    disabled
                  >
                    {action.label}
                  </Button>
                </Tooltip>
              ),
            )}
            <Tooltip title="设为当前场次，后台数据将按该场次展示">
              <Button size="small" type="link" style={{ padding: 0 }} onClick={() => setSessionId(row.id)}>
                设为当前
              </Button>
            </Tooltip>
            {/* 行内操作：无权限时保留但禁用（整列消失会让表格看起来缺列） */}
            {canWrite ? (
              <Button size="small" type="link" style={{ padding: 0 }} onClick={() => setWindowRow(row)}>
                编辑窗口
              </Button>
            ) : (
              <Tooltip title="无「修改开放时间与系统设置」权限">
                <Button size="small" type="link" style={{ padding: 0 }} disabled>
                  编辑窗口
                </Button>
              </Tooltip>
            )}
            {/* draft 场次：进工作台 = 继续配置（契约 M 的「继续配置」入口） */}
            <Button
              size="small"
              type="link"
              style={{ padding: 0 }}
              onClick={() => void navigate(`/admin/sessions/${row.id}`)}
            >
              {row.status === 'draft' ? '继续配置' : '进入工作台'}
            </Button>
          </Space>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="场次管理"
        description="一场评议一个场次：点「新建场次」走三步向导（基本信息 → 问卷基础表 → 票别分配），完成后在工作台发码与查看结果。场次结束后不可恢复。"
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>
              刷新
            </Button>
            {canWrite ? (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => setWizardOpen(true)}
              >
                新建场次
              </Button>
            ) : null}
          </>
        }
      />

      {error && data ? <StaleDataAlert error={error} onRetry={refresh} /> : null}
      {!data && error ? <ErrorState error={error} onRetry={refresh} /> : null}

      {data ? (
        <Card title="场次一览" extra={`共 ${sessions.length} 个`}>
          <Table<AdminSessionDto>
            rowKey="id"
            size="small"
            loading={loading}
            columns={columns}
            dataSource={sessions}
            pagination={false}
            scroll={{ x: 'max-content' }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    canWrite ? '还没有场次，请点击右上角「新建场次」开始' : '还没有场次'
                  }
                />
              ),
            }}
          />
        </Card>
      ) : loading ? (
        <LoadingState />
      ) : null}

      {/* 新建场次三步向导：基本信息 → 问卷基础表 → 票别分配（契约 J） */}
      <SessionCreateWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={() => {
          refresh();
          reload();
        }}
      />

      {/* 开放时间窗编辑弹窗：与场次工作台页头共用同一组件 */}
      <SessionWindowModal
        session={windowRow}
        open={windowRow !== null}
        onClose={() => setWindowRow(null)}
        onSaved={() => {
          refresh();
          reload();
        }}
      />
    </>
  );
}
