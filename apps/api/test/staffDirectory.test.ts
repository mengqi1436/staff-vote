/**
 * 全局人员目录（人员管理）与「目录 → 场次副本」的接口/服务测试。
 *
 * 目标库：`TEST_DATABASE_URL` 指向的测试库；未设置时整组跳过并提示，
 * 绝不退回去连开发库（与 admin.test.ts 同一约定）。
 *
 * 数据隔离：所有夹具带 `SDTEST` 前缀，只清理自己前缀的数据。
 *
 * 覆盖：
 *   - 同步按工号 upsert（重复同步不产生重复行）、部门名匹配 / 自动创建；
 *   - replace 模式只停用名单外的人，不删除；
 *   - 空名单拒绝执行（防误调用清空人员目录）；
 *   - 同步端点鉴权：未带 / 带错令牌 401，正确令牌 200；
 *   - 从目录选人落场次副本：副本归属**列所属部门**、工号写入、同场次重复选人幂等；
 *   - 列表搜索同时匹配姓名、工号、部门名。
 */
import 'dotenv/config';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? '';
/** 没给测试库就跳过整组用例，而不是退回去连开发库。 */
const suiteEnabled = Boolean(testDatabaseUrl);

if (!suiteEnabled) {
  console.warn(
    '[staffDirectory.test] 未设置 TEST_DATABASE_URL，跳过人员目录测试。\n' +
      "  运行方式：$env:NODE_ENV='test'; $env:TEST_DATABASE_URL='<测试库连接串>'; " +
      'pnpm --filter @staff-vote/api test',
  );
}

// 必须在导入 src 之前改写：src/env.ts 在模块求值时读 process.env。
process.env.NODE_ENV = 'test';
if (suiteEnabled) process.env.TEST_DATABASE_URL = testDatabaseUrl;
/** 同步端点要求配置令牌；测试里固定一个，避免依赖开发机 .env。 */
const SYNC_TOKEN = 'sdtest-sync-token-0123456789';
process.env.STAFF_SYNC_TOKEN = SYNC_TOKEN;

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { employeeIdFromStaff, listStaffDirectory, syncStaffDirectory } = await import(
  '../src/services/staffDirectory.js'
);

const TAG = 'SDTEST';

