---
name: 职工素质评议系统
description: Apple 风格。基于 antd 6 组件体系实现（WWDC Designing Fluid Interfaces 精神的 Web 移植契约 v1），不引入新依赖。
colors:
  primary: "#0071e3"
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

- `colorPrimary`：`#0071e3`（Apple 蓝，白底对比度约 4.6:1，达 WCAG AA）。
- `colorLink`：`#0066cc`（深一档 Apple 蓝）。链接文字会落在 `Layout` 的 `#f5f5f7` 等浅灰底上，`#0071e3` 在其上只有约 4.3:1，故链接整体取深档；普通 `<a>`（react-router `Link`）的静止 / hover / active 三态分别由 `colorLink` / `colorLinkHover` / `colorLinkActive` 给出，不要在页面里内联覆盖链接色。`colorLinkHover` 另取更深一档 `#0055aa`：antd 由 `colorLink` 派生的默认悬停色比它浅两档，落在浅底上同样不足 4.5:1。
- `components.Menu` 的 `itemSelectedColor` / `subMenuItemSelectedColor`：`#0066cc`（深一档 Apple 蓝）。antd 的选中底 `controlItemBgActive = colorPrimaryBg`（`#e6f7ff`）是浅主色，`#0071e3` 文字落在其上只有约 4.3:1，故选中文字单独用深档达 AA。同组的分组标题 `groupTitleColor` 取 `rgba(0, 0, 0, 0.65)`：antd 默认 `colorTextDescription`（`rgba(0, 0, 0, 0.45)`）落在浅色侧栏上只有约 3.3:1。
- `colorInfoText` / `colorWarningText`：`#0066cc` / `#874d00`（深档）。antd 派生出的这两个 token 等于 `colorInfo` / `colorWarning` 原色，落在同族浅底（`#e6f7ff` / `#fffbe6`）上只有约 4.3:1 / 1.8:1；静默提示条（`StaticNotice`）的标题就在这样的浅底上，故取深档（约 5.1:1 / 6.5:1）。
- `colorError`：`#d70015`（Apple 系统红深档）。
- 其余状态色沿用 antd 语义（success `#52c41a` / warning `#faad14` / info `#0071e3`（跟随主色，避免残留 antd 默认蓝））。
- 唯一约束：**状态不靠颜色单独表意**，停用/作废等必须同时有文字。

## Typography

- 字体栈不变：`-apple-system` 系统栈（antd 默认）。数字列（分数、数量、随机码、工号）加 `.tabular`（`font-variant-numeric: tabular-nums`），否则无法纵向比较。
- 页面大标题（PageHeader h2）：fontSize 22 / fontWeight 700 / letterSpacing -0.01em / lineHeight 1.3。
- **中文正文不加负字距**（负字距只给大标题），说明文字用 Typography secondary 灰。

## Layout

- 页面结构 = `PageHeader`（标题+说明+右侧操作）+ antd `Card` 分区。
- **信息架构按评议工作流组织**：准备（部门→职工→项点）→ 发票（票种→随机码）→ 执行（开放时间）→ 收尾（结果→打印）。侧栏菜单按此分组（Menu `type: 'group'`），概览页顶部是流程进度中枢（四步可点击卡片，数据来自 stats.overview）。
- 每个流程页底部放 `NextStep` 链接串联下一步。
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

## Shapes

全局 `borderRadius: 10`（ConfigProvider 单值，组件圆角由它派生）。

## 不可动的版式基准

`global.css` 的 **`.sheet-excel`（问卷配置 Excel 版式）与 `.score-table`（打分表）** 复刻纸质参考表/附件8，**版式规则不可动**；Apple 化只允许替换焦点色等颜色值，不改结构、间距、行列规则。

## Components

