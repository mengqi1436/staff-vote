import { Steps } from 'antd';

/**
 * 投票入口的流程步骤条：验证身份 → 填写打分 → 完成提交。
 *
 * 三页顶部都放同一份，让职工随时知道自己在哪一步、还剩几步。
 * 刻意不传 onChange：步骤不可点击。流程只能前进（随机码核销后回不去、
 * 提交成功后改不了），可点的步骤条会暗示「能跳回去」，是误导。
 *
 * 视觉走 Apple 风格契约：完成/进行/等待三态的颜色全部来自全局 token
 * （由 VoteSurface 的 ConfigProvider 注入），组件不写死色值；
 * 下间距 24 落在 16/24 间距节奏上。
 */
const STEP_ITEMS = [{ title: '验证身份' }, { title: '填写打分' }, { title: '完成提交' }];

export function VoteSteps({ current }: { current: 0 | 1 | 2 }) {
  return <Steps size="small" current={current} items={STEP_ITEMS} style={{ marginBottom: 24 }} />;
}
