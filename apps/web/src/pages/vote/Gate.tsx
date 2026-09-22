import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Alert, Button, Card, Input, Result, Spin, Typography } from 'antd';
import { useNavigate, useSearchParams } from 'react-router';
import dayjs from 'dayjs';
import { ApiError, saveVoteToken, voteApi } from '../../lib/api.js';
import type { VoteStatus } from '../../lib/api.js';
import { saveVoteSessionInfo } from '../../components/vote/voteSession.js';
import { VoteSteps } from '../../components/vote/VoteSteps.js';
import { VoteSurface } from '../../components/VoteSurface.js';

/**
 * 投票入口（流程第 1 步：验证身份）。
 *
 * 使用者是普通职工，可能在手机上打开，也可能在公用电脑上一次性使用。
 * 因此：只输随机码，不问姓名与身份；非开放时段整页拦掉，不渲染输入框
 * （后端接口同样会拒绝，前端提示只是提示不是防线）；错误文案只按状态码给，
 * 不回显后端细节。
 *
 * 视觉走标准企业风：白卡片居中，组件全部用 antd 默认样式；
 * 字号与触控目标由 voteTheme（16px / 44px）整体放大，页面不做定制。
 */

/** 登录失败的文案：只按状态码给固定说法，不把内部错误暴露在投票入口上。 */
function loginErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return '该随机码无效或已被使用，请核对后重试，或联系发码人。';
    if (error.status === 403) return '当前未开放投票，请在通知的投票时间内再来。';
    if (error.status === 429) return '尝试过于频繁，请稍等一会儿再试。';
    if (error.status === 400) return '随机码格式不正确，请核对后重试。';
    if (error.status === 0) return '网络连接失败，请检查网络后重试。';
  }
  return '暂时无法进入，请稍后重试或联系管理员。';
}

/** 未开放时的补充说明：能判断是还没开始还是已经结束，比只说「未开放」有用。 */
function closedHint(status: VoteStatus | null): string {
  if (status === null) return '请在通知的投票时间内再来。';
  const now = dayjs();
  if (status.startAt !== null && now.isBefore(dayjs(status.startAt))) {
    return `投票将于 ${dayjs(status.startAt).format('YYYY-MM-DD HH:mm')} 开始，请在开放时间内再来。`;
  }
  if (status.endAt !== null && now.isAfter(dayjs(status.endAt))) {
    return `投票已于 ${dayjs(status.endAt).format('YYYY-MM-DD HH:mm')} 结束，感谢参与。`;
  }
  const message = status.message.trim();
  if (message !== '' && message !== '当前未开放投票') return message;
  return '请在通知的投票时间内再来。';
}

/** 居中的白卡片外壳：手机与桌面共用一套，步骤条固定在卡片顶部。 */
function GateCard({ children, maxWidth = 520 }: { children: ReactNode; maxWidth?: number }) {
  return (
    <div
      style={{
        minHeight: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '48px 16px',
      }}
    >
      <Card style={{ width: '100%', maxWidth }}>
        <VoteSteps current={0} />
        {children}
      </Card>
    </div>
  );
}

