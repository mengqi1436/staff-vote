# staff-vote — 职工素质评议系统

匿名投票系统：职工凭随机码投票打分（`apps/web` 投票入口），管理员配置表单/发票/导出（`apps/web` 后台）。pnpm monorepo：`apps/api`（Express 5 + TS + Prisma 7 + PostgreSQL 17）、`apps/web`（React 19 + Vite + Ant Design 6）。

## 常用命令

```bash
pnpm -r typecheck        # 类型检查（零错误才算过）
pnpm -r test             # 全部测试
pnpm -r build            # 两个应用构建
pnpm dev:api             # 后端 http://127.0.0.1:3000
pnpm dev:web             # 前端 http://localhost:5173（/api 代理到后端）
pnpm db:generate|deploy|seed|drift   # Prisma 生成/迁移/种子/漂移检查
```

后端测试细节：单元套件（scoring/code/password）随时可跑；接口套件需要 `TEST_DATABASE_URL`，未设置时 `admin.test.ts`、`rbac.test.ts`、`revoke-bulk.test.ts`、`sessions.test.ts`、`permission-gate.test.ts`、`auth-context.test.ts` 六个套件跳过并提示；`vote.test.ts` 与 `test/e2e.test.ts` 未设置时**故意失败**（防止误连开发库，e2e 还会清空业务表）——没有测试库时 `pnpm -r test` 预期「部分跳过 + 这两个文件失败」，是环境状态不是代码缺陷，但 `vote.test.ts` 的失败**不能**据此当成环境问题忽略。

## 架构与真源（改前必看）

- **数据模型**：`apps/api/prisma/schema.prisma` 是唯一真源；`prisma/migrations/` 是**手写 SQL**（表结构唯一真源），不要让 Prisma 自动生成迁移。约束：主键 UUID v7 由 Prisma 客户端生成（列不设 DEFAULT）、时间列显式 `@db.Timestamptz(3)`、表名列名 snake_case。
- **权限码**：唯一真源 `apps/api/src/lib/permissions.ts`，数据库 `permissions` 表是 seed 幂等同步的副本——新增权限码**不需要写迁移**，改文件重跑 `pnpm db:seed` 即可。
- **新增危险操作必须三处一起改**：后端挂 `requirePermission(code)`、前端 `useAuth().can(code)` 门控按钮、权限码进目录并重跑 seed。前端隐藏按钮只是体验层，后端才是防线；反之只挂后端也 UX 缺陷。无角色的账号权限为空 = 只读。
- **前端接口客户端** `apps/web/src/lib/api.ts` 契约冻结，改接口先看它。
- **计分口径**在 `apps/api/src/lib/scoring`：三种「没有数据」刻意区别对待——票种没发（不参与）、格子弃权（计 0）、项点零票（不参与综合分）。改计分前先读 `apps/api/src/lib/scoring` 注释与 `scoring.test.ts`。

## 前端设计约束（apps/web/DESIGN.md）

- **Apple 风格**（WWDC Designing Fluid Interfaces 精神的 Web 移植契约 v1，基于 antd 6 实现）：主色/链接 `#0071e3`、错误 `#d70015`、圆角 10、顶栏/侧栏毛玻璃、按压反馈 `.pressable`。禁止引入动画库/CSS 框架/第二组件库。
- 唯一允许的 token 层在 `main.tsx` 全局 ConfigProvider（`theme.ts`），各页不得自行覆盖色板/动效/材质。
- 两个人格：后台 antd 默认密度（14px/32px）；投票入口用 `VoteSurface` 包 `voteTheme`（16px/44px 触控）。
- 版式基准不可动：`global.css` 的 `.sheet-excel` 与 `.score-table` 复刻纸质参考表/附件8，只允许换焦点色等颜色值。
- 数字列加 `.tabular`；状态不靠颜色单独表意；权限门控规范（主按钮无权不渲染、行内操作 disabled+Tooltip）见 DESIGN.md。

## 其他要点

- 匿名边界：`score_sheets` 表不含随机码/IP/User-Agent，**不要加回去**，也不要往匿名链路里塞可识别信息。
- 管理员口令 scrypt 哈希（OWASP 参数），AES-128 仅预留用于将来的可还原字段，绝不用于口令。
- 防锁死：系统必须保留至少一个「已启用且拥有 `admins.manage`」的账号，违反的操作后端 409。
- pnpm 依赖构建脚本需在 `pnpm-workspace.yaml` 的 `allowBuilds`/`onlyBuiltDependencies` 放行（prisma/esbuild 已放行）。

## 文档地图

- `README.md` — 技术栈、快速开始、数据库/计分/匿名/权限设计要点（**改敏感区前先读**）
- `apps/web/DESIGN.md` — 前端设计规范与 Do's/Don'ts
- `apps/web/PRODUCT.md` — 产品原则
- `docs/superpowers/specs/2026-09-19-staff-vote-design.md` — 设计基线
- `deploy/README.md` — 部署手册（Nginx/systemd/备份）
- `sql/README.md` — 建库脚本说明
