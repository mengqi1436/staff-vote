---
name: 职工素质评议系统
description: Apple 风格。基于 antd 6 组件体系实现（WWDC Designing Fluid Interfaces 精神的 Web 移植契约 v1），不引入新依赖。
colors:
  primary: "#0066cc"
  link: "#0066cc"
  success: "#52c41a"
  warning: "#faad14"
  error: "#d70015"
  text: "rgba(0, 0, 0, 0.88)"
  text-secondary: "rgba(0, 0, 0, 0.45)"
  layout-bg: "#f5f5f7"
  container-bg: "#ffffff"
  border: "#d9d9d9"
  split: "#f0f0f0"
typography:
  body-admin:
    fontFamily: "系统字体栈（-apple-system 开头，含 PingFang SC / Microsoft YaHei）"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.57
    letterSpacing: "normal"
  body-vote:
    fontFamily: "系统字体栈（-apple-system 开头，含 PingFang SC / Microsoft YaHei）"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.57
    letterSpacing: "normal"
rounded:
  md: "10px (ConfigProvider borderRadius，全局唯一值，不再分 4/6/8 三档)"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 15px"
  button-primary-vote:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    height: "44px"
    padding: "0 28px"
  card:
    backgroundColor: "{colors.container-bg}"
    rounded: "{rounded.md}"
    padding: "24px"
  cell-input:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    height: "44px"
---

## Overview

**Apple 风格**：克制的材质、层级分明的排版、即时按压反馈、柔和过渡。设计依据：**WWDC Designing Fluid Interfaces 精神的 Web 移植契约 v1**（下称「契约」）。实现完全基于 antd 6 组件体系，token 只在 `main.tsx` 全局 ConfigProvider 定义，不引入任何新依赖。

转向记录：前两轮自定义视觉（蓝灰定制主题、纸上年鉴）均已废弃删除；本轮 Apple 风是用户明确要求的第三次转向——用户要求界面更有 Apple 的质感与流畅感。教训不变：不在 antd 之上再造体系，本轮的「体系」就是这份契约本身，各页照做、不自行发挥。

系统有**两个人格**，差异只在密度，不在颜色与形状：

| | 后台 | 投票入口 |
|---|---|---|
| 使用者 | 管理员，评议期间每天多次，桌面 | 职工，一年一两次，可能用手机 |
| 字号 / 控件 | antd 默认密度（14px / 32px） | `voteTheme`（16px / 44px 触控） |
| 实现 | 全局默认主题 | `components/VoteSurface.tsx` 包 `voteTheme` |

## Colors

- `colorPrimary`：`#0066cc`（深 Apple 蓝）。主色文字会落在白底与 Layout 浅灰底（`#f5f5f7`）两种底上，浅一档的 `#0071e3` 在灰底只有约 4.3:1，`#0066cc` 两个底都在 5:1 以上；antd 由主色派生的选中文字（Menu / Tabs 的 `itemSelectedColor` 等）因此整体达标。唯 Tabs 的 `itemHoverColor` 由 `colorPrimaryHover` 派生、又是直接落在灰底上的悬停文字，需在 `components.Tabs` 覆盖为 `#0066cc`（选中/按下文字沿用默认派生值即可，不重复覆盖）。
- `colorPrimaryHover`：`#0071e3` / `colorPrimaryActive`：`#0055aa`。实心主色按钮悬停时是「白字 + 主色底」，antd 派生的悬停底（`#0066cc` 色板第 5 档 `#2384d9`）配白字只有约 3.9:1，显式取亮一档的 Apple 蓝（白字约 4.7:1）与深一档 active。
- `colorLink`：`#0066cc`，与主色同值（antd 6 的链接色不跟随 `colorPrimary`，需显式指定）；`colorLinkHover` 取更深一档 `#0055aa`——antd 派生的默认悬停色偏浅，落在浅底上不足 4.5:1。普通 `<a>`（react-router `Link`）的静止 / hover / active 三态由 `colorLink` / `colorLinkHover` / `colorLinkActive` 给出，不要在页面里内联覆盖链接色。
- `components.Menu.groupTitleColor`：`rgba(0, 0, 0, 0.65)`。antd 默认 `colorTextDescription`（`rgba(0, 0, 0, 0.45)`）落在浅色侧栏上只有约 3.3:1。
- `colorInfoText` / `colorWarningText`：antd 的 `genColorMapToken` 把它们取为各自色板第 9 档，而 6.6.4 的 `generateColorPalettes` 把第 9 档映射回 `colors[5]`（即原色）——默认 `colorWarningText` 就是 `#faad14`，对 `colorWarningBg` 只有 1.83:1，故显式取深档 `#874d00`（约 6.5:1）；`colorInfoText` 默认即 `#0066cc`，对 `colorInfoBg` 约 5.1:1，无需覆盖。
- `colorError`：`#d70015`（Apple 系统红深档），`colorErrorHover` 显式取深一档 `#c00f1e`——antd 派生的悬停档（色板第 5 档 `#E32431`）作 danger 链接悬停文字落在表格行 hover 灰底上只有约 4.4:1。
- 其余状态色沿用 antd 语义（success `#52c41a` / warning `#faad14` / info `#0066cc`（跟随主色，避免残留 antd 默认蓝））。
- 唯一约束：**状态不靠颜色单独表意**，停用/作废等必须同时有文字。

