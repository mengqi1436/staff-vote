/**
 * adminAuth 上下文的骨架测试：身份与权限每次都从库里实时解析。
 *
 * 这一组只测地基本身，不依赖任何业务端点是否挂了权限中间件：
 *   1. `/me` 返回角色名与权限码
 *   2. 账号被停用后，**尚未过期的会话令牌立即失效**
 *      （令牌是无状态的，若不查库就会继续有效满 2 小时 —— 这是本次一并修掉的洞）
 *   3. 账号被删除后同样立即失效
 *   4. 未分配角色的账号权限为空数组（等价只读）
 *
 * 目标库与夹具约定同 admin.test.ts：TEST_DATABASE_URL + 前缀隔离。
 */
import 'dotenv/config';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? '';
const suiteEnabled = Boolean(testDatabaseUrl);

if (!suiteEnabled) {
  console.warn('[auth-context.test] 未设置 TEST_DATABASE_URL，跳过 adminAuth 上下文测试。');
}

// 必须在导入 src 之前改写：env.ts 在模块求值时读 process.env。
process.env.NODE_ENV = 'test';
if (suiteEnabled) process.env.TEST_DATABASE_URL = testDatabaseUrl;

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { ALL_PERMISSION_CODES } = await import('../src/lib/permissions.js');
const { cleanupRbac, createAdmin, createRole } = await import('./rbac-fixtures.js');

/** 没有可用测试库就整组跳过。 */
const describeDb = suiteEnabled ? describe : describe.skip;

/** 夹具前缀：只清理自己的数据。 */
const TAG = 'AXC';
const PASSWORD = 'Test-Passw0rd!2026';

const app = createApp();

describeDb('adminAuth 上下文', () => {
  let superRoleId = '';

  beforeAll(async () => {
    await cleanupRbac(TAG);
    superRoleId = await createRole(`${TAG}role`, '测试全权限角色', ALL_PERMISSION_CODES);
  });

  afterAll(async () => {
    await cleanupRbac(TAG);
    await prisma.$disconnect();
  });

  it('登录后 /me 返回角色名与全部权限码', async () => {
    await createAdmin(`${TAG}me`, PASSWORD, superRoleId);
    const agent = request.agent(app);

    await agent
      .post('/api/admin/login')
      .send({ username: `${TAG}me`, password: PASSWORD })
      .expect(200);

    const res = await agent.get('/api/admin/me').expect(200);
    expect(res.body.username).toBe(`${TAG}me`);
    expect(res.body.roleName).toBe('测试全权限角色');
    expect(res.body.permissions.sort()).toEqual([...ALL_PERMISSION_CODES].sort());
  });

  it('账号被停用后，未过期的令牌立即失效', async () => {
    await createAdmin(`${TAG}disabled`, PASSWORD, superRoleId);
    const agent = request.agent(app);

    await agent
      .post('/api/admin/login')
      .send({ username: `${TAG}disabled`, password: PASSWORD })
      .expect(200);
    // 停用前令牌有效
    await agent.get('/api/admin/me').expect(200);

    await prisma.adminUser.update({
      where: { username: `${TAG}disabled` },
      data: { enabled: false },
    });

    const res = await agent.get('/api/admin/me').expect(401);
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('账号被删除后，未过期的令牌立即失效', async () => {
    const id = await createAdmin(`${TAG}gone`, PASSWORD, superRoleId);
    const agent = request.agent(app);

    await agent
      .post('/api/admin/login')
      .send({ username: `${TAG}gone`, password: PASSWORD })
      .expect(200);
    await agent.get('/api/admin/me').expect(200);

    await prisma.adminUser.delete({ where: { id } });

    await agent.get('/api/admin/me').expect(401);
  });

  it('未分配角色的账号权限为空数组（等价只读）', async () => {
    await createAdmin(`${TAG}norole`, PASSWORD, null);
    const agent = request.agent(app);

    await agent
      .post('/api/admin/login')
      .send({ username: `${TAG}norole`, password: PASSWORD })
      .expect(200);

    const res = await agent.get('/api/admin/me').expect(200);
    expect(res.body.roleId).toBeNull();
    expect(res.body.roleName).toBeNull();
    expect(res.body.permissions).toEqual([]);
  });
});