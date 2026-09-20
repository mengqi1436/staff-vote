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
    {/* 全局用 antd 默认主题（标准企业风）；投票端由 VoteSurface 局部放大字号与触控目标。
        仅有的三个 token 定制全为对比度达标（WCAG AA 4.5:1），色值都取 antd 官方色板深一档：
        - colorPrimary #0958d9（blue-7）：默认 #1677ff 白底仅约 4.0:1
        - colorLink 同值：antd 6 的链接色不跟随 colorPrimary，需显式指定
        - colorError #cf1322（red-7）：默认 #ff4d4f 作「删除/作废」等文字色只有 3.3:1 */}
    <ConfigProvider
      locale={zhCN}
      theme={{ token: { colorPrimary: '#0958d9', colorLink: '#0958d9', colorError: '#cf1322' } }}
    >
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
);