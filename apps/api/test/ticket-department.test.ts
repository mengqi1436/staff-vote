/**
 * 随机码绑定评议部门（批次级 departmentId）接口测试。
 *
 * 覆盖：
 *   1. 绑定发码：batch 与每张 ticket 都写入 departmentId；
 *   2. 绑定码登录（createVoteSession）只返回被绑定的部门；
 *   3. 绑定码越权取打分表 / 提交其他部门 → 403 TICKET_DEPARTMENT_MISMATCH；
 *   4. NULL 绑定（存量万能码）回归：登录返回全部启用部门，可评任意部门；
 *   5. 跨场次的 departmentId 发码 → 400 DEPARTMENT_NOT_IN_SESSION；
 *   6. 停用部门发码 → 409 DEPARTMENT_DISABLED；
 *   7. 绑定码正常提交核销成功（评分表落在绑定部门）；
 *   8. 批次列表 DTO 带 departmentId / departmentName。
 *
 * 夹具约定：所有数据带 `TDB` 前缀，只清理自己的数据（与同库的其他测试文件并存）。
 * 账号与角色只在 beforeAll 建一次：每用例重建会让已登录的 Cookie 立即失效（401），
 * 也会把登录限流（10 次/分钟）撞满。
 */
import 'dotenv/config';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? '';
/** 没给测试库就跳过整组用例，而不是退回去连开发库。 */
const suiteEnabled = Boolean(testDatabaseUrl);

if (!suiteEnabled) {
  console.warn(
    '[ticket-department.test] 未设置 TEST_DATABASE_URL，跳过随机码绑定部门测试。\n' +
      "  运行方式：$env:NODE_ENV='test'; $env:TEST_DATABASE_URL='<测试库连接串>'; " +
      'pnpm --filter @staff-vote/api test',
  );
}

// 必须在导入 src 之前改写：src/env.ts 在模块求值时读 process.env（静态 import 会被提升）。
process.env.NODE_ENV = 'test';
if (suiteEnabled) process.env.TEST_DATABASE_URL = testDatabaseUrl;

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { cleanupRbac, createAdmin, createRole } = await import('./rbac-fixtures.js');

/** 没有可用测试库就整组跳过。 */
const describeDb = suiteEnabled ? describe : describe.skip;

/** 夹具前缀：清理只删自己前缀的数据。 */
const TAG = 'TDB';
const PASSWORD = 'Test-Passw0rd!2026';

const app = createApp();
let operatorAgent: ReturnType<typeof request.agent>;

let seq = 0;
function nextSeq(): number {
  seq += 1;
  return seq;
}

/** 本文件建的场次 id，afterAll 兜底清理。 */
const sessionIds: string[] = [];

async function makeSession(label: string, status: 'voting' | 'draft' = 'voting'): Promise<string> {
  const created = await prisma.voteSession.create({
    data: { name: `${TAG}场次-${label}${nextSeq()}`, status },
  });
  sessionIds.push(created.id);
  return created.id;
}

interface MadeDepartment {
  id: string;
  /** 提交一格所需的 (voteColumnId, criterionId) */
  cell: { voteColumnId: string; criterionId: string };
}

/** 部门 + 1 被评列 + 1 项点（0-100），凑齐一格可提交的最小问卷。 */
async function makeDepartment(
  sessionId: string,
  label: string,
  opts: { enabled?: boolean } = {},
): Promise<MadeDepartment> {
  const department = await prisma.department.create({
    data: { sessionId, name: `${TAG}部门-${label}${nextSeq()}`, enabled: opts.enabled ?? true },
  });
  const column = await prisma.voteColumn.create({
    data: { departmentId: department.id, sessionId, name: `${TAG}被评列-${label}` },
  });
  const criterion = await prisma.criterion.create({
    data: {
      departmentId: department.id,
      sessionId,
      name: `${TAG}项点-${label}`,
      minScore: 0,
      maxScore: 100,
    },
  });
  return { id: department.id, cell: { voteColumnId: column.id, criterionId: criterion.id } };
}

async function makeEnabledTicketType(sessionId: string, label: string): Promise<{ id: string }> {
  return prisma.ticketType.create({
    data: {
      sessionId,
      code: `${TAG}TT${nextSeq()}${label}`,
      name: `${TAG}票种-${label}`,
      weightPercent: 100,
      enabled: true,
    },
  });
}

