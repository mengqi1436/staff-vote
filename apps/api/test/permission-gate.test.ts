/**
 * 权限门控测试：既有写端点必须被 `requirePermission` 硬拦。
 *
 * 前端按钮门控只是体验层；这一组用 supertest 打真实 HTTP，证明**绕过界面直接调接口**
 * 一样会被拒 —— 只读账号拿不到任何写权限，五个配置模块的写操作全部 403。
 *
 * 同时反向钉死两件事，避免「挂错位置」被误判成安全：
 *   1. 有写权限的账号走同一路径必须正常通过（挂太严会误伤）；
 *   2. GET 读操作不受权限限制（用 router.use 整段挂会把读也拦掉，那是错的）。
 *
 * 夹具约定同 admin.test.ts / auth-context.test.ts：TEST_DATABASE_URL + 前缀隔离。
 * 测试库只跑迁移不跑 seed，所以角色授权前必须先 ensurePermissions（见 rbac-fixtures）。
 */
import 'dotenv/config';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? '';
/** 没给测试库就跳过整组用例，而不是退回去连开发库。 */
const suiteEnabled = Boolean(testDatabaseUrl);

if (!suiteEnabled) {
  console.warn('[permission-gate.test] 未设置 TEST_DATABASE_URL，跳过权限门控测试。');
}

// 必须在导入 src 之前改写：src/env.ts 在模块求值时读 process.env。
process.env.NODE_ENV = 'test';
if (suiteEnabled) process.env.TEST_DATABASE_URL = testDatabaseUrl;

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { cleanupRbac, createAdmin, createRole } = await import('./rbac-fixtures.js');
const { ensureDefaultSession } = await import('./session-fixtures.js');

/** 没有可用测试库就整组跳过。 */
const describeDb = suiteEnabled ? describe : describe.skip;

/** 夹具前缀：清理与断言都靠它把自己的数据与别的测试文件区分开。 */
const TAG = 'PG';
const PASSWORD = 'Test-Passw0rd!2026';

/** 五个写权限码：与路由挂载表一一对应。 */
const WRITE_CODES = [
  'departments.write',
  'employees.write',
  'criteria.write',
  'ticketTypes.write',
  'settings.write',
];

const app = createApp();
type Agent = ReturnType<typeof request.agent>;

let viewer: Agent;
let editor: Agent;
/** 真实存在的部门/票种/职工/项点：用来证明 403 是权限拦的，而不是 404 兜的。 */
let departmentId = '';
let employeeId = '';
let criterionId = '';
let ticketTypeId = '';

/** 只清理本文件创建的夹具（按前缀），与同库的其他测试文件安全并存。 */
async function clearOwnFixtures(): Promise<void> {
  const departments = await prisma.department.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const departmentIds = departments.map((row) => row.id);
  await prisma.employee.deleteMany({ where: { departmentId: { in: departmentIds } } });
  await prisma.criterion.deleteMany({ where: { departmentId: { in: departmentIds } } });
  await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
  await prisma.ticketType.deleteMany({ where: { code: { startsWith: TAG } } });
}

/** 登录并返回带 Cookie 的 agent。 */
async function loginAs(username: string): Promise<Agent> {
  const agent = request.agent(app);
  await agent.post('/api/admin/login').send({ username, password: PASSWORD }).expect(200);
  return agent;
}

