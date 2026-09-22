import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * 投票入口四端点的接口测试（supertest 直接打 app，不监听端口）。
 *
 * 跑在独立测试库上，两条路都堵死：`NODE_ENV=test` 时 db.ts 的 resolveConnectionString()
 * 会优先取 TEST_DATABASE_URL；外加这里把 DATABASE_URL 也改写成同一个测试库连接串，
 * 即使有人忘了设 NODE_ENV=test，应用连接也不会落到开发库上。
 *
 * 改写必须发生在加载 src/app.js 之前：src/env.ts 在模块求值时读 process.env，共享的
 * prisma 实例随即建连。静态 import 会被提升，所以下面用动态 import —— 顺序就是保证。
 *
 * 夹具数据全部带随机后缀并按 id 清理，因此可以与同库的其他测试文件并跑。
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error(
    '缺少 TEST_DATABASE_URL：接口测试必须跑在独立测试库上（apps/api/.env 或环境变量）',
  );
}
process.env.DATABASE_URL = testDatabaseUrl;

const { createApp } = await import('../src/app.js');
const { createPrismaClient, prisma: appPrisma } = await import('../src/db.js');
const { SETTING_KEYS, VOTE_CLOSED_MESSAGE } = await import('../src/lib/settings.js');
const { signAdminToken, verifyVoteToken } = await import('../src/lib/token.js');
const { createTestSession } = await import('./session-fixtures.js');

const app = createApp();
/** 测试自己的连接：建夹具、查落库结果。同时证明 app 与测试确实在同一个库上。 */
const prisma = createPrismaClient(testDatabaseUrl);

const tag = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
const WINDOW_KEYS = [SETTING_KEYS.voteOpen, SETTING_KEYS.voteStartAt, SETTING_KEYS.voteEndAt];
const MISSING_ID = '00000000-0000-7000-8000-000000000000';

interface Fixture {
  /** 本夹具专用场次（voting）：所有业务数据都挂在它下面，登录/提交的场次校验因此可用 */
  sessionId: string;
  /** 额外占位场次：保证库中 ≥2 场，「/status 未带 sessionId 时 session=null」的断言不随库状态漂移 */
  placeholderSessionId: string;
  ticketTypeId: string;
  ticketTypeCode: string;
  ticketTypeName: string;
  departmentId: string;
  departmentName: string;
  /** 部门上的问卷表头四项，用于断言 /vote/sheet 原样回传（而非落回默认值） */
  departmentHeader: {
    questionnaireType: string;
    headerNote: string;
    title: string;
    footerNote: string;
  };
  disabledDepartmentId: string;
  otherDepartmentId: string;
  /** 部门内两个启用被评列（打分表的列），按 sortOrder 排列 */
  voteColumnIds: readonly [string, string];
  /** 宽区间项点（0-100） */
  wide: CriterionFixture;
  /** 窄区间项点（10-20），用于越界测试 */
  narrow: CriterionFixture;
  disabledCriterionId: string;
  disabledVoteColumnId: string;
  otherCriterionId: string;
  otherVoteColumnId: string;
}

interface CriterionFixture {
  id: string;
  name: string;
  /** 项点描述：宽项点带描述、窄项点留空，两种形态都要能原样回传 */
  description: string | null;
  minScore: number;
  maxScore: number;
}

/**
 * 建立本文件专用的夹具：自己的票种、部门、被评列、项点。
 * 不依赖种子数据，也就不依赖"测试库是否跑过 seed"。
 */