interface Generated {
  batchId: string;
  codes: string[];
}

/** 走管理端发码接口（含 departmentId 透传）。 */
async function generate(input: {
  sessionId: string;
  ticketTypeId: string;
  departmentId?: string;
  count?: number;
}): Promise<{ status: number; body: any }> {
  const res = await operatorAgent.post('/api/admin/tickets/generate').send({
    sessionId: input.sessionId,
    ticketTypeId: input.ticketTypeId,
    count: input.count ?? 1,
    ...(input.departmentId ? { departmentId: input.departmentId } : {}),
  });
  return { status: res.status, body: res.body as Record<string, unknown> };
}

/** 直接建一张孤立票（自带批次），用于 NULL 绑定回归等不走发码接口的用例。 */
async function makeRawTicket(
  sessionId: string,
  ticketTypeId: string,
  departmentId: string | null,
): Promise<{ id: string; code: string }> {
  const batch = await prisma.ticketBatch.create({
    data: {
      ticketTypeId,
      sessionId,
      ...(departmentId ? { departmentId } : {}),
      count: 1,
      operator: TAG,
    },
  });
  const ticket = await prisma.ticket.create({
    data: {
      code: `${TAG}CODE${nextSeq()}`,
      ticketTypeId,
      batchId: batch.id,
      sessionId,
      ...(departmentId ? { departmentId } : {}),
    },
  });
  return { id: ticket.id, code: ticket.code };
}

let loginSeq = 0;

