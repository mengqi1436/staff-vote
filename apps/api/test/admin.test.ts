/**
 * 管理端接口测试（vitest + supertest）。
 *
 * 目标库：`TEST_DATABASE_URL` 指向的测试库。三个接口测试文件共用这一个库，
 * 因此 vitest 配置里关闭了文件级并行（`fileParallelism: false`）——
 * 共用库 + 并行执行 = 互相清数据，症状是「单独跑都过、一起跑就挂」。
 * 未设置 TEST_DATABASE_URL 时整组跳过并打印提示，绝不退回去连开发库。
 *
 * 数据隔离方式：本文件的所有夹具都带 `AT` 前缀，`beforeEach` 只清理自己前缀的数据，
 * 不做全表清空。因此即使被指向与别的测试文件相同的库，也不会清掉别人的夹具。
 * 票种权重是全局约束，相关用例先读取当前启用合计再构造场景，两种库上都能跑。
 *
 * 覆盖：鉴权、登录/登出、票种权重合计、发码/作废/批次、导出 xlsx、部门/被评列/职工/项点
 * CRUD 与软删除、部门问卷表头配置、名单导入、设置、统计口径、结果计分与多 sheet 导出。
 */
import 'dotenv/config';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? '';
/** 没给测试库就跳过整组用例，而不是退回去连开发库。 */
const suiteEnabled = Boolean(testDatabaseUrl);

if (!suiteEnabled) {
  console.warn(
    '[admin.test] 未设置 TEST_DATABASE_URL，跳过管理端接口测试。\n' +
      "  运行方式：$env:NODE_ENV='test'; $env:TEST_DATABASE_URL='<测试库连接串>'; " +
      'pnpm --filter @staff-vote/api test',
  );
}

// 必须在导入 src 之前改写：src/env.ts 在模块求值时读 process.env，
// src/db.ts 的 prisma 单例随即按 NODE_ENV/TEST_DATABASE_URL 决定连接串。
// 静态 import 会被提升，所以下面用动态 import —— 顺序就是保证。
process.env.NODE_ENV = 'test';
if (suiteEnabled) process.env.TEST_DATABASE_URL = testDatabaseUrl;

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { CODE_ALPHABET, CODE_LENGTH } = await import('../src/lib/code.js');
const { hashPassword } = await import('../src/lib/password.js');
const { ADMIN_COOKIE } = await import('../src/middleware/adminAuth.js');
const { ALL_PERMISSION_CODES } = await import('../src/lib/permissions.js');
// 投票端打分表只认令牌签名（不查票据），因此软删除用例可以就地签发一张令牌验证列已消失
const { signVoteToken } = await import('../src/lib/token.js');
const { createRole } = await import('./rbac-fixtures.js');

/** 没有可用测试库就整组跳过。 */
const describeDb = suiteEnabled ? describe : describe.skip;

/** 夹具前缀：清理与断言都靠它把自己的数据与别的测试文件区分开。 */
const TAG = 'AT';
const ADMIN_USERNAME = `${TAG}admin`;
const ADMIN_PASSWORD = 'Test-Passw0rd!2026';

const app = createApp();
let agent: ReturnType<typeof request.agent>;
let passwordHash = '';
/** beforeAll 里创建的管理员行；令牌的 sub 必须始终指向它。 */
let adminId = '';
let sequence = 0;

const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

function nextCode(): string {
  sequence += 1;
  return `${TAG}${sequence}`;
}

// -----------------------------------------------------------------------------
// 夹具
// -----------------------------------------------------------------------------

/**
 * 只清理本文件创建的夹具（按前缀），保证与同库的其他测试文件并存时不误删。
 * 顺序遵守外键依赖：引用者在前。
 */
async function clearOwnFixtures(): Promise<void> {
  const departments = await prisma.department.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const departmentIds = departments.map((row) => row.id);
  const ticketTypes = await prisma.ticketType.findMany({
    where: { code: { startsWith: TAG } },
    select: { id: true },
  });
  const ticketTypeIds = ticketTypes.map((row) => row.id);

  const sheets = await prisma.scoreSheet.findMany({
    where: { departmentId: { in: departmentIds } },
    select: { id: true },
  });
  await prisma.scoreItem.deleteMany({ where: { sheetId: { in: sheets.map((row) => row.id) } } });
  await prisma.scoreSheet.deleteMany({ where: { departmentId: { in: departmentIds } } });
  await prisma.ticket.deleteMany({ where: { ticketTypeId: { in: ticketTypeIds } } });
  await prisma.ticketBatch.deleteMany({ where: { ticketTypeId: { in: ticketTypeIds } } });
  await prisma.employee.deleteMany({ where: { departmentId: { in: departmentIds } } });
  await prisma.criterion.deleteMany({ where: { departmentId: { in: departmentIds } } });
  // 被评列必须排在 scoreItem 之后：score_items 对 vote_columns 是 RESTRICT 外键
  await prisma.voteColumn.deleteMany({ where: { departmentId: { in: departmentIds } } });
  await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
  await prisma.ticketType.deleteMany({ where: { id: { in: ticketTypeIds } } });
}

/**
 * 清理本文件的管理员与角色夹具。
 *
 * 只在 beforeAll 调一次，**不能**放进 beforeEach：
 * adminAuth 现在每次请求都按令牌里的 id 查库，若每个用例前删号重建，
 * 账号 id 变了而 Cookie 里的令牌没变，后续请求会立刻 401
 * （权限改造后这套用例集体变红的根因）。
 */
async function clearOwnAdmin(): Promise<void> {
  await prisma.adminUser.deleteMany({ where: { username: { startsWith: TAG } } });
  await prisma.adminRole.deleteMany({ where: { code: { startsWith: TAG } } });
}

/** 直接写库造票种（夹具用，绕开接口的权重校验；校验本身另有专门用例）。 */
async function newTicketType(
  weightPercent = 100,
  enabled = true,
): Promise<{ id: string; code: string }> {
  const code = nextCode();
  const created = await prisma.ticketType.create({
    data: { code, name: `${TAG}票种-${code}`, weightPercent, enabled },
  });
  return { id: created.id, code: created.code };
}

async function enabledWeightSum(): Promise<number> {
  const res = await agent.get('/api/admin/ticket-types');
  expect(res.status).toBe(200);
  return (res.body as Array<{ weightPercent: number; enabled: boolean }>)
    .filter((row) => row.enabled)
    .reduce((sum, row) => sum + row.weightPercent, 0);
}

async function createDepartment(name: string): Promise<{ id: string; name: string }> {
  const res = await agent.post('/api/admin/departments').send({ name });
  expect(res.status).toBe(200);
  return res.body as { id: string; name: string };
}

async function createEmployee(departmentId: string, name: string, employeeNo?: string) {
  const res = await agent
    .post('/api/admin/employees')
    .send({ departmentId, name, employeeNo: employeeNo ?? null });
  expect(res.status).toBe(200);
  return res.body as { id: string; name: string; employeeNo: string | null };
}

async function createCriterion(
  departmentId: string,
  name: string,
  minScore: number,
  maxScore: number,
) {
  const res = await agent
    .post('/api/admin/criteria')
    .send({ departmentId, name, minScore, maxScore });
  expect(res.status).toBe(200);
  return res.body as { id: string; name: string };
}

/** 被评列即打分表的列（个人问卷下是各职务），与职工名单无关。 */
async function createVoteColumn(
  departmentId: string,
  name: string,
  sortOrder?: number,
): Promise<{ id: string; name: string }> {
  const res = await agent
    .post('/api/admin/vote-columns')
    .send({ departmentId, name, sortOrder });
  expect(res.status).toBe(200);
  return res.body as { id: string; name: string };
}