## Typography

- 字体栈不变：`-apple-system` 系统栈（antd 默认）。数字列（分数、数量、随机码、工号）加 `.tabular`（`font-variant-numeric: tabular-nums`），否则无法纵向比较。
- 页面大标题（PageHeader h2）：fontSize 22 / fontWeight 700 / letterSpacing -0.01em / lineHeight 1.3。
- **中文正文不加负字距**（负字距只给大标题），说明文字用 Typography secondary 灰。

## 提示与说明图标

- **只有两种提示形态**：必须立刻被看到的信息用 `Alert`（错误、警告、操作后果、风险确认、空状态）；解释性内容（口径、字段含义、算法说明、后果补充）收进标题或标签旁的「?」图标，用 `shared.tsx` 的 `HelpTip` / `HelpLabel`，页面正文不再铺灰字说明段落。
- 「?」必须可键盘操作：实现是原生 `button` + `.help-tip`，悬停、点击、Tab 聚焦都能展开；不要用 `<span>` 包图标。
- **浮层文本必须能读**：`HelpTip` 会按句末标点自动断句分行，超长句再按分号二次拆分；需要讲层次时直接传字符串数组，一项一段。不要把一整段无标点的长文塞进去。
- 不用 `Alert type="info"` 蓝框承载解释——只保留错误/警告/成功三类 Alert，以及空状态（用 `Empty`）。
- 文案读者是单位里组织评议的行政人员，不出现开发词（幂等、载荷、回显、锚点、契约编号、接口字段名）。
- 业务术语全站统一：评议 / 评议项目 / 人员类别 / 打分表 / 随机码 / 权重。打印版与导出 Excel 是纸质参考表基准，表头与表注不随界面改名。
- 投票端（职工）例外：说明保持直接可见，不折进「?」——职工一年用一两次、可能用手机，悬停不可靠。

## Layout

- 页面结构 = `PageHeader`（标题 + 说明图标 + 右侧操作）+ antd `Card` 分区。
- **信息架构按评议组织**：评议列表 + 单页评议工作台（Tabs 依次：部门 → 评议项目 → 职工 → 打分表 → 人员类别权重 → 随机码 → 统计 → 结果导出，页头常驻开放控制）。
- 投票入口三页顶部放 `VoteSteps` 步骤条（验证身份→填写打分→完成提交，不可点击，流程只能前进）。

## 材质与层级

- 顶栏：`sticky` + `rgba(255,255,255,0.72)` + `backdrop-filter: blur(20px) saturate(180%)`，无硬分隔线。
- 侧栏：浅色半透明 `rgba(245,245,245,0.85)` + `blur(20px)`，Menu `theme="light"`。
- **内容区不堆材质**：页面主体就是纯色背景 + Card，阴影只用 antd 默认（Modal、Dropdown）。
- **禁止半透明叠半透明**——毛玻璃上再叠毛玻璃会把层级糊掉。

## 动效

- 按压反馈：`.pressable`（`translateY(1px)`，120ms）——可点击的卡片/按钮即按即回。
- 过渡：120–240ms，`ease-out`。
- 不引入动画库，没有弹跳（bounce）keyframes。
- `prefers-reduced-motion` 兜底保留（global.css 全局）。

