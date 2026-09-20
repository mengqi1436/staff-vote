import type { ReactNode } from 'react';
import { ConfigProvider } from 'antd';
import { voteTheme } from '../theme.js';

/**
 * 投票端的人格外壳。
 *
 * 双人格共用颜色与形状（同一本年鉴），只在密度与字号上分叉：
 * 这一层把 voteTheme 与 `.vote-surface` 的宽松间距尺度一起套上去，
 * 于是投票入口的页面代码不需要关心自己处在哪套密度里。
 *
 * 真正的防线在后端；这里的样式分叉只服务于阅读与操作手感。
 */
export function VoteSurface({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider theme={voteTheme}>
      <div className="vote-surface">{children}</div>
    </ConfigProvider>
  );
}