/**
 * 后台各页共用的小组件。
 *
 * 只保留有真实逻辑价值的封装：
 *   - ErrorState：401 统一跳登录（会话过期时不让管理员逐页看「加载失败」）
 *   - StaleDataAlert：轮询失败时保留旧数据只提示
 *   - PageHeader：统一页头结构
 *   - NextStep：评议工作流的步骤串联
 *   - useNotify：统一 message 入口
 * 视觉全部用 antd 标准组件，不自造体系。
 * 上一轮的 LedgerSection / LedgerNotes / Figure 已随「年鉴」主题删除；
 * 口径说明直接用 Alert type="info" 或 Typography.Text type="secondary"。
 */
import { App as AntApp, Alert, Button, Result, Skeleton, Space } from 'antd';
import { Link, useNavigate } from 'react-router';
import type { ReactNode } from 'react';
import { ApiError } from '../../lib/api.js';

/**
 * 统一错误态。
 *
 * 401 单独处理：会话过期后每个页面都会 401，直接把管理员送回登录页，
 * 比让他逐页看到「请求失败（401）」要好。仅体验层，权限在后端。
 */
export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const navigate = useNavigate();

  if (error instanceof ApiError && error.status === 401) {
    return (
      <Result
        status="warning"
        title="登录状态已失效"
        subTitle="会话已过期或未登录，请重新登录后台"
        extra={
          <Button type="primary" onClick={() => void navigate('/admin/login', { replace: true })}>
            重新登录
          </Button>
        }
      />
    );
  }

  const detail =
    error instanceof ApiError && error.fields?.length
      ? `${error.message}（${error.fields.map((field) => `${field.path}: ${field.message}`).join('；')}）`
      : error.message;

  return (
    <Result
      status="error"
      title="数据加载失败"
      subTitle={detail}
      extra={onRetry ? <Button type="primary" onClick={onRetry}>重试</Button> : undefined}
    />
  );
}

/** 首屏加载骨架。 */
export function LoadingState({ rows = 4 }: { rows?: number }) {
  return <Skeleton active paragraph={{ rows }} style={{ padding: 16 }} />;
}

/** 页头：标题 + 说明 + 右侧操作区。 */
export function PageHeader({
  title,
  description,
  extra,
}: {
  title: ReactNode;
  description?: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 16,
        marginBottom: 16,
      }}
    >
      <div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, lineHeight: 1.4 }}>{title}</h2>
        {description ? (
          <div style={{ marginTop: 4, color: 'rgba(0, 0, 0, 0.45)', maxWidth: '78ch' }}>
            {description}
          </div>
        ) : null}
      </div>
      {extra ? <Space wrap>{extra}</Space> : null}
    </div>
  );
}

/**
 * 评议工作流的「下一步」引导，放在页面底部。
 *
 * 后台页面按工作流分组（准备 → 发票 → 执行 → 收尾），这个链接把步骤串起来，
 * 让第一次组织评议的管理员不用自己想「接下来该去哪」。
 */
export function NextStep({ to, children }: { to: string; children: ReactNode }) {
  return (
    <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid #f0f0f0' }}>
      <Link to={to}>下一步：{children} →</Link>
    </div>
  );
}

/**
 * 轮询页面在「已有数据但最近一次刷新失败」时的提示条。
 * 概览页 5 秒一轮，偶发失败不该清空屏幕，只提示数据可能不是最新。
 */
export function StaleDataAlert({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      title="最新一次刷新失败，当前显示的是最后一次成功的数据"
      description={error.message}
      action={
        <Button size="small" onClick={onRetry}>
          重试
        </Button>
      }
    />
  );
}

/** 操作成功/失败提示的统一入口，避免各页面写法不一致。 */
export function useNotify() {
  const { message } = AntApp.useApp();
  return {
    success: (text: string) => void message.success(text),
    error: (text: string) => void message.error(text),
  };
}