/** 投票端登录换令牌（限流 10 次/分钟，逐用例轮换来源 IP）。 */
async function voteLogin(code: string): Promise<string> {
  loginSeq += 1;
  const res = await request(app)
    .post('/api/vote/session')
    .set('X-Forwarded-For', `10.98.0.${loginSeq}`)
    .send({ code });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

function getSheet(token: string, departmentId: string) {
  return request(app)
    .get('/api/vote/sheet')
    .set('Authorization', `Bearer ${token}`)
    .query({ departmentId });
}

function postSubmit(token: string, body: unknown) {
  return request(app)
    .post('/api/vote/submit')
    .set('Authorization', `Bearer ${token}`)
    .send(body as object);
}

/** 只清理本文件的数据：删除顺序遵循外键 RESTRICT。 */
async function clearFixtures(): Promise<void> {
  const types = await prisma.ticketType.findMany({
    where: { code: { startsWith: TAG } },
    select: { id: true },
  });
  const typeIds = types.map((row) => row.id);
  const departments = await prisma.department.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const departmentIds = departments.map((row) => row.id);

  const sheetIds = (
    await prisma.scoreSheet.findMany({
      where: { departmentId: { in: departmentIds } },
      select: { id: true },
    })
  ).map((row) => row.id);
  await prisma.scoreItem.deleteMany({ where: { sheetId: { in: sheetIds } } });
  await prisma.sheetTicketMap.deleteMany({ where: { sheetId: { in: sheetIds } } });
  await prisma.scoreSheet.deleteMany({ where: { id: { in: sheetIds } } });
  await prisma.ticket.deleteMany({ where: { ticketTypeId: { in: typeIds } } });
  await prisma.ticketBatch.deleteMany({ where: { ticketTypeId: { in: typeIds } } });
  await prisma.ticketType.deleteMany({ where: { id: { in: typeIds } } });
  await prisma.voteColumn.deleteMany({ where: { departmentId: { in: departmentIds } } });
  await prisma.criterion.deleteMany({ where: { departmentId: { in: departmentIds } } });
  await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
  await prisma.voteSession.deleteMany({ where: { id: { in: sessionIds } } });
  sessionIds.length = 0;
}

async function login(username: string): Promise<ReturnType<typeof request.agent>> {
  const agent = request.agent(app);
  const res = await agent.post('/api/admin/login').send({ username, password: PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

describeDb('随机码绑定评议部门', () => {
  beforeAll(async () => {
    const rows =
      await prisma.$queryRaw<Array<{ currentDatabase: string }>>`SELECT current_database() AS "currentDatabase"`;
    const connected = rows[0]?.currentDatabase ?? '';
    const expected = new URL(testDatabaseUrl).pathname.replace(/^\//, '');
    if (connected !== expected) {
      throw new Error(
        `测试实际连到 ${connected}，而 TEST_DATABASE_URL 指向的是 ${expected}；` +
          '请确认 NODE_ENV=test 且 TEST_DATABASE_URL 指向测试库后重跑。',
      );
    }

    await clearFixtures();
    await cleanupRbac(TAG);

    const operatorRoleId = await createRole(`${TAG}role-operator`, '测试-可发码', [
      'tickets.generate',
    ]);
    await createAdmin(`${TAG}admin`, PASSWORD, operatorRoleId);
    operatorAgent = await login(`${TAG}admin`);
  });

  beforeEach(async () => {
    await clearFixtures();
  });

  afterAll(async () => {
    await clearFixtures();
    await cleanupRbac(TAG);
    await prisma.$disconnect();
  });

  it('绑定发码：batch 与每张 ticket 都写入 departmentId', async () => {
    const sessionId = await makeSession('绑定发码');
    const type = await makeEnabledTicketType(sessionId, '绑定');
    const department = await makeDepartment(sessionId, '目标');

    const res = await generate({
      sessionId,
      ticketTypeId: type.id,
      departmentId: department.id,
      count: 2,
    });
    expect(res.status).toBe(200);
    const { batchId, codes } = res.body as unknown as Generated;
    expect(codes).toHaveLength(2);

    const batch = await prisma.ticketBatch.findUnique({ where: { id: batchId } });
    expect(batch?.departmentId).toBe(department.id);
    const tickets = await prisma.ticket.findMany({ where: { ticketTypeId: type.id } });
    expect(tickets).toHaveLength(2);
    for (const ticket of tickets) expect(ticket.departmentId).toBe(department.id);
  });

  it('绑定码登录只返回被绑定的部门', async () => {
    const sessionId = await makeSession('登录过滤');
    const type = await makeEnabledTicketType(sessionId, '过滤');
    const bound = await makeDepartment(sessionId, '绑定');
    await makeDepartment(sessionId, '其他');

    const { body } = await generate({
      sessionId,
      ticketTypeId: type.id,
      departmentId: bound.id,
    });
    const [code] = (body as unknown as Generated).codes;

    const res = await request(app)
      .post('/api/vote/session')
      .set('X-Forwarded-For', `10.98.1.${++loginSeq}`)
      .send({ code });
    expect(res.status).toBe(200);
    expect(res.body.departments).toEqual([{ id: bound.id, name: expect.any(String) }]);
  });

  it('绑定码越权取其他部门打分表 → 403 TICKET_DEPARTMENT_MISMATCH', async () => {
    const sessionId = await makeSession('越权sheet');
    const type = await makeEnabledTicketType(sessionId, '越权');
    const bound = await makeDepartment(sessionId, '绑定');
    const other = await makeDepartment(sessionId, '其他');

    const { body } = await generate({
      sessionId,
      ticketTypeId: type.id,
      departmentId: bound.id,
    });
    const token = await voteLogin((body as unknown as Generated).codes[0] as string);

    const res = await getSheet(token, other.id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TICKET_DEPARTMENT_MISMATCH');
    expect(res.body.error.message).toBe('该随机码仅限评议指定部门');
  });

  it('绑定码越权提交其他部门 → 403 TICKET_DEPARTMENT_MISMATCH，票不核销', async () => {
    const sessionId = await makeSession('越权submit');
    const type = await makeEnabledTicketType(sessionId, '越权提交');
    const bound = await makeDepartment(sessionId, '绑定');
    const other = await makeDepartment(sessionId, '其他');

    const { body } = await generate({
      sessionId,
      ticketTypeId: type.id,
      departmentId: bound.id,
    });
    const [code] = (body as unknown as Generated).codes;
    const token = await voteLogin(code as string);

    const res = await postSubmit(token, {
      departmentId: other.id,
      items: [{ ...other.cell, score: 80 }],
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TICKET_DEPARTMENT_MISMATCH');

    const ticket = await prisma.ticket.findUnique({ where: { code: code as string } });
    expect(ticket?.status).toBe('unused');
    expect(await prisma.scoreSheet.count({ where: { departmentId: other.id } })).toBe(0);
  });

  it('NULL 绑定存量码回归：登录返回全部启用部门，可评任意部门', async () => {
    const sessionId = await makeSession('万能回归');
    const type = await makeEnabledTicketType(sessionId, '万能');
    const deptA = await makeDepartment(sessionId, 'A');
    const deptB = await makeDepartment(sessionId, 'B');
    const ticket = await makeRawTicket(sessionId, type.id, null);

    const loginRes = await request(app)
      .post('/api/vote/session')
      .set('X-Forwarded-For', `10.98.2.${++loginSeq}`)
      .send({ code: ticket.code });
    expect(loginRes.status).toBe(200);
    const returned = (loginRes.body.departments as Array<{ id: string }>).map((row) => row.id);
    expect(returned).toContain(deptA.id);
    expect(returned).toContain(deptB.id);

    const sheet = await getSheet(loginRes.body.token as string, deptB.id);
    expect(sheet.status).toBe(200);

    const submit = await postSubmit(loginRes.body.token as string, {
      departmentId: deptB.id,
      items: [{ ...deptB.cell, score: 90 }],
    });
    expect(submit.status).toBe(200);
    expect(submit.body).toEqual({ ok: true });
  });

  it('跨场次 departmentId 发码 → 400 DEPARTMENT_NOT_IN_SESSION', async () => {
    const sessionId = await makeSession('本场次');
    const otherSessionId = await makeSession('他场次', 'draft');
    const type = await makeEnabledTicketType(sessionId, '跨场');
    const foreignDepartment = await makeDepartment(otherSessionId, '他场');

    const res = await generate({
      sessionId,
      ticketTypeId: type.id,
      departmentId: foreignDepartment.id,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DEPARTMENT_NOT_IN_SESSION');
  });

  it('停用部门发码 → 409 DEPARTMENT_DISABLED', async () => {
    const sessionId = await makeSession('停用');
    const type = await makeEnabledTicketType(sessionId, '停用');
    const disabled = await makeDepartment(sessionId, '停用', { enabled: false });

    const res = await generate({
      sessionId,
      ticketTypeId: type.id,
      departmentId: disabled.id,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEPARTMENT_DISABLED');
  });

  it('绑定码正常提交核销成功：评分表落在绑定部门', async () => {
    const sessionId = await makeSession('正常提交');
    const type = await makeEnabledTicketType(sessionId, '提交');
    const bound = await makeDepartment(sessionId, '绑定');

    const { body } = await generate({
      sessionId,
      ticketTypeId: type.id,
      departmentId: bound.id,
    });
    const [code] = (body as unknown as Generated).codes;
    const token = await voteLogin(code as string);

    const res = await postSubmit(token, {
      departmentId: bound.id,
      items: [{ ...bound.cell, score: 88 }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const ticket = await prisma.ticket.findUnique({ where: { code: code as string } });
    expect(ticket?.status).toBe('used');
    const sheets = await prisma.scoreSheet.findMany({ where: { departmentId: bound.id } });
    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.sessionId).toBe(sessionId);
    expect(sheets[0]?.ticketTypeId).toBe(type.id);
  });

  it('批次列表 DTO 带 departmentId / departmentName', async () => {
    const sessionId = await makeSession('批次列表');
    const type = await makeEnabledTicketType(sessionId, '列表');
    const bound = await makeDepartment(sessionId, '列表');

    const { body } = await generate({
      sessionId,
      ticketTypeId: type.id,
      departmentId: bound.id,
    });
    const { batchId } = body as unknown as Generated;

    const res = await operatorAgent
      .get('/api/admin/ticket-batches')
      .query({ sessionId });
    expect(res.status).toBe(200);
    const batch = (res.body as Array<{ id: string; departmentId: string | null; departmentName: string | null }>).find(
      (row) => row.id === batchId,
    );
    expect(batch).toBeDefined();
    expect(batch?.departmentId).toBe(bound.id);
    expect(batch?.departmentName).toEqual(expect.any(String));
    expect(batch?.departmentName).not.toBeNull();
  });

  it('不绑定发码（缺省 departmentId）：批次 departmentId 为 null', async () => {
    const sessionId = await makeSession('不绑定');
    const type = await makeEnabledTicketType(sessionId, '不绑定');

    const { body } = await generate({ sessionId, ticketTypeId: type.id });
    const { batchId } = body as unknown as Generated;

    const batch = await prisma.ticketBatch.findUnique({ where: { id: batchId } });
    expect(batch?.departmentId).toBeNull();
  });
});