describeDb('管理端写端点的权限门控', () => {
  beforeAll(async () => {
    const rows = await prisma.$queryRaw<Array<{ currentDatabase: string }>>`
      SELECT current_database() AS "currentDatabase"`;
    const connected = rows[0]?.currentDatabase ?? '';
    const expected = new URL(testDatabaseUrl).pathname.replace(/^\//, '');
    if (connected !== expected) {
      throw new Error(
        `测试实际连到 ${connected}，而 TEST_DATABASE_URL 指向的是 ${expected}；` +
          '请确认 NODE_ENV=test 且 TEST_DATABASE_URL 指向测试库后重跑。',
      );
    }

    await cleanupRbac(TAG);
    await clearOwnFixtures();
    // 业务表挂 session_id 后，接口的场次自动解析依赖库里恰有默认场次。
    await ensureDefaultSession(prisma);

    // 只读角色不授任何权限：这正是「没有写权限的角色天然只读」的场景
    const viewerRoleId = await createRole(`${TAG}viewer`, '测试只读角色', []);
    const editorRoleId = await createRole(`${TAG}editor`, '测试写入角色', WRITE_CODES);
    await createAdmin(`${TAG}viewer`, PASSWORD, viewerRoleId);
    await createAdmin(`${TAG}editor`, PASSWORD, editorRoleId);

    viewer = await loginAs(`${TAG}viewer`);
    editor = await loginAs(`${TAG}editor`);
  });

  beforeEach(async () => {
    await clearOwnFixtures();

    const sessionId = await ensureDefaultSession(prisma);
    const department = await prisma.department.create({
      data: { sessionId, name: `${TAG}部门-夹具`, sortOrder: 1 },
    });
    departmentId = department.id;

    const employee = await prisma.employee.create({
      data: { departmentId, sessionId, name: `${TAG}职工-夹具`, sortOrder: 1 },
    });
    employeeId = employee.id;

    const criterion = await prisma.criterion.create({
      data: {
        departmentId,
        sessionId,
        name: `${TAG}项点-夹具`,
        minScore: 0,
        maxScore: 100,
        sortOrder: 1,
      },
    });
    criterionId = criterion.id;

    const ticketType = await prisma.ticketType.create({
      data: {
        sessionId,
        code: `${TAG}TT-BASE`,
        name: `${TAG}票种-夹具`,
        weightPercent: 0,
        enabled: false,
      },
    });
    ticketTypeId = ticketType.id;
  });

  afterAll(async () => {
    await clearOwnFixtures();
    await cleanupRbac(TAG);
    await prisma.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // 每个模块：只读账号 403 + 有权限账号通过 + GET 不受限
  // ---------------------------------------------------------------------------

  it('部门：只读账号写操作 403，有权限账号可写，GET 不受限', async () => {
    const created = await viewer.post('/api/admin/departments').send({ name: `${TAG}部门-只读新建` });
    expect(created.status).toBe(403);
    expect(created.body.error.code).toBe('PERMISSION_DENIED');

    const patched = await viewer
      .patch(`/api/admin/departments/${departmentId}`)
      .send({ name: `${TAG}部门-只读改名` });
    expect(patched.status).toBe(403);

    const removed = await viewer.delete(`/api/admin/departments/${departmentId}`);
    expect(removed.status).toBe(403);

    // 被拦之后库里没有任何变化：权限拦在业务逻辑之前
    expect(await prisma.department.count({ where: { name: `${TAG}部门-只读新建` } })).toBe(0);
    expect((await prisma.department.findUnique({ where: { id: departmentId } }))?.name).toBe(
      `${TAG}部门-夹具`,
    );

    // 只读账号仍能读列表：读操作不挂权限
    const list = await viewer.get('/api/admin/departments').expect(200);
    expect((list.body as Array<{ id: string }>).some((row) => row.id === departmentId)).toBe(true);

    // 有权限账号同一操作正常通过
    const ok = await editor.post('/api/admin/departments').send({ name: `${TAG}部门-编辑新建` });
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe(`${TAG}部门-编辑新建`);
    expect(
      (await editor.patch(`/api/admin/departments/${ok.body.id}`).send({ name: `${TAG}部门-编辑改名` }))
        .status,
    ).toBe(200);
    expect((await editor.delete(`/api/admin/departments/${ok.body.id}`)).status).toBe(204);
  });

  it('职工：只读账号写操作（含名单导入）403，有权限账号可写，GET 不受限', async () => {
    const body = { departmentId, name: `${TAG}职工-只读新建` };
    expect((await viewer.post('/api/admin/employees').send(body)).status).toBe(403);
    expect(
      (await viewer.patch(`/api/admin/employees/${employeeId}`).send({ name: `${TAG}职工-只读改名` }))
        .status,
    ).toBe(403);
    expect((await viewer.delete(`/api/admin/employees/${employeeId}`)).status).toBe(403);

    // 导入是 multipart，中间件在最前面，同样必须被拦下
    const csv = `部门,姓名,工号\n${TAG}部门-只读导入,只读职工,\n`;
    const imported = await viewer
      .post('/api/admin/employees/import')
      .attach('file', Buffer.from(csv, 'utf8'), 'roster.csv');
    expect(imported.status).toBe(403);
    expect(imported.body.error.code).toBe('PERMISSION_DENIED');

    expect(await prisma.employee.count({ where: { name: { startsWith: `${TAG}职工-只读` } } })).toBe(0);
    expect(await prisma.department.count({ where: { name: `${TAG}部门-只读导入` } })).toBe(0);

    // 只读账号仍能读名单
    const list = await viewer.get(`/api/admin/employees?departmentId=${departmentId}`).expect(200);
    expect((list.body as Array<{ id: string }>).some((row) => row.id === employeeId)).toBe(true);

    // 有权限账号同一操作正常通过
    const ok = await editor.post('/api/admin/employees').send({
      departmentId,
      name: `${TAG}职工-编辑新建`,
    });
    expect(ok.status).toBe(200);
    expect((await editor.patch(`/api/admin/employees/${ok.body.id}`).send({ sortOrder: 9 })).status).toBe(
      200,
    );
    expect((await editor.delete(`/api/admin/employees/${ok.body.id}`)).status).toBe(204);

    const editorImport = await editor
      .post('/api/admin/employees/import')
      .attach('file', Buffer.from(`部门,姓名,工号\n${TAG}部门-编辑导入,编辑职工,\n`, 'utf8'), 'roster.csv');
    expect(editorImport.status).toBe(200);
    expect(editorImport.body.created).toBe(1);
  });

  it('项点：只读账号写操作 403，有权限账号可写，GET 不受限', async () => {
    const body = { departmentId, name: `${TAG}项点-只读新建`, minScore: 0, maxScore: 100 };
    expect((await viewer.post('/api/admin/criteria').send(body)).status).toBe(403);
    expect((await viewer.patch(`/api/admin/criteria/${criterionId}`).send({ maxScore: 90 })).status).toBe(
      403,
    );
    expect((await viewer.delete(`/api/admin/criteria/${criterionId}`)).status).toBe(403);

    expect(await prisma.criterion.count({ where: { name: `${TAG}项点-只读新建` } })).toBe(0);
    expect((await prisma.criterion.findUnique({ where: { id: criterionId } }))?.maxScore).toBe(100);

    const list = await viewer.get(`/api/admin/criteria?departmentId=${departmentId}`).expect(200);
    expect((list.body as Array<{ id: string }>).some((row) => row.id === criterionId)).toBe(true);

    const ok = await editor
      .post('/api/admin/criteria')
      .send({ departmentId, name: `${TAG}项点-编辑新建`, minScore: 0, maxScore: 50 });
    expect(ok.status).toBe(200);
    expect((await editor.patch(`/api/admin/criteria/${ok.body.id}`).send({ maxScore: 60 })).status).toBe(
      200,
    );
    expect((await editor.delete(`/api/admin/criteria/${ok.body.id}`)).status).toBe(204);
  });

  it('票种：只读账号写操作 403，有权限账号可写，GET 不受限', async () => {
    const code = `${TAG}TT-RO`;
    expect(
      (await viewer.post('/api/admin/ticket-types').send({ code, name: `${TAG}票种-只读新建`, weightPercent: 0, enabled: false }))
        .status,
    ).toBe(403);
    expect(
      (await viewer.patch(`/api/admin/ticket-types/${ticketTypeId}`).send({ name: `${TAG}票种-只读改名` }))
        .status,
    ).toBe(403);
    expect((await viewer.delete(`/api/admin/ticket-types/${ticketTypeId}`)).status).toBe(403);

    expect(await prisma.ticketType.count({ where: { code } })).toBe(0);
    expect((await prisma.ticketType.findUnique({ where: { id: ticketTypeId } }))?.name).toBe(
      `${TAG}票种-夹具`,
    );

    const list = await viewer.get('/api/admin/ticket-types').expect(200);
    expect((list.body as Array<{ id: string }>).some((row) => row.id === ticketTypeId)).toBe(true);

    // 用停用票种（不参与权重合计校验）验证有权限账号可以正常写入
    const ok = await editor.post('/api/admin/ticket-types').send({
      code: `${TAG}TT-RW`,
      name: `${TAG}票种-编辑新建`,
      weightPercent: 0,
      enabled: false,
    });
    expect(ok.status).toBe(200);
    expect(
      (await editor.patch(`/api/admin/ticket-types/${ok.body.id}`).send({ name: `${TAG}票种-编辑改名` }))
        .status,
    ).toBe(200);
    expect((await editor.delete(`/api/admin/ticket-types/${ok.body.id}`)).status).toBe(204);
  });

  it('系统设置：只读账号 PUT 403，有权限账号可写，GET 不受限', async () => {
    const baseline = (await viewer.get('/api/admin/settings').expect(200)).body['system.title'];
    // 试写的值必须与基线不同，否则「被拦下没写进去」与「恰好写成了同一个值」无法区分
    const deniedTitle = baseline === `${TAG}标题-只读` ? `${TAG}标题-只读-2` : `${TAG}标题-只读`;

    const denied = await viewer.put('/api/admin/settings').send({ 'system.title': deniedTitle });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');

    // 只读账号仍能读设置，且这次被拦下的写没有落库
    const readable = await viewer.get('/api/admin/settings').expect(200);
    expect(readable.body['system.title']).toBe(baseline);

    const before = (await editor.get('/api/admin/settings').expect(200)).body['system.title'];
    try {
      const updated = await editor.put('/api/admin/settings').send({ 'system.title': `${TAG}标题-编辑` });
      expect(updated.status).toBe(200);
      expect(updated.body['system.title']).toBe(`${TAG}标题-编辑`);
      expect((await editor.get('/api/admin/settings')).body['system.title']).toBe(`${TAG}标题-编辑`);
    } finally {
      // 设置是全局的：改完必须还原，别影响同库其他套件
      await editor.put('/api/admin/settings').send({ 'system.title': before });
    }
  });

  it('只读账号可以读全部五类列表（读操作不挂权限）', async () => {
    const responses = await Promise.all([
      viewer.get('/api/admin/departments'),
      viewer.get('/api/admin/employees'),
      viewer.get('/api/admin/criteria'),
      viewer.get('/api/admin/ticket-types'),
      viewer.get('/api/admin/settings'),
    ]);

    expect(responses).toHaveLength(5);
    for (const res of responses) {
      expect(res.status).toBe(200);
    }
  });

  it('403 文案取权限目录的中文名，可直接展示给用户', async () => {
    const res = await viewer
      .post('/api/admin/criteria')
      .send({ departmentId, name: `${TAG}项点-文案`, minScore: 0, maxScore: 10 });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'PERMISSION_DENIED',
      message: '当前账号没有「管理评分项点」权限，请联系超级管理员',
    });
  });
});