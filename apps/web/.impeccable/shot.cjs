/**
 * 设计验收用：灌入演示数据 + 批量截图。
 *
 * 这是开发工具，不是产品代码，放在 .impeccable/ 下。
 *
 * 演示数据全部为**合成数据**（PRODUCT.md 的 Evidence on Hand 已声明：
 * 不存在真实职工姓名、部门名与成绩，演示数据必须标注为合成）。
 *
 * 用法：先起服务（pnpm dev:api + pnpm dev:web），再
 *   node .impeccable/shot.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(path.join(process.env.TEMP || '/tmp', 'sv-shot', 'node_modules', 'playwright'));

const API = 'http://127.0.0.1:3000/api';
const WEB = 'http://127.0.0.1:5173';
const OUT = path.join(__dirname, 'review');

const ADMIN = { username: 'admin', password: 'C76dPmQFlOUZ3bvx' };

async function api(pathname, { method = 'GET', body, cookie, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers['Cookie'] = cookie;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = text;
  }
  return { status: res.status, body: payload, setCookie: res.headers.getSetCookie?.() ?? [] };
}

/** 合成演示数据：两个部门、六个职工、每个部门四个项点。 */
async function seedDemo(cookie) {
  const existing = await api('/admin/departments', { cookie });
  if ((existing.body?.length ?? 0) > 0) {
    console.log('[seed] 已有部门数据，跳过灌入');
    return;
  }

  const departments = [
    { name: '综合办公室', employees: ['周文彬', '林清和', '许静怡'] },
    { name: '生产运行部', employees: ['郑立诚', '贺明远', '苏晓宁'] },
  ];
  const criteria = [
    { name: '工作业绩', minScore: 0, maxScore: 100 },
    { name: '业务能力', minScore: 0, maxScore: 100 },
    { name: '协作沟通', minScore: 0, maxScore: 20 },
    { name: '作风纪律', minScore: 60, maxScore: 100 },
  ];

  // 工号必须全局唯一，且不能用部门 id 前缀拼：UUIDv7 是时间有序的，同一批创建的
  // 部门前 4 位相同（如都落在 01a0…），拼出来的工号会撞唯一约束。
  let employeeSeq = 0;

  for (const dept of departments) {
    const created = await api('/admin/departments', { method: 'POST', cookie, body: { name: dept.name } });
    if (created.status !== 200) {
      console.log(`[seed] 建部门失败：${dept.name}`, created.body);
      continue;
    }
    const departmentId = created.body.id;
    let employeesOk = 0;
    let criteriaOk = 0;

    for (const [index, name] of dept.employees.entries()) {
      employeeSeq += 1;
      const res = await api('/admin/employees', {
        method: 'POST',
        cookie,
        body: {
          departmentId,
          name,
          employeeNo: `DEMO-${String(employeeSeq).padStart(3, '0')}`,
          sortOrder: index,
        },
      });
      // 必须检查状态：曾因漏检导致工号撞唯一约束时静默失败，日志却照报成功
      if (res.status === 200) employeesOk += 1;
      else console.log(`[seed] 建职工失败 ${dept.name}/${name}:`, res.status, res.body);
    }

    for (const [index, criterion] of criteria.entries()) {
      const res = await api('/admin/criteria', {
        method: 'POST',
        cookie,
        body: { departmentId, ...criterion, sortOrder: index },
      });
      if (res.status === 200) criteriaOk += 1;
      else console.log(`[seed] 建项点失败 ${dept.name}/${criterion.name}:`, res.status, res.body);
    }

    console.log(
      `[seed] ${dept.name}：实际建成 ${employeesOk}/${dept.employees.length} 名职工、${criteriaOk}/${criteria.length} 个项点`,
    );
  }
}

