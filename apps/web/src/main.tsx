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
        - colorLink #0066cc（深一档 Apple 蓝）：链接文字会落在 Layout 的 #f5f5f7 等
          浅灰底上，主色在其上只有约 4.3:1，故链接整体取深档；colorLinkHover 再深一档
          #0055aa——antd 由 colorLink 派生的默认悬停色比它浅两档，同样不达 AA
        - colorBgLayout #f5f5f7：与 body、DESIGN.md 的 layout-bg 同值，不设则后台
          Layout 走 antd 默认 #f5f5f5
        - components.Menu.groupTitleColor rgba(0, 0, 0, 0.65)：侧栏分组标题，antd 默认
          colorTextDescription 对浅灰底只有约 3.3:1
        - colorInfo 同主色：Alert info、processing 态等走 colorInfo，antd 固定默认
          #1677ff 不跟随主色，不覆盖会残留旧 antd 蓝
        - colorInfoText / colorWarningText 深档：浅色语义底（colorInfoBg #e6f7ff /
          colorWarningBg #fffbe6）上的文字若用主色或警示原色不达 AA，深档分别约
          5.1:1 与 6.5:1（antd 派生出的同名 token 等于原色，须显式覆盖）
        - colorError #d70015（Apple 系统红深档）：默认 #ff4d4f 作「删除/作废」等
          文字色只有 3.3:1；对 colorErrorBg #ffe7e6 约 4.6:1，无需再加深
        - borderRadius 10（Apple 卡片式圆角）：antd 会派生小控件圆角 */}
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#0071e3',
          colorLink: '#0066cc',
          colorLinkHover: '#0055aa',
          colorBgLayout: '#f5f5f7',
          colorInfo: '#0071e3',
          colorInfoText: '#0066cc',
          colorWarningText: '#874d00',
          colorError: '#d70015',
          borderRadius: 10,
        },
        components: {
          Menu: {
            groupTitleColor: 'rgba(0, 0, 0, 0.65)',
            itemSelectedColor: '#0066cc',
            subMenuItemSelectedColor: '#0066cc',
          },
          Tabs: {
            // 页签选中/悬停文字默认走主色，而 Admins/Tickets 的 Tabs 直接落在
            // Layout 灰底上（无 Card 白底包裹），主色在其上不达 AA，同样取深档
            itemSelectedColor: '#0066cc',
            itemHoverColor: '#0066cc',
            itemActiveColor: '#0066cc',
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