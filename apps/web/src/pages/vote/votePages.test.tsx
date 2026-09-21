import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { VOTE_TOKEN_KEY } from '../../lib/api.js';
import type { TicketTypeDto, VoteColumnBrief, VoteCriterionDto } from '../../lib/api.js';
import { saveVoteSessionInfo } from '../../components/vote/voteSession.js';
import { VoteDone } from './Done.js';
import { VoteGate } from './Gate.js';
import { VoteSheet } from './Sheet.js';

/**
 * 投票入口三页的页面级测试。
 *
 * 打分表的键盘与校验在 ScoreTable.test.tsx 里测；这里管的是页面外壳：
 * 关闭态是否真的不渲染输入框、登录错误是否按状态码翻译、无令牌是否退回入口、
 * 页面能不能把部门名/票种/打分表组装起来。只 mock 全局 fetch，走真实的 lib/api.ts。
 */

const TICKET_TYPE: TicketTypeDto = {
  id: 't1',
  code: 'FRONT',
  name: '一线职工票',
  weightPercent: 60,
  sortOrder: 1,
  enabled: true,
};

const DEPARTMENT = { id: 'd1', name: '生产部' };

const CRITERIA: VoteCriterionDto[] = [
  { id: 'c1', name: '政治素质', description: '信念坚定、对党忠诚。', minScore: 0, maxScore: 20 },
];

const VOTE_COLUMNS: VoteColumnBrief[] = [{ id: 'v1', name: '主任', employeeName: '张三' }];

/** 打分表响应体：与 GET /api/vote/sheet 的契约一致（表头文案 + 项点行 + 被评列）。 */
function sheetBody(overrides: Record<string, unknown> = {}) {
  return {
    department: DEPARTMENT,
    questionnaireType: 'person',
    headerNote: '附件1-1',
    title: 'xx车间负责人评价问卷',
    footerNote: '填写说明：每一条评价项点满分20分，弃权、不填视为0分。',
    criteria: CRITERIA,
    voteColumns: VOTE_COLUMNS,
    ...overrides,
  };
}

const fetchMock = vi.fn();

/** 只实现 lib/api.ts 用到的三个成员，避免依赖 jsdom 里不保证存在的 Response 类。 */
function reply(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(payload)),
  };
}

function statusBody(open: boolean) {
  return { open, message: open ? '' : '当前未开放投票', startAt: null, endAt: null };
}

function renderGate(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<VoteGate />} />
        <Route path="/vote/sheet" element={<div>已进入打分表页</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Gate 与真实打分页同挂：验证「登录成功 → 进入打分页」这条真实链路，而不是被 stub 掩盖。 */
function renderGateToSheet(session: unknown) {
  fetchMock.mockImplementation((url: string) => {
    if (url.endsWith('/api/vote/status')) return Promise.resolve(reply(200, statusBody(true)));
    if (url.endsWith('/api/vote/session')) return Promise.resolve(reply(200, session));
    return Promise.resolve(reply(404, { error: { code: 'NOT_FOUND', message: '未预期的请求' } }));
  });
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<VoteGate />} />
        <Route path="/vote/sheet" element={<VoteSheet />} />
        <Route path="/vote/done" element={<div>已进入成功页</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderSheet(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<div>已回到投票入口</div>} />
        <Route path="/vote/sheet" element={<VoteSheet />} />
        <Route path="/vote/done" element={<div>已进入成功页</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** 断言页面顶部的流程步骤条：三步固定，当前步高亮（antd Steps 的 process 态）。 */
function expectCurrentStep(container: HTMLElement, title: string): void {
  const steps = container.querySelector('.ant-steps');
  expect(steps).not.toBeNull();
  const titles = [...steps!.querySelectorAll('.ant-steps-item-title')].map((node) => node.textContent);
  expect(titles).toEqual(['验证身份', '填写打分', '完成提交']);
  expect(steps!.querySelector('.ant-steps-item-process .ant-steps-item-title')?.textContent).toBe(title);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('投票入口（Gate）', () => {
  it('未开放时整页提示，且不渲染随机码输入框', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, statusBody(false)));
    const { container } = renderGate('/');

    expect(await screen.findByText('当前未开放投票')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /进入打分/ })).not.toBeInTheDocument();
    expectCurrentStep(container, '验证身份');
  });

  it('开放时渲染输入框，链接里的随机码自动填入，提交后存令牌并进入打分表', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, statusBody(true)));
    fetchMock.mockResolvedValueOnce(
      reply(200, { token: 'tok-1', ticketType: TICKET_TYPE, departments: [DEPARTMENT] }),
    );
    const { container } = renderGate('/?code=K7M2QP9X');

    expect(await screen.findByRole('textbox')).toHaveValue('K7M2QP9X');
    expectCurrentStep(container, '验证身份');

    fireEvent.click(screen.getByRole('button', { name: /进入打分/ }));
    expect(await screen.findByText('已进入打分表页')).toBeInTheDocument();
    expect(sessionStorage.getItem(VOTE_TOKEN_KEY)).toBe('tok-1');
  });

  it('票据无效时给友好文案，不回显后端细节也不放行', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, statusBody(true)));
    fetchMock.mockResolvedValueOnce(reply(401, { error: { code: 'TICKET_USED', message: '该票据已使用' } }));
    renderGate('/');

    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'AAAA2222' } });
    fireEvent.click(screen.getByRole('button', { name: /进入打分/ }));

    expect(await screen.findByText(/该随机码无效或已被使用/)).toBeInTheDocument();
    expect(screen.queryByText(/该票据已使用/)).not.toBeInTheDocument();
    expect(screen.queryByText('已进入打分表页')).not.toBeInTheDocument();
  });

  it('触发限流时提示稍后再试', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, statusBody(true)));
    fetchMock.mockResolvedValueOnce(reply(429, { error: { code: 'RATE_LIMITED', message: 'too many requests' } }));
    renderGate('/');

    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'AAAA2222' } });
    fireEvent.click(screen.getByRole('button', { name: /进入打分/ }));

    expect(await screen.findByText(/尝试过于频繁/)).toBeInTheDocument();
  });

  it('没有任何可评议部门时留在入口并说明原因，不静默弹回', async () => {
    renderGateToSheet({ token: 'tok-1', ticketType: TICKET_TYPE, departments: [] });

    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'K7M2QP9X' } });
    fireEvent.click(screen.getByRole('button', { name: /进入打分/ }));

    // 空部门是服务端的合法状态，必须说清楚「为什么进不去」，而不是把职工弹回一个没变化的页面
    expect(await screen.findByText(/还没有可评议的部门/)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });
});

