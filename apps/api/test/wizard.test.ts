import 'dotenv/config';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * 新建场次向导链路的接口测试（迁移 0007 / 契约 A-F）：
 *
 *   A. 全局部门字典 /org-departments CRUD（写需 departments.write，读=登录即可）
 *   B. POST /sessions：事务建场次 + 自动插入场内同名部门（409/404/422 校验）
 *   C. POST /sessions/:id/start 完整性校验（409 SESSION_INCOMPLETE + detail 中文缺项清单）
 *   D. PUT /sessions/:id/ticket-plan 票别分配聚合（422 WEIGHT_SUM / 409 有答卷禁移除）
 *   E. 投票提交事务写 sheet_ticket_map 受控映射
 *   F. 按随机码导出答卷（附件8 形态）与整场整合导出（答卷汇总）
 *
 * 夹具约定同 sessions.test.ts：TEST_DATABASE_URL + `WZ` 前缀隔离，afterAll 只清自己的数据。
 * 投票链路夹具（场次/部门/项点/列/票种/码）直写库，登录与提交走 /api/vote 接口。
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suiteEnabled = Boolean(testDatabaseUrl);

if (!suiteEnabled) {
  console.warn('[wizard.test] 未设置 TEST_DATABASE_URL，跳过新建场次向导接口测试。');
}

// 必须在导入 src 之前改写：src/env.ts 在模块求值时读 process.env。
process.env.NODE_ENV = 'test';
if (suiteEnabled) process.env.TEST_DATABASE_URL = testDatabaseUrl;

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { hashPassword } = await import('../src/lib/password.js');
const { ALL_PERMISSION_CODES } = await import('../src/lib/permissions.js');
const { createRole } = await import('./rbac-fixtures.js');

const describeDb = suiteEnabled ? describe : describe.skip;

const TAG = 'WZ';
const ADMIN_USERNAME = `${TAG}admin`;
const READONLY_USERNAME = `${TAG}readonly`;
const PASSWORD = 'Test-Passw0rd!2026';
const PAST_OPENS_AT = '2026-01-01T00:00:00+08:00';

const app = createApp();
let agent: ReturnType<typeof request.agent>;
let readonlyAgent: ReturnType<typeof request.agent>;

/** 本文件建立的场次与字典部门 id，afterAll 统一清理。 */
const sessionIds: string[] = [];
const orgDepartmentIds: string[] = [];

/** 场次名：向导创建走接口，名字带 TAG 便于 afterAll 兜底清理。 */
let sessionSeq = 0;
async function newOrgDepartment(name: string): Promise<string> {
  const res = await agent.post('/api/admin/org-departments').send({ name });
  expect(res.status).toBe(200);
  orgDepartmentIds.push(res.body.department.id);
  return res.body.department.id;
}

/** 走向导契约创建场次：字典部门 + 场次名 + 过去的 opensAt（不卡投票开放窗口）。 */
async function newSession(name: string): Promise<string> {
  const orgId = await newOrgDepartment(`${TAG}字典-${name}`);
  const res = await agent.post('/api/admin/sessions').send({
    name,
    orgDepartmentId: orgId,
    opensAt: PAST_OPENS_AT,
  });
  expect(res.status).toBe(200);
  sessionIds.push(res.body.session.id);
  return res.body.session.id;
}

/** 给向导场次补齐项点与被评列（场内部门由创建自动插入），返回场内部门 id。 */
async function setupQuestionnaire(sessionId: string): Promise<string> {
  const department = await prisma.department.findFirstOrThrow({ where: { sessionId } });
  await agent.post('/api/admin/criteria').send({
    departmentId: department.id,
    name: '德',
    minScore: 0,
    maxScore: 100,
  });
  await agent.post('/api/admin/vote-columns').send({ departmentId: department.id, name: '主任' });
  return department.id;
}

/** 建一张孤立票据（自带批次），返回票据行。 */
let ticketSeq = 0;
async function createTicket(sessionId: string, ticketTypeId: string) {
  ticketSeq += 1;
  const batch = await prisma.ticketBatch.create({
    data: { ticketTypeId, sessionId, count: 1, operator: 'wizard.test' },
  });
  return prisma.ticket.create({
    data: {
      code: `${TAG}${ticketSeq}${Date.now() % 1000}`,
      ticketTypeId,
      batchId: batch.id,
      sessionId,
    },
  });
}