async function createFixture(): Promise<Fixture> {
  // 场次直接置为 voting：登录与提交都要求「票所属场次 = voting」。
  const sessionId = await createTestSession(prisma, `投票测试场次-${tag}`, 'voting');
  // 占位一场（draft）：让「库里 ≥2 场」成为本文件的稳定前提。
  const placeholderSessionId = await createTestSession(prisma, `投票测试占位场次-${tag}`, 'draft');
  const ticketType = await prisma.ticketType.create({
    data: { sessionId, code: `VT${tag}`, name: `投票测试票种-${tag}`, weightPercent: 100 },
  });
  // 表头四项显式给非默认值：用默认值断言不出"原样回传"，硬编码默认值也能蒙混过关。
  const department = await prisma.department.create({
    data: {
      sessionId,
      name: `投票测试部门-${tag}`,
      sortOrder: 1,
      questionnaireType: 'workshop',
      headerNote: `附件9-${tag}`,
      title: `投票测试问卷-${tag}`,
      footerNote: '满分 100 分，弃权、不填按 0 分计',
    },
  });
  const otherDepartment = await prisma.department.create({
    data: { sessionId, name: `投票测试他部门-${tag}`, sortOrder: 2 },
  });
  const disabledDepartment = await prisma.department.create({
    data: { sessionId, name: `投票测试停用部门-${tag}`, sortOrder: 3, enabled: false },
  });

  const columnA = await prisma.voteColumn.create({
    data: { departmentId: department.id, sessionId, name: '主任', sortOrder: 1 },
  });
  const columnB = await prisma.voteColumn.create({
    data: { departmentId: department.id, sessionId, name: '党支部书记', sortOrder: 2 },
  });
  const disabledColumn = await prisma.voteColumn.create({
    data: { departmentId: department.id, sessionId, name: '停用被评列', sortOrder: 3, enabled: false },
  });
  const otherColumn = await prisma.voteColumn.create({
    data: { departmentId: otherDepartment.id, sessionId, name: '外部门被评列', sortOrder: 1 },
  });

  const wide = await prisma.criterion.create({
    data: {
      departmentId: department.id,
      sessionId,
      name: '德',
      description: '政治素质、职业操守与作风表现',
      minScore: 0,
      maxScore: 100,
      sortOrder: 1,
    },
  });
  const narrow = await prisma.criterion.create({
    data: { departmentId: department.id, sessionId, name: '能', minScore: 10, maxScore: 20, sortOrder: 2 },
  });
  const disabledCriterion = await prisma.criterion.create({
    data: {
      departmentId: department.id,
      sessionId,
      name: '停用项点',
      minScore: 0,
      maxScore: 100,
      sortOrder: 3,
      enabled: false,
    },
  });
  const otherCriterion = await prisma.criterion.create({
    data: { departmentId: otherDepartment.id, sessionId, name: '外部门项点', minScore: 0, maxScore: 100 },
  });

  return {
    sessionId,
    placeholderSessionId,
    ticketTypeId: ticketType.id,
    ticketTypeCode: ticketType.code,
    ticketTypeName: ticketType.name,
    departmentId: department.id,
    departmentName: department.name,
    disabledDepartmentId: disabledDepartment.id,
    otherDepartmentId: otherDepartment.id,
    departmentHeader: {
      questionnaireType: department.questionnaireType,
      headerNote: department.headerNote,
      title: department.title,
      footerNote: department.footerNote,
    },
    voteColumnIds: [columnA.id, columnB.id],
    wide: {
      id: wide.id,
      name: wide.name,
      description: wide.description,
      minScore: wide.minScore,
      maxScore: wide.maxScore,
    },
    narrow: {
      id: narrow.id,
      name: narrow.name,
      description: narrow.description,
      minScore: narrow.minScore,
      maxScore: narrow.maxScore,
    },
    disabledCriterionId: disabledCriterion.id,
    disabledVoteColumnId: disabledColumn.id,
    otherCriterionId: otherCriterion.id,
    otherVoteColumnId: otherColumn.id,
  };
}

const fixture = await createFixture();
/** 夹具建立前的设置原值，测试结束后恢复，避免给同库的其他测试留下"投票开着"的状态。 */
const savedWindowSettings = await prisma.setting.findMany({ where: { key: { in: WINDOW_KEYS } } });

let ticketSeq = 0;
let loginSeq = 0;

/** 直接改设置表：不经过管理端接口，避免依赖另一个 teammate 正在实现的功能。 */
async function setVoteWindow(
  open: boolean,
  window: { startAt?: string; endAt?: string } = {},
): Promise<void> {
  const values: Array<[string, string]> = [
    [SETTING_KEYS.voteOpen, open ? 'true' : 'false'],
    [SETTING_KEYS.voteStartAt, window.startAt ?? ''],
    [SETTING_KEYS.voteEndAt, window.endAt ?? ''],
  ];
  await Promise.all(
    values.map(([key, value]) =>
      prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } }),
    ),
  );
}

/** 建一张孤立票据（自带批次），让每个用例从"未使用的码"出发，互不消耗。 */
async function createTicket(status: 'unused' | 'used' | 'revoked' = 'unused') {
  ticketSeq += 1;
  const batch = await prisma.ticketBatch.create({
    data: {
      ticketTypeId: fixture.ticketTypeId,
      sessionId: fixture.sessionId,
      count: 1,
      operator: 'vote.test',
    },
  });
  return prisma.ticket.create({
    data: {
      code: `${tag}${ticketSeq}`,
      ticketTypeId: fixture.ticketTypeId,
      batchId: batch.id,
      sessionId: fixture.sessionId,
      status,
      usedAt: status === 'unused' ? null : new Date(),
    },
  });
}

