import { Card, Result, Typography } from 'antd';
import { VoteSteps } from '../../components/vote/VoteSteps.js';
import { VoteSurface } from '../../components/VoteSurface.js';

/**
 * 提交成功页（流程第 3 步：完成提交）。
 *
 * 职工在这里只需要确认三件事：提交成功了、不能改、可以走了。
 * 因此刻意不放「返回」或「再改一次」的入口 —— 一码一票提交即核销，
 * 留一个回退入口只会让人以为还能改，等发现不行时已经来不及补救。
 *
 * 视觉用 antd Result 的标准成功态，不做自定义动效。
 */
export function VoteDone() {
  return (
    <VoteSurface>
      <div
        style={{
          minHeight: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '48px 16px',
        }}
      >
        <Card style={{ width: '100%', maxWidth: 640 }}>
          <VoteSteps current={2} />
          <Result status="success" title="提交成功" subTitle="感谢您的参与。">
            <div style={{ display: 'grid', gap: 12, textAlign: 'left' }}>
              <p style={{ margin: 0 }}>
                您的评分已经提交并生效，<strong>提交后不可修改</strong>。
              </p>
              <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
                一码一票：这枚随机码已经核销，不能再次提交，也不能回来修改分数。
              </Typography.Paragraph>
              <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
                本页不显示您提交的内容，系统也不记录您的姓名与身份。
              </Typography.Paragraph>
              <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
                如果这是公用电脑，请关闭本页面后再离开。
              </Typography.Paragraph>
            </div>
          </Result>
        </Card>
      </div>
    </VoteSurface>
  );
}