**例外：投票入口的高铁主题场景（GSAP）**。这是唯一允许的动画库用法，边界固定如下，不得扩大：

- 只允许出现在 `pages/vote/Gate.tsx` 的入口场景（`components/vote/GateScene.tsx` + `gateMotion.ts`），后台一律不准用。
- 只动 `transform` / `opacity`，不写 CSS keyframes，不改 `.sheet-excel` 与 `.score-table` 任何版式规则。
- 能否播由 `components/vote/gateMotion.ts` 的 `canPlayGateMotion()` 判定，**判定不过就不播、也不渲染舞台**（只留文字，不许出现「一辆停在终点的车」）：用户要求减少动效、内核不认识 `prefers-reduced-motion`、内核不支持 `min-height: 100dvh`（Chrome 108 以前）三种情况都归到这条。判定通过才建补间，补间只动 `transform` / `opacity`。
- `.gate-scene` 的 `min-height` 必须同时写 `100vh` 与 `100dvh`（vh 在前）。只写 `dvh` 时，Chrome 108 以前会丢弃该声明，容器塌成 0 高，绝对定位的舞台跑到内容上方（列车压住标题），这是已修过的线上故障。
- 装饰层 `aria-hidden="true"` + `pointer-events: none`：不参与读屏、不挡操作。
- 场景与内容用「内容居中 + 舞台绝对定位贴底」分离，两者不争布局；窄屏与矮屏（`max-height: 720px` 或 `max-width: 640px`）隐藏舞台，舞台不可见时内容必须立即交付、不许让人干等动画。
- 未开放状态不用卡片容器：内容直接落在页面背景上，层级靠字号与留白建立。状态标题以**场次状态为主、时间窗为辅**判定（已结束 / 已暂停 / 尚未开始 / 未开放），四种状态给四种行动指引，不许一律说「未开放」。
- 造型按 CR400AF 量产车实车绘制：银色底 + 黑色车窗带 + 车窗下红色线条（先头车收成箭头形），8 辆编组、转向架外露、车顶受电弓。**蓝色是样板车涂装，不是量产车，不要用**。这是场景自身的写实配色，不参与全局 token 体系。

## Shapes

全局 `borderRadius: 10`（ConfigProvider 单值，组件圆角由它派生）。

## 不可动的版式基准

`global.css` 的 **`.sheet-excel`（问卷配置 Excel 版式）与 `.score-table`（打分表）** 复刻纸质参考表/附件8，**版式规则不可动**；Apple 化只允许替换焦点色等颜色值，不改结构、间距、行列规则。

## Components

- **共享（`pages/admin/shared.tsx`）**：`PageHeader` / `ErrorState`（401 统一跳登录）/ `LoadingState`（Skeleton）/ `StaleDataAlert`（轮询失败保留旧数据）/ `useNotify`。
- **投票端**：`VoteSurface`（套 voteTheme）、`VoteSteps`（步骤条）、`ScoreTable`（粘性表头 + 粘性姓名列 + Tab/方向键网格导航 + blur 校验 + >50 行分页）。
- **开放判定单一真源在后端（`apps/api/src/lib/settings.ts` 的 `evaluateVoteWindow`）**：场次状态 + 本场次时间窗（`opensAt` / `closesAt` 可空）的判定集中在后端，前端不重复实现，只消费后端结果（`/vote/status`、`stats.overview`）。前端自己的窗口逻辑只有展示/编辑两件工具（`pages/admin/sessionShared.tsx`）：`formatWindow`（窗口单行描述，空侧显式写「不限开始 / 长期开放」）与 `SessionWindowModal`（编辑窗口弹窗，场次列表行与工作台页头共用）。
- **身份与权限（`lib/auth.tsx`）**：`AuthProvider` 包住 `/admin` 全部路由，`useAuth()` 给出 `{ admin, loading, error, can(code), reload }`。权限码由 `/me` 权威下发，前端只用来决定**按钮显隐**。测试用 `src/test-utils.tsx` 的 `renderWithAuth(ui, permissions?)` 注入固定权限（默认全权限，只读传 `[]`），避免「加载中」造成的显隐断言竞态。
- **按钮门控的统一标准**：主操作按钮（新增/导入/保存/发码/作废）无权限时**不渲染**；行内开关与行内操作（启停/编辑/删除）保留但 `disabled` + Tooltip 写明缺哪个权限——整列消失会让表格看起来缺列。
- **权限被拒的呈现**：整页无权访问时给结果页说明（如「没有「管理管理员账号与角色权限」权限」），操作被拒时用页面内 Alert 带出后端 message，不吞掉原因。
- **权重分配（票种页签）**：票种编码在**场次内**唯一（同一场次不重号，跨场次可重用）。列出启用票种 + 实时合计，合计≠100 时保存禁用并写清差额；提交时按「先降权、后升权」逐条串行，中间每一步合计都不会超过 100%，不会撞上后端「合计不得超过 100」的上限。这是单行 PATCH 契约下一次改完全部权重的可靠方式（后端规则允许 ≤100 的升权中间步，正是为了让多步重分配可行）。
- **一键作废（随机码页签）**：作废范围**限定在本场次**——`danger` 按钮 + 确认框先报准确数量（「将作废本场次当前筛选下 N 张未使用码；已使用的码不受影响；作废后不可恢复」），只影响 `未使用` 状态。

