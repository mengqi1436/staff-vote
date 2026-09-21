import { Router } from 'express';
import { adminAuth } from '../../middleware/adminAuth.js';
import { loginRouter, sessionRouter } from './auth.js';
import { criteriaRouter } from './criteria.js';
import { departmentsRouter } from './departments.js';
import { employeesRouter } from './employees.js';
import { rbacRouter } from './rbac.js';
import { settingsRouter } from './settings.js';
import { resultsRouter, statsRouter } from './stats.js';
import { ticketBatchesRouter, ticketsRouter } from './tickets.js';
import { ticketTypesRouter } from './ticketTypes.js';
import { voteColumnsRouter } from './voteColumns.js';

/**
 * 管理端路由，挂载于 `/api/admin`。
 *
 * 契约见设计文档第 12.2 节。除 `/login` 外全部经 `adminAuth` 中间件：
 * 登录路由先挂，随后整段 use(adminAuth)，此后新增的端点默认就是受保护的，
 * 不存在「忘了加鉴权」的写法。
 *
 *   POST   /login  { username, password }  → 设置 httpOnly Cookie；用 adminLoginLimiter
 *   POST   /logout
 *   GET    /me
 *   /ticket-types      GET POST PATCH DELETE   权重合计=100 校验（写需 ticketTypes.write）
 *   /tickets           GET（分页筛选）
 *   /tickets/generate  POST { ticketTypeId, count }  → 批量发码，记 TicketBatch 与 AuditLog
 *                                                   （tickets.generate）
 *   /tickets/export    GET  → xlsx
 *   /tickets/:id/revoke POST → 作废单张未使用的码（tickets.revoke）
 *   /tickets/revoke-bulk POST { ticketTypeId? } → 一键作废该范围内全部未使用码；
 *                         used / revoked 不动，返回 { revoked }（tickets.revoke）
 *   /ticket-batches    GET
 *   /departments       GET POST PATCH DELETE   删除为软删除（enabled=false）；
 *                         PATCH 同时负责问卷表头配置（questionnaireType / headerNote /
 *                         title / footerNote）（写需 departments.write）
 *   /vote-columns      GET POST PATCH DELETE   被评列：打分表的列，与职工名单分离
 *                         （写需 criteria.write，与项点同属问卷结构配置）
 *   /employees         GET POST PATCH DELETE   （写需 employees.write）
 *   /employees/import  POST  multipart xlsx/csv （employees.write）
 *   /criteria          GET POST PATCH DELETE   校验 max > min；含项点描述（criteria.write）
 *   /settings          GET PUT                 投票总开关、起止时间、系统标题（settings.write）
 *   /stats/overview    GET  各票种发放/已用/剩余 + 各部门提交数（后台 5 秒轮询）
 *   /results           GET ?departmentId=      排名与明细
 *   /results/export.xlsx GET
 *   /permissions       GET                     权限目录（按 groupName + sortOrder）
 *   /roles             GET POST PATCH DELETE   角色与权限数组；内置角色不可删、被账号使用不可删
 *   /admins            GET POST PATCH DELETE   管理员账号：改角色/启停/重置口令都走 PATCH
 *
 * 权限总则：写操作逐个挂 `requirePermission`（不是 router.use 整段挂），
 * 读操作一律不挂 —— 没有任何写权限的角色天然就是只读。
 * 最后三个资源整体要求 `admins.manage`：没有该权限的账号连权限目录都读不到。
 */
export const adminRouter: Router = Router();

adminRouter.use(loginRouter);
adminRouter.use(adminAuth);
adminRouter.use(sessionRouter);
adminRouter.use('/ticket-types', ticketTypesRouter);
adminRouter.use('/tickets', ticketsRouter);
adminRouter.use('/ticket-batches', ticketBatchesRouter);
adminRouter.use('/departments', departmentsRouter);
adminRouter.use('/vote-columns', voteColumnsRouter);
adminRouter.use('/employees', employeesRouter);
adminRouter.use('/criteria', criteriaRouter);
adminRouter.use('/settings', settingsRouter);
adminRouter.use('/stats', statsRouter);
adminRouter.use('/results', resultsRouter);
// RBAC 三个资源的路径互不重叠，整段挂载即可（权限门控在 rbacRouter 内部）
adminRouter.use(rbacRouter);