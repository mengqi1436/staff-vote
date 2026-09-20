/**
 * RBAC 账号与角色管理接口测试（vitest + supertest）。
 *
 * 目标库与夹具约定同 admin.test.ts：`TEST_DATABASE_URL` + 前缀隔离，只清理自己的数据。
 * 测试库只跑迁移、不跑 seed，`permissions` 表是空的，因此权限行由夹具
 * {@link ensurePermissions}（经 createRole 间接调用）幂等补齐。
 *
 * 覆盖两类东西：
 *   1. 权限门控：没有 `admins.manage` 的账号调这些接口一律 403；
 *   2. 安全守卫（本任务核心）：不能停用/删除/降级自己；系统必须至少保留一个
 *      「已启用且拥有 admins.manage」的账号，否则权限再也管不了；口令长度与唯一性。
 *
 * 守卫的构造说明（很重要，否则会怀疑用例不可达）：
 *   - 「最后一个管理账号」只在操作者是合格账号时可能出现 —— 能调接口本身就说明
 *     操作者拥有 admins.manage。所以：
 *       · 库里还有第二个合格账号时，停用/删除/降级自己命中的是【自己】这条守卫；
 *       · 库里只剩自己时，同三个操作命中的是【最后一个】这条守卫（先判定它）。
 *     两条路径分别用两个用例构造，断言的是不同的错误码。
 */
import 'dotenv/config';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? '';
/** 没给测试库就跳过整组用例，而不是退回去连开发库。 */
const suiteEnabled = Boolean(testDatabaseUrl);

if (!suiteEnabled) {
  console.warn(
    '[rbac.test] 未设置 TEST_DATABASE_URL，跳过 RBAC 管理接口测试。\n' +
      "  运行方式：$env:NODE_ENV='test'; $env:TEST_DATABASE_URL='<测试库连接串>'; " +
      'pnpm --filter @staff-vote/api exec vitest run test/rbac.test.ts',
  );
}

// 必须在导入 src 之前改写：src/env.ts 在模块求值时读 process.env。
process.env.NODE_ENV = 'test';
if (suiteEnabled) process.env.TEST_DATABASE_URL = testDatabaseUrl;

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { ALL_PERMISSION_CODES } = await import('../src/lib/permissions.js');
const { cleanupRbac, createAdmin, createRole } = await import('./rbac-fixtures.js');

/** 没有可用测试库就整组跳过。 */
const describeDb = suiteEnabled ? describe : describe.skip;

/** 夹具前缀：清理与断言都靠它把自己的数据与别的测试文件区分开。 */
const TAG = 'RBT';
const PASSWORD = 'Test-Passw0rd!2026';
const NEW_PASSWORD = 'Rotated-Passw0rd!2026';

/** 本任务反复用到的权限码：管理管理员账号与角色权限。 */
const MANAGE = 'admins.manage';
/** 与 admins.manage 无关的写权限，用来观察「改角色后权限立即生效」。 */
const WRITE = 'settings.write';

const app = createApp();

interface Fixtures {
  /** 全权限角色（含 admins.manage） */
  superRoleId: string;
  /** 评议管理员角色：有写权限但没有 admins.manage */
  opsRoleId: string;
  /** 只读角色：没有任何权限 */
  readonlyRoleId: string;
}

let fixtures: Fixtures;
let bossId = '';
let agent: ReturnType<typeof request.agent>;

// -----------------------------------------------------------------------------
// 辅助
// -----------------------------------------------------------------------------

async function loginAs(username: string, password = PASSWORD): Promise<ReturnType<typeof request.agent>> {
  const client = newSession();
  const res = await client.post('/api/admin/login').send({ username, password });
  expect(res.status).toBe(200);
  return client;
}

/** 会话序号：给每个测试会话分配独立来源 IP（见 newSession）。 */
let sessionSequence = 0;

