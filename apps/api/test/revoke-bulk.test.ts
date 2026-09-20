/**
 * 一键作废（批量作废未使用随机码）接口测试。
 *
 * 覆盖：
 *   1. 只作废 `unused`：used / revoked 一律不动；
 *   2. 按票种作废时不影响其他票种；
 *   3. 无 `tickets.revoke` 权限 → 403 `PERMISSION_DENIED`，且一张码都没被作废
 *      （权限校验在写库之前，不是「写完再报错」）；
 *   4. 返回值等于实际作废数，重复调用第二次返回 0；
 *   5. AuditLog 记录动作、操作者、范围与数量；
 *   6. 既有发码与单张作废端点同样纳入权限。
 *
 * 夹具约定：所有数据带 `RVB` 前缀，只清理自己的数据（与同库的其他测试文件并存）。
 * 账号与角色只在 beforeAll 建一次：令牌的 `sub` 是账号 id，每用例重建账号会让
 * 已登录的 Cookie 立即失效（401），也会把登录限流（10 次/分钟）撞满。
 */
import 'dotenv/config';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? '';
/** 没给测试库就跳过整组用例，而不是退回去连开发库。 */
const suiteEnabled = Boolean(testDatabaseUrl);

if (!suiteEnabled) {
  console.warn(
    '[revoke-bulk.test] 未设置 TEST_DATABASE_URL，跳过一键作废接口测试。\n' +
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
const TAG = 'RVB';
const PASSWORD = 'Test-Passw0rd!2026';
/** 一键作废的审计动作名。 */
const REVOKE_ACTION = 'ticket.revoke_bulk';

const app = createApp();
let operatorAgent: ReturnType<typeof request.agent>;
let viewerAgent: ReturnType<typeof request.agent>;

let sequence = 0;

function nextSeq(): number {
  sequence += 1;
  return sequence;
}

interface MadeTickets {
  id: string;
  code: string;
  /** 用于断言「已核销的码原样不动」的那张码 */
  usedCode: string | null;
}

/**
 * 造「票种 + 批次 + 指定状态的码」。
 *
 * 票种一律 `weightPercent: 0` 且不启用：权重合计是同库其他用例的全局约束，
 * 这里不参与接口层的权重校验，夹具也不该影响别人。
 */
async function makeTickets(
  label: string,
  plan: { unused?: number; used?: number; revoked?: number },
): Promise<MadeTickets> {
  const code = `${TAG}${label}${nextSeq()}`;
  const type = await prisma.ticketType.create({
    data: { code, name: `${TAG}票种-${label}`, weightPercent: 0, enabled: false },
  });

  const rows: Array<{
    code: string;
    ticketTypeId: string;
    batchId: string;
    status: 'unused' | 'used' | 'revoked';
    usedAt: Date | null;
  }> = [];
  let usedCode: string | null = null;
  const push = (status: 'unused' | 'used' | 'revoked', index: number): void => {
    const ticketCode = `${code}-${status}${index}`;
    if (status === 'used' && !usedCode) usedCode = ticketCode;
    rows.push({
      code: ticketCode,
      ticketTypeId: type.id,
      batchId: '',
      status,
      usedAt: status === 'used' ? new Date() : null,
    });
  };
  for (let i = 1; i <= (plan.unused ?? 0); i += 1) push('unused', i);
  for (let i = 1; i <= (plan.used ?? 0); i += 1) push('used', i);
  for (let i = 1; i <= (plan.revoked ?? 0); i += 1) push('revoked', i);

  const batch = await prisma.ticketBatch.create({
    data: { ticketTypeId: type.id, count: rows.length, operator: TAG },
  });
  if (rows.length > 0) {
    await prisma.ticket.createMany({
      data: rows.map((row) => ({ ...row, batchId: batch.id })),
    });
  }

  return { id: type.id, code: type.code, usedCode };
}

interface StatusCounts {
  unused: number;
  used: number;
  revoked: number;
}

async function countsOf(ticketTypeId: string): Promise<StatusCounts> {
  const rows = await prisma.ticket.groupBy({
    by: ['status'],
    where: { ticketTypeId },
    _count: { _all: true },
  });
  const counts: StatusCounts = { unused: 0, used: 0, revoked: 0 };
  for (const row of rows) counts[row.status] = row._count._all;
  return counts;
}

/** 只清理本文件的票与批次；账号与角色活到 afterAll。 */
async function clearTicketFixtures(): Promise<void> {
  const types = await prisma.ticketType.findMany({
    where: { code: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = types.map((row) => row.id);
  await prisma.ticket.deleteMany({ where: { ticketTypeId: { in: ids } } });
  await prisma.ticketBatch.deleteMany({ where: { ticketTypeId: { in: ids } } });
  await prisma.ticketType.deleteMany({ where: { id: { in: ids } } });
}

async function login(username: string): Promise<ReturnType<typeof request.agent>> {
  const agent = request.agent(app);
  const res = await agent.post('/api/admin/login').send({ username, password: PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

describeDb('一键作废随机码', () => {
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

    await clearTicketFixtures();
    await cleanupRbac(TAG);

    const operatorRoleId = await createRole(`${TAG}role-operator`, '测试-可发码可作废', [
      'tickets.generate',
      'tickets.revoke',
    ]);
    const viewerRoleId = await createRole(`${TAG}role-viewer`, '测试-只读', []);
    await createAdmin(`${TAG}admin`, PASSWORD, operatorRoleId);
    await createAdmin(`${TAG}viewer`, PASSWORD, viewerRoleId);

    operatorAgent = await login(`${TAG}admin`);
    viewerAgent = await login(`${TAG}viewer`);
  });

  beforeEach(async () => {
    await clearTicketFixtures();
  });

  afterAll(async () => {
    await clearTicketFixtures();
    await cleanupRbac(TAG);
    await prisma.$disconnect();
  });

  it('未登录调用一键作废返回 401', async () => {
    const res = await request(app).post('/api/admin/tickets/revoke-bulk').send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('只作废未使用的码：已核销的码原样不动', async () => {
    const type = await makeTickets('仅未使用', { unused: 2, used: 1 });

    const res = await operatorAgent
      .post('/api/admin/tickets/revoke-bulk')
      .send({ ticketTypeId: type.id });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: 2 });

    expect(await countsOf(type.id)).toEqual({ unused: 0, used: 1, revoked: 2 });

    // 已核销的那张码状态与核销时间都不能被改写
    const used = await prisma.ticket.findUnique({ where: { code: type.usedCode ?? '' } });
    expect(used?.status).toBe('used');
    expect(used?.usedAt).not.toBeNull();
  });

  it('已作废的码不重复计数', async () => {
    const type = await makeTickets('含已作废', { unused: 1, revoked: 1 });

    const res = await operatorAgent
      .post('/api/admin/tickets/revoke-bulk')
      .send({ ticketTypeId: type.id });
    expect(res.body).toEqual({ revoked: 1 });
    expect(await countsOf(type.id)).toEqual({ unused: 0, used: 0, revoked: 2 });
  });

  it('按票种作废：A 票种的作废不影响 B 票种', async () => {
    const typeA = await makeTickets('票种A', { unused: 2 });
    const typeB = await makeTickets('票种B', { unused: 2, used: 1 });

    const res = await operatorAgent
      .post('/api/admin/tickets/revoke-bulk')
      .send({ ticketTypeId: typeA.id });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: 2 });

    expect(await countsOf(typeA.id)).toEqual({ unused: 0, used: 0, revoked: 2 });
    expect(await countsOf(typeB.id)).toEqual({ unused: 2, used: 1, revoked: 0 });
  });

  it('返回值等于实际作废数，重复调用第二次为 0', async () => {
    const type = await makeTickets('重复调用', { unused: 3 });

    const first = await operatorAgent
      .post('/api/admin/tickets/revoke-bulk')
      .send({ ticketTypeId: type.id });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ revoked: 3 });

    const second = await operatorAgent
      .post('/api/admin/tickets/revoke-bulk')
      .send({ ticketTypeId: type.id });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ revoked: 0 });

    expect(await countsOf(type.id)).toEqual({ unused: 0, used: 0, revoked: 3 });
  });

  it('写 AuditLog：动作、操作者、范围与作废数量', async () => {
    const typeA = await makeTickets('审计A', { unused: 1 });
    const typeB = await makeTickets('审计B', { unused: 2 });

    await operatorAgent
      .post('/api/admin/tickets/revoke-bulk')
      .send({ ticketTypeId: typeA.id });
    await operatorAgent
      .post('/api/admin/tickets/revoke-bulk')
      .send({ ticketTypeId: typeB.id });

    const audits = await prisma.auditLog.findMany({ where: { action: REVOKE_ACTION } });
    const details = audits.map((row) => row.detail);

    expect(details).toContainEqual({
      scope: 'ticketType',
      ticketTypeId: typeA.id,
      count: 1,
      operator: `${TAG}admin`,
    });
    expect(details).toContainEqual({
      scope: 'ticketType',
      ticketTypeId: typeB.id,
      count: 2,
      operator: `${TAG}admin`,
    });
    // 审计里绝不能出现随机码明文
    expect(JSON.stringify(details)).not.toContain(`${TAG}审计B`);
  });

  it('不传 ticketTypeId 即全部票种：库内所有未使用码一起作废', async () => {
    const typeA = await makeTickets('全部A', { unused: 1 });
    const typeB = await makeTickets('全部B', { unused: 2 });

    // 全局范围会连带作废同库其他测试文件的夹具（它们可能正处在自己的用例中间）。
    // 与 admin.test.ts「改完设置再复原」同一做法：先记下不属于本文件的未使用码，用完立刻放回。
    const foreign = await prisma.ticket.findMany({
      where: { status: 'unused', ticketTypeId: { notIn: [typeA.id, typeB.id] } },
      select: { id: true },
    });

    try {
      const res = await operatorAgent.post('/api/admin/tickets/revoke-bulk').send({});
      expect(res.status).toBe(200);
      // 本文件之外若恰有未使用码，也会被这条全局语句一并作废，因此只做下界断言
      expect(res.body.revoked).toBeGreaterThanOrEqual(3);

      expect(await countsOf(typeA.id)).toEqual({ unused: 0, used: 0, revoked: 1 });
      expect(await countsOf(typeB.id)).toEqual({ unused: 0, used: 0, revoked: 2 });

      const audits = await prisma.auditLog.findMany({ where: { action: REVOKE_ACTION } });
      expect(audits.map((row) => row.detail)).toContainEqual({
        scope: 'all',
        ticketTypeId: null,
        count: res.body.revoked,
        operator: `${TAG}admin`,
      });
    } finally {
      if (foreign.length > 0) {
        await prisma.ticket.updateMany({
          where: { id: { in: foreign.map((row) => row.id) } },
          data: { status: 'unused' },
        });
      }
    }
  });

  it('无 tickets.revoke 权限：403 PERMISSION_DENIED 且一张码都没被作废', async () => {
    const type = await makeTickets('无权限', { unused: 2, used: 1 });
    const auditsBefore = await prisma.auditLog.count({ where: { action: REVOKE_ACTION } });

    const res = await viewerAgent
      .post('/api/admin/tickets/revoke-bulk')
      .send({ ticketTypeId: type.id });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
    // 权限校验在写库之前：码的状态与审计都不能有任何变化
    expect(await countsOf(type.id)).toEqual({ unused: 2, used: 1, revoked: 0 });
    expect(await prisma.auditLog.count({ where: { action: REVOKE_ACTION } })).toBe(auditsBefore);
  });

  it('既有发码与单张作废端点同样受权限保护', async () => {
    const type = await makeTickets('端点门控', { unused: 1 });
    const enabled = await prisma.ticketType.create({
      data: {
        code: `${TAG}启用票种${nextSeq()}`,
        name: `${TAG}票种-可发码`,
        weightPercent: 0,
        enabled: true,
      },
    });
    const [ticket] = await prisma.ticket.findMany({ where: { ticketTypeId: type.id } });
    if (!ticket) throw new Error('夹具缺少未使用的码');

    const viewerGenerate = await viewerAgent
      .post('/api/admin/tickets/generate')
      .send({ ticketTypeId: enabled.id, count: 1 });
    expect(viewerGenerate.status).toBe(403);
    expect(viewerGenerate.body.error.code).toBe('PERMISSION_DENIED');

    const viewerRevoke = await viewerAgent.post(`/api/admin/tickets/${ticket.id}/revoke`);
    expect(viewerRevoke.status).toBe(403);
    expect(viewerRevoke.body.error.code).toBe('PERMISSION_DENIED');
    expect(await countsOf(type.id)).toEqual({ unused: 1, used: 0, revoked: 0 });

    // 有权限的账号走同一条路径必须能通过（否则上面的 403 可能只是端点坏了）
    const generated = await operatorAgent
      .post('/api/admin/tickets/generate')
      .send({ ticketTypeId: enabled.id, count: 2 });
    expect(generated.status).toBe(200);
    expect((generated.body.codes as string[]).length).toBe(2);

    const revoked = await operatorAgent.post(`/api/admin/tickets/${ticket.id}/revoke`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe('revoked');
  });

  it('ticketTypeId 类型非法返回 400，不存在的票种按 0 处理', async () => {
    const invalid = await operatorAgent
      .post('/api/admin/tickets/revoke-bulk')
      .send({ ticketTypeId: 123 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_FAILED');

    const missing = await operatorAgent
      .post('/api/admin/tickets/revoke-bulk')
      .send({ ticketTypeId: 'not-exist-ticket-type' });
    expect(missing.status).toBe(200);
    expect(missing.body).toEqual({ revoked: 0 });
  });
});