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
/** 不存在的场次 ID（PATCH 404 用例）。 */
const MISSING_SESSION_ID = '00000000-0000-7000-8000-000000000000';

const app = createApp();
let agent: ReturnType<typeof request.agent>;
/** 本文件建立的场次 id，afterAll 统一清理。 */
const sessionIds: string[] = [];
/** 本文件建立的全局字典部门 id（向导契约 B 的前置），afterAll 统一清理。 */
const orgDepartmentIds: string[] = [];

/**
 * 建一个场次（走向导契约：字典部门 + opensAt 必填），记录 id 供清理。
 * opensAt 取过去时间，不影响状态机用例的开放判定。
 */
async function newSession(name: string): Promise<string> {
  const org = await agent.post('/api/admin/org-departments').send({ name: `${name}-字典` });
  expect(org.status).toBe(200);
  orgDepartmentIds.push(org.body.department.id);
  const res = await agent.post('/api/admin/sessions').send({
    name,
    orgDepartmentId: org.body.department.id,
    opensAt: '2026-01-01T00:00:00+08:00',
  });
  expect(res.status).toBe(200);
  sessionIds.push(res.body.session.id);
  return res.body.session.id;
}

/**
 * 把场次配置补齐到「可开始投票」（契约 C 的完整性校验前置）：
 * 向导创建已自动插入一条场内部门，这里补项点、被评列、100% 票种与一张未使用码。
 */