/** 直接写库造一张已提交的打分表：投票端点由另一位 teammate 实现，测试不依赖它。 */
async function submitSheet(
  departmentId: string,
  ticketTypeId: string,
  items: Array<{ voteColumnId: string; criterionId: string; score: number }>,
): Promise<string> {
  const sheet = await prisma.scoreSheet.create({ data: { departmentId, ticketTypeId } });
  await prisma.scoreItem.createMany({ data: items.map((item) => ({ ...item, sheetId: sheet.id })) });
  return sheet.id;
}

/** 「两被评列 × 两项点 + 一个票种有分」的部门，供结果与导出用例复用。 */
async function setupScoredDepartment(): Promise<{
  deptId: string;
  first: { id: string; name: string };
  second: { id: string; name: string };
  criterionA: { id: string; name: string };
  criterionB: { id: string; name: string };
}> {
  const department = await createDepartment(`${TAG}部门-结果`);
  const criterionA = await createCriterion(department.id, '德', 0, 100);
  const criterionB = await createCriterion(department.id, '能', 0, 50);
  const first = await createVoteColumn(department.id, '主任', 0);
  const second = await createVoteColumn(department.id, '党支部书记', 1);
  const ticketType = await newTicketType(100);

  await submitSheet(department.id, ticketType.id, [
    { voteColumnId: first.id, criterionId: criterionA.id, score: 90 },
    { voteColumnId: first.id, criterionId: criterionB.id, score: 45 },
    { voteColumnId: second.id, criterionId: criterionA.id, score: 60 },
    { voteColumnId: second.id, criterionId: criterionB.id, score: 30 },
  ]);

  return { deptId: department.id, first, second, criterionA, criterionB };
}

/** supertest 默认按 content-type 解析响应体；xlsx 需要自己收成一整块 Buffer。 */
async function getWorkbook(url: string): Promise<ExcelJS.Workbook> {
  const res = await agent
    .get(url)
    .buffer(true)
    .parse((response, callback) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    });

  expect(res.status).toBe(200);
  expect(String(res.headers['content-type'])).toContain('spreadsheetml.sheet');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(res.body as ArrayBuffer);
  return workbook;
}

function cellToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function readAllRows(sheet: ExcelJS.Worksheet): string[][] {
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as unknown[];
    const cells: string[] = [];
    for (let i = 1; i < values.length; i += 1) cells.push(cellToText(values[i]));
    rows.push(cells);
  });
  return rows;
}

/** 从工作表中定位表头行（首列为给定列名），返回表头与其后的数据行。 */
function readTable(
  sheet: ExcelJS.Worksheet | undefined,
  firstHeader: string,
): { header: string[]; rows: string[][] } {
  if (!sheet) throw new Error('导出件缺少工作表');
  const all = readAllRows(sheet);
  const index = all.findIndex((cells) => cells[0] === firstHeader);
  if (index === -1) throw new Error(`工作表 ${sheet.name} 缺少表头「${firstHeader}」`);
  return {
    header: all[index] ?? [],
    rows: all.slice(index + 1).filter((cells) => cells.some((cell) => cell !== '')),
  };
}

// -----------------------------------------------------------------------------