## 权限与角色

权限是**领域规则**而不是视觉体系，但它的呈现规则要固定下来：

- 权限目录的单一真源是后端 `lib/permissions.ts`（8 个码，按「评议准备 / 发票与票种 / 评议执行 / 系统管理」分组），数据库 `permissions` 表是它的副本，由 seed 幂等同步。
- 角色 → 权限；账号 → 角色。**没有角色的账号权限为空数组，等价只读**。
- 分工必须记牢：**前端隐藏按钮只是体验层，后端 `requirePermission` 才是防线**。任何「只在界面上拦住」的写法都是缺陷。
- 系统必须始终保留至少一个「已启用且拥有 `admins.manage`」的账号，任何会导致 0 个的操作一律 409 —— 否则没人能再管理权限。这条守卫的文案要出现在账号页上，让人知道为什么按钮是灰的。
- 导航三个入口（场次管理 / 系统设置 / 账号与权限）平铺，不再有「系统管理」分组与 `NextStep` 跨页引导，评议配置全部在场次工作台的页签里。

## Do's and Don'ts

**Do**

- 用 Apple 的克制原则表达界面：材质只给悬浮层（顶栏/侧栏），按压即反馈（`.pressable`），状态不靠颜色单独表意（同时有文字）。
- 口径说明必须保留（Alert info / Typography secondary）：票种加权、归一化等权平均、零票排除、同分并列——产品原则「结果可复现、可解释」。
- 无障碍基线不退化：投票端 error summary（role=alert + 可聚焦 + 逐条链接到格子）、aria-describedby / aria-invalid、blur 校验、44px 触控目标。
- 动效遵守契约：按压反馈 120ms、过渡 120–240ms ease-out；信息性动画（如发码后新码浅底淡出）同样尊重 prefers-reduced-motion（global.css 全局兜底）。
- 新增一个「不可逆或能改变投票有效性」的操作时，**三处一起改**：后端挂 `requirePermission`、前端用 `useAuth().can()` 门控、权限码加进 `lib/permissions.ts` 目录并重跑 seed。

**Don't**

- 不自造 Apple 规范之外的体系：色板、动效曲线、材质强度都按本文档契约，不各页自行发挥。
- 不在内容区堆材质，不半透明叠半透明。
- 不引入动画库、CSS 框架或第二组件库——Apple 化基于 antd 6 组件体系实现。唯一例外是投票入口的高铁场景（GSAP），边界见「动效」章节。
- 不在职工可见文案出现后台术语（票种权重、归一化、批次）。
- 不用 Alert 承载常驻提示（antd 6 Alert 固定 role="alert"，常驻内容会与动态错误抢唯一 alert 语义；常驻提示用静默样式，动态错误才用 Alert）。
- 不用 emoji 当图标；图标统一 @ant-design/icons。
- 不要「只在前端隐藏按钮」就当权限做完了：那只是体验层，直接调接口一样能改数据；反之也不要只挂后端而让用户点了才被拒。
- 不要把权限码写成页面里散落的字符串比较，一律走 `useAuth().can(code)`，保证默认拒绝（无身份即无权）。

**已知项**：单 chunk ≈1.4MB（antd 全量打包，gzip ≈430KB）。内部系统可接受；若投票入口需要面向公网移动端优化，做路由级 React.lazy 分割（后台与投票入口天然可分）。