export function VoteGate() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // 规范化用户输入：去空白与连字符、转大写（镜像后端 lib/code.ts 的 normalizeCode）。
  const normalize = (raw: string) => raw.replace(/[\s-]/g, '').toUpperCase();
  // 扫码链接形如 /?code=K7M2QP9X，进页面就带进输入框
  const linkedCode = normalize(searchParams.get('code') ?? '');

  const [status, setStatus] = useState<VoteStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [code, setCode] = useState(linkedCode);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      setStatus(await voteApi.status());
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (code.trim() === '') {
        setFormError('请输入随机码。');
        return;
      }
      setSubmitting(true);
      setFormError(null);
      try {
        const result = await voteApi.session(code);
        // 多场评议：场次已暂停/结束时后端可能仍然发码成功，前端在这里拦下并说明原因
        if (result.session !== undefined && result.session.status !== 'voting') {
          setFormError('当前场次未开放投票，请稍后再试或联系发码人。');
          return;
        }
        // 服务端还没有启用任何部门时，打分页无表可填、只能把人弹回入口。
        // 空部门是合法响应而不是错误，所以在这里说清原因，不存令牌也不跳转。
        if (result.departments.length === 0) {
          setFormError('当前还没有可评议的部门，请联系评议组织者。');
          return;
        }
        saveVoteToken(result.token);
        saveVoteSessionInfo({
          ticketType: result.ticketType,
          departments: result.departments,
          // 场次信息旧后端没有：undefined 原样交给缓存，读取端容错
          session: result.session,
        });
        // replace：不回退到一个已经核销过的入口页
        void navigate('/vote/sheet', { replace: true });
      } catch (error: unknown) {
        setFormError(loginErrorText(error));
      } finally {
        setSubmitting(false);
      }
    },
    [code, navigate],
  );

  if (loading) {
    return (
      <VoteSurface>
        <GateCard>
          <div style={{ padding: '32px 0', textAlign: 'center' }}>
            <Spin />
            <p role="status" style={{ margin: '16px 0 0' }}>
              <Typography.Text type="secondary">正在核对投票状态……</Typography.Text>
            </p>
          </div>
        </GateCard>
      </VoteSurface>
    );
  }

  if (loadFailed) {
    return (
      <VoteSurface>
        <GateCard>
          <Result
            status="error"
            title="暂时无法取回投票状态"
            subTitle="没有取到投票状态，请检查网络后重试。"
            extra={
              <Button type="primary" onClick={() => void loadStatus()}>
                重新加载
              </Button>
            }
          />
        </GateCard>
      </VoteSurface>
    );
  }

  if (status === null || !status.open) {
    // 未开放：整页拦掉，不渲染输入框，只把「什么时候能来」说清楚
    return (
      <VoteSurface>
        <GateCard>
          <Result status="info" title="当前未开放投票" subTitle={closedHint(status)} />
        </GateCard>
      </VoteSurface>
    );
  }

  // 多场评议：所在场次已暂停或已结束（旧后端没有 session 字段，undefined 时不拦截）
  if (status.session !== undefined && status.session.status !== 'voting') {
    return (
      <VoteSurface>
        <GateCard>
          <Result status="info" title="当前场次未开放投票" subTitle={`「${status.session.name}」暂未开放投票，请在通知的投票时间内再来。`} />
        </GateCard>
      </VoteSurface>
    );
  }

  return (
    <VoteSurface>
      <GateCard>
        <Typography.Title level={3} style={{ marginTop: 0, marginBottom: 8, textAlign: 'center' }}>
          职工素质评议
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 24, textAlign: 'center' }}>
          请输入发放给您的随机码。本系统不询问也不记录您的姓名与身份。
        </Typography.Paragraph>

        <form onSubmit={(event) => void handleSubmit(event)}>
          <label htmlFor="vote-code" style={{ display: 'block', marginBottom: 8 }}>
            随机码
          </label>
          <Input
            id="vote-code"
            value={code}
            placeholder="请输入随机码"
            autoComplete="off"
            spellCheck={false}
            aria-describedby="vote-code-hint"
            status={formError === null ? undefined : 'error'}
            // 与后端 normalizeCode 保持一致：去空白、去连字符、转大写，让职工看到的就是要提交的
            onChange={(event) => setCode(event.target.value.replace(/[\s-]/g, '').toUpperCase())}
            style={{ textAlign: 'center' }}
          />
          <Typography.Paragraph id="vote-code-hint" type="secondary" style={{ margin: '8px 0 0' }}>
            随机码不区分大小写，中间的空格与连字符可以照抄。
          </Typography.Paragraph>

          {formError === null ? null : (
            // antd Alert 自带 role="alert"，读屏会立即播报动态出现的错误
            <Alert type="error" showIcon title={formError} style={{ marginTop: 16 }} />
          )}

          <Button type="primary" htmlType="submit" block loading={submitting} style={{ marginTop: 24 }}>
            进入打分
          </Button>
        </form>

        <Typography.Paragraph type="secondary" style={{ margin: '16px 0 0' }}>
          {linkedCode !== '' && code === linkedCode
            ? '已从链接带入随机码，确认无误后点击「进入打分」。一码一票，提交后不可修改。'
            : '一码一票，提交后不可修改，请核对无误后再提交。'}
        </Typography.Paragraph>
      </GateCard>
    </VoteSurface>
  );
}