- **共享（`pages/admin/shared.tsx`）**：`PageHeader` / `NextStep` / `ErrorState`（401 统一跳登录）/ `LoadingState`（Skeleton）/ `StaleDataAlert`（轮询失败保留旧数据）/ `useNotify`。
- **投票端**：`VoteSurface`（套 voteTheme）、`VoteSteps`（步骤条）、`ScoreTable`（粘性表头 + 粘性姓名列 + Tab/方向键网格导航 + blur 校验 + >50 行分页）。
- **窗口判定单一真源（`pages/admin/lib.ts`）**：`voteWindowConditions` 逐条返回三层条件，`evaluateVoteWindow` 由其派生；设置页判定表直接渲染 rows，不再有第二份实现。
- **身份与权限（`lib/auth.tsx`）**：`AuthProvider` 包住 `/admin` 全部路由，`useAuth()` 给出 `{ admin, loading, error, can(code), reload }`。权限码由 `/me` 权威下发，前端只用来决定**按钮显隐**。测试用 `src/test-utils.tsx` 的 `renderWithAuth(ui, permissions?)` 注入固定权限（默认全权限，只读传 `[]`），避免「加载中」造成的显隐断言竞态。
- **按钮门控的统一标准**：主操作按钮（新增/导入/保存/发码/作废）无权限时**不渲染**；行内开关与行内操作（启停/编辑/删除）保留但 `disabled` + Tooltip 写明缺哪个权限——整列消失会让表格看起来缺列。
- **权限被拒的呈现**：整页无权访问时给结果页说明（如「没有「管理管理员账号与角色权限」权限」），操作被拒时用页面内 Alert 带出后端 message，不吞掉原因。
- **权重分配（票种页）**：列出启用票种 + 实时合计，合计≠100 时保存禁用并写清差额；提交时按「先降权、后升权」逐条串行，中间每一步合计都不会超过 100%，不会撞上后端「合计不得超过 100」的上限。这是单行 PATCH 契约下一次改完全部权重的可靠方式（后端规则允许 ≤100 的升权中间步，正是为了让多步重分配可行）。
- **一键作废（随机码页）**：`danger` 按钮 + 确认框先报准确数量（「将作废当前筛选下 N 张未使用码；已使用的码不受影响；作废后不可恢复」），只影响 `未使用` 状态。

## 权限与角色

权限是**领域规则**而不是视觉体系，但它的呈现规则要固定下来：

- 权限目录的单一真源是后端 `lib/permissions.ts`（8 个码，按「评议准备 / 发票与票种 / 评议执行 / 系统管理」分组），数据库 `permissions` 表是它的副本，由 seed 幂等同步。
- 角色 → 权限；账号 → 角色。**没有角色的账号权限为空数组，等价只读**。
- 分工必须记牢：**前端隐藏按钮只是体验层，后端 `requirePermission` 才是防线**。任何「只在界面上拦住」的写法都是缺陷。
- 系统必须始终保留至少一个「已启用且拥有 `admins.manage`」的账号，任何会导致 0 个的操作一律 409 —— 否则没人能再管理权限。这条守卫的文案要出现在账号页上，让人知道为什么按钮是灰的。
- 导航里「账号与权限」归入「系统管理」分组，不属于评议流程，因此该页不加 `NextStep`。

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
- 不引入动画库、CSS 框架或第二组件库——Apple 化基于 antd 6 组件体系实现。
- 不在职工可见文案出现后台术语（票种权重、归一化、批次）。
- 不用 Alert 承载常驻提示（antd 6 Alert 固定 role="alert"，常驻内容会与动态错误抢唯一 alert 语义；常驻提示用静默样式，动态错误才用 Alert）。
- 不用 emoji 当图标；图标统一 @ant-design/icons。
- 不要「只在前端隐藏按钮」就当权限做完了：那只是体验层，直接调接口一样能改数据；反之也不要只挂后端而让用户点了才被拒。
- 不要把权限码写成页面里散落的字符串比较，一律走 `useAuth().can(code)`，保证默认拒绝（无身份即无权）。

**已知项**：单 chunk ≈1.4MB（antd 全量打包，gzip ≈430KB）。内部系统可接受；若投票入口需要面向公网移动端优化，做路由级 React.lazy 分割（后台与投票入口天然可分）。