/** 发一批码并让其中几张"已使用"，好让概览与发码页有真实分布。 */
async function seedTickets(cookie) {
  const stats = await api('/admin/stats/overview', { cookie });
  if ((stats.body?.totals?.issued ?? 0) > 0) {
    console.log('[seed] 已有随机码，跳过发放');
    return;
  }
  const types = stats.body?.ticketTypes ?? [];
  for (const type of types) {
    const res = await api('/admin/tickets/generate', {
      method: 'POST',
      cookie,
      body: { ticketTypeId: type.id, count: type.code === 'A' ? 6 : 12 },
    });
    if (res.status !== 200) console.log(`[seed] 发码失败 ${type.code}:`, res.status, res.body);
  }
  console.log('[seed] 已按票种发放随机码');
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // 1) 登录拿 Cookie
  const login = await api('/admin/login', { method: 'POST', body: ADMIN });
  if (login.status !== 200) throw new Error(`登录失败：${login.status} ${JSON.stringify(login.body)}`);
  const rawCookie = login.setCookie.map((c) => c.split(';')[0]).join('; ');
  console.log('[auth] 管理员已登录');

  // 2) 演示数据
  await seedDemo(rawCookie);
  await seedTickets(rawCookie);

  // 3) 让投票入口处于"已开放"，好截到可登录态
  await api('/admin/settings', { method: 'PUT', cookie: rawCookie, body: { 'vote.open': 'true' } });

  const browser = await chromium.launch();

  const cookieJar = login.setCookie.map((raw) => {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    return { name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: '127.0.0.1', path: '/' };
  });

  const targets = [
    ['admin-login', '/admin/login'],
    ['admin-dashboard', '/admin'],
    ['admin-ticket-types', '/admin/ticket-types'],
    ['admin-tickets', '/admin/tickets'],
    ['admin-departments', '/admin/departments'],
    ['admin-employees', '/admin/employees'],
    ['admin-criteria', '/admin/criteria'],
    ['admin-settings', '/admin/settings'],
    ['admin-results', '/admin/results'],
    ['admin-print', '/admin/results/print'],
  ];

  // 桌面
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await desktop.addCookies(cookieJar);
  const page = await desktop.newPage();
  for (const [name, route] of targets) {
    await page.goto(`${WEB}${route}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
    console.log(`[shot] ${name} (desktop 1440)`);
  }
  await desktop.close();

  // 投票入口：桌面 + 移动
  const voteTargets = [
    ['vote-gate-open', '/'],
    ['vote-done', '/vote/done'],
  ];
  for (const [label, viewport, suffix] of [
    ['desktop', { width: 1440, height: 900 }, 'desktop'],
    ['mobile', { width: 390, height: 844 }, 'mobile'],
  ]) {
    const ctx = await browser.newContext({ viewport, isMobile: suffix === 'mobile', hasTouch: suffix === 'mobile' });
    const votePage = await ctx.newPage();
    for (const [name, route] of voteTargets) {
      await votePage.goto(`${WEB}${route}`, { waitUntil: 'networkidle' });
      await votePage.waitForTimeout(700);
      await votePage.screenshot({ path: path.join(OUT, `${name}-${suffix}.png`), fullPage: true });
      console.log(`[shot] ${name} (${label} ${viewport.width})`);
    }
    await ctx.close();
  }

  // 未开放态：单独截一张，因为这是需求里点名要的文案
  await api('/admin/settings', { method: 'PUT', cookie: rawCookie, body: { 'vote.open': 'false' } });
  const closedCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const closedPage = await closedCtx.newPage();
  await closedPage.goto(`${WEB}/`, { waitUntil: 'networkidle' });
  await closedPage.waitForTimeout(700);
  await closedPage.screenshot({ path: path.join(OUT, 'vote-gate-closed-mobile.png'), fullPage: true });
  console.log('[shot] vote-gate-closed (mobile 390)');
  await closedCtx.close();

  await browser.close();
  console.log(`\n[done] 截图输出目录：${OUT}`);
})().catch((error) => {
  console.error('[shot] 失败：', error);
  process.exit(1);
});