/**
 * 登录换令牌。每次换一个来源 IP：登录限流是 10 次/分钟，用例数不该被限流阈值卡住；
 * 限流本身由 src/lib/rateLimit.ts 负责，不是本文件的测试对象。
 */
function login(code: string) {
  loginSeq += 1;
  return request(app)
    .post('/api/vote/session')
    .set('X-Forwarded-For', `10.99.0.${loginSeq}`)
    .send({ code });
}

/** 建一张新码并登录，返回投票令牌。 */
async function newToken(): Promise<{ token: string; ticketId: string; code: string }> {
  const ticket = await createTicket();
  const res = await login(ticket.code);
  expect(res.status).toBe(200);
  return { token: res.body.token as string, ticketId: ticket.id, code: ticket.code };
}

function getSheet(token: string | null, departmentId: string) {
  const req = request(app).get('/api/vote/sheet').query({ departmentId });
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
}

function postSubmit(token: string | null, body: unknown) {
  const req = request(app).post('/api/vote/submit');
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.send(body as object);
}

/** 本部门已落库的评分表（只由本文件的用例产生）。 */
function countSheets() {
  return prisma.scoreSheet.count({ where: { departmentId: fixture.departmentId } });
}

beforeEach(async () => {
  await setVoteWindow(true);
  // 每个用例从"零张评分表"开始，"只落一张表"之类的断言才有意义。
  const sheets = await prisma.scoreSheet.findMany({
    where: { departmentId: fixture.departmentId },
    select: { id: true },
  });
  await prisma.scoreItem.deleteMany({ where: { sheetId: { in: sheets.map((s) => s.id) } } });
  await prisma.scoreSheet.deleteMany({ where: { departmentId: fixture.departmentId } });
});