describe('打分表页（Sheet）', () => {
  it('没有投票令牌时退回投票入口', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, statusBody(false)));
    renderSheet('/vote/sheet');

    expect(await screen.findByText('已回到投票入口')).toBeInTheDocument();
  });

  it('有令牌与缓存时显示参考表版式的打分表，不出现后台术语，请求带上投票令牌', async () => {
    sessionStorage.setItem(VOTE_TOKEN_KEY, 'tok-1');
    saveVoteSessionInfo({ ticketType: TICKET_TYPE, departments: [DEPARTMENT] });
    fetchMock.mockResolvedValueOnce(reply(200, sheetBody()));
    const { container } = renderSheet('/vote/sheet');

    // 行 = 项点，列 = 被评列；抬头与表尾说明来自后台配置
    expect(await screen.findByRole('rowheader', { name: /政治素质/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '主任' })).toBeInTheDocument();
    expect(screen.getByText('附件1-1')).toBeInTheDocument();
    expect(screen.getByText('xx车间负责人评价问卷')).toBeInTheDocument();
    expect(screen.getByText(/弃权、不填视为0分/)).toBeInTheDocument();
    expect(screen.getByText('提交后不可修改')).toBeInTheDocument();
    // 「票种」是后台术语，职工可见文案里不许出现
    expect(screen.queryByText(/票种/)).not.toBeInTheDocument();
    expectCurrentStep(container, '填写打分');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/vote/sheet?departmentId=d1'),
      expect.objectContaining({ headers: { Authorization: 'Bearer tok-1' } }),
    );
  });
});

describe('成功页（Done）', () => {
  it('明确告知已提交且不可修改，不留可回退的入口', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/vote/done']}>
        <Routes>
          <Route path="/vote/done" element={<VoteDone />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('提交成功')).toBeInTheDocument();
    expect(screen.getByText(/提交后不可修改/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expectCurrentStep(container, '完成提交');
  });
});

describe('未开放时的区分（Gate）', () => {
  it('未开始时说明开始时间，仍然不渲染输入框', async () => {
    const startAt = new Date(Date.now() + 3 * 3600_000).toISOString();
    fetchMock.mockResolvedValueOnce(reply(200, { open: false, message: '', startAt, endAt: null }));
    renderGate('/');

    expect(await screen.findByText('当前未开放投票')).toBeInTheDocument();
    expect(screen.getByText(/投票将于 \d{4}-\d{2}-\d{2} \d{2}:\d{2} 开始/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /进入打分/ })).not.toBeInTheDocument();
  });

  it('已结束时说明结束时间', async () => {
    const endAt = new Date(Date.now() - 3 * 3600_000).toISOString();
    fetchMock.mockResolvedValueOnce(reply(200, { open: false, message: '', startAt: null, endAt }));
    renderGate('/');

    expect(await screen.findByText(/投票已于 \d{4}-\d{2}-\d{2} \d{2}:\d{2} 结束，感谢参与/)).toBeInTheDocument();
  });

  it('开放时用 .vote-surface 外壳包住页面', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, statusBody(true)));
    const { container } = renderGate('/');

    expect(await screen.findByRole('textbox')).toBeInTheDocument();
    expect(container.querySelector('.vote-surface')).not.toBeNull();
  });
});