describeDb('管理端接口', () => {
  beforeAll(async () => {
    const rows =
      await prisma.$queryRaw<Array<{ currentDatabase: string }>>`SELECT current_database() AS "currentDatabase"`;
    const connected = rows[0]?.currentDatabase ?? '';
    const expected = new URL(testDatabaseUrl).pathname.replace(/^\//, '');

    // 连接串与 db.ts 的选库逻辑只要有一处不对，就可能把数据写进开发库，直接失败最省事。
    if (connected !== expected) {
      throw new Error(
        `测试实际连到 ${connected}，而 TEST_DATABASE_URL 指向的是 ${expected}；` +
          '请确认 NODE_ENV=test 且 TEST_DATABASE_URL 指向测试库后重跑。',
      );
    }

    passwordHash = await hashPassword(ADMIN_PASSWORD);
    agent = request.agent(app);

    await clearOwnFixtures();
    await clearOwnAdmin();
    // 账号必须带角色：本轮起管理端写接口都要求权限码，无角色账号等价只读
    const roleId = await createRole(`${TAG}role-super`, '测试-超级管理员', ALL_PERMISSION_CODES);
    const admin = await prisma.adminUser.create({
      data: { username: ADMIN_USERNAME, passwordHash, roleId },
    });
    adminId = admin.id;

    const login = await agent
      .post('/api/admin/login')
      .send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
    expect(login.status).toBe(200);
  });

  beforeEach(async () => {
    // 只清业务夹具：管理员与角色在 beforeAll 建一次并复用（理由见 clearOwnAdmin）
    await clearOwnFixtures();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // 鉴权
  // ---------------------------------------------------------------------------

  it('未登录访问管理端点一律 401', async () => {
    const anonymous = request.agent(app);
    const responses = await Promise.all([
      anonymous.get('/api/admin/ticket-types'),
      anonymous.post('/api/admin/ticket-types').send({ code: 'X', name: 'X', weightPercent: 0 }),
      anonymous.get('/api/admin/tickets'),
      anonymous.post('/api/admin/tickets/generate').send({ ticketTypeId: 'x', count: 1 }),
      anonymous.get('/api/admin/tickets/export'),
      anonymous.post('/api/admin/tickets/whatever/revoke'),
      anonymous.get('/api/admin/ticket-batches'),
      anonymous.get('/api/admin/departments'),
      anonymous.get('/api/admin/employees'),
      anonymous.post('/api/admin/employees/import'),
      anonymous.get('/api/admin/criteria'),
      anonymous.get('/api/admin/vote-columns'),
      anonymous.post('/api/admin/vote-columns').send({ departmentId: 'x', name: '主任' }),
      anonymous.get('/api/admin/settings'),
      anonymous.put('/api/admin/settings').send({}),
      anonymous.get('/api/admin/me'),
      anonymous.post('/api/admin/logout'),
      anonymous.get('/api/admin/stats/overview'),
      anonymous.get('/api/admin/results?departmentId=x'),
      anonymous.get('/api/admin/results/export.xlsx?departmentId=x'),
    ]);

    expect(responses).toHaveLength(20);
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('UNAUTHORIZED');
    }
  });

  it('伪造的会话 Cookie 被拒', async () => {
    const res = await request(app)
      .get('/api/admin/me')
      .set('Cookie', `${ADMIN_COOKIE}=forged-token`);
    expect(res.status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // 登录 / 登出
  // ---------------------------------------------------------------------------

  it('登录成功下发 httpOnly Cookie 并返回身份', async () => {
    const client = request.agent(app);
    const res = await client
      .post('/api/admin/login')
      .send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: adminId, username: ADMIN_USERNAME });

    const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
    const session = cookies.find((cookie) => cookie.startsWith(`${ADMIN_COOKIE}=`));
    expect(session).toBeDefined();
    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Lax');

    const me = await client.get('/api/admin/me');
    expect(me.status).toBe(200);
    // /me 除身份外还返回角色与权限码：前端靠它决定按钮显隐，后端靠它做权限校验
    expect(me.body.id).toBe(adminId);
    expect(me.body.username).toBe(ADMIN_USERNAME);
    expect(me.body.roleName).toBe('测试-超级管理员');
    expect(me.body.permissions).toEqual(
      expect.arrayContaining(['departments.write', 'tickets.revoke', 'admins.manage']),
    );
  });

  it('口令错误与用户名不存在返回同一文案', async () => {
    const wrongPassword = await request(app)
      .post('/api/admin/login')
      .send({ username: ADMIN_USERNAME, password: 'not-the-password' });
    const unknownUser = await request(app)
      .post('/api/admin/login')
      .send({ username: 'no-such-admin', password: 'not-the-password' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(wrongPassword.body.error.code).toBe(unknownUser.body.error.code);
    expect(wrongPassword.body.error.message).toBe(unknownUser.body.error.message);
  });

  it('登录参数缺失返回 400', async () => {
    const res = await request(app).post('/api/admin/login').send({ username: ADMIN_USERNAME });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('登出后会话失效', async () => {
    const client = request.agent(app);
    const login = await client
      .post('/api/admin/login')
      .send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
    expect(login.status).toBe(200);

    const logout = await client.post('/api/admin/logout');
    expect(logout.status).toBe(204);
    const cleared = ((logout.headers['set-cookie'] ?? []) as unknown as string[]).find((cookie) =>
      cookie.startsWith(`${ADMIN_COOKIE}=`),
    );
    expect(cleared).toBeDefined();

    expect((await client.get('/api/admin/me')).status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // 票种与权重
  // ---------------------------------------------------------------------------

  it('GET /ticket-types 返回票种与发放/使用计数', async () => {
    const ticketType = await newTicketType(100);
    const generated = await agent
      .post('/api/admin/tickets/generate')
      .send({ ticketTypeId: ticketType.id, count: 3 });
    expect(generated.status).toBe(200);
    const codes = generated.body.codes as string[];

    await prisma.ticket.update({
      where: { code: codes[0] as string },
      data: { status: 'used', usedAt: new Date() },
    });
    const [revokeTarget] = await prisma.ticket.findMany({
      where: { code: codes[1] as string },
      select: { id: true },
    });
    expect((await agent.post(`/api/admin/tickets/${revokeTarget?.id}/revoke`)).status).toBe(200);

    const res = await agent.get('/api/admin/ticket-types');
    expect(res.status).toBe(200);
    const row = (res.body as Array<{ id: string }>).find((item) => item.id === ticketType.id);
    expect(row).toMatchObject({
      code: ticketType.code,
      weightPercent: 100,
      enabled: true,
      issuedCount: 3,
      usedCount: 1,
      unusedCount: 1,
    });
  });

  it('权重合计校验：新建与升权不得超过 100，降权可作过渡步骤', async () => {
    // 权重合计是全局约束，先看当前环境（空库为 0；与别的测试文件同库时可能已是 100）
    const sum = await enabledWeightSum();
    expect(sum).toBeLessThanOrEqual(100);

    // 1) 新建票种允许逐步搭建，但不得超过 100
    const headroom = 100 - sum;
    const fillerWeight = headroom >= 2 ? headroom - 2 : 0;
    const created = await agent
      .post('/api/admin/ticket-types')
      .send({ code: nextCode(), name: `${TAG}票种-新建`, weightPercent: fillerWeight });
    expect(created.status).toBe(200);
    expect(created.body.weightPercent).toBe(fillerWeight);
    const total = sum + fillerWeight;
    expect(await enabledWeightSum()).toBe(total);

    // 2) 再新建一个会越过 100 的票种 → 409 且提示差额
    const over = await agent
      .post('/api/admin/ticket-types')
      .send({ code: nextCode(), name: `${TAG}票种-超限`, weightPercent: 100 - total + 1 });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('WEIGHT_SUM_INVALID');
    expect(over.body.error.message).toContain('101%');
    expect(over.body.error.message).toContain('差额');

    // 3) 升权补到 100：允许（写入后合计恰好 100）
    const fillWeight = fillerWeight + (100 - total);
    const fill = await agent
      .patch(`/api/admin/ticket-types/${created.body.id}`)
      .send({ weightPercent: fillWeight });
    expect(fill.status).toBe(200);
    expect(await enabledWeightSum()).toBe(100);

    // 4) 继续升权 1 点越过 100 → 409；降权是重新分配权重的过渡步骤 → 允许；再补齐回 100 → 允许
    //    （票种权重已是 0 时没有下降空间，跳过这一段）
    if (fillWeight > 0 && fillWeight < 100) {
      const raised = await agent
        .patch(`/api/admin/ticket-types/${created.body.id}`)
        .send({ weightPercent: fillWeight + 1 });
      expect(raised.status).toBe(409);
      expect(raised.body.error.message).toContain('差额');

      const lowered = await agent
        .patch(`/api/admin/ticket-types/${created.body.id}`)
        .send({ weightPercent: fillWeight - 1 });
      expect(lowered.status).toBe(200);
      expect(await enabledWeightSum()).toBe(100 - fillWeight + (fillWeight - 1));

      const back = await agent
        .patch(`/api/admin/ticket-types/${created.body.id}`)
        .send({ weightPercent: fillWeight });
      expect(back.status).toBe(200);
      expect(await enabledWeightSum()).toBe(100);
    }

    // 5) 停用的票种不计入合计，可以随便建
    const disabled = await agent
      .post('/api/admin/ticket-types')
      .send({ code: nextCode(), name: `${TAG}票种-停用`, weightPercent: 10, enabled: false });
    expect(disabled.status).toBe(200);
    expect(disabled.body.enabled).toBe(false);
    expect(await enabledWeightSum()).toBe(100);

    // 6) 只改名称不触发权重校验
    const renamed = await agent
      .patch(`/api/admin/ticket-types/${created.body.id}`)
      .send({ name: `${TAG}票种-改名` });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe(`${TAG}票种-改名`);

    expect(
      (await agent.patch('/api/admin/ticket-types/not-exist').send({ weightPercent: 0 })).status,
    ).toBe(404);
  });

  it('权重重分配：多步升权的中间步（合计 ≤100）不被拒绝', async () => {
    // 计分按实际权重合计归一化（lib/scoring.ts），合计 ≠100 本就是合法中间状态：
    // 降权方向从来允许停在 90。「先降腾空间、再分多步补齐」是重新分配权重的唯一通路，
    // 若中间步被拒，任何含两个以上升权项的重分配都无法完成 ——
    // 只有最后一步恰好落在 100，之前的升权步全部会被卡死。
    const sum = await enabledWeightSum();
    const headroom = 100 - sum;
    if (headroom < 21) {
      // 与其他测试文件同库时可能没有余量，无法构造 TAG 降权方；如实跳过（同上一个用例的条件跳过）
      console.warn(`[admin.test] 当前库余量仅 ${headroom}%，跳过多步升权场景`);
      return;
    }

    const a = await newTicketType(0);
    const b = await newTicketType(0);

    // 两步升权：a 0→15（合计 sum+15 < 100），b 0→5（合计 sum+20 ≤ 99）
    const raiseA = await agent
      .patch(`/api/admin/ticket-types/${a.id}`)
      .send({ weightPercent: 15 });
    expect(raiseA.status).toBe(200);

    const raiseB = await agent
      .patch(`/api/admin/ticket-types/${b.id}`)
      .send({ weightPercent: 5 });
    expect(raiseB.status).toBe(200);
    expect(await enabledWeightSum()).toBe(sum + 20);

    // 越过 100 仍然拒绝：a 再加 headroom-19 → 合计恰好 101
    const over = await agent
      .patch(`/api/admin/ticket-types/${a.id}`)
      .send({ weightPercent: 15 + (headroom - 20) + 1 });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('WEIGHT_SUM_INVALID');
    expect(over.body.error.message).toContain('101%');
  });

  it('新建票种编码重复返回 409', async () => {
    const code = nextCode();
    const first = await agent
      .post('/api/admin/ticket-types')
      .send({ code, name: `${TAG}票种-A`, weightPercent: 0 });
    expect(first.status).toBe(200);

    const duplicate = await agent
      .post('/api/admin/ticket-types')
      .send({ code, name: `${TAG}票种-B`, weightPercent: 0 });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('TICKET_TYPE_EXISTS');
  });

  it('删除票种是软删除，停用后仍可查询', async () => {
    const ticketType = await newTicketType(0);
    expect((await agent.delete(`/api/admin/ticket-types/${ticketType.id}`)).status).toBe(204);

    const list = await agent.get('/api/admin/ticket-types');
    const row = (list.body as Array<{ id: string }>).find((item) => item.id === ticketType.id);
    expect(row).toMatchObject({ enabled: false });
    expect(await prisma.ticketType.count({ where: { id: ticketType.id } })).toBe(1);

    expect((await agent.delete('/api/admin/ticket-types/not-exist')).status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // 发码 / 作废 / 批次
  // ---------------------------------------------------------------------------

  it('发码创建批次与未使用随机码并写审计日志', async () => {
    const ticketType = await newTicketType(100);
    const res = await agent
      .post('/api/admin/tickets/generate')
      .send({ ticketTypeId: ticketType.id, count: 5 });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(5);
    const codes = res.body.codes as string[];
    expect(codes).toHaveLength(5);
    expect(new Set(codes).size).toBe(5);
    for (const code of codes) expect(code).toMatch(CODE_PATTERN);

    const batch = await prisma.ticketBatch.findUnique({ where: { id: res.body.batchId as string } });
    expect(batch?.count).toBe(5);
    expect(batch?.operator).toBe(ADMIN_USERNAME);
    expect(batch?.ticketTypeId).toBe(ticketType.id);
    expect(await prisma.ticket.count({ where: { batchId: batch?.id } })).toBe(5);
    expect(await prisma.auditLog.count({ where: { action: 'ticket.generate' } })).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('非法发码参数被拒：数量越界、票种不存在、票种停用', async () => {
    const ticketType = await newTicketType(100);

    const tooFew = await agent
      .post('/api/admin/tickets/generate')
      .send({ ticketTypeId: ticketType.id, count: 0 });
    expect(tooFew.status).toBe(400);

    const tooMany = await agent
      .post('/api/admin/tickets/generate')
      .send({ ticketTypeId: ticketType.id, count: 2001 });
    expect(tooMany.status).toBe(400);

    const missing = await agent
      .post('/api/admin/tickets/generate')
      .send({ ticketTypeId: 'not-exist', count: 1 });
    expect(missing.status).toBe(404);

    await agent.delete(`/api/admin/ticket-types/${ticketType.id}`);
    const disabled = await agent
      .post('/api/admin/tickets/generate')
      .send({ ticketTypeId: ticketType.id, count: 1 });
    expect(disabled.status).toBe(409);
    expect(disabled.body.error.code).toBe('TICKET_TYPE_DISABLED');
  });

  it('随机码列表分页与按状态/票种过滤', async () => {
    const typeA = await newTicketType(100);
    const typeB = await newTicketType(0);
    await agent.post('/api/admin/tickets/generate').send({ ticketTypeId: typeA.id, count: 3 });
    await agent.post('/api/admin/tickets/generate').send({ ticketTypeId: typeB.id, count: 2 });

    const page = await agent.get('/api/admin/tickets?page=1&pageSize=2');
    expect(page.status).toBe(200);
    expect(page.body.page).toBe(1);
    expect(page.body.pageSize).toBe(2);
    expect(page.body.items).toHaveLength(2);
    expect(page.body.total).toBeGreaterThanOrEqual(5);

    const byType = await agent.get(`/api/admin/tickets?ticketTypeId=${typeA.id}&pageSize=100`);
    expect(byType.body.total).toBe(3);
    expect(
      byType.body.items.every(
        (item: { ticketType: { code: string } }) => item.ticketType.code === typeA.code,
      ),
    ).toBe(true);

    const first = byType.body.items[0] as { id: string };
    await prisma.ticket.update({
      where: { id: first.id },
      data: { status: 'used', usedAt: new Date() },
    });

    const used = await agent.get(`/api/admin/tickets?status=used&ticketTypeId=${typeA.id}`);
    expect(used.body.total).toBe(1);
    expect(used.body.items[0].usedAt).toBeTruthy();

    const invalid = await agent.get('/api/admin/tickets?status=unknown');
    expect(invalid.status).toBe(400);
  });

  it('作废仅限未使用的码，重复作废与作废已核销都是 409', async () => {
    const ticketType = await newTicketType(100);
    const generated = await agent
      .post('/api/admin/tickets/generate')
      .send({ ticketTypeId: ticketType.id, count: 2 });
    const tickets = await prisma.ticket.findMany({
      where: { batchId: generated.body.batchId as string },
      orderBy: { code: 'asc' },
    });
    const first = tickets[0];
    const second = tickets[1];
    if (!first || !second) throw new Error('发码数量不符合预期');

    const revoked = await agent.post(`/api/admin/tickets/${first.id}/revoke`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe('revoked');
    expect(revoked.body.ticketType.code).toBe(ticketType.code);
    expect(revoked.body.batchId).toBe(generated.body.batchId);

    const again = await agent.post(`/api/admin/tickets/${first.id}/revoke`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('TICKET_ALREADY_REVOKED');

    await prisma.ticket.update({
      where: { id: second.id },
      data: { status: 'used', usedAt: new Date() },
    });
    const usedRevoke = await agent.post(`/api/admin/tickets/${second.id}/revoke`);
    expect(usedRevoke.status).toBe(409);
    expect(usedRevoke.body.error.code).toBe('TICKET_ALREADY_USED');

    expect((await agent.post('/api/admin/tickets/not-exist/revoke')).status).toBe(404);
  });

  it('批次列表带票种与数量', async () => {
    const ticketType = await newTicketType(100);
    const generated = await agent
      .post('/api/admin/tickets/generate')
      .send({ ticketTypeId: ticketType.id, count: 4 });

    const res = await agent.get('/api/admin/ticket-batches');
    expect(res.status).toBe(200);
    const row = (res.body as Array<{ id: string }>).find((item) => item.id === generated.body.batchId);
    expect(row).toMatchObject({
      count: 4,
      operator: ADMIN_USERNAME,
      ticketType: { id: ticketType.id, code: ticketType.code },
    });
  });

  it('随机码导出 xlsx：列口径与行数符合预期', async () => {
    const typeA = await newTicketType(100);
    const typeB = await newTicketType(0);
    await agent.post('/api/admin/tickets/generate').send({ ticketTypeId: typeA.id, count: 3 });
    await agent.post('/api/admin/tickets/generate').send({ ticketTypeId: typeB.id, count: 2 });

    const workbook = await getWorkbook(`/api/admin/tickets/export?ticketTypeId=${typeA.id}`);
    const table = readTable(workbook.getWorksheet('随机码清单'), '随机码');
    expect(table.header).toEqual(['随机码', '票种', '状态', '核销时间', '批次', '创建时间']);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0]?.[1]).toContain(typeA.code);
    expect(table.rows[0]?.[2]).toBe('未使用');

    // 状态用中文：核销一张后导出件里的状态随之变化
    const [ticket] = await prisma.ticket.findMany({ where: { ticketTypeId: typeA.id }, take: 1 });
    await prisma.ticket.update({
      where: { id: ticket?.id },
      data: { status: 'used', usedAt: new Date() },
    });
    const afterUsed = await getWorkbook(
      `/api/admin/tickets/export?ticketTypeId=${typeA.id}&status=used`,
    );
    const usedRows = readTable(afterUsed.getWorksheet('随机码清单'), '随机码').rows;
    expect(usedRows).toHaveLength(1);
    expect(usedRows[0]?.[2]).toBe('已核销');
    expect(usedRows[0]?.[3]).not.toBe('');
  });

  // ---------------------------------------------------------------------------
  // 部门 / 职工 / 项点
  // ---------------------------------------------------------------------------

  it('部门 CRUD 与软删除', async () => {
    const created = await createDepartment(`${TAG}部门-生产`);
    const id = created.id;

    const duplicate = await agent.post('/api/admin/departments').send({ name: `${TAG}部门-生产` });
    expect(duplicate.status).toBe(409);

    const updated = await agent
      .patch(`/api/admin/departments/${id}`)
      .send({ name: `${TAG}部门-生产一部` });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe(`${TAG}部门-生产一部`);

    const list = await agent.get('/api/admin/departments');
    expect(
      (list.body as Array<{ id: string; name: string }>).some(
        (row) => row.id === id && row.name === `${TAG}部门-生产一部`,
      ),
    ).toBe(true);

    expect((await agent.delete(`/api/admin/departments/${id}`)).status).toBe(204);
    const after = await agent.get('/api/admin/departments');
    expect((after.body as Array<{ id: string }>).find((row) => row.id === id)).toMatchObject({
      enabled: false,
    });
    // 软删除：行还在，历史评分不会因为删除部门而消失
    expect(await prisma.department.count({ where: { id } })).toBe(1);

    expect((await agent.patch('/api/admin/departments/not-exist').send({ name: 'x' })).status).toBe(404);
    expect((await agent.delete('/api/admin/departments/not-exist')).status).toBe(404);
    expect((await agent.post('/api/admin/departments').send({ name: '' })).status).toBe(400);
  });

  it('部门可通过 PATCH 停用与恢复启用（前端启停开关的落点）', async () => {
    // 前端的启停开关调用的正是 PATCH { enabled }，这条路径必须真的写进数据库。
    // 风险点：service 的 update data 里漏掉 enabled 时，zod 与 typecheck 都不会报错，
    // 症状是「停用后再也开不回来」且没有任何提示 —— 用一次往返断言把它钉死。
    const created = await createDepartment(`${TAG}部门-启停`);
    const id = created.id;

    const disabled = await agent.patch(`/api/admin/departments/${id}`).send({ enabled: false });
    expect(disabled.status).toBe(200);
    expect(disabled.body.enabled).toBe(false);
    expect((await prisma.department.findUnique({ where: { id } }))?.enabled).toBe(false);

    const restored = await agent.patch(`/api/admin/departments/${id}`).send({ enabled: true });
    expect(restored.status).toBe(200);
    expect(restored.body.enabled).toBe(true);
    expect((await prisma.department.findUnique({ where: { id } }))?.enabled).toBe(true);

    // 只改 enabled 不应顺手改动其它字段
    expect(restored.body.name).toBe(`${TAG}部门-启停`);
  });

  it('部门 PATCH 保存问卷表头配置（类型/附件号/标题/填写说明）并能读回', async () => {
    const created = await createDepartment(`${TAG}部门-问卷`);
    const id = created.id;

    // 新建部门按参考表的默认抬头：个人问卷 + 附件1-1，标题与填写说明留空
    const initial = await agent.get('/api/admin/departments');
    expect((initial.body as Array<{ id: string }>).find((row) => row.id === id)).toMatchObject({
      questionnaireType: 'person',
      headerNote: '附件1-1',
      title: '',
      footerNote: '',
    });

    const title = `${TAG}车间负责人评价问卷`;
    const footerNote = '请如实填写，不填视为弃权。';
    const saved = await agent.patch(`/api/admin/departments/${id}`).send({
      questionnaireType: 'workshop',
      headerNote: '附件2-1',
      title,
      footerNote,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      questionnaireType: 'workshop',
      headerNote: '附件2-1',
      title,
      footerNote,
    });

    // 回读：问卷配置页刷新后不能退回默认值（GET 漏字段是本轮改动的典型症状）
    const reread = await agent.get('/api/admin/departments');
    expect((reread.body as Array<{ id: string }>).find((row) => row.id === id)).toMatchObject({
      questionnaireType: 'workshop',
      headerNote: '附件2-1',
      title,
      footerNote,
    });
    expect((await prisma.department.findUnique({ where: { id } }))?.questionnaireType).toBe('workshop');

    // 问卷类型只接受 person / workshop：路由层 zod 先拦下（service 里另有
    // QUESTIONNAIRE_TYPE_INVALID 分支，只有越过分区校验的调用才会走到），非法值不落库
    const invalid = await agent
      .patch(`/api/admin/departments/${id}`)
      .send({ questionnaireType: 'team' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_FAILED');
    expect((await prisma.department.findUnique({ where: { id } }))?.questionnaireType).toBe('workshop');
  });

  it('职工 CRUD：按部门过滤、工号唯一、改派与软删除', async () => {
    const department = await createDepartment(`${TAG}部门-职工`);
    const other = await createDepartment(`${TAG}部门-其他`);
    const employeeNo = `${TAG}E001`;

    const created = await createEmployee(department.id, '张三', employeeNo);
    expect(created).toMatchObject({ name: '张三', employeeNo, departmentId: department.id });

    const duplicate = await agent
      .post('/api/admin/employees')
      .send({ departmentId: other.id, name: '李四', employeeNo });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('EMPLOYEE_NO_EXISTS');

    await createEmployee(other.id, '王五');

    const filtered = await agent.get(`/api/admin/employees?departmentId=${department.id}`);
    expect(filtered.body).toHaveLength(1);
    expect(filtered.body[0].id).toBe(created.id);

    const moved = await agent
      .patch(`/api/admin/employees/${created.id}`)
      .send({ departmentId: other.id, name: '张三（调岗）' });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ departmentId: other.id, name: '张三（调岗）' });

    expect((await agent.delete(`/api/admin/employees/${created.id}`)).status).toBe(204);
    const after = await agent.get(`/api/admin/employees?departmentId=${other.id}`);
    expect((after.body as Array<{ id: string }>).find((row) => row.id === created.id)).toMatchObject({
      enabled: false,
    });
    expect(await prisma.employee.count({ where: { id: created.id } })).toBe(1);

    const unknownDepartment = await agent
      .post('/api/admin/employees')
      .send({ departmentId: 'not-exist', name: '赵六' });
    expect(unknownDepartment.status).toBe(400);
    expect((await agent.patch('/api/admin/employees/not-exist').send({ name: 'x' })).status).toBe(404);
  });

  it('项点必须为整数且 maxScore > minScore（创建与修改都校验）', async () => {
    const department = await createDepartment(`${TAG}部门-项点`);

    const equal = await agent
      .post('/api/admin/criteria')
      .send({ departmentId: department.id, name: '德', minScore: 80, maxScore: 80 });
    expect(equal.status).toBe(400);
    expect(equal.body.error.code).toBe('CRITERION_RANGE_INVALID');

    const inverted = await agent
      .post('/api/admin/criteria')
      .send({ departmentId: department.id, name: '能', minScore: 90, maxScore: 10 });
    expect(inverted.status).toBe(400);
    expect(inverted.body.error.code).toBe('CRITERION_RANGE_INVALID');

    const decimal = await agent
      .post('/api/admin/criteria')
      .send({ departmentId: department.id, name: '勤', minScore: 0, maxScore: 10.5 });
    expect(decimal.status).toBe(400);
    expect(decimal.body.error.code).toBe('VALIDATION_FAILED');

    const ok = await createCriterion(department.id, '绩', 0, 100);
    const patchInverted = await agent.patch(`/api/admin/criteria/${ok.id}`).send({ minScore: 120 });
    expect(patchInverted.status).toBe(400);
    expect(patchInverted.body.error.code).toBe('CRITERION_RANGE_INVALID');

    const patched = await agent.patch(`/api/admin/criteria/${ok.id}`).send({ maxScore: 50 });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ minScore: 0, maxScore: 50 });

    expect((await agent.delete(`/api/admin/criteria/${ok.id}`)).status).toBe(204);
    const list = await agent.get(`/api/admin/criteria?departmentId=${department.id}`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: ok.id, enabled: false });
    expect(await prisma.criterion.count({ where: { id: ok.id } })).toBe(1);

    expect((await agent.patch('/api/admin/criteria/not-exist').send({ minScore: 1 })).status).toBe(404);
    const unknownDepartment = await agent
      .post('/api/admin/criteria')
      .send({ departmentId: 'not-exist', name: 'x', minScore: 0, maxScore: 10 });
    expect(unknownDepartment.status).toBe(400);
  });

  it('被评列 CRUD：同名可重复、改名与软删除后从打分表消失', async () => {
    const department = await createDepartment(`${TAG}部门-被评列`);
    const other = await createDepartment(`${TAG}部门-被评列其他`);

    const createdRes = await agent
      .post('/api/admin/vote-columns')
      .send({ departmentId: department.id, name: '副主任', sortOrder: 0 });
    expect(createdRes.status).toBe(200);
    expect(createdRes.body).toMatchObject({
      departmentId: department.id,
      name: '副主任',
      sortOrder: 0,
      enabled: true,
    });
    const created = createdRes.body as { id: string };

    // 刻意不做重名校验：参考表的个人问卷里「副主任」原样出现两次（两个副主任岗位），
    // 后台必须能照抄那张表 —— 同名可以有第二行
    const twin = await createVoteColumn(department.id, '副主任', 1);
    expect(twin.id).not.toBe(created.id);

    // 跨部门同名同样允许
    const sameNameElsewhere = await createVoteColumn(other.id, '副主任');
    expect(sameNameElsewhere.id).not.toBe(created.id);

    // 改名成同部门已存在的名字也允许（同一列的两行必须仍能各自独立编辑）
    const renamed = await agent
      .patch(`/api/admin/vote-columns/${created.id}`)
      .send({ name: '党支部书记' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('党支部书记');

    const filtered = await agent.get(`/api/admin/vote-columns?departmentId=${department.id}`);
    expect(filtered.body).toHaveLength(2);
    expect((filtered.body as Array<{ name: string }>).map((row) => row.name)).toEqual([
      '党支部书记',
      '副主任',
    ]);
    // 两行是各自独立的记录：同名不代表同一行
    expect(new Set((filtered.body as Array<{ id: string }>).map((row) => row.id)).size).toBe(2);

    // 软删除：行还在（历史评分仍可读），但列出时 enabled=false
    expect((await agent.delete(`/api/admin/vote-columns/${twin.id}`)).status).toBe(204);
    const after = await agent.get(`/api/admin/vote-columns?departmentId=${department.id}`);
    expect((after.body as Array<{ id: string }>).find((row) => row.id === twin.id)).toMatchObject({
      enabled: false,
    });
    expect(await prisma.voteColumn.count({ where: { id: twin.id } })).toBe(1);

    // 打分表只取启用列：停用的被评列从投票端彻底消失，而不是留成空表头
    const sheet = await request(app)
      .get(`/api/vote/sheet?departmentId=${department.id}`)
      .set('Authorization', `Bearer ${signVoteToken('soft-delete-check', 'soft-delete-check')}`);
    expect(sheet.status).toBe(200);
    expect((sheet.body.voteColumns as Array<{ name: string }>).map((row) => row.name)).toEqual([
      '党支部书记',
    ]);

    expect((await agent.patch('/api/admin/vote-columns/not-exist').send({ name: 'x' })).status).toBe(
      404,
    );
    expect((await agent.delete('/api/admin/vote-columns/not-exist')).status).toBe(404);
    expect(
      (
        await agent
          .post('/api/admin/vote-columns')
          .send({ departmentId: 'not-exist', name: '副主任' })
      ).status,
    ).toBe(400);
    expect(
      (
        await agent
          .post('/api/admin/vote-columns')
          .send({ departmentId: department.id, name: '   ' })
      ).status,
    ).toBe(400);
  });

  it('软删除部门/被评列/项点后历史评分仍然可读', async () => {
    const department = await createDepartment(`${TAG}部门-软删`);
    const column = await createVoteColumn(department.id, '主任');
    const criterion = await createCriterion(department.id, '德', 0, 100);
    const ticketType = await newTicketType(100);
    await submitSheet(department.id, ticketType.id, [
      { voteColumnId: column.id, criterionId: criterion.id, score: 90 },
    ]);

    await agent.delete(`/api/admin/vote-columns/${column.id}`);
    await agent.delete(`/api/admin/criteria/${criterion.id}`);
    await agent.delete(`/api/admin/departments/${department.id}`);

    const res = await agent.get(`/api/admin/results?departmentId=${department.id}`);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({
      voteColumnName: '主任',
      comprehensiveScore: 90,
      enabled: false,
    });
    expect(res.body.criteria[0]).toMatchObject({ enabled: false });
  });

  // ---------------------------------------------------------------------------
  // 名单导入
  // ---------------------------------------------------------------------------

  it('CSV 导入按「部门 + 工号」upsert，重复导入只更新', async () => {
    const departmentA = `${TAG}部门-导入A`;
    const departmentB = `${TAG}部门-导入B`;
    const csv = [
      '部门,姓名,工号',
      `${departmentA},张三,${TAG}I001`,
      `${departmentA},李四,${TAG}I002`,
      `${departmentB},王五,`,
    ].join('\n');

    const first = await agent
      .post('/api/admin/employees/import')
      .attach('file', Buffer.from(csv, 'utf8'), 'roster.csv');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      total: 3,
      created: 3,
      updated: 0,
      skipped: 0,
      departmentsCreated: 2,
      errors: [],
    });
    expect(await prisma.employee.count({ where: { employeeNo: { startsWith: TAG } } })).toBe(2);

    const second = await agent
      .post('/api/admin/employees/import')
      .attach('file', Buffer.from(csv, 'utf8'), 'roster.csv');
    expect(second.body).toMatchObject({ created: 0, updated: 3, departmentsCreated: 0 });
    expect(await prisma.employee.count({ where: { employeeNo: { startsWith: TAG } } })).toBe(2);

    // 工号是唯一键：工号相同但部门变化时更新原行，不新建
    const moved = await agent
      .post('/api/admin/employees/import')
      .attach('file', Buffer.from(`部门,姓名,工号\n${departmentB},张三,${TAG}I001`, 'utf8'), 'move.csv');
    expect(moved.body).toMatchObject({ created: 0, updated: 1 });
    const departmentBRow = await prisma.department.findUniqueOrThrow({ where: { name: departmentB } });
    expect(await prisma.employee.count({ where: { departmentId: departmentBRow.id } })).toBe(2);
  });

  it('xlsx 导入并逐行报告脏数据', async () => {
    const department = `${TAG}部门-导入X`;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('名单');
    sheet.addRow(['部门', '姓名', '工号']);
    sheet.addRow([department, '赵六', `${TAG}I100`]);
    sheet.addRow(['', '无部门的人', '']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const res = await agent.post('/api/admin/employees/import').attach('file', buffer, 'roster.xlsx');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, created: 1, updated: 0 });
    expect(res.body.errors).toEqual([{ row: 3, message: '部门与姓名不能为空' }]);
    expect(await prisma.department.count({ where: { name: department } })).toBe(1);
  });

  it('导入的文件/字段不合法时返回 400', async () => {
    const noFile = await agent.post('/api/admin/employees/import').field('note', '没有文件');
    expect(noFile.status).toBe(400);

    const notMultipart = await agent.post('/api/admin/employees/import').send({ file: 'x' });
    expect(notMultipart.status).toBe(400);

    const empty = await agent
      .post('/api/admin/employees/import')
      .attach('file', Buffer.from('', 'utf8'), 'empty.csv');
    expect(empty.status).toBe(400);

    // 纯文本会被当作 CSV：解析出脏行并逐行报错，而不是整批失败
    const wrongFormat = await agent
      .post('/api/admin/employees/import')
      .attach('file', Buffer.from('not a spreadsheet at all', 'utf8'), 'notes.txt');
    expect(wrongFormat.status).toBe(200);
    expect(wrongFormat.body.errors).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // 设置
  // ---------------------------------------------------------------------------

  it('设置 GET 返回四个键，PUT 更新并留痕', async () => {
    const initial = await agent.get('/api/admin/settings');
    expect(initial.status).toBe(200);
    for (const key of ['vote.open', 'vote.startAt', 'vote.endAt', 'system.title']) {
      expect(typeof initial.body[key]).toBe('string');
    }

    const title = `${TAG}标题-${nextCode()}`;
    const updated = await agent.put('/api/admin/settings').send({ 'system.title': title });
    expect(updated.status).toBe(200);
    expect(updated.body['system.title']).toBe(title);

    const reread = await agent.get('/api/admin/settings');
    expect(reread.body['system.title']).toBe(title);
    expect(await prisma.auditLog.count({ where: { action: 'settings.update' } })).toBeGreaterThanOrEqual(
      1,
    );

    // 开关与起止时间：写完立即回读，随后复原，避免影响同库的其他用例
    const before = await agent.get('/api/admin/settings');
    try {
      const opened = await agent.put('/api/admin/settings').send({ 'vote.open': 'true' });
      expect(opened.body['vote.open']).toBe('true');
      expect((await agent.get('/api/admin/settings')).body['vote.open']).toBe('true');

      const cleared = await agent
        .put('/api/admin/settings')
        .send({ 'vote.startAt': '', 'vote.endAt': '' });
      expect(cleared.body).toMatchObject({ 'vote.startAt': '', 'vote.endAt': '' });
      expect((await agent.get('/api/admin/settings')).body['vote.endAt']).toBe('');
    } finally {
      await agent.put('/api/admin/settings').send({
        'vote.open': before.body['vote.open'],
        'vote.startAt': before.body['vote.startAt'],
        'vote.endAt': before.body['vote.endAt'],
      });
    }

    // 非法值一律 400，且不落库
    expect((await agent.put('/api/admin/settings').send({ 'vote.open': 'yes' })).status).toBe(400);
    expect((await agent.put('/api/admin/settings').send({ 'vote.startAt': '昨天' })).status).toBe(400);
    expect((await agent.put('/api/admin/settings').send({ 'system.title': '' })).status).toBe(400);

    const badOrder = await agent.put('/api/admin/settings').send({
      'vote.startAt': '2026-09-20T00:00:00+08:00',
      'vote.endAt': '2026-09-19T00:00:00+08:00',
    });
    expect(badOrder.status).toBe(400);
    expect(badOrder.body.error.code).toBe('VOTE_WINDOW_INVALID');
  });

  // ---------------------------------------------------------------------------
  // 统计
  // ---------------------------------------------------------------------------

  it('统计口径：票种计数、总量自洽、部门进度与投票窗口', async () => {
    const department = await createDepartment(`${TAG}部门-统计`);
    await createEmployee(department.id, '张三');
    const second = await createEmployee(department.id, '李四');
    const criterion = await createCriterion(department.id, '德', 0, 100);
    // 职工名单只影响 employeeCount；打分表的列是被评列
    const column = await createVoteColumn(department.id, '主任');
    const ticketType = await newTicketType(100);

    const generated = await agent
      .post('/api/admin/tickets/generate')
      .send({ ticketTypeId: ticketType.id, count: 4 });
    const tickets = await prisma.ticket.findMany({
      where: { batchId: generated.body.batchId as string },
      orderBy: { code: 'asc' },
    });
    const usedTicket = tickets[0];
    const revokedTicket = tickets[1];
    if (!usedTicket || !revokedTicket) throw new Error('发码数量不符合预期');

    await prisma.ticket.update({
      where: { id: usedTicket.id },
      data: { status: 'used', usedAt: new Date() },
    });
    await agent.post(`/api/admin/tickets/${revokedTicket.id}/revoke`);
    await submitSheet(department.id, ticketType.id, [
      { voteColumnId: column.id, criterionId: criterion.id, score: 80 },
    ]);

    const res = await agent.get('/api/admin/stats/overview');
    expect(res.status).toBe(200);

    const row = (res.body.ticketTypes as Array<{ id: string }>).find(
      (item) => item.id === ticketType.id,
    );
    expect(row).toMatchObject({ issued: 4, used: 1, unused: 2, revoked: 1, weightPercent: 100 });

    // 总量必须等于按票种汇总，且三种状态相加等于发放量
    const sumOf = (key: string): number =>
      (res.body.ticketTypes as Array<Record<string, number>>).reduce(
        (acc, item) => acc + (item[key] ?? 0),
        0,
      );
    expect(res.body.totals.issued).toBe(sumOf('issued'));
    expect(res.body.totals.used).toBe(sumOf('used'));
    expect(res.body.totals.unused).toBe(sumOf('unused'));
    expect(res.body.totals.revoked).toBe(sumOf('revoked'));
    expect(res.body.totals.used + res.body.totals.unused + res.body.totals.revoked).toBe(
      res.body.totals.issued,
    );
    expect(res.body.totals.sheets).toBeGreaterThanOrEqual(1);

    const departmentRow = (res.body.departments as Array<{ id: string }>).find(
      (item) => item.id === department.id,
    );
    expect(departmentRow).toMatchObject({ employeeCount: 2, sheetCount: 1 });

    // 软删除的职工不再计入在册人数，但已提交打分表仍计入
    await agent.delete(`/api/admin/employees/${second.id}`);
    const after = await agent.get('/api/admin/stats/overview');
    expect(
      (after.body.departments as Array<{ id: string }>).find((item) => item.id === department.id),
    ).toMatchObject({ employeeCount: 1, sheetCount: 1 });

    // 投票窗口：message 必须与 open 一致，且时间可解析
    const voteWindow = res.body.voteWindow as {
      open: boolean;
      message: string;
      startAt: string | null;
    };
    expect(typeof voteWindow.open).toBe('boolean');
    expect(voteWindow.message).toBe(voteWindow.open ? '' : '当前未开放投票');
    if (voteWindow.startAt) expect(Number.isNaN(Date.parse(voteWindow.startAt))).toBe(false);
    expect(Number.isNaN(Date.parse(res.body.generatedAt as string))).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 结果与导出
  // ---------------------------------------------------------------------------

  it('结果口径：项点归一化、综合得分与排名', async () => {
    const { deptId, first, second, criterionB } = await setupScoredDepartment();

    const res = await agent.get(`/api/admin/results?departmentId=${deptId}`);
    expect(res.status).toBe(200);
    expect(res.body.department.name).toBe(`${TAG}部门-结果`);
    expect(res.body.criteria).toHaveLength(2);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.sheetCount).toBe(1);
    expect(res.body.ticketTypesInvolved).toHaveLength(1);

    const firstRow = res.body.rows.find((row: { voteColumnId: string }) => row.voteColumnId === first.id);
    const secondRow = res.body.rows.find(
      (row: { voteColumnId: string }) => row.voteColumnId === second.id,
    );
    // 主任：德 90/100 → 90，能 45/50 → 90，综合 (90+90)/2 = 90
    expect(firstRow).toMatchObject({
      rank: 1,
      voteColumnName: '主任',
      enabled: true,
      comprehensiveScore: 90,
    });
    // 党支部书记：德 60，能 30/50 → 60，综合 60
    expect(secondRow).toMatchObject({
      rank: 2,
      voteColumnName: '党支部书记',
      comprehensiveScore: 60,
    });

    // 「能」满分只有 50：45 分归一化后是 90，而不是 45
    const normalized = firstRow.criteria.find(
      (row: { criterionId: string }) => row.criterionId === criterionB.id,
    );
    expect(normalized).toMatchObject({ rawScore: 45, normalizedScore: 90 });
  });

  it('结果按实际收到票的票种加权归一化', async () => {
    const department = await createDepartment(`${TAG}部门-加权`);
    const column = await createVoteColumn(department.id, '主任');
    const criterion = await createCriterion(department.id, '德', 0, 100);
    const typeA = await newTicketType(50);
    const typeB = await newTicketType(30);

    // A(50%) 打 80，B(30%) 打 100：(80×50 + 100×30) / 80 = 87.5
    await submitSheet(department.id, typeA.id, [
      { voteColumnId: column.id, criterionId: criterion.id, score: 80 },
    ]);
    await submitSheet(department.id, typeB.id, [
      { voteColumnId: column.id, criterionId: criterion.id, score: 100 },
    ]);

    const res = await agent.get(`/api/admin/results?departmentId=${department.id}`);
    const row = res.body.rows[0];
    expect(row.criteria[0]).toMatchObject({ rawScore: 87.5, normalizedScore: 87.5 });
    expect(res.body.sheetCount).toBe(2);
    expect(
      (res.body.ticketTypesInvolved as Array<{ id: string }>).map((item) => item.id).sort(),
    ).toEqual([typeA.id, typeB.id].sort());
  });

  it('某部门某票种零票时按有票票种归一化，不按 0 分计入', async () => {
    const department = await createDepartment(`${TAG}部门-缺票种`);
    const column = await createVoteColumn(department.id, '主任');
    const criterion = await createCriterion(department.id, '德', 0, 100);
    const typeC = await newTicketType(20);

    // 只有 20% 权重的票种有票，均分 90：归一化后仍是 90，而不是 90×20/100
    await submitSheet(department.id, typeC.id, [
      { voteColumnId: column.id, criterionId: criterion.id, score: 90 },
    ]);

    const res = await agent.get(`/api/admin/results?departmentId=${department.id}`);
    expect(res.body.rows[0].criteria[0]).toMatchObject({ rawScore: 90, normalizedScore: 90 });
    expect(res.body.rows[0].criteria[0].participatingTicketTypeIds).toEqual([typeC.id]);
    expect(res.body.ticketTypesInvolved.map((item: { id: string }) => item.id)).toEqual([typeC.id]);
  });

  it('同分并列排名（1、1、3 式）', async () => {
    const department = await createDepartment(`${TAG}部门-并列`);
    const criterion = await createCriterion(department.id, '德', 0, 100);
    const first = await createVoteColumn(department.id, '甲', 0);
    const second = await createVoteColumn(department.id, '乙', 1);
    const third = await createVoteColumn(department.id, '丙', 2);
    const ticketType = await newTicketType(100);

    await submitSheet(department.id, ticketType.id, [
      { voteColumnId: first.id, criterionId: criterion.id, score: 80 },
      { voteColumnId: second.id, criterionId: criterion.id, score: 80 },
      { voteColumnId: third.id, criterionId: criterion.id, score: 50 },
    ]);

    const res = await agent.get(`/api/admin/results?departmentId=${department.id}`);
    const rankOf = (voteColumnId: string): number =>
      res.body.rows.find((row: { voteColumnId: string }) => row.voteColumnId === voteColumnId).rank;

    expect(rankOf(first.id)).toBe(1);
    expect(rankOf(second.id)).toBe(1);
    expect(rankOf(third.id)).toBe(3);
  });

  it('没有任何评分的被评列得 0 分并排在末位', async () => {
    const { deptId } = await setupScoredDepartment();
    const column = await createVoteColumn(deptId, '副主任', 2);
    const res = await agent.get(`/api/admin/results?departmentId=${deptId}`);

    const zero = res.body.rows.find(
      (row: { voteColumnId: string }) => row.voteColumnId === column.id,
    );
    expect(zero).toMatchObject({ voteColumnName: '副主任', comprehensiveScore: 0 });
    // 弃权、不填视为 0 分：本部门有表，该列就在每个项点上按 0 分参与平均，
    // 所以它的 criteria 不是空数组，而是「每项都是 0 分」
    expect(zero.criteria).toHaveLength(2);
    expect(
      (zero.criteria as Array<{ rawScore: number; normalizedScore: number }>).every(
        (row) => row.rawScore === 0 && row.normalizedScore === 0,
      ),
    ).toBe(true);
    expect(zero.rank).toBe(3);
  });

  it('结果参数缺失或部门不存在时的错误码', async () => {
    const missing = await agent.get('/api/admin/results');
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('VALIDATION_FAILED');

    const notFound = await agent.get('/api/admin/results?departmentId=not-exist');
    expect(notFound.status).toBe(404);
  });

  it('结果导出 xlsx：三个 sheet，行数符合预期', async () => {
    const { deptId, criterionA, criterionB } = await setupScoredDepartment();

    const workbook = await getWorkbook(`/api/admin/results/export.xlsx?departmentId=${deptId}`);

    const ranking = readTable(workbook.getWorksheet('综合排名'), '排名');
    expect(ranking.header).toEqual(['排名', '被评对象', '综合得分', '计分项点数']);
    expect(ranking.rows).toHaveLength(2);
    expect(ranking.rows[0]?.[1]).toBe('主任');
    expect(ranking.rows[0]?.[2]).toBe('90');
    expect(ranking.rows[0]?.[3]).toBe('2');
    expect(ranking.rows[1]?.[1]).toBe('党支部书记');

    // 明细行数 = 被评列数 × 有数据的项点数
    const details = readTable(workbook.getWorksheet('各项明细'), '被评对象');
    expect(details.header).toEqual(['被评对象', '项点', '原始分', '归一化分', '参与票种']);
    expect(details.rows).toHaveLength(4);
    expect(details.rows.filter((row) => row[1] === criterionA.name)).toHaveLength(2);
    expect(details.rows.filter((row) => row[1] === criterionB.name)).toHaveLength(2);
    expect(details.rows.every((row) => row[4] !== '')).toBe(true);

    // 参与票种口径：本次参与计分的票种标「是」，其余标「否」
    const involved = readTable(workbook.getWorksheet('参与票种口径'), '票种');
    expect(involved.header).toEqual(['票种', '名称', '权重百分比', '是否参与计分']);
    expect(involved.rows.filter((row) => row[3] === '是')).toHaveLength(1);

    // 一个部门一套项点列，跨部门汇总没有意义：缺参数直接 400
    expect((await agent.get('/api/admin/results/export.xlsx')).status).toBe(400);
  });

  it('审计日志记录管理动作，且不落随机码明文', async () => {
    const department = await createDepartment(`${TAG}部门-审计`);
    await createEmployee(department.id, '张三');
    await createCriterion(department.id, '德', 0, 100);
    const ticketType = await newTicketType(100);
    const generated = await agent
      .post('/api/admin/tickets/generate')
      .send({ ticketTypeId: ticketType.id, count: 1 });
    await agent.put('/api/admin/settings').send({ 'system.title': `${TAG}标题-审计` });

    const expectedActions = [
      'department.create',
      'employee.create',
      'criterion.create',
      'ticket.generate',
      'settings.update',
    ];
    const logs = await prisma.auditLog.findMany({ where: { action: { in: expectedActions } } });
    const actions = new Set(logs.map((row) => row.action));
    for (const action of expectedActions) expect(actions.has(action)).toBe(true);

    // 审计明细只记批次与数量，不记随机码明文
    const detail = await prisma.auditLog.findFirst({
      where: {
        action: 'ticket.generate',
        detail: { path: ['batchId'], equals: generated.body.batchId },
      },
    });
    expect(detail?.detail).toMatchObject({ count: 1, operator: ADMIN_USERNAME });
    expect(JSON.stringify(detail?.detail)).not.toContain(generated.body.codes[0]);
  });
});