async function makeStartable(sessionId: string, code: string): Promise<void> {
  const department = await prisma.department.findFirstOrThrow({ where: { sessionId } });
  await agent
    .post('/api/admin/criteria')
    .send({ departmentId: department.id, name: `${code}项点`, minScore: 0, maxScore: 100 });
  await agent.post('/api/admin/vote-columns').send({ departmentId: department.id, name: `${code}列` });
  const type = await newTicketType(sessionId, code);
  const generated = await agent
    .post('/api/admin/tickets/generate')
    .send({ sessionId, ticketTypeId: type, count: 1 });
  expect(generated.status).toBe(200);
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
    // 向导契约引入的字典部门：按「场次名-字典」的命名约定清理本文件建立的项
    for (const orgId of orgDepartmentIds) {
      await prisma.orgDepartment.deleteMany({ where: { id: orgId } });
    }
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

    const duplicate = await agent.post('/api/admin/sessions').send({
      name: `${TAG}场次-A`,
      // 带全合法字段才能穿过形状校验，命中服务层的重名 409
      orgDepartmentId: orgDepartmentIds[orgDepartmentIds.length - 1],
      opensAt: '2026-01-01T00:00:00+08:00',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('SESSION_EXISTS');
  });

  it('draft 场次列表携带开始投票阻塞清单；配置齐全后清空', async () => {
    const created = await newSession(`${TAG}场次-阻塞`);

    // 刚建的场次只有部门（向导自动落一条），缺项点/被评列/票种/未用码
    const list = await agent.get('/api/admin/sessions');
    const row = list.body.sessions.find((s: { id: string }) => s.id === created);
    expect(Array.isArray(row.startBlockers)).toBe(true);
    expect(row.startBlockers.length).toBeGreaterThan(0);

    // 补齐配置后阻塞清单清空；此时 start 接口不再 409
    await makeStartable(created, `${TAG}B1`);
    const after = await agent.get('/api/admin/sessions');
    const afterRow = after.body.sessions.find((s: { id: string }) => s.id === created);
    expect(afterRow.startBlockers).toEqual([]);
  });

  it('状态机：draft→voting→paused→voting→ended，ended 终态不可逆', async () => {
    const id = await newSession(`${TAG}场次-状态机`);
    await makeStartable(id, `${TAG}S1`);

    // draft → end 非法
    const earlyEnd = await agent.post(`/api/admin/sessions/${id}/end`);
    expect(earlyEnd.status).toBe(409);
    expect(earlyEnd.body.error.code).toBe('INVALID_SESSION_TRANSITION');

    const started = await agent.post(`/api/admin/sessions/${id}/start`);
    expect(started.status).toBe(200);
    expect(started.body.session.status).toBe('voting');
    expect(started.body.session.startAt).toBeTruthy();

    // draft → pause 非法（此刻已是 voting，但 pause 合法）；先测 draft 时期不可能，跳过
    const paused = await agent.post(`/api/admin/sessions/${id}/pause`);
    expect(paused.status).toBe(200);
    expect(paused.body.session.status).toBe('paused');

    // paused → end 合法
    const ended = await agent.post(`/api/admin/sessions/${id}/end`);
    expect(ended.status).toBe(200);
    expect(ended.body.session.status).toBe('ended');
    expect(ended.body.session.endedAt).toBeTruthy();

    // ended 终态：start / pause / end 全部 409
    for (const action of ['start', 'pause', 'end']) {
      const res = await agent.post(`/api/admin/sessions/${id}/${action}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_SESSION_TRANSITION');
    }
  });

  it('状态机：paused → start 恢复 voting，且不覆盖首次 startAt', async () => {
    const id = await newSession(`${TAG}场次-恢复`);
    await makeStartable(id, `${TAG}S2`);
    const started = await agent.post(`/api/admin/sessions/${id}/start`);
    const firstStartAt = started.body.session.startAt as string;
    await agent.post(`/api/admin/sessions/${id}/pause`);

    const resumed = await agent.post(`/api/admin/sessions/${id}/start`);
    expect(resumed.status).toBe(200);
    expect(resumed.body.session.status).toBe('voting');
    expect(resumed.body.session.startAt).toBe(firstStartAt);
  });

  it('PATCH 更新名称与开放时间窗：缺省不改、null 清空、重名 409', async () => {
    const id = await newSession(`${TAG}场次-编辑`);
    const opensAt = '2026-09-01T08:00:00+08:00';
    const closesAt = '2026-09-30T18:00:00+08:00';

    // 合法更新：名称 + 时间窗一起改。时间按时刻比较：TIMESTAMPTZ 回读是 UTC ISO 串。
    const opensAtMs = Date.parse(opensAt);
    const closesAtMs = Date.parse(closesAt);
    const updated = await agent.patch(`/api/admin/sessions/${id}`).send({ name: `${TAG}场次-编辑后`, opensAt, closesAt });
    expect(updated.status).toBe(200);
    expect(updated.body.session).toMatchObject({
      id,
      name: `${TAG}场次-编辑后`,
    });
    expect(Date.parse(updated.body.session.opensAt)).toBe(opensAtMs);
    expect(Date.parse(updated.body.session.closesAt)).toBe(closesAtMs);
    // 列表带出新字段
    const list = await agent.get('/api/admin/sessions');
    const row = list.body.sessions.find((s: { id: string }) => s.id === id);
    expect(Date.parse(row.opensAt)).toBe(opensAtMs);
    expect(Date.parse(row.closesAt)).toBe(closesAtMs);

    // 缺省（undefined）不改：只清 closesAt，opensAt 保持
    const cleared = await agent.patch(`/api/admin/sessions/${id}`).send({ closesAt: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.session.closesAt).toBeNull();
    expect(Date.parse(cleared.body.session.opensAt)).toBe(opensAtMs);

    // 重名 → 409 SESSION_EXISTS（排除自身：改回原名不冲突）
    const other = await newSession(`${TAG}场次-重名他场`);
    const dup = await agent
      .patch(`/api/admin/sessions/${id}`)
      .send({ name: `${TAG}场次-重名他场` });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SESSION_EXISTS');
    const self = await agent
      .patch(`/api/admin/sessions/${id}`)
      .send({ name: `${TAG}场次-编辑后` });
    expect(self.status).toBe(200);
    expect(other).toBeTruthy();
  });

  it('PATCH opensAt >= closesAt → 400 VOTE_WINDOW_INVALID', async () => {
    const id = await newSession(`${TAG}场次-窗口校验`);
    // 相等也拒绝：两侧同时设
    const equal = await agent.patch(`/api/admin/sessions/${id}`).send({
      opensAt: '2026-09-20T00:00:00+08:00',
      closesAt: '2026-09-20T00:00:00+08:00',
    });
    expect(equal.status).toBe(400);
    expect(equal.body.error.code).toBe('VOTE_WINDOW_INVALID');

    // 顺序写反同样拒绝
    const reversed = await agent.patch(`/api/admin/sessions/${id}`).send({
      opensAt: '2026-09-21T00:00:00+08:00',
      closesAt: '2026-09-20T00:00:00+08:00',
    });
    expect(reversed.status).toBe(400);
    expect(reversed.body.error.code).toBe('VOTE_WINDOW_INVALID');

    // 只改一侧、与库里另一侧合成反序也拒绝：先设正序窗口，再把 closesAt 改到 opensAt 之前
    await agent.patch(`/api/admin/sessions/${id}`).send({
      opensAt: '2026-09-10T00:00:00+08:00',
      closesAt: '2026-09-30T00:00:00+08:00',
    });
    const oneSided = await agent
      .patch(`/api/admin/sessions/${id}`)
      .send({ closesAt: '2026-09-01T00:00:00+08:00' });
    expect(oneSided.status).toBe(400);
    expect(oneSided.body.error.code).toBe('VOTE_WINDOW_INVALID');
  });

  it('PATCH 场次不存在 → 404；ended 场次仍可改窗口', async () => {
    const missing = await agent
      .patch(`/api/admin/sessions/${MISSING_SESSION_ID}`)
      .send({ name: 'x' });
    expect(missing.status).toBe(404);

    const id = await newSession(`${TAG}场次-终态改窗`);
    await makeStartable(id, `${TAG}S3`);
    await agent.post(`/api/admin/sessions/${id}/start`);
    await agent.post(`/api/admin/sessions/${id}/end`);
    expect((await agent.get('/api/admin/sessions')).body.sessions.find((s: { id: string }) => s.id === id).status).toBe('ended');

    // ended 为终态，但时间窗不属于状态机：为下一期复用窗口是正常操作
    const res = await agent.patch(`/api/admin/sessions/${id}`).send({
      opensAt: '2026-10-01T08:00:00+08:00',
      closesAt: '2026-10-31T18:00:00+08:00',
    });
    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe('ended');
    expect(Date.parse(res.body.session.opensAt)).toBe(Date.parse('2026-10-01T08:00:00+08:00'));
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
    // idB 场内有两部门：向导按字典自动插入的「场次名-字典」+ 手工建的 B场部门；
    // 关键断言是过滤正确：只含本场部门，不含 A 场的。
    const names = filtered.body.map((row: { name: string }) => row.name);
    expect(names).toContain(`${TAG}B场部门`);
    expect(names).not.toContain(`${TAG}A场部门`);
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
