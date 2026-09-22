/**
 * 场次管理接口测试：CRUD、状态机、多场时的 SESSION_REQUIRED、发码领码留痕。
 *
 * 状态机契约：draft→start→voting；voting→pause→paused；paused→start→voting；
 * voting|paused→end→ended；ended 终态不可逆；非法流转 409 INVALID_SESSION_TRANSITION。
 *
 * 夹具约定同 admin.test.ts：TEST_DATABASE_URL + `SS` 前缀隔离，只清理自己的数据。
 * 本文件会建多个场次（这正是 SESSION_REQUIRED 用例的前提），afterAll 全部删除，
 * 让库回到「只剩默认场次」的状态，与同库的其他测试文件并存。
 */
import 'dotenv/config';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suiteEnabled = Boolean(testDatabaseUrl);

if (!suiteEnabled) {
  console.warn('[sessions.test] 未设置 TEST_DATABASE_URL，跳过场次管理接口测试。');
}

// 必须在导入 src 之前改写：src/env.ts 在模块求值时读 process.env。
process.env.NODE_ENV = 'test';
if (suiteEnabled) process.env.TEST_DATABASE_URL = testDatabaseUrl;

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { hashPassword } = await import('../src/lib/password.js');
const { ALL_PERMISSION_CODES } = await import('../src/lib/permissions.js');
const { createRole } = await import('./rbac-fixtures.js');
const { ensureDefaultSession } = await import('./session-fixtures.js');

const describeDb = suiteEnabled ? describe : describe.skip;

const TAG = 'SS';
const ADMIN_USERNAME = `${TAG}admin`;
const PASSWORD = 'Test-Passw0rd!2026';

const app = createApp();
let agent: ReturnType<typeof request.agent>;
/** 本文件建立的场次 id，afterAll 统一清理。 */
const sessionIds: string[] = [];

/** 建一个场次（走接口），记录 id 供清理。 */
async function newSession(name: string): Promise<string> {
  const res = await agent.post('/api/admin/sessions').send({ name });
  expect(res.status).toBe(200);
  sessionIds.push(res.body.session.id);
  return res.body.session.id;
}

async function newDepartment(sessionId: string, name: string): Promise<string> {
  const res = await agent.post('/api/admin/departments').send({ sessionId, name });
  expect(res.status).toBe(200);
  return res.body.id;
}

async function newEmployee(sessionId: string, departmentId: string, name: string): Promise<string> {
  const res = await agent.post('/api/admin/employees').send({ sessionId, departmentId, name });
  expect(res.status).toBe(200);
  return res.body.id;
}

/** 给场次建一个 100% 权重的票种（走接口；场次内启用合计从 0 起算）。 */
async function newTicketType(sessionId: string, code: string): Promise<string> {
  const res = await agent
    .post('/api/admin/ticket-types')
    .send({ sessionId, code, name: `${TAG}票种-${code}`, weightPercent: 100 });
  expect(res.status).toBe(200);
  return res.body.id;
}

