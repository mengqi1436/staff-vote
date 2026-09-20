import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import ExcelJS from 'exceljs';

/**
 * 端到端验收：从初始化管理员一路走到导出 Excel。
 *
 * 这个文件验证的是「系统能不能真的用」，而不是单个函数的正确性 ——
 * 后者由 scoring/code/password/vote/admin 各自覆盖。
 *
 * 跑在 `TEST_DATABASE_URL` 指向的测试库上。
 * 本文件的 beforeAll 会清空所有业务表，因此依赖 vitest 关闭文件级并行
 * （见 vitest.config.ts）—— 与其它测试文件同时跑会互相清数据。
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  // 刻意不输出连接串：它含数据库口令，而错误消息会进日志与 CI 输出。
  throw new Error('缺少 TEST_DATABASE_URL，无法运行端到端测试（应指向独立测试库，不是开发库）');
}

// 必须在导入 src 之前设置：src/db.ts 的 prisma 单例在模块求值时决定连接串
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_URL = testDatabaseUrl;

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { hashPassword } = await import('../src/lib/password.js');
const { ALL_PERMISSION_CODES } = await import('../src/lib/permissions.js');
const { createRole } = await import('./rbac-fixtures.js');

const app = createApp();

const ADMIN_USERNAME = 'e2e-admin';
const ADMIN_PASSWORD = 'e2e-Password-123';



// 跨用例共享的状态
let admin: ReturnType<typeof request.agent>;
let departmentId = '';
let employeeAId = '';
let employeeBId = '';
let criterionScoreId = '';
let criterionQualityId = '';
let ticketTypeAId = '';
let ticketTypeBId = '';
let ticketTypeCId = '';
let generatedCodes: string[] = [];

beforeAll(async () => {
  // 清空测试库。删除顺序遵守外键依赖（子表在前）。
  await prisma.scoreItem.deleteMany();
  await prisma.scoreSheet.deleteMany();
  await prisma.ticket.deleteMany();
  await prisma.ticketBatch.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.criterion.deleteMany();
  await prisma.department.deleteMany();
  await prisma.ticketType.deleteMany();
  await prisma.setting.deleteMany();
  // 刻意【不】清空 audit_logs：审计表是只增的，本文件的用例也不读它，
  // 却会连带清掉同库其他测试文件刚写入的审计行（并发跑整套时表现为
  // 「别的套件断言审计条数突然变成 2」）。业务表清空已足够让 e2e 从干净状态开始。
  await prisma.adminUser.deleteMany();

  // 账号必须带角色：管理端写接口（发码、配置）都要求权限码，无角色账号等价只读。
  // createRole 是幂等的，重复跑不会撞唯一约束。
  const superRoleId = await createRole('e2e-super', '测试-超级管理员', ALL_PERMISSION_CODES);
  await prisma.adminUser.create({
    data: {
      username: ADMIN_USERNAME,
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      roleId: superRoleId,
    },
  });

  // 票种由本文件自行建立，不依赖 seed：端到端测试跑在独立的测试库上，
  // 而 seed 只写开发库。权重仍为 50/30/20（合计 100），
  // 这样用例 14 的加权归一化断言才有确定的分母。
  await prisma.ticketType.createMany({
    data: [
      { code: 'A', name: 'A 票（领导评议）', weightPercent: 50, sortOrder: 0 },
      { code: 'B', name: 'B 票（部门互评）', weightPercent: 30, sortOrder: 1 },
      { code: 'C', name: 'C 票（职工评议）', weightPercent: 20, sortOrder: 2 },
    ],
  });

  admin = request.agent(app);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('端到端：职工素质评议完整流程', () => {
  it('1. 管理员登录并拿到会话 Cookie', async () => {
    const res = await admin
      .post('/api/admin/login')
      .send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.username).toBe(ADMIN_USERNAME);
    // 会话在 httpOnly Cookie 里，响应体不应回传令牌
    expect(res.body.token).toBeUndefined();
  });

  it('2. 配置部门与职工名单（打分表的行）', async () => {
    const dept = await admin.post('/api/admin/departments').send({ name: '技术部', sortOrder: 0 });
    expect(dept.status).toBe(200);
    departmentId = dept.body.id;

    const e1 = await admin
      .post('/api/admin/employees')
      .send({ departmentId, name: '张伟', employeeNo: 'T001', sortOrder: 0 });
    const e2 = await admin
      .post('/api/admin/employees')
      .send({ departmentId, name: '李静', employeeNo: 'T002', sortOrder: 1 });
    expect(e1.status).toBe(200);
    expect(e2.status).toBe(200);
    employeeAId = e1.body.id;
    employeeBId = e2.body.id;
  });

  it('3. 配置素质项点（打分表的列），两项满分不同', async () => {
    // 故意让两项满分不同（100 与 10）——这正是「原始分不能直接相加」的场景
    const c1 = await admin
      .post('/api/admin/criteria')
      .send({ departmentId, name: '工作业绩', minScore: 0, maxScore: 100, sortOrder: 0 });
    const c2 = await admin
      .post('/api/admin/criteria')
      .send({ departmentId, name: '工作质量', minScore: 0, maxScore: 10, sortOrder: 1 });
    expect(c1.status).toBe(200);
    expect(c2.status).toBe(200);
    criterionScoreId = c1.body.id;
    criterionQualityId = c2.body.id;
  });

  it('4. 拒绝非法项点区间（max <= min）', async () => {
    const res = await admin
      .post('/api/admin/criteria')
      .send({ departmentId, name: '非法项', minScore: 10, maxScore: 10 });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('5. 配置票种权重（合计必须 100）', async () => {
    const types = await admin.get('/api/admin/ticket-types');
    expect(types.status).toBe(200);
    // 票种由本文件的 beforeAll 建立（A/B/C = 50/30/20）
    expect(types.body).toHaveLength(3);
    ticketTypeAId = types.body.find((t: { code: string }) => t.code === 'A').id;
    ticketTypeBId = types.body.find((t: { code: string }) => t.code === 'B').id;
    ticketTypeCId = types.body.find((t: { code: string }) => t.code === 'C').id;

    // 把 A 的权重改成 60，合计会变成 110，必须被拒绝
    const bad = await admin.patch(`/api/admin/ticket-types/${ticketTypeAId}`).send({ weightPercent: 60 });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
  });

  it('6. 非开放时段：投票状态为关闭，登录被拒', async () => {
    await admin.put('/api/admin/settings').send({ 'vote.open': 'false' });

    const status = await request(app).get('/api/vote/status');
    expect(status.status).toBe(200);
    expect(status.body.open).toBe(false);
    expect(status.body.message).toBe('当前未开放投票');

    // 先发一张码，再尝试用它登录
    const gen = await admin
      .post('/api/admin/tickets/generate')
      .send({ ticketTypeId: ticketTypeAId, count: 1 });
    expect(gen.status).toBe(200);

    const denied = await request(app).post('/api/vote/session').send({ code: gen.body.codes[0] });
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toBe('当前未开放投票');
  });

  it('7. 开放投票后批量发码', async () => {
    const res = await admin.put('/api/admin/settings').send({ 'vote.open': 'true' });
    expect(res.status).toBe(200);

    const status = await request(app).get('/api/vote/status');
    expect(status.body.open).toBe(true);

    const genA = await admin.post('/api/admin/tickets/generate').send({ ticketTypeId: ticketTypeAId, count: 1 });
    const genB = await admin.post('/api/admin/tickets/generate').send({ ticketTypeId: ticketTypeBId, count: 1 });
    expect(genA.status).toBe(200);
    expect(genB.status).toBe(200);
    generatedCodes = [genA.body.codes[0] as string, genB.body.codes[0] as string];
    expect(new Set(generatedCodes).size).toBe(2);
    // A 票码应为 8 位且不含易混字符
    expect(generatedCodes[0]).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });

  it('8. 职工凭 A 票码登录并取到动态打分表', async () => {
    const session = await request(app).post('/api/vote/session').send({ code: generatedCodes[0] });
    expect(session.status).toBe(200);
    expect(session.body.ticketType.code).toBe('A');
    expect(session.body.token).toBeTruthy();
    // 令牌不得携带码明文
    expect(JSON.stringify(session.body)).not.toContain(generatedCodes[0] as string);

    const dept = session.body.departments.find((d: { id: string }) => d.id === departmentId);
    expect(dept).toBeTruthy();

    const sheet = await request(app)
      .get(`/api/vote/sheet?departmentId=${departmentId}`)
      .set('Authorization', `Bearer ${session.body.token}`);
    expect(sheet.status).toBe(200);
    expect(sheet.body.criteria).toHaveLength(2);
    expect(sheet.body.employees).toHaveLength(2);
    expect(sheet.body.criteria.map((c: { name: string }) => c.name)).toEqual(['工作业绩', '工作质量']);
  });

  it('9. 拒绝小数分与越界分', async () => {
    const session = await request(app).post('/api/vote/session').send({ code: generatedCodes[0] });
    const token = session.body.token as string;

    const decimal = await request(app)
      .post('/api/vote/submit')
      .set('Authorization', `Bearer ${token}`)
      .send({
        departmentId,
        items: [
          { employeeId: employeeAId, criterionId: criterionScoreId, score: 88.5 },
        ],
      });
    expect(decimal.status).toBeGreaterThanOrEqual(400);
    expect(decimal.status).toBeLessThan(500);

    const outOfRange = await request(app)
      .post('/api/vote/submit')
      .set('Authorization', `Bearer ${token}`)
      .send({
        departmentId,
        items: [{ employeeId: employeeAId, criterionId: criterionQualityId, score: 999 }],
      });
    expect(outOfRange.status).toBeGreaterThanOrEqual(400);
    expect(outOfRange.status).toBeLessThan(500);

    const empty = await request(app)
      .post('/api/vote/submit')
      .set('Authorization', `Bearer ${token}`)
      .send({ departmentId, items: [] });
    expect(empty.status).toBeGreaterThanOrEqual(400);
    expect(empty.status).toBeLessThan(500);
  });

  it('10. A 票提交完整打分（4 格）', async () => {
    const session = await request(app).post('/api/vote/session').send({ code: generatedCodes[0] });
    const token = session.body.token as string;

    const res = await request(app)
      .post('/api/vote/submit')
      .set('Authorization', `Bearer ${token}`)
      .send({
        departmentId,
        items: [
          { employeeId: employeeAId, criterionId: criterionScoreId, score: 90 },
          { employeeId: employeeAId, criterionId: criterionQualityId, score: 8 },
          { employeeId: employeeBId, criterionId: criterionScoreId, score: 70 },
          { employeeId: employeeBId, criterionId: criterionQualityId, score: 6 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('11. 同一码二次提交被拒（一码一票）', async () => {
    const session = await request(app).post('/api/vote/session').send({ code: generatedCodes[0] });
    // 码已核销，重新登录就应当失败
    expect(session.status).toBe(401);

    // 即便拿旧令牌直接提交也必须被拒
    const stale = await request(app)
      .post('/api/vote/submit')
      .set('Authorization', `Bearer ${session.body?.token ?? 'invalid'}`)
      .send({
        departmentId,
        items: [{ employeeId: employeeAId, criterionId: criterionScoreId, score: 10 }],
      });
    expect(stale.status).toBeGreaterThanOrEqual(400);
  });

  it('12. B 票提交同一批职工的不同分数', async () => {
    const session = await request(app).post('/api/vote/session').send({ code: generatedCodes[1] });
    expect(session.status).toBe(200);
    const token = session.body.token as string;

    const res = await request(app)
      .post('/api/vote/submit')
      .set('Authorization', `Bearer ${token}`)
      .send({
        departmentId,
        items: [
          { employeeId: employeeAId, criterionId: criterionScoreId, score: 70 },
          { employeeId: employeeAId, criterionId: criterionQualityId, score: 6 },
          { employeeId: employeeBId, criterionId: criterionScoreId, score: 50 },
          { employeeId: employeeBId, criterionId: criterionQualityId, score: 4 },
        ],
      });
    expect(res.status).toBe(200);
  });

  it('13. 后台实时统计反映发码与核销情况', async () => {
    const res = await admin.get('/api/admin/stats/overview');
    expect(res.status).toBe(200);

    const typeA = res.body.ticketTypes.find((t: { code: string }) => t.code === 'A');
    expect(typeA.issued).toBe(2); // 非开放时段那张 + 开放后那张
    expect(typeA.used).toBe(1);
    expect(typeA.unused).toBe(1);

    expect(res.body.totals.sheets).toBe(2); // A 票与 B 票各一张
    const dept = res.body.departments.find((d: { id: string }) => d.id === departmentId);
    expect(dept.sheetCount).toBe(2);
    expect(dept.employeeCount).toBe(2);
    expect(res.body.voteWindow.open).toBe(true);
  });

  it('14. 结果按票种加权并对实际有票的票种归一化', async () => {
    const res = await admin.get(`/api/admin/results?departmentId=${departmentId}`);
    expect(res.status).toBe(200);

    // 只有 A(50%) 与 B(30%) 有票，C(20%) 零票 → 权重按 80 归一化
    expect(res.body.ticketTypesInvolved.map((t: { code: string }) => t.code).sort()).toEqual(['A', 'B']);
    expect(res.body.sheetCount).toBe(2);

    const zhang = res.body.rows.find((r: { employeeName: string }) => r.employeeName === '张伟');
    expect(zhang).toBeTruthy();

    const score = zhang.criteria.find((c: { criterionName: string }) => c.criterionName === '工作业绩');
    // (90*50 + 70*30) / 80 = 82.5
    expect(score.rawScore).toBeCloseTo(82.5, 2);

    const quality = zhang.criteria.find((c: { criterionName: string }) => c.criterionName === '工作质量');
    // (8*50 + 6*30) / 80 = 7.25，归一化到 0-100 → 72.5
    expect(quality.rawScore).toBeCloseTo(7.25, 2);
    expect(quality.normalizedScore).toBeCloseTo(72.5, 2);

    // 综合得分 = (82.5 + 72.5) / 2 = 77.5
    // 若把原始分直接相加再平均会得到 (82.5+7.25)/2 = 44.875，这条断言守住口径
    expect(zhang.comprehensiveScore).toBeCloseTo(77.5, 2);

    expect(res.body.rows[0].rank).toBe(1);
  });

  it('15. 导出 Excel 可被解析且含真实数据', async () => {
    const res = await admin
      .get(`/api/admin/results/export.xlsx?departmentId=${departmentId}`)
      .responseType('blob');

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);

    const workbook = new ExcelJS.Workbook();
    // exceljs 的 index.d.ts 在模块内自定义了 `Buffer` 接口（extends ArrayBuffer），
    // 与 Node 全局的泛型 `Buffer<ArrayBufferLike>` 是两个不同类型，
    // 因此必须断到它自己的参数类型，断到全局 Buffer 是无效断言。
    await workbook.xlsx.load(res.body as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    expect(workbook.worksheets.length).toBeGreaterThanOrEqual(1);

    // 汇总 sheet 里应能找到职工姓名
    const first = workbook.worksheets[0];
    expect(first).toBeTruthy();
    const text = first
      ?.getSheetValues()
      .flat()
      .filter((v): v is string => typeof v === 'string')
      .join('|');
    expect(text).toContain('张伟');
  });

  it('16. 随机码清单可导出', async () => {
    const res = await admin
      .get('/api/admin/tickets/export')
      .responseType('blob');
    expect(res.status).toBe(200);

    const workbook = new ExcelJS.Workbook();
    // exceljs 的 index.d.ts 在模块内自定义了 `Buffer` 接口（extends ArrayBuffer），
    // 与 Node 全局的泛型 `Buffer<ArrayBufferLike>` 是两个不同类型，
    // 因此必须断到它自己的参数类型，断到全局 Buffer 是无效断言。
    await workbook.xlsx.load(res.body as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const sheet = workbook.worksheets[0];
    expect(sheet).toBeTruthy();

    const codes = sheet
      ?.getSheetValues()
      .flat()
      .filter((v): v is string => typeof v === 'string' && /^[A-HJ-NP-Z2-9]{8}$/.test(v));
    expect(codes && codes.length).toBeGreaterThanOrEqual(2);
  });

  it('17. 关闭投票后状态回到未开放', async () => {
    await admin.put('/api/admin/settings').send({ 'vote.open': 'false' });
    const status = await request(app).get('/api/vote/status');
    expect(status.body.open).toBe(false);
    expect(status.body.message).toBe('当前未开放投票');
  });
});