afterAll(async () => {
  const sheetIds = (
    await prisma.scoreSheet.findMany({
      where: { departmentId: fixture.departmentId },
      select: { id: true },
    })
  ).map((sheet) => sheet.id);

  await prisma.scoreItem.deleteMany({ where: { sheetId: { in: sheetIds } } });
  await prisma.scoreSheet.deleteMany({ where: { departmentId: fixture.departmentId } });
  await prisma.ticket.deleteMany({ where: { ticketTypeId: fixture.ticketTypeId } });
  await prisma.ticketBatch.deleteMany({ where: { ticketTypeId: fixture.ticketTypeId } });
  await prisma.voteColumn.deleteMany({
    where: { departmentId: { in: [fixture.departmentId, fixture.otherDepartmentId] } },
  });
  // 职务列绑定的被评人要随本夹具清理，否则 employees 引用部门会挡住 department 删除
  await prisma.employee.deleteMany({
    where: { departmentId: { in: [fixture.departmentId, fixture.otherDepartmentId] } },
  });
  await prisma.criterion.deleteMany({
    where: { departmentId: { in: [fixture.departmentId, fixture.otherDepartmentId] } },
  });
  await prisma.department.deleteMany({
    where: {
      id: {
        in: [fixture.departmentId, fixture.otherDepartmentId, fixture.disabledDepartmentId],
      },
    },
  });
  await prisma.ticketType.delete({ where: { id: fixture.ticketTypeId } });
  // 场次最后删：RESTRICT 外键要求先清空挂靠的业务数据。
  await prisma.voteSession.deleteMany({
    where: { id: { in: [fixture.sessionId, fixture.placeholderSessionId] } },
  });

  for (const key of WINDOW_KEYS) {
    const original = savedWindowSettings.find((row) => row.key === key);
    if (original) {
      await prisma.setting.upsert({
        where: { key },
        create: { key, value: original.value },
        update: { value: original.value },
      });
    } else {
      await prisma.setting.deleteMany({ where: { key } });
    }
  }

  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

describe('GET /api/vote/status', () => {
  it('开放时 open=true 且文案为空', async () => {
    await setVoteWindow(true);

    const res = await request(app).get('/api/vote/status');

    expect(res.status).toBe(200);
    expect(res.body.open).toBe(true);
    expect(res.body.message).toBe('');
    // 本夹具场次存在 → 库中 ≥2 场，未带 sessionId 时只按全局窗口判定，session 为 null。
    expect(res.body.session).toBeNull();
  });

  it('带 sessionId 时按该场次判定并回传场次信息', async () => {
    await setVoteWindow(true);

    const res = await request(app).get('/api/vote/status').query({ sessionId: fixture.sessionId });

    expect(res.status).toBe(200);
    expect(res.body.open).toBe(true);
    expect(res.body.session).toEqual({
      id: fixture.sessionId,
      name: `投票测试场次-${tag}`,
      status: 'voting',
    });
  });

  it('场次不存在 → 400 SESSION_NOT_FOUND', async () => {
    const res = await request(app).get('/api/vote/status').query({ sessionId: MISSING_ID });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('场次暂停时即使全局开放也判定为关闭', async () => {
    await setVoteWindow(true);
    await prisma.voteSession.update({
      where: { id: fixture.sessionId },
      data: { status: 'paused' },
    });

    const res = await request(app).get('/api/vote/status').query({ sessionId: fixture.sessionId });

    expect(res.body.open).toBe(false);
    expect(res.body.message).toBe(VOTE_CLOSED_MESSAGE);
    expect(res.body.session.status).toBe('paused');

    // 恢复 voting，避免影响后续用例
    await prisma.voteSession.update({
      where: { id: fixture.sessionId },
      data: { status: 'voting' },
    });
  });

  it('关闭时返回统一文案「当前未开放投票」', async () => {
    await setVoteWindow(false);

    const res = await request(app).get('/api/vote/status');

    expect(res.status).toBe(200);
    expect(res.body.open).toBe(false);
    expect(res.body.message).toBe(VOTE_CLOSED_MESSAGE);
  });

  it('总开关打开但未到起始时间时仍视为关闭，并回传计划开始时间', async () => {
    const startAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await setVoteWindow(true, { startAt });

    const res = await request(app).get('/api/vote/status');

    expect(res.body.open).toBe(false);
    expect(res.body.startAt).toBe(startAt);
    expect(res.body.message).toBe(VOTE_CLOSED_MESSAGE);
  });
});

describe('POST /api/vote/session —— 凭码换令牌', () => {
  it('未使用的码可登录，返回票种与启用部门，且令牌不含码明文', async () => {
    const ticket = await createTicket();

    const res = await login(ticket.code);

    expect(res.status).toBe(200);
    const payload = verifyVoteToken(res.body.token as string);
    expect(payload).toEqual({
      kind: 'vote',
      sub: ticket.id,
      ticketTypeId: fixture.ticketTypeId,
    });
    expect(res.body.ticketType).toEqual({
      id: fixture.ticketTypeId,
      code: fixture.ticketTypeCode,
      name: fixture.ticketTypeName,
      weightPercent: 100,
    });
    // 响应带票所属场次（投票端按它展示与判定开放状态）。
    expect(res.body.session).toEqual({
      id: fixture.sessionId,
      name: `投票测试场次-${tag}`,
      status: 'voting',
    });

    // 部门只含启用项、按 sortOrder：夹具两个部门 sortOrder 1 / 2，停用部门不出现。
    const ids = (res.body.departments as Array<{ id: string }>).map((department) => department.id);
    expect(ids).toContain(fixture.departmentId);
    expect(ids.indexOf(fixture.departmentId)).toBeLessThan(ids.indexOf(fixture.otherDepartmentId));
    expect(ids).not.toContain(fixture.disabledDepartmentId);

    // 令牌里只有票据 ID 与票种 ID，响应体里不出现码明文。
    expect(JSON.stringify(res.body)).not.toContain(ticket.code);
  });

  it('小写与带空格的码同样可登录（规范化）', async () => {
    const ticket = await createTicket();

    const res = await login(`  ${ticket.code.toLowerCase()} `);

    expect(res.status).toBe(200);
  });

  it('码不存在 → 401', async () => {
    const res = await login(`ZZ${tag}ZZ`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CODE');
  });

  it('码已使用 → 401「该票据已使用」', async () => {
    const ticket = await createTicket('used');

    const res = await login(ticket.code);

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('该票据已使用');
  });

  it('码已作废 → 401', async () => {
    const ticket = await createTicket('revoked');

    const res = await login(ticket.code);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TICKET_REVOKED');
  });

  it('投票未开放 → 403 且文案为「当前未开放投票」，票据不被消耗', async () => {
    await setVoteWindow(false);
    const ticket = await createTicket();

    const res = await login(ticket.code);

    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe(VOTE_CLOSED_MESSAGE);
    const after = await prisma.ticket.findUnique({ where: { id: ticket.id } });
    expect(after?.status).toBe('unused');
  });

  it('全局开放但场次暂停/结束 → 403，票据不被消耗', async () => {
    await setVoteWindow(true);
    const ticket = await createTicket();
    await prisma.voteSession.update({
      where: { id: fixture.sessionId },
      data: { status: 'paused' },
    });

    const paused = await login(ticket.code);
    expect(paused.status).toBe(403);
    expect(paused.body.error.code).toBe('VOTE_CLOSED');

    await prisma.voteSession.update({
      where: { id: fixture.sessionId },
      data: { status: 'ended' },
    });
    const ended = await login(ticket.code);
    expect(ended.status).toBe(403);
    expect(ended.body.error.code).toBe('VOTE_CLOSED');

    const after = await prisma.ticket.findUnique({ where: { id: ticket.id } });
    expect(after?.status).toBe('unused');

    // 恢复 voting，避免影响后续用例
    await prisma.voteSession.update({
      where: { id: fixture.sessionId },
      data: { status: 'voting' },
    });
  });

  it('未开放时优先按码判定：无效码仍然是 401 而不是 403', async () => {
    await setVoteWindow(false);

    const res = await login(`ZZ${tag}ZZ`);

    expect(res.status).toBe(401);
  });

  it('缺少 code → 400', async () => {
    const res = await request(app).post('/api/vote/session').send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('GET /api/vote/sheet —— 取打分表骨架', () => {
  it('返回部门、问卷表头、启用项点（含描述与区间）与启用被评列', async () => {
    const { token } = await newToken();

    // 给第一个职务列绑定被评人：表头第二行「职务与姓名」要随表回传姓名
    const employee = await prisma.employee.create({
      data: { departmentId: fixture.departmentId, sessionId: fixture.sessionId, name: '张三' },
    });
    await prisma.voteColumn.update({
      where: { id: fixture.voteColumnIds[0] },
      data: { employeeId: employee.id },
    });

    const res = await getSheet(token, fixture.departmentId);

    expect(res.status).toBe(200);
    expect(res.body.department).toEqual({
      id: fixture.departmentId,
      name: fixture.departmentName,
    });
    // 表头四项来自部门配置，原样回传，不落回默认值。
    expect(res.body.questionnaireType).toBe(fixture.departmentHeader.questionnaireType);
    expect(res.body.headerNote).toBe(fixture.departmentHeader.headerNote);
    expect(res.body.title).toBe(fixture.departmentHeader.title);
    expect(res.body.footerNote).toBe(fixture.departmentHeader.footerNote);
    // 停用项点不出现，顺序按 sortOrder；description 带描述与留空两种形态都回传。
    expect(res.body.criteria).toEqual([fixture.wide, fixture.narrow]);
    // 列 = 被评列：停用列不出现，顺序按 sortOrder；绑定了被评人的列回传姓名。
    expect(res.body.voteColumns).toEqual([
      { id: fixture.voteColumnIds[0], name: '主任', employeeName: '张三' },
      { id: fixture.voteColumnIds[1], name: '党支部书记', employeeName: null },
    ]);
    // 打分维度已换成被评列，旧模型的 employees 字段必须整体消失，而不是留个空数组。
    expect(res.body).not.toHaveProperty('employees');
  });

  it('缺少 departmentId → 400', async () => {
    const { token } = await newToken();

    const res = await request(app)
      .get('/api/vote/sheet')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
  });

  it('部门不存在 → 404', async () => {
    const { token } = await newToken();

    const res = await getSheet(token, MISSING_ID);

    expect(res.status).toBe(404);
  });

  it('部门已停用 → 404', async () => {
    const { token } = await newToken();

    const res = await getSheet(token, fixture.disabledDepartmentId);

    expect(res.status).toBe(404);
  });

  it('缺少令牌 → 401', async () => {
    const res = await getSheet(null, fixture.departmentId);

    expect(res.status).toBe(401);
  });

  it('伪造令牌 → 401', async () => {
    const res = await getSheet('not-a-real-token', fixture.departmentId);

    expect(res.status).toBe(401);
  });

  it('管理端令牌不能当投票令牌用（kind 校验）→ 401', async () => {
    const adminToken = signAdminToken(MISSING_ID, 'admin');

    const res = await getSheet(adminToken, fixture.departmentId);

    expect(res.status).toBe(401);
  });

  it('认证方案名不区分大小写（小写 bearer 同样可用）', async () => {
    const { token } = await newToken();

    const res = await request(app)
      .get('/api/vote/sheet')
      .query({ departmentId: fixture.departmentId })
      .set('Authorization', `bearer ${token}`);

    expect(res.status).toBe(200);
  });
});

describe('POST /api/vote/submit —— 提交与核销', () => {
  /**
   * 本部门启用被评列（2）× 启用项点（2）= 4 格的完整提交内容。
   * 提交完整性校验要求全部格子都填，多数用例从它出发。
   */
  function fullItems(): Array<{ voteColumnId: string; criterionId: string; score: number }> {
    return [
      { voteColumnId: fixture.voteColumnIds[0], criterionId: fixture.wide.id, score: 88 },
      { voteColumnId: fixture.voteColumnIds[0], criterionId: fixture.narrow.id, score: 15 },
      { voteColumnId: fixture.voteColumnIds[1], criterionId: fixture.wide.id, score: 60 },
      { voteColumnId: fixture.voteColumnIds[1], criterionId: fixture.narrow.id, score: 12 },
    ];
  }

  it('正常提交：返回 ok、只落一张匿名评分表、票据被核销', async () => {
    const ticket = await createTicket();
    const loginRes = await login(ticket.code);
    const token = loginRes.body.token as string;

    const res = await postSubmit(token, {
      departmentId: fixture.departmentId,
      items: fullItems(),
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const used = await prisma.ticket.findUnique({ where: { id: ticket.id } });
    expect(used?.status).toBe('used');
    expect(used?.usedAt).toBeInstanceOf(Date);

    const sheets = await prisma.scoreSheet.findMany({
      where: { departmentId: fixture.departmentId },
      include: { items: true },
    });
    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.ticketTypeId).toBe(fixture.ticketTypeId);
    expect(sheets[0]?.sessionId).toBe(fixture.sessionId);
    expect(sheets[0]?.submittedAt).toBeInstanceOf(Date);
    // 全部 4 格必须都落库：完整性校验强制填满，缺格在提交前就被拒绝。
    expect(sheets[0]?.items).toHaveLength(4);
    expect(sheets[0]?.items.map((item) => item.score).sort((a, b) => a - b)).toEqual([12, 15, 60, 88]);
    // 分数要落在对的格子上：按 (被评列, 项点) 对齐，而不只是四个数字都对得上。
    expect(
      sheets[0]?.items.map((item) => `${item.voteColumnId}|${item.criterionId}`).sort(),
    ).toEqual(
      [
        `${fixture.voteColumnIds[0]}|${fixture.wide.id}`,
        `${fixture.voteColumnIds[0]}|${fixture.narrow.id}`,
        `${fixture.voteColumnIds[1]}|${fixture.wide.id}`,
        `${fixture.voteColumnIds[1]}|${fixture.narrow.id}`,
      ].sort(),
    );
  });

  it('只提交部分格子 → 400 INCOMPLETE_SHEET，票据不被消耗', async () => {
    const { token, ticketId } = await newToken();

    const res = await postSubmit(token, {
      departmentId: fixture.departmentId,
      // 4 格只交 3 格：缺 1 格
      items: fullItems().slice(0, 3),
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INCOMPLETE_SHEET');
    expect(res.body.error.message).toBe('还有 1 个项点未完成打分');
    const after = await prisma.ticket.findUnique({ where: { id: ticketId } });
    expect(after?.status).toBe('unused');
    expect(await countSheets()).toBe(0);
  });

  it('一格都不交（空 items 在路由层已被拒）与交重复格都被前置校验拦下', async () => {
    const { token } = await newToken();

    const duplicated = await postSubmit(token, {
      departmentId: fixture.departmentId,
      items: [
        ...fullItems(),
        { voteColumnId: fixture.voteColumnIds[0], criterionId: fixture.wide.id, score: 10 },
      ],
    });
    expect(duplicated.status).toBe(400);
    expect(duplicated.body.error.code).toBe('DUPLICATE_ITEM');
  });

  it('匿名边界：score_sheets 只有 id / department_id / ticket_type_id / session_id / submitted_at 五列', async () => {
    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'score_sheets'
      ORDER BY ordinal_position
    `;

    // 没有 ticket_id、没有 IP、没有 user_agent —— 匿名性靠字段不存在来保证，而不是靠"记得别写"。
    // session_id 只标记场次归属（多场次隔离必需），同样无法定位到投票人。
    expect(columns.map((column) => column.column_name)).toEqual([
      'id',
      'department_id',
      'ticket_type_id',
      'submitted_at',
      'session_id',
    ]);
  });

  it('重复提交：同一令牌第二次 409，且不会多出第二张表', async () => {
    const { token } = await newToken();
    const body = {
      departmentId: fixture.departmentId,
      items: fullItems(),
    };

    const first = await postSubmit(token, body);
    const second = await postSubmit(token, body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('TICKET_USED');
    expect(await countSheets()).toBe(1);
  });

  it('并发提交：同一令牌两个请求只成功一个，不会写出两张表', async () => {
    const { token } = await newToken();
    const body = {
      departmentId: fixture.departmentId,
      items: fullItems(),
    };

    const [first, second] = await Promise.all([postSubmit(token, body), postSubmit(token, body)]);

    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([200, 409]);
    expect(await countSheets()).toBe(1);
  });

  it('提交中途场次被暂停 → 403，票据保持未使用', async () => {
    const ticket = await createTicket();
    const loginRes = await login(ticket.code);
    const token = loginRes.body.token as string;
    await prisma.voteSession.update({
      where: { id: fixture.sessionId },
      data: { status: 'paused' },
    });

    const res = await postSubmit(token, {
      departmentId: fixture.departmentId,
      items: fullItems(),
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('VOTE_CLOSED');
    const after = await prisma.ticket.findUnique({ where: { id: ticket.id } });
    expect(after?.status).toBe('unused');
    expect(await countSheets()).toBe(0);

    // 恢复 voting，避免影响后续用例
    await prisma.voteSession.update({
      where: { id: fixture.sessionId },
      data: { status: 'voting' },
    });
  });

  it('投票中途关闭后提交被拒（403），票据保持未使用', async () => {
    const ticket = await createTicket();
    const loginRes = await login(ticket.code);
    const token = loginRes.body.token as string;
    await setVoteWindow(false);

    const res = await postSubmit(token, {
      departmentId: fixture.departmentId,
      items: [{ voteColumnId: fixture.voteColumnIds[0], criterionId: fixture.wide.id, score: 90 }],
    });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe(VOTE_CLOSED_MESSAGE);
    const after = await prisma.ticket.findUnique({ where: { id: ticket.id } });
    expect(after?.status).toBe('unused');
    expect(await countSheets()).toBe(0);
  });

  it('缺少令牌 → 401', async () => {
    const res = await postSubmit(null, {
      departmentId: fixture.departmentId,
      items: [{ voteColumnId: fixture.voteColumnIds[0], criterionId: fixture.wide.id, score: 90 }],
    });

    expect(res.status).toBe(401);
  });
});

describe('POST /api/vote/submit —— 入参校验', () => {
  it('items 为空 → 400', async () => {
    const { token } = await newToken();

    const res = await postSubmit(token, { departmentId: fixture.departmentId, items: [] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('分数为小数 → 400', async () => {
    const { token } = await newToken();

    const res = await postSubmit(token, {
      departmentId: fixture.departmentId,
      items: [{ voteColumnId: fixture.voteColumnIds[0], criterionId: fixture.wide.id, score: 88.5 }],
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('分数为字符串 → 400', async () => {
    const { token } = await newToken();

    const res = await postSubmit(token, {
      departmentId: fixture.departmentId,
      items: [{ voteColumnId: fixture.voteColumnIds[0], criterionId: fixture.wide.id, score: '88' }],
    });

    expect(res.status).toBe(400);
  });

  it('分数高于项点上限 → 400，并指出区间', async () => {
    const { token } = await newToken();

    const res = await postSubmit(token, {
      departmentId: fixture.departmentId,
      items: [{ voteColumnId: fixture.voteColumnIds[0], criterionId: fixture.narrow.id, score: 21 }],
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SCORE_OUT_OF_RANGE');
    expect(res.body.error.message).toContain('10-20');
  });

  it('分数低于项点下限 → 400', async () => {
    const { token } = await newToken();

    const res = await postSubmit(token, {
      departmentId: fixture.departmentId,
      items: [{ voteColumnId: fixture.voteColumnIds[0], criterionId: fixture.narrow.id, score: 9 }],
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SCORE_OUT_OF_RANGE');
  });

  it('区间端点值可提交（10 与 20 都合法）→ 200', async () => {
    const { token } = await newToken();

    const res = await postSubmit(token, {
      departmentId: fixture.departmentId,
      items: [
        { voteColumnId: fixture.voteColumnIds[0], criterionId: fixture.narrow.id, score: 10 },
        { voteColumnId: fixture.voteColumnIds[1], criterionId: fixture.narrow.id, score: 20 },
        { voteColumnId: fixture.voteColumnIds[0], criterionId: fixture.wide.id, score: 50 },
        { voteColumnId: fixture.voteColumnIds[1], criterionId: fixture.wide.id, score: 60 },
      ],
    });

    expect(res.status).toBe(200);
  });

  it('被评列不属于该部门 → 400（防越权写）', async () => {
    const { token } = await newToken();

    const res = await postSubmit(token, {
      departmentId: fixture.departmentId,
      items: [
        { voteColumnId: fixture.otherVoteColumnId, criterionId: fixture.wide.id, score: 90 },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ITEM_OUT_OF_DEPARTMENT');
    expect(res.body.error.message).toBe('被评列不属于该部门，或该列已停用');
    expect(await countSheets()).toBe(0);
  });

  it('项点不属于该部门 → 400（防越权写）', async () => {
    const { token } = await newToken();

    const res = await postSubmit(token, {
      departmentId: fixture.departmentId,
      items: [
        { voteColumnId: fixture.voteColumnIds[0], criterionId: fixture.otherCriterionId, score: 90 },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ITEM_OUT_OF_DEPARTMENT');
  });

  it('已停用的被评列或项点 → 400，且不留半张表', async () => {
    const { token } = await newToken();

    const disabledColumn = await postSubmit(token, {
      departmentId: fixture.departmentId,
      items: [
        { voteColumnId: fixture.disabledVoteColumnId, criterionId: fixture.wide.id, score: 90 },
      ],
    });
    const disabledCriterion = await postSubmit(token, {
      departmentId: fixture.departmentId,
      items: [
        { voteColumnId: fixture.voteColumnIds[0], criterionId: fixture.disabledCriterionId, score: 90 },
      ],
    });

    expect(disabledColumn.status).toBe(400);
    expect(disabledColumn.body.error.code).toBe('ITEM_OUT_OF_DEPARTMENT');
    expect(disabledColumn.body.error.message).toBe('被评列不属于该部门，或该列已停用');
    expect(disabledCriterion.status).toBe(400);
    expect(disabledCriterion.body.error.code).toBe('ITEM_OUT_OF_DEPARTMENT');
    expect(disabledCriterion.body.error.message).toBe('打分项不属于该部门，或该项点已停用');
    expect(await countSheets()).toBe(0);
  });

  it('同一被评列与项点重复出现 → 400', async () => {
    const { token } = await newToken();

    const res = await postSubmit(token, {
      departmentId: fixture.departmentId,
      items: [
        { voteColumnId: fixture.voteColumnIds[0], criterionId: fixture.wide.id, score: 80 },
        { voteColumnId: fixture.voteColumnIds[0], criterionId: fixture.wide.id, score: 90 },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DUPLICATE_ITEM');
  });

  it('部门不存在 → 404', async () => {
    const { token } = await newToken();

    const res = await postSubmit(token, {
      departmentId: MISSING_ID,
      items: [{ voteColumnId: fixture.voteColumnIds[0], criterionId: fixture.wide.id, score: 90 }],
    });

    expect(res.status).toBe(404);
  });

  it('部门已停用 → 404', async () => {
    const { token } = await newToken();

    const res = await postSubmit(token, {
      departmentId: fixture.disabledDepartmentId,
      items: [{ voteColumnId: fixture.voteColumnIds[0], criterionId: fixture.wide.id, score: 90 }],
    });

    expect(res.status).toBe(404);
  });

  it('校验失败不消耗票据：同一令牌修正后可继续提交', async () => {
    const { token, ticketId } = await newToken();

    await postSubmit(token, {
      departmentId: fixture.departmentId,
      items: [{ voteColumnId: fixture.voteColumnIds[0], criterionId: fixture.narrow.id, score: 999 }],
    });
    const fixed = await postSubmit(token, {
      departmentId: fixture.departmentId,
      items: [
        { voteColumnId: fixture.voteColumnIds[0], criterionId: fixture.narrow.id, score: 20 },
        { voteColumnId: fixture.voteColumnIds[0], criterionId: fixture.wide.id, score: 50 },
        { voteColumnId: fixture.voteColumnIds[1], criterionId: fixture.narrow.id, score: 15 },
        { voteColumnId: fixture.voteColumnIds[1], criterionId: fixture.wide.id, score: 60 },
      ],
    });

    expect(fixed.status).toBe(200);
    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
    expect(ticket?.status).toBe('used');
  });
});