describeDb('场次管理', () => {
  beforeAll(async () => {
    await prisma.adminUser.deleteMany({ where: { username: { startsWith: TAG } } });
    await prisma.adminRole.deleteMany({ where: { code: { startsWith: TAG } } });
    // 本文件不写业务夹具（除发码用例的票），发码用例自己清；这里只保证默认场次在。
    await ensureDefaultSession(prisma);

    const roleId = await createRole(`${TAG}role`, '测试-场次管理员', ALL_PERMISSION_CODES);
    await prisma.adminUser.create({
      data: {
        username: ADMIN_USERNAME,
        passwordHash: await hashPassword(PASSWORD),
        roleId,
      },
    });
    agent = request.agent(app);
    const login = await agent
      .post('/api/admin/login')
      .send({ username: ADMIN_USERNAME, password: PASSWORD });
    expect(login.status).toBe(200);
  });

  afterAll(async () => {
    // 按场次逐个清业务数据再删场次（外键 RESTRICT）：发码用例会留下批次与票，
    // 批次的 operator 是管理员用户名，不能按固定前缀清理。
    for (const id of sessionIds) {
      const typeIds = (
        await prisma.ticketType.findMany({ where: { sessionId: id }, select: { id: true } })
      ).map((row) => row.id);
      await prisma.ticket.deleteMany({ where: { ticketTypeId: { in: typeIds } } });
      await prisma.ticketBatch.deleteMany({ where: { ticketTypeId: { in: typeIds } } });
      const departmentIds = (
        await prisma.department.findMany({ where: { sessionId: id }, select: { id: true } })
      ).map((row) => row.id);
      await prisma.employee.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.criterion.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.voteColumn.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
      await prisma.ticketType.deleteMany({ where: { id: { in: typeIds } } });
      await prisma.voteSession.deleteMany({ where: { id } });
    }
    await prisma.adminUser.deleteMany({ where: { username: { startsWith: TAG } } });
    await prisma.adminRole.deleteMany({ where: { code: { startsWith: TAG } } });
    await prisma.$disconnect();
  });

  it('创建场次：默认 draft，列表可见，重名 409', async () => {
    const created = await newSession(`${TAG}场次-A`);
    expect(created).toBeTruthy();

    const list = await agent.get('/api/admin/sessions');
    const row = list.body.sessions.find((s: { id: string }) => s.id === created);
    expect(row.status).toBe('draft');
    expect(row.name).toBe(`${TAG}场次-A`);
    expect(row.startAt).toBeNull();
    expect(row.endedAt).toBeNull();

    const duplicate = await agent.post('/api/admin/sessions').send({ name: `${TAG}场次-A` });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('SESSION_EXISTS');
  });

  it('状态机：draft→voting→paused→voting→ended，ended 终态不可逆', async () => {
    const id = await newSession(`${TAG}场次-状态机`);

    // draft → end 非法
    const earlyEnd = await agent.post(`/api/admin/sessions/${id}/end`);
    expect(earlyEnd.status).toBe(409);
    expect(earlyEnd.body.error.code).toBe('INVALID_SESSION_TRANSITION');

    const started = await agent.post(`/api/admin/sessions/${id}/start`);
    expect(started.status).toBe(200);
    expect(started.body.status).toBe('voting');
    expect(started.body.startAt).toBeTruthy();

    // draft → pause 非法（此刻已是 voting，但 pause 合法）；先测 draft 时期不可能，跳过
    const paused = await agent.post(`/api/admin/sessions/${id}/pause`);
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('paused');

    // paused → end 合法
    const ended = await agent.post(`/api/admin/sessions/${id}/end`);
    expect(ended.status).toBe(200);
    expect(ended.body.status).toBe('ended');
    expect(ended.body.endedAt).toBeTruthy();

    // ended 终态：start / pause / end 全部 409
    for (const action of ['start', 'pause', 'end']) {
      const res = await agent.post(`/api/admin/sessions/${id}/${action}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_SESSION_TRANSITION');
    }
  });

  it('状态机：paused → start 恢复 voting，且不覆盖首次 startAt', async () => {
    const id = await newSession(`${TAG}场次-恢复`);
    const started = await agent.post(`/api/admin/sessions/${id}/start`);
    const firstStartAt = started.body.startAt as string;
    await agent.post(`/api/admin/sessions/${id}/pause`);

    const resumed = await agent.post(`/api/admin/sessions/${id}/start`);
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe('voting');
    expect(resumed.body.startAt).toBe(firstStartAt);
  });

  it('多场时未带 sessionId 的创建类请求 → 400 SESSION_REQUIRED', async () => {
    await newSession(`${TAG}场次-B`);
    // 此时库里至少有两个非默认场次 + 默认场次（若存在）→ 肯定多场。

    const dept = await agent.post('/api/admin/departments').send({ name: `${TAG}无场次部门` });
    expect(dept.status).toBe(400);
    expect(dept.body.error.code).toBe('SESSION_REQUIRED');

    const type = await agent
      .post('/api/admin/ticket-types')
      .send({ code: `${TAG}NOSESS`, name: '无场次票种', weightPercent: 10 });
    expect(type.status).toBe(400);
    expect(type.body.error.code).toBe('SESSION_REQUIRED');

    const generate = await agent.post('/api/admin/tickets/generate').send({
      ticketTypeId: 'any',
      count: 1,
    });
    expect(generate.status).toBe(400);
    expect(generate.body.error.code).toBe('SESSION_REQUIRED');
  });

  it('多场时列表类接口未带 sessionId 同样 400 SESSION_REQUIRED；带了只返回该场', async () => {
    const idA = await newSession(`${TAG}场次-列表A`);
    const idB = await newSession(`${TAG}场次-列表B`);
    await newDepartment(idA, `${TAG}A场部门`);
    await newDepartment(idB, `${TAG}B场部门`);

    const noFilter = await agent.get('/api/admin/departments');
    expect(noFilter.status).toBe(400);
    expect(noFilter.body.error.code).toBe('SESSION_REQUIRED');

    const filtered = await agent.get(`/api/admin/departments?sessionId=${idB}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.map((row: { name: string }) => row.name)).toEqual([`${TAG}B场部门`]);
  });

  it('发码 assignments：按序写入领码人（发放留痕），跨场次职工被拒', async () => {
    const id = await newSession(`${TAG}场次-发码`);
    const departmentId = await newDepartment(id, `${TAG}发码部门`);
    const empA = await newEmployee(id, departmentId, `${TAG}职工甲`);
    const empB = await newEmployee(id, departmentId, `${TAG}职工乙`);
    const otherSession = await newSession(`${TAG}场次-他场`);
    const otherDept = await newDepartment(otherSession, `${TAG}他场部门`);
    const empOther = await newEmployee(otherSession, otherDept, `${TAG}他场职工`);

    const ticketTypeId = await newTicketType(id, `${TAG}T1`);

    // 正常：2 张码都按序指定领码人；再发 1 张不指定（assignments 可省略）
    const ok = await agent.post('/api/admin/tickets/generate').send({
      sessionId: id,
      ticketTypeId,
      count: 2,
      assignments: [{ ticketTypeId, employeeIds: [empA, empB] }],
    });
    expect(ok.status).toBe(200);

    const tickets = await prisma.ticket.findMany({
      where: { batchId: ok.body.batchId },
      include: { assignee: { select: { name: true } } },
    });
    expect(tickets).toHaveLength(2);
    // 返回的 codes[i] 就是生成的第 i 张码：assignee 按 assignments 顺序与之对应
    const assigneeByCode = new Map(
      (ok.body.codes as string[]).map((code, index) => [code, [empA, empB][index]]),
    );
    for (const ticket of tickets) {
      expect(ticket.assigneeId).toBe(assigneeByCode.get(ticket.code));
    }

    // 不带 assignments：生成的码无领码人
    const plain = await agent.post('/api/admin/tickets/generate').send({
      sessionId: id,
      ticketTypeId,
      count: 1,
    });
    expect(plain.status).toBe(200);
    const plainTickets = await prisma.ticket.findMany({
      where: { batchId: plain.body.batchId },
    });
    expect(plainTickets).toHaveLength(1);
    expect(plainTickets[0]?.assigneeId).toBeNull();

    // 领码人属于其他场次 → 400
    const mismatch = await agent.post('/api/admin/tickets/generate').send({
      sessionId: id,
      ticketTypeId,
      count: 1,
      assignments: [{ ticketTypeId, employeeIds: [empOther] }],
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe('SESSION_MISMATCH');

    // 数量不一致 → 400
    const badCount = await agent.post('/api/admin/tickets/generate').send({
      sessionId: id,
      ticketTypeId,
      count: 5,
      assignments: [{ ticketTypeId, employeeIds: [empA] }],
    });
    expect(badCount.status).toBe(400);
    expect(badCount.body.error.code).toBe('ASSIGNMENT_COUNT_MISMATCH');
  });

  it('发码票种不属于目标场次 → 400 SESSION_MISMATCH', async () => {
    const id = await newSession(`${TAG}场次-票种校验`);
    const otherSession = await newSession(`${TAG}场次-票种他场`);
    const ticketTypeId = await newTicketType(otherSession, `${TAG}T2`);

    const res = await agent.post('/api/admin/tickets/generate').send({
      sessionId: id,
      ticketTypeId,
      count: 1,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SESSION_MISMATCH');
  });
});