describeDb('新建场次向导（org-departments / sessions / ticket-plan / 导出）', () => {
  beforeAll(async () => {
    await prisma.adminUser.deleteMany({ where: { username: { startsWith: TAG } } });
    await prisma.adminRole.deleteMany({ where: { code: { startsWith: TAG } } });

    const roleId = await createRole(`${TAG}role`, '测试-向导管理员', ALL_PERMISSION_CODES);
    const readonlyRoleId = await createRole(`${TAG}role-ro`, '测试-向导只读', []);
    await prisma.adminUser.create({
      data: { username: ADMIN_USERNAME, passwordHash: await hashPassword(PASSWORD), roleId },
    });
    await prisma.adminUser.create({
      data: { username: READONLY_USERNAME, passwordHash: await hashPassword(PASSWORD), roleId: readonlyRoleId },
    });

    agent = request.agent(app);
    const login = await agent
      .post('/api/admin/login')
      .send({ username: ADMIN_USERNAME, password: PASSWORD });
    expect(login.status).toBe(200);

    readonlyAgent = request.agent(app);
    const readonlyLogin = await readonlyAgent
      .post('/api/admin/login')
      .send({ username: READONLY_USERNAME, password: PASSWORD });
    expect(readonlyLogin.status).toBe(200);
  });

  afterAll(async () => {
    // 清理顺序遵守外键依赖（映射随答卷/票据级联删除，仍显式删一遍兜底）。
    for (const sessionId of sessionIds) {
      await prisma.sheetTicketMap.deleteMany({ where: { sessionId } });
      const typeIds = (
        await prisma.ticketType.findMany({ where: { sessionId }, select: { id: true } })
      ).map((row) => row.id);
      await prisma.ticket.deleteMany({ where: { ticketTypeId: { in: typeIds } } });
      await prisma.ticketBatch.deleteMany({ where: { ticketTypeId: { in: typeIds } } });
      const departmentIds = (
        await prisma.department.findMany({ where: { sessionId }, select: { id: true } })
      ).map((row) => row.id);
      await prisma.scoreItem.deleteMany({
        where: { sheet: { departmentId: { in: departmentIds } } },
      });
      await prisma.scoreSheet.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.criterion.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.voteColumn.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
      await prisma.ticketType.deleteMany({ where: { id: { in: typeIds } } });
      await prisma.voteSession.deleteMany({ where: { id: sessionId } });
    }
    await prisma.orgDepartment.deleteMany({ where: { id: { in: orgDepartmentIds } } });
    await prisma.adminUser.deleteMany({ where: { username: { startsWith: TAG } } });
    await prisma.adminRole.deleteMany({ where: { code: { startsWith: TAG } } });
    await prisma.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // 契约 A：全局部门字典
  // ---------------------------------------------------------------------------

  describe('契约 A：全局部门字典 /org-departments', () => {
    it('创建 → 列表 → 更新：{ department } 形状与字段齐全', async () => {
      const created = await agent
        .post('/api/admin/org-departments')
        .send({ name: `${TAG}字典部门-甲`, sortOrder: 3 });
      expect(created.status).toBe(200);
      expect(created.body.department).toMatchObject({
        name: `${TAG}字典部门-甲`,
        sortOrder: 3,
        enabled: true,
      });
      expect(created.body.department.createdAt).toBeTruthy();
      orgDepartmentIds.push(created.body.department.id);

      const list = await agent.get('/api/admin/org-departments');
      expect(list.status).toBe(200);
      const row = list.body.departments.find(
        (d: { id: string }) => d.id === created.body.department.id,
      );
      expect(row).toBeTruthy();

      const updated = await agent
        .patch(`/api/admin/org-departments/${created.body.department.id}`)
        .send({ name: `${TAG}字典部门-甲改`, sortOrder: 1, enabled: false });
      expect(updated.status).toBe(200);
      expect(updated.body.department).toMatchObject({
        name: `${TAG}字典部门-甲改`,
        sortOrder: 1,
        enabled: false,
      });
    });

    it('重名创建 → 409 ORG_DEPARTMENT_EXISTS', async () => {
      const first = await agent.post('/api/admin/org-departments').send({ name: `${TAG}字典重名` });
      expect(first.status).toBe(200);
      orgDepartmentIds.push(first.body.department.id);

      const duplicate = await agent
        .post('/api/admin/org-departments')
        .send({ name: `${TAG}字典重名` });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe('ORG_DEPARTMENT_EXISTS');
    });

    it('未引用的字典项可删除；被场次引用时 409 ORG_DEPARTMENT_IN_USE', async () => {
      const unused = await agent.post('/api/admin/org-departments').send({ name: `${TAG}字典未引用` });
      expect(unused.status).toBe(200);

      const removed = await agent.delete(`/api/admin/org-departments/${unused.body.department.id}`);
      expect(removed.status).toBe(204);

      // 被引用：走向导建一个引用它的场次，再删字典项必须被拦下
      const orgId = await newOrgDepartment(`${TAG}字典被引用`);
      const session = await agent.post('/api/admin/sessions').send({
        name: `${TAG}场次-字典引用`,
        orgDepartmentId: orgId,
        opensAt: PAST_OPENS_AT,
      });
      expect(session.status).toBe(200);
      sessionIds.push(session.body.session.id);

      const blocked = await agent.delete(`/api/admin/org-departments/${orgId}`);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('ORG_DEPARTMENT_IN_USE');
    });

    it('无 departments.write 的账号写操作 → 403；读操作放行', async () => {
      const denied = await readonlyAgent.post('/api/admin/org-departments').send({ name: `${TAG}越权` });
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('PERMISSION_DENIED');

      const patchDenied = await readonlyAgent.patch('/api/admin/org-departments/whatever').send({ name: 'x' });
      expect(patchDenied.status).toBe(403);

      const list = await readonlyAgent.get('/api/admin/org-departments');
      expect(list.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // 契约 B：POST /sessions（向导第一步）
  // ---------------------------------------------------------------------------

  describe('契约 B：POST /sessions 建场次 + 自动插入场内部门', () => {
    it('正向：一个事务内建场次与场内同名部门，DTO 带字典部门信息', async () => {
      const orgId = await newOrgDepartment(`${TAG}字典-B正向`);
      const res = await agent.post('/api/admin/sessions').send({
        name: `${TAG}场次-B正向`,
        orgDepartmentId: orgId,
        opensAt: '2026-09-01T08:00:00+08:00',
        closesAt: '2026-09-30T18:00:00+08:00',
      });
      expect(res.status).toBe(200);
      sessionIds.push(res.body.session.id);

      const session = res.body.session;
      expect(session).toMatchObject({
        name: `${TAG}场次-B正向`,
        status: 'draft',
        orgDepartmentId: orgId,
        orgDepartmentName: `${TAG}字典-B正向`,
      });
      expect(Date.parse(session.opensAt)).toBe(Date.parse('2026-09-01T08:00:00+08:00'));
      expect(Date.parse(session.closesAt)).toBe(Date.parse('2026-09-30T18:00:00+08:00'));

      // 场内部门自动插入：同名、person 问卷、启用
      const departments = await prisma.department.findMany({ where: { sessionId: session.id } });
      expect(departments).toHaveLength(1);
      expect(departments[0]).toMatchObject({
        name: `${TAG}字典-B正向`,
        questionnaireType: 'person',
        enabled: true,
      });

      // 列表 DTO 同样带字典部门信息（向后兼容：旧场次两字段为 null）
      const list = await agent.get('/api/admin/sessions');
      const row = list.body.sessions.find((s: { id: string }) => s.id === session.id);
      expect(row.orgDepartmentName).toBe(`${TAG}字典-B正向`);
    });

    it('closesAt 留空 = 永久开放（closesAt 为 null）', async () => {
      const res = await newSession(`${TAG}场次-B永久`);
      const list = await agent.get('/api/admin/sessions');
      const row = list.body.sessions.find((s: { id: string }) => s.id === res);
      expect(row.opensAt).toBeTruthy();
      expect(row.closesAt).toBeNull();
    });

    it('重名 → 409 SESSION_EXISTS', async () => {
      await newSession(`${TAG}场次-B重名`);
      const orgId = await newOrgDepartment(`${TAG}字典-B重名`);
      const duplicate = await agent.post('/api/admin/sessions').send({
        name: `${TAG}场次-B重名`,
        orgDepartmentId: orgId,
        opensAt: PAST_OPENS_AT,
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe('SESSION_EXISTS');
    });

    it('字典部门不存在 → 404 ORG_DEPARTMENT_NOT_FOUND', async () => {
      const res = await agent.post('/api/admin/sessions').send({
        name: `${TAG}场次-B幽灵部门`,
        orgDepartmentId: '00000000-0000-7000-8000-000000000000',
        opensAt: PAST_OPENS_AT,
      });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ORG_DEPARTMENT_NOT_FOUND');
    });

    it('opensAt >= closesAt → 422 VOTE_WINDOW_INVALID', async () => {
      const orgId = await newOrgDepartment(`${TAG}字典-B窗口`);
      const equal = await agent.post('/api/admin/sessions').send({
        name: `${TAG}场次-B窗口相等`,
        orgDepartmentId: orgId,
        opensAt: '2026-09-20T00:00:00+08:00',
        closesAt: '2026-09-20T00:00:00+08:00',
      });
      expect(equal.status).toBe(422);
      expect(equal.body.error.code).toBe('VOTE_WINDOW_INVALID');

      const reversed = await agent.post('/api/admin/sessions').send({
        name: `${TAG}场次-B窗口反序`,
        orgDepartmentId: orgId,
        opensAt: '2026-09-21T00:00:00+08:00',
        closesAt: '2026-09-20T00:00:00+08:00',
      });
      expect(reversed.status).toBe(422);
      expect(reversed.body.error.code).toBe('VOTE_WINDOW_INVALID');
    });

    it('无 settings.write 的账号 → 403', async () => {
      const denied = await readonlyAgent.post('/api/admin/sessions').send({
        name: `${TAG}越权场次`,
        orgDepartmentId: '00000000-0000-7000-8000-000000000000',
        opensAt: PAST_OPENS_AT,
      });
      expect(denied.status).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // 契约 C：start 完整性校验
  // ---------------------------------------------------------------------------

  describe('契约 C：start 的完整性校验（409 SESSION_INCOMPLETE）', () => {
    it('四类缺项逐个触发：空场次逐项补齐，detail 随之收敛，配齐后 start 成功', async () => {
      // 空场次（直写库，不走向导 —— 向导场次自带场内部门，测不出「缺部门」）
      const session = await prisma.voteSession.create({ data: { name: `${TAG}场次-C完整性` } });
      sessionIds.push(session.id);

      const initial = await agent.post(`/api/admin/sessions/${session.id}/start`);
      expect(initial.status).toBe(409);
      expect(initial.body.error.code).toBe('SESSION_INCOMPLETE');
      expect(initial.body.error.detail).toEqual(
        expect.arrayContaining([
          expect.stringContaining('启用部门'),
          expect.stringContaining('启用票种'),
          expect.stringContaining('随机码'),
        ]),
      );

      // 补 1：启用部门（未配置项点/被评列 → 缺项清单出现部门级提示）
      const department = await prisma.department.create({
        data: { sessionId: session.id, name: `${TAG}C部门` },
      });
      const afterDepartment = await agent.post(`/api/admin/sessions/${session.id}/start`);
      expect(afterDepartment.status).toBe(409);
      expect(afterDepartment.body.error.detail.join('\n')).not.toContain('启用部门：');
      expect(afterDepartment.body.error.detail.join('\n')).toContain(`${TAG}C部门`);
      expect(afterDepartment.body.error.detail.join('\n')).toContain('项点');
      expect(afterDepartment.body.error.detail.join('\n')).toContain('被评列');

      // 补 2：项点
      await prisma.criterion.create({
        data: { departmentId: department.id, sessionId: session.id, name: '德' },
      });
      const afterCriterion = await agent.post(`/api/admin/sessions/${session.id}/start`);
      expect(afterCriterion.status).toBe(409);
      expect(afterCriterion.body.error.detail.join('\n')).not.toContain('项点');

      // 补 3：被评列
      await prisma.voteColumn.create({
        data: { departmentId: department.id, sessionId: session.id, name: '主任' },
      });
      const afterColumn = await agent.post(`/api/admin/sessions/${session.id}/start`);
      expect(afterColumn.status).toBe(409);
      expect(afterColumn.body.error.detail.join('\n')).not.toContain('被评列');

      // 补 4：票种（权重合计 50 ≠ 100 → 出现权重缺项）
      const ticketType = await prisma.ticketType.create({
        data: { sessionId: session.id, code: 'A', name: 'A 票', weightPercent: 50 },
      });
      const afterHalfWeight = await agent.post(`/api/admin/sessions/${session.id}/start`);
      expect(afterHalfWeight.status).toBe(409);
      expect(afterHalfWeight.body.error.detail.join('\n')).toContain('权重合计为 50%');

      // 权重补到 100 → 只剩随机码缺项
      await prisma.ticketType.update({ where: { id: ticketType.id }, data: { weightPercent: 100 } });
      const afterWeight = await agent.post(`/api/admin/sessions/${session.id}/start`);
      expect(afterWeight.status).toBe(409);
      const remaining = afterWeight.body.error.detail as string[];
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toContain('随机码');

      // 补 5：一张未使用码 → start 成功
      await createTicket(session.id, ticketType.id);
      const started = await agent.post(`/api/admin/sessions/${session.id}/start`);
      expect(started.status).toBe(200);
      expect(started.body.session.status).toBe('voting');
    });

    it('向导建好的场次配置齐后 start 成功；paused→voting 恢复不做完整性校验', async () => {
      const sessionId = await newSession(`${TAG}场次-C恢复`);
      await setupQuestionnaire(sessionId);
      const ticketType = await prisma.ticketType.create({
        data: { sessionId, code: 'A', name: 'A 票', weightPercent: 100 },
      });
      await createTicket(sessionId, ticketType.id);

      const started = await agent.post(`/api/admin/sessions/${sessionId}/start`);
      expect(started.status).toBe(200);
      expect(started.body.session.status).toBe('voting');

      // 中途停用项点后暂停再恢复：恢复路径不做完整性校验（回到暂停前状态）
      await prisma.criterion.updateMany({ where: { sessionId }, data: { enabled: false } });
      await agent.post(`/api/admin/sessions/${sessionId}/pause`);
      const resumed = await agent.post(`/api/admin/sessions/${sessionId}/start`);
      expect(resumed.status).toBe(200);
      expect(resumed.body.session.status).toBe('voting');
    });
  });

  // ---------------------------------------------------------------------------
  // 契约 D：PUT /sessions/:id/ticket-plan
  // ---------------------------------------------------------------------------

  describe('契约 D：票别分配 PUT /sessions/:id/ticket-plan', () => {
    it('正向：一次提交全集 → 票种建齐、批次发码、数组顺序即 sortOrder', async () => {
      const sessionId = await newSession(`${TAG}场次-D正向`);
      const res = await agent.put(`/api/admin/sessions/${sessionId}/ticket-plan`).send({
        types: [
          { code: 'A', name: 'A 票（领导评议）', weightPercent: 50, count: 3 },
          { code: 'B', name: 'B 票（部门互评）', weightPercent: 30, count: 2 },
          { code: 'C', name: 'C 票（职工评议）', weightPercent: 20, count: 0 },
        ],
      });
      expect(res.status).toBe(200);

      // 响应形状：{ ticketTypes, generated }，不返回明文码
      expect(res.body.ticketTypes).toHaveLength(3);
      expect(res.body.ticketTypes.map((t: { code: string }) => t.code)).toEqual(['A', 'B', 'C']);
      expect(res.body.generated).toHaveLength(2);
      for (const item of res.body.generated) {
        expect(item.ticketTypeId).toBeTruthy();
        expect(item.batchId).toBeTruthy();
        expect([3, 2]).toContain(item.count);
      }
      expect(JSON.stringify(res.body)).not.toMatch(new RegExp(`"codes"`));

      // 库里：A 3 张、B 2 张、C 0 张；批次只建了发码的两个
      const typeRows = await prisma.ticketType.findMany({ where: { sessionId } });
      const typeByCode = new Map(typeRows.map((row) => [row.code, row]));
      const countA = await prisma.ticket.count({ where: { ticketTypeId: typeByCode.get('A')!.id } });
      const countB = await prisma.ticket.count({ where: { ticketTypeId: typeByCode.get('B')!.id } });
      const countC = await prisma.ticket.count({ where: { ticketTypeId: typeByCode.get('C')!.id } });
      expect([countA, countB, countC]).toEqual([3, 2, 0]);
      const batches = await prisma.ticketBatch.findMany({ where: { sessionId } });
      expect(batches).toHaveLength(2);

      // 数组顺序即 sortOrder
      expect(typeByCode.get('A')!.sortOrder).toBe(0);
      expect(typeByCode.get('B')!.sortOrder).toBe(1);
      expect(typeByCode.get('C')!.sortOrder).toBe(2);
    });

    it('权重合计 ≠ 100 → 422 WEIGHT_SUM，整批不落库', async () => {
      const sessionId = await newSession(`${TAG}场次-D权重`);
      const res = await agent.put(`/api/admin/sessions/${sessionId}/ticket-plan`).send({
        types: [
          { code: 'A', name: 'A 票', weightPercent: 60, count: 1 },
          { code: 'B', name: 'B 票', weightPercent: 30, count: 1 },
        ],
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('WEIGHT_SUM');
      expect(await prisma.ticketType.count({ where: { sessionId } })).toBe(0);
      expect(await prisma.ticketBatch.count({ where: { sessionId } })).toBe(0);
    });

    it('未列入的现有票种被软停用；upsert 更新 name/weight 且重新启用已停用票种', async () => {
      const sessionId = await newSession(`${TAG}场次-D停用`);
      // 第一轮：A/B/C
      await agent.put(`/api/admin/sessions/${sessionId}/ticket-plan`).send({
        types: [
          { code: 'A', name: 'A 票', weightPercent: 50, count: 0 },
          { code: 'B', name: 'B 票', weightPercent: 30, count: 0 },
          { code: 'C', name: 'C 票', weightPercent: 20, count: 0 },
        ],
      });
      // 第二轮：只交 A（改权重）与 D（新票种）→ B/C 软停用
      const second = await agent.put(`/api/admin/sessions/${sessionId}/ticket-plan`).send({
        types: [
          { code: 'A', name: 'A 票改', weightPercent: 80, count: 0 },
          { code: 'D', name: 'D 票', weightPercent: 20, count: 1 },
        ],
      });
      expect(second.status).toBe(200);

      const rows = await prisma.ticketType.findMany({ where: { sessionId } });
      const byCode = new Map(rows.map((row) => [row.code, row]));
      expect(byCode.get('A')).toMatchObject({ name: 'A 票改', weightPercent: 80, enabled: true });
      expect(byCode.get('B')!.enabled).toBe(false);
      expect(byCode.get('C')!.enabled).toBe(false);
      expect(byCode.get('D')).toMatchObject({ enabled: true });
      expect(await prisma.ticket.count({ where: { ticketTypeId: byCode.get('D')!.id } })).toBe(1);

      // 第三轮：重新启用 B（upsert 复活）——A/B/D 合计 80+10+10
      const third = await agent.put(`/api/admin/sessions/${sessionId}/ticket-plan`).send({
        types: [
          { code: 'A', name: 'A 票改', weightPercent: 80, count: 0 },
          { code: 'B', name: 'B 票', weightPercent: 10, count: 0 },
          { code: 'D', name: 'D 票', weightPercent: 10, count: 0 },
        ],
      });
      expect(third.status).toBe(200);
      const revived = await prisma.ticketType.findFirst({ where: { sessionId, code: 'B' } });
      expect(revived!.enabled).toBe(true);
    });

    it('已有答卷的票种被移出集合 → 409 TICKET_TYPE_HAS_SHEETS；改 name/weight 仍允许', async () => {
      const sessionId = await newSession(`${TAG}场次-D答卷`);
      await agent.put(`/api/admin/sessions/${sessionId}/ticket-plan`).send({
        types: [
          { code: 'A', name: 'A 票', weightPercent: 50, count: 1 },
          { code: 'B', name: 'B 票', weightPercent: 50, count: 1 },
        ],
      });
      const typeA = await prisma.ticketType.findFirstOrThrow({ where: { sessionId, code: 'A' } });
      // 造一张已答卷：直接给 A 建答卷（不走向票流程，这里只关心「有答卷」这个事实）
      const department = await prisma.department.create({
        data: { sessionId, name: `${TAG}D部门` },
      });
      const sheet = await prisma.scoreSheet.create({
        data: { departmentId: department.id, ticketTypeId: typeA.id, sessionId },
      });
      await prisma.sheetTicketMap.create({
        data: {
          ticketId: (await prisma.ticket.findFirstOrThrow({ where: { ticketTypeId: typeA.id } })).id,
          sheetId: sheet.id,
          sessionId,
        },
      });

      // 移除 A → 409
      const removed = await agent.put(`/api/admin/sessions/${sessionId}/ticket-plan`).send({
        types: [{ code: 'B', name: 'B 票', weightPercent: 100, count: 0 }],
      });
      expect(removed.status).toBe(409);
      expect(removed.body.error.code).toBe('TICKET_TYPE_HAS_SHEETS');

      // A 的 code 保留在集合中（改 name/weight）→ 200
      const kept = await agent.put(`/api/admin/sessions/${sessionId}/ticket-plan`).send({
        types: [
          { code: 'A', name: 'A 票改', weightPercent: 60, count: 0 },
          { code: 'B', name: 'B 票', weightPercent: 40, count: 0 },
        ],
      });
      expect(kept.status).toBe(200);
    });

    it('提交集合内编码重复 → 400 VALIDATION_FAILED；无权限账号 → 403', async () => {
      const sessionId = await newSession(`${TAG}场次-D校验`);
      const duplicate = await agent.put(`/api/admin/sessions/${sessionId}/ticket-plan`).send({
        types: [
          { code: 'A', name: 'A 票', weightPercent: 50, count: 0 },
          { code: 'A', name: 'A 票二号', weightPercent: 50, count: 0 },
        ],
      });
      expect(duplicate.status).toBe(400);
      expect(duplicate.body.error.code).toBe('VALIDATION_FAILED');

      const denied = await readonlyAgent.put(`/api/admin/sessions/${sessionId}/ticket-plan`).send({
        types: [{ code: 'A', name: 'A 票', weightPercent: 100, count: 0 }],
      });
      expect(denied.status).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // 契约 E + F：投票提交写受控映射；按码导出与整场导出
  // ---------------------------------------------------------------------------

  describe('契约 E/F：受控映射与导出', () => {
    /** 一条完整的可投票链路夹具：voting 场次 + 问卷 + 100% 票种 + 两张码。 */
    async function setupVotableSession(name: string): Promise<{
      sessionId: string;
      departmentId: string;
      voteColumnId: string;
      criterionId: string;
      ticketTypeId: string;
    }> {
      const session = await prisma.voteSession.create({
        data: { name, status: 'voting' },
      });
      sessionIds.push(session.id);
      const department = await prisma.department.create({
        data: {
          sessionId: session.id,
          name: '安装车间',
          headerNote: '附件8-1',
          title: 'xx评议问卷',
          footerNote: '满分 100 分，弃权按 0 分计',
        },
      });
      const criterion = await prisma.criterion.create({
        data: { departmentId: department.id, sessionId: session.id, name: '德' },
      });
      const voteColumn = await prisma.voteColumn.create({
        data: { departmentId: department.id, sessionId: session.id, name: '主任' },
      });
      const ticketType = await prisma.ticketType.create({
        data: { sessionId: session.id, code: 'A', name: 'A 票（领导评议）', weightPercent: 100 },
      });
      return {
        sessionId: session.id,
        departmentId: department.id,
        voteColumnId: voteColumn.id,
        criterionId: criterion.id,
        ticketTypeId: ticketType.id,
      };
    }

    async function submitOnce(code: string, departmentId: string, voteColumnId: string, criterionId: string) {
      const login = await request(app).post('/api/vote/session').send({ code });
      expect(login.status).toBe(200);
      return request(app)
        .post('/api/vote/submit')
        .set('Authorization', `Bearer ${login.body.token}`)
        .send({
          departmentId,
          items: [{ voteColumnId, criterionId, score: 88 }],
        });
    }

    it('提交后 sheet_ticket_map 写入映射（票→答卷→场次）；重复提交不产生第二行', async () => {
      const fixture = await setupVotableSession(`${TAG}场次-E映射`);
      const ticket = await createTicket(fixture.sessionId, fixture.ticketTypeId);

      const submitted = await submitOnce(
        ticket.code,
        fixture.departmentId,
        fixture.voteColumnId,
        fixture.criterionId,
      );
      expect(submitted.status).toBe(200);

      const mapping = await prisma.sheetTicketMap.findUnique({
        where: { ticketId: ticket.id },
      });
      expect(mapping).toBeTruthy();
      expect(mapping!.sessionId).toBe(fixture.sessionId);
      const sheet = await prisma.scoreSheet.findUnique({ where: { id: mapping!.sheetId } });
      expect(sheet).toBeTruthy();
      expect(sheet!.departmentId).toBe(fixture.departmentId);

      // 重复提交（新令牌拿不到 → 用直发请求模拟核销后的重试）映射仍只有一行
      const secondLogin = await request(app).post('/api/vote/session').send({ code: ticket.code });
      expect(secondLogin.status).toBe(401);
      expect(await prisma.sheetTicketMap.count({ where: { ticketId: ticket.id } })).toBe(1);
    });

    it('按随机码导出答卷：附件8 形态（抬头替换 xx / 行=项点 / 列=被评列 / 表尾 / 提交时间与票别）', async () => {
      const fixture = await setupVotableSession(`${TAG}场次-F单码`);
      const ticket = await createTicket(fixture.sessionId, fixture.ticketTypeId);
      const submitted = await submitOnce(
        ticket.code,
        fixture.departmentId,
        fixture.voteColumnId,
        fixture.criterionId,
      );
      expect(submitted.status).toBe(200);

      const res = await agent
        .get(`/api/admin/tickets/${ticket.id}/export.xlsx`)
        .responseType('blob');
      expect(res.status).toBe(200);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(res.body as unknown as Parameters<typeof workbook.xlsx.load>[0]);
      const sheet = workbook.worksheets[0];
      expect(sheet).toBeTruthy();
      const values = sheet!.getSheetValues().flat().filter((v): v is string | number => typeof v !== 'object');
      const text = values.join('|');
      // 抬头：附件号 + 标题中 xx 替换为部门名
      expect(text).toContain('附件8-1');
      expect(text).toContain('安装车间评议问卷');
      expect(text).not.toContain('xx评议问卷');
      // 行=项点，格=分数
      expect(text).toContain('德');
      expect(text).toContain('88');
      // 表尾说明 + 提交时间 + 票别
      expect(text).toContain('满分 100 分');
      expect(text).toContain('提交时间');
      expect(text).toContain('A 票（领导评议）');
    });

    it('未使用的码 → 409；已作废 → 409；已使用但无映射 → 404 TICKET_NO_SHEET', async () => {
      const fixture = await setupVotableSession(`${TAG}场次-F异常`);
      const unused = await createTicket(fixture.sessionId, fixture.ticketTypeId);
      const unusedRes = await agent.get(`/api/admin/tickets/${unused.id}/export.xlsx`);
      expect(unusedRes.status).toBe(409);
      expect(unusedRes.body.error.code).toBe('TICKET_NOT_USED');

      const revokedTicket = await createTicket(fixture.sessionId, fixture.ticketTypeId);
      await prisma.ticket.update({ where: { id: revokedTicket.id }, data: { status: 'revoked' } });
      const revokedRes = await agent.get(`/api/admin/tickets/${revokedTicket.id}/export.xlsx`);
      expect(revokedRes.status).toBe(409);
      expect(revokedRes.body.error.code).toBe('TICKET_REVOKED');

      // 历史答卷形态：used 但映射缺失（功能上线前提交的）
      const orphan = await createTicket(fixture.sessionId, fixture.ticketTypeId);
      await prisma.ticket.update({
        where: { id: orphan.id },
        data: { status: 'used', usedAt: new Date() },
      });
      const orphanRes = await agent.get(`/api/admin/tickets/${orphan.id}/export.xlsx`);
      expect(orphanRes.status).toBe(404);
      expect(orphanRes.body.error.code).toBe('TICKET_NO_SHEET');
    });

    it('整场导出：统分 sheets + 「答卷汇总」（含随机码列与各格分数、无映射历史答卷一并包含）', async () => {
      const fixture = await setupVotableSession(`${TAG}场次-F整场`);
      // 一张走正常流程（有映射）+ 一张历史答卷（无映射，票已核销）
      const ticket = await createTicket(fixture.sessionId, fixture.ticketTypeId);
      const submitted = await submitOnce(
        ticket.code,
        fixture.departmentId,
        fixture.voteColumnId,
        fixture.criterionId,
      );
      expect(submitted.status).toBe(200);

      const legacySheet = await prisma.scoreSheet.create({
        data: {
          departmentId: fixture.departmentId,
          ticketTypeId: fixture.ticketTypeId,
          sessionId: fixture.sessionId,
        },
      });
      await prisma.scoreItem.create({
        data: {
          sheetId: legacySheet.id,
          voteColumnId: fixture.voteColumnId,
          criterionId: fixture.criterionId,
          score: 66,
        },
      });

      const res = await agent
        .get(`/api/admin/sessions/${fixture.sessionId}/export.xlsx`)
        .responseType('blob');
      expect(res.status).toBe(200);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(res.body as unknown as Parameters<typeof workbook.xlsx.load>[0]);
      const names = workbook.worksheets.map((sheet) => sheet.name);
      // 单启用部门：统分 sheet 保持原始名（不加部门后缀）
      expect(names).toContain('综合排名');
      expect(names).toContain('票别单项明细');
      expect(names).toContain('答卷汇总');

      const summary = workbook.worksheets.find((sheet) => sheet.name === '答卷汇总')!;
      const text = summary.getSheetValues().flat().filter((v): v is string | number => typeof v !== 'object').join('|');
      expect(text).toContain('随机码');
      expect(text).toContain(ticket.code);
      expect(text).toContain('88');
      expect(text).toContain('66');

      // 无映射的历史答卷也在行内（2 行答卷：序号 1、2）
      const dataRows = summary.getColumn(1).values.filter((v) => typeof v === 'number');
      expect(dataRows).toContain(1);
      expect(dataRows).toContain(2);
    });

    it('导出需要 results.export 权限：只读账号 403，未登录 401', async () => {
      // 权限门控在路由中间件层，资源不存在与否不影响 403/401 的判定
      const deniedTicket = await readonlyAgent.get(`/api/admin/tickets/whatever/export.xlsx`);
      expect(deniedTicket.status).toBe(403);
      const deniedSession = await readonlyAgent.get(
        `/api/admin/sessions/00000000-0000-7000-8000-000000000000/export.xlsx`,
      );
      expect(deniedSession.status).toBe(403);
      const anonymous = await request(app).get(`/api/admin/tickets/whatever/export.xlsx`);
      expect(anonymous.status).toBe(401);
    });
  });
});