describe.skipIf(!suiteEnabled)('全局人员目录', () => {
  let sessionId = '';
  let departmentId = '';
  let otherDepartmentId = '';
  let orgDepartmentId = '';
  let otherOrgDepartmentId = '';

  /** 按前缀清理夹具：先删引用方（答卷/列/职工），再删被引用方。 */
  async function cleanup(): Promise<void> {
    const sessions = await prisma.voteSession.findMany({
      where: { name: { startsWith: TAG } },
      select: { id: true },
    });
    const ids = sessions.map((row) => row.id);
    if (ids.length > 0) {
      await prisma.employee.deleteMany({ where: { sessionId: { in: ids } } });
      await prisma.voteColumn.deleteMany({ where: { sessionId: { in: ids } } });
      await prisma.department.deleteMany({ where: { sessionId: { in: ids } } });
      await prisma.voteSession.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.staffDirectoryEntry.deleteMany({ where: { employeeNo: { startsWith: TAG } } });
    await prisma.orgDepartment.deleteMany({ where: { name: { startsWith: TAG } } });
  }

  beforeAll(async () => {
    await cleanup();

    const org = await prisma.orgDepartment.create({ data: { name: `${TAG}-贵阳西车间` } });
    orgDepartmentId = org.id;
    const orgOther = await prisma.orgDepartment.create({ data: { name: `${TAG}-湖潮车间` } });
    otherOrgDepartmentId = orgOther.id;

    const session = await prisma.voteSession.create({
      data: { name: `${TAG}-评议`, orgDepartmentId: org.id },
    });
    sessionId = session.id;

    const department = await prisma.department.create({
      data: { sessionId, name: `${TAG}-甲部门` },
    });
    departmentId = department.id;
    const other = await prisma.department.create({
      data: { sessionId, name: `${TAG}-乙部门` },
    });
    otherDepartmentId = other.id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('按工号 upsert：重复同步不产生重复行，字段被更新', async () => {
    const first = await syncStaffDirectory(
      [
        { employeeNo: `${TAG}-1001`, name: '张三', department: `${TAG}-贵阳西车间`, gender: '男', age: 35 },
        { employeeNo: `${TAG}-1002`, name: '李四', department: `${TAG}-湖潮车间` },
      ],
      { mode: 'upsert' },
      'test',
    );
    expect(first.created).toBe(2);
    expect(first.updated).toBe(0);

    const second = await syncStaffDirectory(
      [{ employeeNo: `${TAG}-1001`, name: '张三（改）', department: `${TAG}-贵阳西车间`, age: 36 }],
      { mode: 'upsert' },
      'test',
    );
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);

    const rows = await prisma.staffDirectoryEntry.findMany({
      where: { employeeNo: { startsWith: TAG } },
      orderBy: { employeeNo: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: '张三（改）', age: 36, orgDepartmentId });
    expect(rows[1]).toMatchObject({ name: '李四', orgDepartmentId: otherOrgDepartmentId });
  });

  it('replace 模式：名单外的人只停用，不删除', async () => {
    const result = await syncStaffDirectory(
      [{ employeeNo: `${TAG}-1001`, name: '张三（改）', department: `${TAG}-贵阳西车间` }],
      { mode: 'replace' },
      'test',
    );
    expect(result.disabled).toBe(1);

    const disabled = await prisma.staffDirectoryEntry.findUnique({
      where: { employeeNo: `${TAG}-1002` },
    });
    // 记录仍在，只是停用 —— 硬删会让已绑定的被评列丢姓名
    expect(disabled?.enabled).toBe(false);
  });

  it('空名单拒绝执行（防止误调用把全员停用）', async () => {
    await expect(syncStaffDirectory([], { mode: 'replace' }, 'test')).rejects.toThrow(/为空/);
  });

  it('同步端点：未带令牌 401，令牌正确 200', async () => {
    const app = createApp();

    const unauthorized = await request(app)
      .post('/api/admin/staff-directory/sync')
      .send({ staff: [{ employeeNo: `${TAG}-2001`, name: '王五' }] });
    expect(unauthorized.status).toBe(401);

    const wrong = await request(app)
      .post('/api/admin/staff-directory/sync')
      .set('X-Sync-Token', 'not-the-token')
      .send({ staff: [{ employeeNo: `${TAG}-2001`, name: '王五' }] });
    expect(wrong.status).toBe(401);

    const ok = await request(app)
      .post('/api/admin/staff-directory/sync')
      .set('X-Sync-Token', SYNC_TOKEN)
      .send({ staff: [{ employeeNo: `${TAG}-2001`, name: '王五', department: `${TAG}-贵阳西车间` }] });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ created: 1, updated: 0 });
  });

  it('目录选人：副本归属列所属部门（允许跨部门），并写入工号', async () => {
    const staff = await prisma.staffDirectoryEntry.create({
      data: {
        employeeNo: `${TAG}-3001`,
        name: '赵六',
        orgDepartmentId: otherOrgDepartmentId, // 目录里属于湖潮车间
        enabled: true,
      },
    });

    // 选入甲部门（跨部门）：副本必须落在甲部门，打印才按本表归集
    const employeeId = await employeeIdFromStaff(staff.id, { departmentId, sessionId });
    const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
    expect(employee).toMatchObject({
      departmentId,
      sessionId,
      employeeNo: `${TAG}-3001`,
      name: '赵六',
    });

    // 同场次重复选人：复用同一副本（(sessionId, 工号) 幂等）
    const again = await employeeIdFromStaff(staff.id, { departmentId, sessionId });
    expect(again).toBe(employeeId);
    expect(await prisma.employee.count({ where: { sessionId, employeeNo: `${TAG}-3001` } })).toBe(1);
  });

  it('停用的人不能选入打分表', async () => {
    const staff = await prisma.staffDirectoryEntry.create({
      data: { employeeNo: `${TAG}-3002`, name: '停用人', enabled: false },
    });
    await expect(employeeIdFromStaff(staff.id, { departmentId, sessionId })).rejects.toThrow(/停用/);
  });

  it('列表搜索同时匹配姓名、工号与部门名', async () => {
    const byName = await listStaffDirectory({ q: '赵六' });
    expect(byName.map((row) => row.employeeNo)).toContain(`${TAG}-3001`);

    const byNo = await listStaffDirectory({ q: `${TAG}-3001` });
    expect(byNo.map((row) => row.name)).toContain('赵六');

    const byDepartment = await listStaffDirectory({ q: `${TAG}-湖潮车间` });
    expect(byDepartment.map((row) => row.name)).toContain('赵六');

    // 默认只返回启用的人：替 replace 用例停用的 1002 不应出现
    const enabledOnly = await listStaffDirectory({ q: `${TAG}-1002` });
    expect(enabledOnly).toHaveLength(0);
    const withDisabled = await listStaffDirectory({ q: `${TAG}-1002`, enabledOnly: false });
    expect(withDisabled).toHaveLength(1);
  });

  it('同一评议内不同部门复用同一条副本（不按部门重复建人）', async () => {
    const staff = await prisma.staffDirectoryEntry.findUnique({
      where: { employeeNo: `${TAG}-3001` },
    });
    const secondColumnDept = await employeeIdFromStaff(staff!.id, {
      departmentId: otherDepartmentId,
      sessionId,
    });
    // 同场次 + 同工号 → 复用；换列所属部门时把副本的归属纠正到新部门
    const employee = await prisma.employee.findUnique({ where: { id: secondColumnDept } });
    expect(employee?.departmentId).toBe(otherDepartmentId);
    expect(await prisma.employee.count({ where: { sessionId, employeeNo: `${TAG}-3001` } })).toBe(1);
  });
});
