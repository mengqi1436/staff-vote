/**
 * 后台各页共用的小组件。
 *
 * 只保留有真实逻辑价值的封装：
 *   - ErrorState：401 统一跳登录（登录状态过期时不让管理员逐页看「加载失败」）
 *   - StaleDataAlert：轮询失败时保留旧数据只提示
 *   - PageHeader：统一页头结构
 *   - useNotify：统一 message 入口
 * 视觉全部用 antd 标准组件，不自造体系。
 * 上一轮的 LedgerSection / LedgerNotes / Figure 已随「年鉴」主题删除；
 * 解释性说明一律走 HelpTip / HelpLabel（见 DESIGN.md「提示与说明图标」），
 * 页面正文不再铺常驻说明段落；错误与警告仍用 Alert 常显。
 * （NextStep 随管理页并入评议工作台页签而移除：页签之间不再需要跨页引导。）
 */
import { App as AntApp, Alert, Button, Result, Skeleton, Space, Tooltip } from 'antd';
import { QuestionCircleOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router';
import type { ReactNode } from 'react';
import { ApiError } from '../../lib/api.js';

/**
 * 说明文字统一收进「?」图标。
 *
 * 使用场景：说明、字段含义、操作后果这类**解释性**内容。错误与警告仍用
 * Alert 直接摆在页面上，不往这里塞——藏起来的错误等于没提示。
 *
 * 触发方式三选一：鼠标悬停、点击（触屏）、键盘 Tab 聚焦后可见。
 * 用原生 button 而不是图标 span，否则键盘用户永远打不开。
 *
 * 文本会按中文句末标点自动断句分行：一长串挤成一段在浮层里最难读。
 * 需要讲层次时直接传字符串数组，一项一段。
 */
export function HelpTip({ text, label = '查看说明' }: { text: ReactNode; label?: string }) {
  return (
    <Tooltip
      title={<HelpContent text={text} />}
      trigger={['hover', 'focus', 'click']}
      placement="top"
      styles={{ container: { maxWidth: 380 } }}
    >
      <button type="button" className="help-tip" aria-label={label}>
        <QuestionCircleOutlined />
      </button>
    </Tooltip>
  );
}

/** 按句号/问号/叹号断句；超长句再按分号拆成短行，保留显式换行。 */
function splitSentences(text: string): string[] {
  const parts: string[] = [];
  for (const line of text.split('\n')) {
    for (const match of line.match(/[^。！？]+[。！？]?/g) ?? []) {
      const sentence = match.trim();
      if (sentence === '') continue;
      // 一个句号内超过 60 字，多半是并列的长句，按分号再断一次
      if (sentence.length > 60) {
        for (const clause of sentence.match(/[^；]+；?/g) ?? [sentence]) {
          const trimmed = clause.trim();
          if (trimmed !== '') parts.push(trimmed);
        }
      } else {
        parts.push(sentence);
      }
    }
  }
  return parts;
}

/** 浮层内容：多句时逐句成行；非字符串（自定义节点）原样渲染。 */
function HelpContent({ text }: { text: ReactNode }) {
  if (typeof text !== 'string') return <>{text}</>;
  const parts = splitSentences(text);
  if (parts.length <= 1) return <>{text}</>;
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {parts.map((part, index) => (
        <div key={index}>{part}</div>
      ))}
    </div>
  );
}

/** 表单标签 + 说明图标：替代 Form.Item 的 extra，避免说明文字占满一行。 */
export function HelpLabel({ children, help }: { children: ReactNode; help: ReactNode }) {
  return (
    <span className="help-label">
      {children}
      <HelpTip text={help} />
    </span>
  );
}

/**
 * 统一错误态。
 *
 * 401 单独处理：登录状态过期后每个页面都会 401，直接把管理员送回登录页，
 * 比让他逐页看到「请求失败（401）」要好。仅体验层，权限在后端。
 * SESSION_REQUIRED 单独处理：多场评议下未选评议，引导到右上角选择器（或评议管理页）。
 */
export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const navigate = useNavigate();

  if (error instanceof ApiError && error.status === 401) {
    return (
      <Result
        status="warning"
        title="登录状态已失效"
        subTitle="登录状态已过期或未登录，请重新登录后台"
        extra={
          <Button type="primary" onClick={() => void navigate('/admin/login', { replace: true })}>
            重新登录
          </Button>
        }
      />
    );
  }

  if (error instanceof ApiError && error.code === 'SESSION_REQUIRED') {
    return (
      <Result
        status="info"
        title="请先选择评议"
        subTitle="多场评议下数据按评议隔离：请在页面右上角选择当前评议后再查看数据。"
        extra={
          <Button type="primary" onClick={() => void navigate('/admin/sessions')}>
            去评议管理
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

/** 页头：标题 + 说明（收进「?」，不占版面） + 右侧操作区。 */
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
        {/* Apple 风页面大标题：22px/700、微负字距只用于大标题（中文正文不加） */}
        <h2
          style={{
            margin: 0,
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: '-0.01em',
            lineHeight: 1.3,
          }}
        >
          {title}
          {description ? <HelpTip text={description} label="查看本页说明" /> : null}
        </h2>
      </div>
      {extra ? <Space wrap>{extra}</Space> : null}
    </div>
  );
}

/**
 * 轮询页面在「已有数据但最近一次刷新失败」时的提示条。
 * 统计页签 5 秒一轮，偶发失败不该清空屏幕，只提示数据可能不是最新。
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