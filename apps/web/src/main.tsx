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
    {/* Apple 风契约 v1.1：仍基于 antd 6 组件体系，只动少数 token 值，不自造视觉体系。
        投票端由 VoteSurface 局部放大字号与触控目标（嵌套 ConfigProvider 会继承合并
        这里的 token，故投票端自动获得同款主色与圆角）。token 定制全为对比度达标：
        - colorPrimary #0066cc（深 Apple 蓝）：主色文字会落在白底与 Layout 浅灰底
          （#f5f5f7）上，浅一档的 #0071e3 在灰底只有约 4.3:1，#0066cc 两个底都在
          5:1 以上；antd 由主色派生的选中文字（Menu/Tabs itemSelectedColor 等）
          因此整体达标。唯 Tabs 的 itemHoverColor 由 colorPrimaryHover 派生，是
          落在灰底上的悬停文字，需在 components.Tabs 覆盖回 #0066cc
        - colorPrimaryHover #0071e3 / colorPrimaryActive #0055aa：实心主色按钮悬停
          时是「白字 + 主色底」，antd 派生的悬停底（#0066cc 色板第 5 档）配白字
          贴着 4.5:1 临界，显式取亮一档的旧 Apple 蓝（白字约 4.7:1）与深一档 active
        - colorLink #0066cc 与主色同值：antd 6 的链接色不跟随 colorPrimary，需显式
          指定；colorLinkHover #0055aa 同理——antd 派生的默认悬停色偏浅，浅底不达 AA
        - colorBgLayout #f5f5f7：与 body、DESIGN.md 的 layout-bg 同值，不设则后台
          Layout 走 antd 默认 #f5f5f5
        - colorInfo #0066cc：Alert info、processing 态等走 colorInfo，antd 固定默认
          #1677ff 不跟随主色，不覆盖会残留旧 antd 蓝。colorInfoText / colorWarningText
          不必覆盖：antd 派生它们取的是各自色板第 9 档深档（genColorMapToken），对
          同族浅底（colorInfoBg / colorWarningBg）本就远超 AA
        - colorError #d70015（Apple 系统红深档）：默认 #ff4d4f 作「删除/作废」等
          文字色只有 3.3:1；对 colorErrorBg #ffe7e6 约 4.6:1，无需再加深
        - components.Menu.groupTitleColor：侧栏分组标题，antd 默认
          colorTextDescription（rgba(0,0,0,0.45)）对浅灰底只有约 3.3:1
        - borderRadius 10（Apple 卡片式圆角）：antd 会派生小控件圆角 */}
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#0066cc',
          colorPrimaryHover: '#0071e3',
          colorPrimaryActive: '#0055aa',
          colorLink: '#0066cc',
          colorLinkHover: '#0055aa',
          colorBgLayout: '#f5f5f7',
          colorInfo: '#0066cc',
          colorError: '#d70015',
          borderRadius: 10,
        },
        components: {
          Menu: {
            groupTitleColor: 'rgba(0, 0, 0, 0.65)',
          },
          Tabs: {
            // 选中/按下文字默认即 colorPrimary / colorPrimaryActive（均已达标），
            // 仅悬停文字默认取 colorPrimaryHover，在 Layout 灰底上只有约 4.3:1
            itemHoverColor: '#0066cc',
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