describe('打分表页的错误汇总与失败保留', () => {
  /** 进入打分表页：令牌 + 会话缓存 + 一份只有 1 个项点、1 个被评列的打分表。 */
  function enterSheet() {
    sessionStorage.setItem(VOTE_TOKEN_KEY, 'tok-1');
    saveVoteSessionInfo({ ticketType: TICKET_TYPE, departments: [DEPARTMENT] });
    fetchMock.mockResolvedValueOnce(reply(200, sheetBody()));
    return renderSheet('/vote/sheet');
  }

  it('提交失败时给出可聚焦的错误汇总，链接指向那一格，inline 标红同时保留', async () => {
    enterSheet();

    const cell = await screen.findByRole('spinbutton', { name: /政治素质/ });
    expect(cell).not.toHaveClass('invalid');

    fireEvent.click(screen.getByRole('button', { name: /提交评分/ }));

    // error summary：role=alert、可聚焦，焦点落在它的标题上
    const summary = await screen.findByRole('alert');
    expect(summary).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('heading', { name: '有 1 处需要修正，尚未提交' })).toHaveFocus();

    // 每条错误都是指向该格的链接
    const link = screen.getByRole('link', { name: /第 1 项「政治素质」的「主任」：未填写/ });
    expect(link).toHaveAttribute('href', '#cell-v1-c1');
    expect(document.getElementById('cell-v1-c1')).toBe(cell);

    // inline 错误没有被 summary 替代
    expect(cell).toHaveClass('invalid');
    expect(cell).toHaveAttribute('aria-invalid', 'true');
    expect(cell).toHaveAttribute('title', '未填写');
  });

  it('点汇总里的链接，焦点落到对应的那一格', async () => {
    enterSheet();

    const cell = await screen.findByRole('spinbutton', { name: /政治素质/ });
    fireEvent.click(screen.getByRole('button', { name: /提交评分/ }));

    fireEvent.click(await screen.findByRole('link', { name: /政治素质.*主任/ }));

    await waitFor(() => expect(cell).toHaveFocus());
  });

  it('服务端拒绝提交时保留已填内容，也保留打分表本身', async () => {
    sessionStorage.setItem(VOTE_TOKEN_KEY, 'tok-1');
    saveVoteSessionInfo({ ticketType: TICKET_TYPE, departments: [DEPARTMENT] });
    fetchMock.mockResolvedValueOnce(reply(200, sheetBody()));
    fetchMock.mockResolvedValueOnce(reply(403, { error: { code: 'VOTE_CLOSED', message: '未开放' } }));
    renderSheet('/vote/sheet');

    const cell = await screen.findByRole('spinbutton', { name: /政治素质/ });
    fireEvent.change(cell, { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: /提交评分/ }));

    expect(await screen.findByText(/当前未开放投票，暂时无法提交/)).toBeInTheDocument();
    expect(cell).toHaveValue(8);
    // 本地校验没有拦下，页面不该误报「需要修正」
    expect(screen.queryByText(/处需要修正/)).not.toBeInTheDocument();
  });

  it('随机码已核销时进入终态并清掉本地令牌，不再渲染打分表', async () => {
    sessionStorage.setItem(VOTE_TOKEN_KEY, 'tok-1');
    saveVoteSessionInfo({ ticketType: TICKET_TYPE, departments: [DEPARTMENT] });
    fetchMock.mockResolvedValueOnce(reply(200, sheetBody()));
    fetchMock.mockResolvedValueOnce(reply(409, { error: { code: 'TICKET_USED', message: '已使用' } }));
    renderSheet('/vote/sheet');

    const cell = await screen.findByRole('spinbutton', { name: /政治素质/ });
    fireEvent.change(cell, { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: /提交评分/ }));

    expect(await screen.findByText(/一码一票不能重复提交/)).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(sessionStorage.getItem(VOTE_TOKEN_KEY)).toBeNull();
  });
});