---
name: 职工素质评议系统
description: 标准企业风。Ant Design 默认设计 + 投票端尺寸差异，不做自定义视觉体系。
colors:
  primary: "#1677ff"
  success: "#52c41a"
  warning: "#faad14"
  error: "#ff4d4f"
  text: "rgba(0, 0, 0, 0.88)"
  text-secondary: "rgba(0, 0, 0, 0.45)"
  layout-bg: "#f5f5f5"
  container-bg: "#ffffff"
  border: "#d9d9d9"
  split: "#f0f0f0"
typography:
  body-admin:
    fontFamily: "antd 默认系统字体栈（含 PingFang SC / Microsoft YaHei）"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.57
    letterSpacing: "normal"
  body-vote:
    fontFamily: "antd 默认系统字体栈（含 PingFang SC / Microsoft YaHei）"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.57
    letterSpacing: "normal"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
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
    rounded: "{rounded.lg}"
    padding: "24px"
  cell-input:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    height: "44px"
---

## Overview

**标准企业风：一切用 Ant Design 6 的默认设计**（默认蓝主色、默认圆角阴影、默认组件形态），不做自定义 token、不自造视觉体系。

前两轮自定义视觉（蓝灰定制主题、纸上年鉴）都已按用户要求废弃并删除。教训写在 theme.ts 注释里：antd 默认就是「标准企业脸」，拿艺术方向替换默认主题是负资产。

系统有**两个人格**，差异只在尺寸，不在颜色与形状：

| | 后台 | 投票入口 |
|---|---|---|
| 使用者 | 管理员，评议期间每天多次，桌面 | 职工，一年一两次，可能用手机 |
| 字号 / 控件 | antd 默认（14px / 32px） | `voteTheme`（16px / 44px 触控） |
| 实现 | 全局默认主题 | `components/VoteSurface.tsx` 包 `voteTheme` |

## Colors

全部 antd 默认，**唯一的 token 定制是主色**：`colorPrimary: '#0958d9'`（antd 官方色板 blue-7）。原因：antd 默认的 #1677ff 在白底上只有约 4.0:1，达不到 WCAG AA 的 4.5:1，链接与正文级主色文字全部不合格；blue-7 约 5.4:1，一行改动让链接、选中态、按钮等全部派生色达标。

状态色沿用 antd 语义（success / warning / error / info）。唯一约束：**状态不靠颜色单独表意**，停用/作废等必须同时有文字。

## Typography

系统字体栈（antd 默认）。数字列（分数、数量、随机码、工号）加 `.tabular`（`font-variant-numeric: tabular-nums`），否则无法纵向比较。

## Layout

- 页面结构 = `PageHeader`（标题+说明+右侧操作）+ antd `Card` 分区。
- **信息架构按评议工作流组织**：准备（部门→职工→项点）→ 发票（票种→随机码）→ 执行（开放时间）→ 收尾（结果→打印）。侧栏菜单按此分组（Menu `type: 'group'`），概览页顶部是流程进度中枢（四步可点击卡片，数据来自 stats.overview）。
- 每个流程页底部放 `NextStep` 链接串联下一步。
- 投票入口三页顶部放 `VoteSteps` 步骤条（验证身份→填写打分→完成提交，不可点击，流程只能前进）。

## Elevation & Depth

antd 默认（Card、Modal、Dropdown 的默认阴影）。不自定义。

## Shapes

antd 默认圆角（4/6/8px）。不自定义。

## Components

- **共享（`pages/admin/shared.tsx`）**：`PageHeader` / `NextStep` / `ErrorState`（401 统一跳登录）/ `LoadingState`（Skeleton）/ `StaleDataAlert`（轮询失败保留旧数据）/ `useNotify`。
- **投票端**：`VoteSurface`（套 voteTheme）、`VoteSteps`（步骤条）、`ScoreTable`（粘性表头 + 粘性姓名列 + Tab/方向键网格导航 + blur 校验 + >50 行分页）。
- **打分表 CSS（global.css `.score-table`）**：功能样式（粘性定位、44px 格高、antd 标准色的焦点/非法态），颜色一律取 antd 标准色值。
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

- 用 antd 标准组件与默认 token 表达界面；需要强调就用组件语义（type="primary"、Alert、Tag）。
- 口径说明必须保留（Alert info / Typography secondary）：票种加权、归一化等权平均、零票排除、同分并列——产品原则「结果可复现、可解释」。
- 无障碍基线不退化：投票端 error summary（role=alert + 可聚焦 + 逐条链接到格子）、aria-describedby / aria-invalid、blur 校验、44px 触控目标。
- 动效克制：仅按压反馈（120ms）、发码后新码浅底淡出（400ms，信息性）、状态过渡（≤180ms）；全部尊重 prefers-reduced-motion（global.css 全局兜底）。
- 新增一个「不可逆或能改变投票有效性」的操作时，**三处一起改**：后端挂 `requirePermission`、前端用 `useAuth().can()` 门控、权限码加进 `lib/permissions.ts` 目录并重跑 seed。

**Don't**

- 不再自造视觉体系（自定义色板、规则线、重线表头、Ledger 组件族——两轮尝试均已删除）。
- 不在职工可见文案出现后台术语（票种权重、归一化、批次）。
- 不用 Alert 承载常驻提示（antd 6 Alert 固定 role="alert"，常驻内容会与动态错误抢唯一 alert 语义；常驻提示用静默样式，动态错误才用 Alert）。
- 不用 emoji 当图标；图标统一 @ant-design/icons。
- 不引入动画库、CSS 框架或第二组件库。
- 不要「只在前端隐藏按钮」就当权限做完了：那只是体验层，直接调接口一样能改数据；反之也不要只挂后端而让用户点了才被拒。
- 不要把权限码写成页面里散落的字符串比较，一律走 `useAuth().can(code)`，保证默认拒绝（无身份即无权）。

**已知项**：单 chunk ≈1.4MB（antd 全量打包，gzip ≈430KB）。内部系统可接受；若投票入口需要面向公网移动端优化，做路由级 React.lazy 分割（后台与投票入口天然可分）。