/**
 * 新建一个测试会话，并给它一个独立的来源 IP。
 *
 * 登录限流是 10 次/分钟・IP、通用限流是 300 次/分钟・IP（lib/rateLimit.ts）：
 * 整套用例都从 127.0.0.1 发请求的话，用到第 11 个账号登录就会 429，
 * 症状是「单独跑某条通过、整套跑就挂」。测试里每个会话换一个 IP 就互不影响，
 * 生产代码与限流参数一个字都不用动。
 */
function newSession(): ReturnType<typeof request.agent> {
  sessionSequence += 1;
  const ip = `10.9.${Math.floor(sessionSequence / 250)}.${(sessionSequence % 250) + 1}`;
  return request
    .agent(app)
    .use((req: { set: (field: string, value: string) => void }) => {
      req.set('X-Forwarded-For', ip);
    });
}

/** 全库「已启用且角色含 admins.manage」的账号 id。守卫不变式的观察口径。 */
async function manageCapableAdminIds(): Promise<string[]> {
  const rows = await prisma.adminUser.findMany({
    where: {
      enabled: true,
      role: { permissions: { some: { permission: { code: MANAGE } } } },
    },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/**
 * 把「别的测试文件遗留的合格账号」临时停用，让本用例面对「系统只剩自己一个管理账号」
 * 的确定状态；结束后在 finally 里原样恢复。
 *
 * 测试库被多个测试文件共用（vitest 已关闭文件级并行），因此恢复必须写在 finally：
 * 异常路径下留下一个被莫名停用的账号，会让别的文件看到无法解释的 401。
 */
async function withSoloManageAccount<T>(run: () => Promise<T>): Promise<T> {
  const outsiders = await prisma.adminUser.findMany({
    where: {
      enabled: true,
      username: { not: { startsWith: TAG } },
      role: { permissions: { some: { permission: { code: MANAGE } } } },
    },
    select: { id: true },
  });
  const ids = outsiders.map((row) => row.id);
  if (ids.length > 0) {
    await prisma.adminUser.updateMany({ where: { id: { in: ids } }, data: { enabled: false } });
  }
  try {
    return await run();
  } finally {
    if (ids.length > 0) {
      await prisma.adminUser.updateMany({ where: { id: { in: ids } }, data: { enabled: true } });
    }
  }
}

/** 造一个本文件专属的账号并登录。 */
async function newAccount(
  name: string,
  roleId: string | null,
): Promise<{ id: string; agent: ReturnType<typeof request.agent> }> {
  const id = await createAdmin(`${TAG}${name}`, PASSWORD, roleId);
  const client = await loginAs(`${TAG}${name}`);
  return { id, agent: client };
}

async function rolesById(): Promise<Map<string, { code: string; name: string; builtin: boolean; adminCount: number; permissions: string[] }>> {
  const res = await agent.get('/api/admin/roles');
  expect(res.status).toBe(200);
  const rows = res.body as Array<{
    id: string;
    code: string;
    name: string;
    builtin: boolean;
    adminCount: number;
    permissions: string[];
  }>;
  return new Map(rows.map((row) => [row.id, row]));
}

// -----------------------------------------------------------------------------

describeDb('RBAC 账号与角色管理', () => {
  beforeAll(async () => {
    await cleanupRbac(TAG);
  });

  beforeEach(async () => {
    await cleanupRbac(TAG);
    fixtures = {
      superRoleId: await createRole(`${TAG}super`, '测试超级管理员', ALL_PERMISSION_CODES),
      opsRoleId: await createRole(
        `${TAG}ops`,
        '测试评议管理员',
        ALL_PERMISSION_CODES.filter((code) => code !== MANAGE),
      ),
      readonlyRoleId: await createRole(`${TAG}readonly`, '测试只读', []),
    };
    bossId = await createAdmin(`${TAG}boss`, PASSWORD, fixtures.superRoleId);
    agent = await loginAs(`${TAG}boss`);
  });

  afterAll(async () => {
    await cleanupRbac(TAG);
    await prisma.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // 权限门控
  // ---------------------------------------------------------------------------

  it('没有 admins.manage 的账号调这些接口一律 403', async () => {
    const { agent: viewer, id: viewerId } = await newAccount('viewer', fixtures.readonlyRoleId);

    const responses = await Promise.all([
      viewer.get('/api/admin/permissions'),
      viewer.get('/api/admin/roles'),
      viewer.post('/api/admin/roles').send({ code: `${TAG}x`, name: '不该建出来', permissions: [] }),
      viewer.patch(`/api/admin/roles/${fixtures.readonlyRoleId}`).send({ name: '改名' }),
      viewer.delete(`/api/admin/roles/${fixtures.readonlyRoleId}`),
      viewer.get('/api/admin/admins'),
      viewer.post('/api/admin/admins').send({ username: `${TAG}x`, password: PASSWORD }),
      viewer.patch(`/api/admin/admins/${viewerId}`).send({ enabled: false }),
      viewer.delete(`/api/admin/admins/${viewerId}`),
    ]);

    expect(responses).toHaveLength(9);
    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('PERMISSION_DENIED');
    }

    // 被拒的写操作不能留下任何痕迹
    expect(await prisma.adminRole.count({ where: { code: `${TAG}x` } })).toBe(0);
    expect(await prisma.adminUser.count({ where: { username: `${TAG}x` } })).toBe(0);
    expect((await prisma.adminUser.findUnique({ where: { id: viewerId } }))?.enabled).toBe(true);
    expect((await prisma.adminRole.findUnique({ where: { id: fixtures.readonlyRoleId } }))?.name).toBe(
      '测试只读',
    );
  });

  it('未登录访问这些端点返回 401', async () => {
    const anonymous = newSession();
    const res = await anonymous.get('/api/admin/roles');
    expect(res.status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // 权限目录
  // ---------------------------------------------------------------------------

  it('GET /permissions 返回权限目录，按分组顺序排列', async () => {
    const res = await agent.get('/api/admin/permissions');
    expect(res.status).toBe(200);

    const rows = res.body as Array<{ code: string; name: string; groupName: string; sortOrder: number }>;
    expect(rows.map((row) => row.code)).toEqual(ALL_PERMISSION_CODES);

    // 同一分组的项必须相邻，且整份目录按 sortOrder 递增输出（前端按顺序分组渲染）
    const orders = rows.map((row) => row.sortOrder);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    for (const row of rows) {
      expect(row.name.length).toBeGreaterThan(0);
      expect(row.groupName.length).toBeGreaterThan(0);
    }
    expect(rows.some((row) => row.code === MANAGE && row.groupName === '系统管理')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 角色
  // ---------------------------------------------------------------------------

  it('GET /roles 返回权限码数组与使用中的账号数', async () => {
    const roles = await rolesById();
    const superRole = roles.get(fixtures.superRoleId);
    const readonlyRole = roles.get(fixtures.readonlyRoleId);

    expect(superRole).toMatchObject({ name: '测试超级管理员', adminCount: 1 });
    expect(superRole?.permissions.sort()).toEqual([...ALL_PERMISSION_CODES].sort());
    expect(readonlyRole).toMatchObject({ name: '测试只读', adminCount: 0, permissions: [] });

    // 换一个账号用该角色，accountCount 随之变化
    await createAdmin(`${TAG}second`, PASSWORD, fixtures.readonlyRoleId);
    expect((await rolesById()).get(fixtures.readonlyRoleId)).toMatchObject({ adminCount: 1 });
  });

  it('POST /roles 创建角色并授权，返回 200；代码重复 409；未授权即只读', async () => {
    const created = await agent
      .post('/api/admin/roles')
      .send({ code: `${TAG}create`, name: '测试新建角色', description: '本轮新建', permissions: [WRITE] });

    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      code: `${TAG}create`,
      name: '测试新建角色',
      description: '本轮新建',
      builtin: false,
      permissions: [WRITE],
      adminCount: 0,
    });

    const duplicate = await agent
      .post('/api/admin/roles')
      .send({ code: `${TAG}create`, name: '重复代码', permissions: [] });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('ROLE_CODE_EXISTS');

    // 未知权限码必须被拒，且不留下半个角色
    const unknown = await agent
      .post('/api/admin/roles')
      .send({ code: `${TAG}unknown`, name: '未知权限', permissions: ['not.a.permission'] });
    expect(unknown.status).toBe(400);
    expect(await prisma.adminRole.count({ where: { code: `${TAG}unknown` } })).toBe(0);
  });

  it('PATCH /roles/:id 改名称、描述与权限；角色代码不可改', async () => {
    const updated = await agent
      .patch(`/api/admin/roles/${fixtures.readonlyRoleId}`)
      .send({ name: '测试只读（改名）', description: '改了描述', permissions: [WRITE] });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ name: '测试只读（改名）', permissions: [WRITE] });

    // 请求体里带 code 也不生效：角色代码是判定锚点，改名会让已有配置失去指代
    const withCode = await agent
      .patch(`/api/admin/roles/${fixtures.readonlyRoleId}`)
      .send({ code: `${TAG}hacked`, name: '再改名' });
    expect(withCode.status).toBe(200);
    expect(withCode.body).toMatchObject({ code: `${TAG}readonly`, name: '再改名' });

    expect((await agent.patch('/api/admin/roles/not-exist').send({ name: 'x' })).status).toBe(404);

    // 改完立刻回读，权限集合确实被替换而不是追加
    const role = (await rolesById()).get(fixtures.readonlyRoleId);
    expect(role?.permissions).toEqual([WRITE]);
  });

  it('内置角色可改名称与权限，但不可删除', async () => {
    const builtin = await prisma.adminRole.create({
      data: { code: `${TAG}builtin`, name: '内置角色', builtin: true },
    });

    const renamed = await agent
      .patch(`/api/admin/roles/${builtin.id}`)
      .send({ name: '内置角色（改名）', permissions: [WRITE] });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: '内置角色（改名）', builtin: true });

    const removed = await agent.delete(`/api/admin/roles/${builtin.id}`);
    expect(removed.status).toBe(409);
    expect(removed.body.error.code).toBe('ROLE_BUILTIN');
    expect(await prisma.adminRole.count({ where: { id: builtin.id } })).toBe(1);
  });

  it('DELETE /roles/:id：仍被账号使用的角色 409，未被使用的自建角色可删', async () => {
    // 先让一个账号真的引用该角色：只建角色不建账号时「没人用」是对的
    const holder = await agent
      .post('/api/admin/admins')
      .send({ username: `${TAG}holder`, password: PASSWORD, roleId: fixtures.readonlyRoleId });
    expect(holder.status).toBe(200);

    const used = await agent.delete(`/api/admin/roles/${fixtures.readonlyRoleId}`);
    expect(used.status).toBe(409);
    expect(used.body.error.code).toBe('ROLE_IN_USE');
    expect(await prisma.adminRole.count({ where: { id: fixtures.readonlyRoleId } })).toBe(1);

    // 未分配角色的账号「未使用」该角色，只有真的引用 roleId 才算使用
    const free = await agent
      .post('/api/admin/roles')
      .send({ code: `${TAG}free`, name: '没有被使用的角色', permissions: [] });
    expect(free.status).toBe(200);

    const removed = await agent.delete(`/api/admin/roles/${free.body.id}`);
    expect(removed.status).toBe(204);
    expect(await prisma.adminRole.count({ where: { id: free.body.id } })).toBe(0);
    expect((await agent.delete('/api/admin/roles/not-exist')).status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // 账号
  // ---------------------------------------------------------------------------

  it('POST /admins：创建返回 200，新口令可登录，用户名重复 409，口令少于 8 位 400', async () => {
    const created = await agent
      .post('/api/admin/admins')
      .send({ username: `${TAG}newbie`, password: PASSWORD, roleId: fixtures.opsRoleId });

    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      username: `${TAG}newbie`,
      roleId: fixtures.opsRoleId,
      roleName: '测试评议管理员',
      enabled: true,
    });
    expect(created.body.createdAt).toBeTruthy();
    expect(created.body.passwordHash).toBeUndefined();

    // 新账号能用新口令登录，并且拿到的正是该角色的权限
    const newbie = await loginAs(`${TAG}newbie`);
    const me = await newbie.get('/api/admin/me');
    expect(me.status).toBe(200);
    expect(me.body.roleName).toBe('测试评议管理员');
    expect(me.body.permissions).not.toContain(MANAGE);
    expect(me.body.permissions).toContain(WRITE);

    const duplicate = await agent
      .post('/api/admin/admins')
      .send({ username: `${TAG}newbie`, password: PASSWORD });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('ADMIN_USERNAME_EXISTS');

    const short = await agent
      .post('/api/admin/admins')
      .send({ username: `${TAG}short`, password: '1234567' });
    expect(short.status).toBe(400);
    expect(await prisma.adminUser.count({ where: { username: `${TAG}short` } })).toBe(0);

    const badRole = await agent
      .post('/api/admin/admins')
      .send({ username: `${TAG}badrole`, password: PASSWORD, roleId: 'not-exist' });
    expect(badRole.status).toBe(400);

    // 未分配角色的账号是只读的，不是「无权限就建不出来」
    const noRole = await agent
      .post('/api/admin/admins')
      .send({ username: `${TAG}norole`, password: PASSWORD });
    expect(noRole.status).toBe(200);
    expect(noRole.body.roleId).toBeNull();
  });

  it('GET /admins 返回账号列表（不含口令哈希）且不泄露哈希', async () => {
    const res = await agent.get('/api/admin/admins');
    expect(res.status).toBe(200);
    const rows = res.body as Array<Record<string, unknown>>;
    const boss = rows.find((row) => row.id === bossId);
    expect(boss).toMatchObject({
      username: `${TAG}boss`,
      roleId: fixtures.superRoleId,
      roleName: '测试超级管理员',
      enabled: true,
    });
    for (const row of rows) expect(row.passwordHash).toBeUndefined();
  });

  it('PATCH /admins/:id 可改角色、启停与重置口令', async () => {
    const { id } = await newAccount('target', fixtures.readonlyRoleId);

    const moved = await agent
      .patch(`/api/admin/admins/${id}`)
      .send({ roleId: fixtures.opsRoleId });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ roleId: fixtures.opsRoleId, roleName: '测试评议管理员' });

    const disabled = await agent.patch(`/api/admin/admins/${id}`).send({ enabled: false });
    expect(disabled.status).toBe(200);
    expect(disabled.body.enabled).toBe(false);
    expect((await prisma.adminUser.findUnique({ where: { id } }))?.enabled).toBe(false);

    const restored = await agent.patch(`/api/admin/admins/${id}`).send({ enabled: true });
    expect(restored.status).toBe(200);
    expect(restored.body.enabled).toBe(true);

    expect((await agent.patch('/api/admin/admins/not-exist').send({ enabled: false })).status).toBe(404);
  });

  it('重置口令后旧口令失效、新口令可用，且口令长度仍然校验', async () => {
    const { id } = await newAccount('rotate', fixtures.opsRoleId);

    const reset = await agent
      .patch(`/api/admin/admins/${id}`)
      .send({ password: NEW_PASSWORD });
    expect(reset.status).toBe(200);

    const oldPassword = await newSession()
      .post('/api/admin/login')
      .send({ username: `${TAG}rotate`, password: PASSWORD });
    expect(oldPassword.status).toBe(401);
    expect(oldPassword.body.error.code).toBe('INVALID_CREDENTIALS');

    const newPassword = await newSession()
      .post('/api/admin/login')
      .send({ username: `${TAG}rotate`, password: NEW_PASSWORD });
    expect(newPassword.status).toBe(200);

    const tooShort = await agent.patch(`/api/admin/admins/${id}`).send({ password: 'short' });
    expect(tooShort.status).toBe(400);

    // 只重置口令不应动角色与状态
    const row = await prisma.adminUser.findUnique({ where: { id } });
    expect(row?.roleId).toBe(fixtures.opsRoleId);
    expect(row?.enabled).toBe(true);
  });

  it('DELETE /admins/:id 删除账号，204', async () => {
    const { id } = await newAccount('deleted', fixtures.readonlyRoleId);

    const removed = await agent.delete(`/api/admin/admins/${id}`);
    expect(removed.status).toBe(204);
    expect(await prisma.adminUser.count({ where: { id } })).toBe(0);

    expect((await agent.delete('/api/admin/admins/not-exist')).status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // 安全守卫：不能对自己做危险操作
  // ---------------------------------------------------------------------------

  it('不能停用、删除或把自己降级成没有 admins.manage 的角色', async () => {
    // 库里还有第二个管理账号，因此这里拦下操作的是「自己」这条守卫，而不是「最后一个」
    await createAdmin(`${TAG}other`, PASSWORD, fixtures.superRoleId);

    const disabledSelf = await agent
      .patch(`/api/admin/admins/${bossId}`)
      .send({ enabled: false });
    expect(disabledSelf.status).toBe(409);
    expect(disabledSelf.body.error.code).toBe('SELF_DISABLE_FORBIDDEN');

    const removedSelf = await agent.delete(`/api/admin/admins/${bossId}`);
    expect(removedSelf.status).toBe(409);
    expect(removedSelf.body.error.code).toBe('SELF_DELETE_FORBIDDEN');

    const demotedSelf = await agent
      .patch(`/api/admin/admins/${bossId}`)
      .send({ roleId: fixtures.opsRoleId });
    expect(demotedSelf.status).toBe(409);
    expect(demotedSelf.body.error.code).toBe('SELF_DEMOTE_FORBIDDEN');

    // 三条被拒的操作都不能落库
    const self = await prisma.adminUser.findUnique({ where: { id: bossId } });
    expect(self).toMatchObject({ enabled: true, roleId: fixtures.superRoleId });

    // 允许的操作仍然放行：改成另一个同样有 admins.manage 的角色、重置自己的口令
    const movedSelf = await agent
      .patch(`/api/admin/admins/${bossId}`)
      .send({ roleId: fixtures.superRoleId, password: NEW_PASSWORD });
    expect(movedSelf.status).toBe(200);
    expect(await loginAs(`${TAG}boss`, NEW_PASSWORD)).toBeTruthy();
  });

  it('系统必须保留至少一个启用的管理账号：最后一个不能被停用/删除/失去权限', async () => {
    await withSoloManageAccount(async () => {
      expect(await manageCapableAdminIds()).toEqual([bossId]);

      const disabledLast = await agent
        .patch(`/api/admin/admins/${bossId}`)
        .send({ enabled: false });
      expect(disabledLast.status).toBe(409);
      expect(disabledLast.body.error.code).toBe('LAST_MANAGER');
      expect(disabledLast.body.error.message).toContain('至少保留一个');

      const removedLast = await agent.delete(`/api/admin/admins/${bossId}`);
      expect(removedLast.status).toBe(409);
      expect(removedLast.body.error.code).toBe('LAST_MANAGER');

      // 移除自己角色的 admins.manage：同样会让系统一个能管权限的账号都不剩
      const stripped = await agent
        .patch(`/api/admin/roles/${fixtures.superRoleId}`)
        .send({ permissions: [WRITE] });
      expect(stripped.status).toBe(409);
      expect(stripped.body.error.code).toBe('LAST_MANAGER');

      // 守卫拒绝后库里必须原样：账号还在、还启用、角色权限没被动过
      expect(await prisma.adminUser.count({ where: { id: bossId } })).toBe(1);
      expect((await prisma.adminUser.findUnique({ where: { id: bossId } }))?.enabled).toBe(true);
      const links = await prisma.rolePermission.findMany({
        where: { roleId: fixtures.superRoleId, permission: { code: MANAGE } },
      });
      expect(links).toHaveLength(1);
    });
  });

  it('角色失去 admins.manage 但有别的管理账号接手时，允许改', async () => {
    // 另一个角色也有 admins.manage，并且已经有一个启用账号在用 → 不构成锁死
    const backupRoleId = await createRole(`${TAG}backup`, '测试备份管理员', ALL_PERMISSION_CODES);
    await createAdmin(`${TAG}backup`, PASSWORD, backupRoleId);

    const stripped = await agent
      .patch(`/api/admin/roles/${fixtures.superRoleId}`)
      .send({ permissions: [WRITE] });
    expect(stripped.status).toBe(200);
    expect(stripped.body.permissions).toEqual([WRITE]);
  });

  // ---------------------------------------------------------------------------
  // 权限改动立即生效
  // ---------------------------------------------------------------------------

  it('改角色后权限立即生效：同一个令牌 403 ↔ 200 往返', async () => {
    const { id, agent: ops } = await newAccount('switchable', fixtures.readonlyRoleId);

    const before = await ops.put('/api/admin/settings').send({ 'system.title': `${TAG}切换前` });
    expect(before.status).toBe(403);
    expect(before.body.error.code).toBe('PERMISSION_DENIED');

    // 换成有 settings.write 的角色
    const promoted = await agent
      .patch(`/api/admin/admins/${id}`)
      .send({ roleId: fixtures.opsRoleId });
    expect(promoted.status).toBe(200);

    // 同一个 Cookie 令牌，无需重新登录：adminAuth 每次请求都重新查库
    const after = await ops.put('/api/admin/settings').send({ 'system.title': `${TAG}切换后` });
    expect(after.status).toBe(200);
    expect(after.body['system.title']).toBe(`${TAG}切换后`);

    // 反之亦然：降回只读角色后立刻又是 403
    await agent.patch(`/api/admin/admins/${id}`).send({ roleId: fixtures.readonlyRoleId });
    const demoted = await ops.put('/api/admin/settings').send({ 'system.title': `${TAG}降级后` });
    expect(demoted.status).toBe(403);

    // 直接改角色权限（不动账号）同样立即生效
    await agent
      .patch(`/api/admin/roles/${fixtures.readonlyRoleId}`)
      .send({ permissions: [WRITE] });
    const granted = await ops.put('/api/admin/settings').send({ 'system.title': `${TAG}授权后` });
    expect(granted.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // 审计
  // ---------------------------------------------------------------------------

  it('所有写操作落 AuditLog，且带操作者', async () => {
    const before = await prisma.auditLog.count();

    const role = await agent
      .post('/api/admin/roles')
      .send({ code: `${TAG}audit`, name: '测试审计角色', permissions: [WRITE] });
    const created = await agent
      .post('/api/admin/admins')
      .send({ username: `${TAG}audit`, password: PASSWORD, roleId: role.body.id });
    await agent
      .patch(`/api/admin/admins/${created.body.id}`)
      .send({ enabled: false, roleId: fixtures.opsRoleId });
    await agent.delete(`/api/admin/admins/${created.body.id}`);
    await agent.patch(`/api/admin/roles/${role.body.id}`).send({ name: '测试审计角色（改名）' });
    await agent.delete(`/api/admin/roles/${role.body.id}`);

    const logs = await prisma.auditLog.findMany({ where: { createdAt: { gte: new Date(Date.now() - 60_000) } } });
    expect(await prisma.auditLog.count()).toBeGreaterThanOrEqual(before + 6);

    const actions = logs.map((row) => row.action);
    for (const action of ['role.create', 'admin.create', 'admin.update', 'admin.delete', 'role.update', 'role.delete']) {
      expect(actions).toContain(action);
    }

    // 同一分钟内别的用例也会写 admin.create/role.create，因此按对象精确匹配自己的那条
    const detailsOf = (action: string): Array<Record<string, unknown>> =>
      logs
        .filter((row) => row.action === action)
        .map((row) => row.detail as unknown as Record<string, unknown>);

    expect(
      detailsOf('admin.create').some(
        (detail) => detail.username === `${TAG}audit` && detail.operator === `${TAG}boss`,
      ),
    ).toBe(true);
    expect(
      detailsOf('role.create').some(
        (detail) => detail.code === `${TAG}audit` && detail.operator === `${TAG}boss`,
      ),
    ).toBe(true);
    expect(
      detailsOf('admin.update').some(
        (detail) => detail.username === `${TAG}audit` && detail.enabled === false,
      ),
    ).toBe(true);
    expect(
      detailsOf('admin.delete').some((detail) => detail.username === `${TAG}audit`),
    ).toBe(true);
  });
});