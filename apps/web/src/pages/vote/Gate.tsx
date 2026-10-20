import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Alert, Button, Input, Result, Spin, Typography } from 'antd';
import { HourglassOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router';
import dayjs from 'dayjs';
import { ApiError, saveVoteToken, voteApi } from '../../lib/api.js';
import type { VoteStatus } from '../../lib/api.js';
import { saveVoteSessionInfo } from '../../components/vote/voteSession.js';
import { VoteSteps } from '../../components/vote/VoteSteps.js';
import { GateScene } from '../../components/vote/GateScene.js';
import { VoteSurface } from '../../components/VoteSurface.js';

/**
 * 投票入口（流程第 1 步：验证身份）。
 *
 * 使用者是普通职工，可能在手机上打开，也可能在公用电脑上一次性使用。
 * 因此：只输随机码，不问姓名与身份；非开放时段整页拦掉，不渲染输入框
 * （后端接口同样会拒绝，前端提示只是提示不是防线）；错误文案只按状态码给，
 * 不回显后端细节。
 *
 * 视觉走 Apple 风格契约：白卡片居中、大标题 700 字重加轻微负字距（仅标题级）、
 * 说明文字用 secondary 灰；主色与圆角交给全局 token，页面不写死色值；
 * 字号与触控目标由 voteTheme（16px / 44px）整体放大。
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
  if (status.opensAt !== null && now.isBefore(dayjs(status.opensAt))) {
    return `投票将于 ${dayjs(status.opensAt).format('YYYY-MM-DD HH:mm')} 开始，请在开放时间内再来。`;
  }
  if (status.closesAt !== null && now.isAfter(dayjs(status.closesAt))) {
    return `投票已于 ${dayjs(status.closesAt).format('YYYY-MM-DD HH:mm')} 结束，感谢参与。`;
  }
  const message = status.message.trim();
  if (message !== '' && message !== '当前未开放投票') return message;
  return '请在通知的投票时间内再来。';
}

/**
 * 页面外壳：无卡片容器，内容直接落在页面背景上。
 *
 * 之前用 antd Card 包住，页面上就多了一个 520px 宽的白框——投票入口本身
 * 只有「一句话 + 一个输入框」，白框既没有分组价值，又把注意力从文案上抢走。
 * 现在改成「背景 → 内容 → 场景」三层直接叠放，层级靠字号与留白建立，
 * 不靠容器边界。阅读宽度由 `.gate-shell-inner` 的 CSS 统一决定。
 *
 * `withTrain` 只给「未开放」分支用：那条路径没有输入框可操作，留出空间
 * 让高铁进站场景完整演完；正常投票流程不带列车，避免抢注意力。
 *
 * `showSteps` 控制是否显示流程步骤条：只有真正可以投票（进入打分流程）
 * 时才显示。未开放时流程根本不会开始，显示「1/3 验证身份」是误导。
 */
function GateLayout({
  children,
  withTrain = false,
  showSteps = false,
}: {
  children: ReactNode;
  withTrain?: boolean;
  showSteps?: boolean;
}) {
  return (
    <GateScene withTrain={withTrain}>
      <div className="gate-shell">
        <div className="gate-shell-inner">
          {showSteps ? <VoteSteps current={0} /> : null}
          {children}
        </div>
      </div>
    </GateScene>
  );
}

/**
 * 未开放时的说明内容。
 *
 * 按 UX 空状态规则：不能只给一句「未开放」就让人走，要给出**为什么**和
 * **下一步该做什么**。这里按「图标 → 标题 → 评议名 → 说明 → 时间窗 →
 * 指引」六级排布，层级靠字号与留白建立。
 *
 * 状态判定以**评议状态为主、时间窗为辅**：后端 `resolveStatusSession` 在库中
 * 只有一场时会自动回传该评议，因此单场部署下 `status.session` 恒非 null。
 * 若先判 `sessionName`，管理员结束评议后职工会看到「暂未开放，请在开放时间内
 * 再来」——而评议其实永久结束了，这是错误指引。
 */
function ClosedNotice({ status }: { status: VoteStatus | null }) {
  const now = dayjs();
  const sessionStatus = status?.session?.status ?? null;
  const opensAt = status?.opensAt != null ? dayjs(status.opensAt) : null;
  const closesAt = status?.closesAt != null ? dayjs(status.closesAt) : null;
  const notStarted = opensAt !== null && now.isBefore(opensAt);
  const ended = closesAt !== null && now.isAfter(closesAt);
  const sessionName = (status?.session?.name ?? '').trim();

  // 标题：评议状态优先，其次时间窗。四种状态给出四种不同行动指引
  const heading =
    sessionStatus === 'ended' || ended
      ? '本轮投票已结束'
      : sessionStatus === 'paused'
        ? '投票已暂停'
        : sessionStatus === 'draft' || notStarted
          ? '投票尚未开始'
          : '当前未开放投票';

  // 时间窗只在「评议本身在投票中、只是时间没到/已过」时展示；
  // 评议被暂停或结束时窗口里的日期会与标题自相矛盾（显示一个还能投的时间）。
  const showWindow = sessionStatus === null || sessionStatus === 'voting';

  // 下一步指引必须与标题一致：「已结束」让人别再等开放时间
  const nextStep =
    heading === '本轮投票已结束'
      ? '本轮评议已归档；如需补录或复核，请联系评议组织者。'
      : heading === '投票已暂停'
        ? '本次评议已暂停，恢复后即可继续；具体时间请留意组织者通知。'
        : '请在开放时间内重新打开本页面；若时间已过但仍需参与，请联系评议组织者。';

  return (
    <div className="gate-notice">
      {/* 层级 1：状态图标。沙漏而不是时钟——时钟本身是圆的，和外层
          圆环叠成「圆中圆中圆」，形状重复；沙漏与外圆互补，
          语义也正好是「等待中」而不是「几点」 */}
      <div aria-hidden="true" className="gate-notice-icon">
        <HourglassOutlined />
      </div>

      {/* 层级 2：主标题。全页唯一的大字号，明确「现在是什么状态」 */}
      <Typography.Title level={2} className="gate-notice-title">
        {heading}
      </Typography.Title>

      {/* 层级 3：评议名（仅多场评议时出现），字号介于标题与说明之间 */}
      {sessionName !== '' ? <div className="gate-notice-session">{`「${sessionName}」`}</div> : null}

      {/* 层级 4：一句解释，说清原因 */}
      <Typography.Paragraph type="secondary" className="gate-notice-desc">
        {sessionName !== '' && showWindow ? '该评议暂未开放投票，请在通知的投票时间内再来。' : closedHint(status)}
      </Typography.Paragraph>

      {/* 层级 5：时间窗。用上下细线分隔，而不是灰底块——灰底块本身就是
          一个「小卡片」，和刚去掉的白框是同一类视觉噪音 */}
      {showWindow && (opensAt !== null || closesAt !== null) ? (
        <dl className="gate-notice-times">
          {opensAt !== null ? (
            <div>
              <dt>开始时间</dt>
              <dd className="tabular">{opensAt.format('YYYY-MM-DD HH:mm')}</dd>
            </div>
          ) : null}
          {closesAt !== null ? (
            <div>
              <dt>结束时间</dt>
              <dd className="tabular">{closesAt.format('YYYY-MM-DD HH:mm')}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {/* 层级 6：下一步指引。字号最小、最弱，但内容最可执行 */}
      <p className="gate-notice-next">{nextStep}</p>
    </div>
  );
}

export function VoteGate() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // 规范化用户输入：NFKC（全角数字转半角）后只留数字，最多 12 位（与后端 lib/code.ts 一致）。
  // 用 \D 一次去掉空格、连字符等分隔符，粘贴打印纸上的「1234 5678 9012」也能直接用；
  // 限长放在归一化之后（不能用原生 maxLength：它会在去掉空格前截断，把码截短）。
  const normalize = (raw: string) => raw.normalize('NFKC').replace(/\D/g, '').slice(0, 12);
  // 扫码链接形如 /?code=123456789012，进页面就带进输入框
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
        // 多场评议：评议已暂停/结束时后端可能仍然发码成功，前端在这里拦下并说明原因
        if (result.session !== undefined && result.session.status !== 'voting') {
          setFormError('本次评议未开放，请稍后再试或联系发码人。');
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
          // 评议信息旧后端没有：undefined 原样交给缓存，读取端容错
          session: result.session,
        });
        // replace：不回退到一个已经使用过的入口页
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
        <GateLayout>
          <div style={{ padding: '32px 0', textAlign: 'center' }}>
            <Spin />
            <p role="status" style={{ margin: '16px 0 0' }}>
              <Typography.Text type="secondary">正在核对投票状态……</Typography.Text>
            </p>
          </div>
        </GateLayout>
      </VoteSurface>
    );
  }

  if (loadFailed) {
    return (
      <VoteSurface>
        <GateLayout>
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
        </GateLayout>
      </VoteSurface>
    );
  }

  // 未开放或评议已暂停/结束（旧后端没有 session 字段、聚合判定回传 null 时都不拦截）：
  // 整页拦掉，不渲染输入框，只把「为什么」和「什么时候能来」说清楚
  const sessionClosed = status?.session != null && status.session.status !== 'voting';
  if (status === null || !status.open || sessionClosed) {
    return (
      <VoteSurface>
        <GateLayout withTrain>
          <ClosedNotice status={status} />
        </GateLayout>
      </VoteSurface>
    );
  }

  return (
    <VoteSurface>
      <GateLayout showSteps>
        {/* 大标题按契约加 700 字重与 -0.01em 负字距；负字距只允许出现在标题级，
            中文正文与说明文字不加，否则笔画密的中文字会挤在一起。
            level 与未开放分支统一为 2，避免同一路由出现 h2/h3 混用。 */}
        <Typography.Title
          level={2}
          style={{ marginTop: 0, marginBottom: 8, textAlign: 'center', fontWeight: 700, letterSpacing: '-0.01em' }}
        >
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
            placeholder="请输入 12 位随机码"
            autoComplete="off"
            spellCheck={false}
            inputMode="numeric"
            aria-describedby="vote-code-hint"
            status={formError === null ? undefined : 'error'}
            // 与后端 normalizeCode 保持一致：只留数字、限长 12 位，让职工看到的就是要提交的
            onChange={(event) => setCode(normalize(event.target.value))}
            style={{ textAlign: 'center' }}
          />
          <Typography.Paragraph id="vote-code-hint" type="secondary" style={{ margin: '8px 0 0' }}>
            12 位数字，中间的空格可以照抄。
          </Typography.Paragraph>

          {formError === null ? null : (
            // antd Alert 自带 role="alert"，读屏会立即播报动态出现的错误
            <Alert type="error" showIcon title={formError} style={{ marginTop: 16 }} />
          )}

          <Button type="primary" htmlType="submit" block loading={submitting} style={{ marginTop: 24 }}>
            进入打分
          </Button>
        </form>

        {/* 尾注与标题、说明共用同一条中轴线，卡片视觉更平衡；文案是测试断言点，只动对齐 */}
        <Typography.Paragraph type="secondary" style={{ margin: '16px 0 0', textAlign: 'center' }}>
          {linkedCode !== '' && code === linkedCode
            ? '已从链接带入随机码，确认无误后点击「进入打分」。一码一票，提交后不可修改。'
            : '一码一票，提交后不可修改，请核对无误后再提交。'}
        </Typography.Paragraph>
      </GateLayout>
    </VoteSurface>
  );
}
