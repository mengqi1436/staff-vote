import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { App } from './App.js';
import './styles/global.css';

dayjs.locale('zh-cn');

const container = document.getElementById('root');
if (!container) throw new Error('#root 容器不存在');

createRoot(container).render(
  <StrictMode>
    {/* Apple 风契约 v1：仍基于 antd 6 组件体系，只动少数 token 值，不自造视觉体系。
        投票端由 VoteSurface 局部放大字号与触控目标（嵌套 ConfigProvider 会继承合并
        这里的 token，故投票端自动获得同款主色与圆角）。token 定制全为对比度达标：
        - colorPrimary #0071e3（Apple 蓝）：白底对比度约 4.6:1，达 WCAG AA 4.5:1
        - colorLink 同值：antd 6 的链接色不跟随 colorPrimary，需显式指定
        - colorInfo 同值：Alert info、processing 态等走 colorInfo，antd 固定默认
          #1677ff 不跟随主色，不覆盖会残留旧 antd 蓝
        - colorError #d70015（Apple 系统红深档）：默认 #ff4d4f 作「删除/作废」等
          文字色只有 3.3:1
        - borderRadius 10（Apple 卡片式圆角）：antd 会派生小控件圆角 */}
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#0071e3',
          colorLink: '#0071e3',
          colorInfo: '#0071e3',
          colorError: '#d70015',
          borderRadius: 10,
        },
        components: {
          Menu: {
            itemSelectedColor: '#0066cc',
            subMenuItemSelectedColor: '#0066cc',
          },
        },
      }}
    >
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
);