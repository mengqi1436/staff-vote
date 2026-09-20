/**
 * 专项核对：触摸目标是否达标（44px 是移动端要求，桌面密集工具栏不适用）。
 * 只看移动端视口，并区分页面类型。
 */
const path = require('node:path');
const { chromium } = require(path.join(process.env.TEMP || '/tmp', 'sv-shot', 'node_modules', 'playwright'));

const WEB = 'http://127.0.0.1:5173';
const API = 'http://127.0.0.1:3000/api';

const PROBE = () => {
  const small = [];
  const sel = 'button,a,[role="button"],input,select,textarea,.ant-btn,.ant-switch,.ant-select-selector';
  for (const el of document.querySelectorAll(sel)) {
    const rc = el.getBoundingClientRect();
    if (rc.width < 1 || rc.height < 1) continue;
    if (rc.height < 44 || rc.width < 44) {
      const cls = typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 2).join('.') : '';
      small.push({
        t: el.tagName.toLowerCase(),
        c: cls,
        w: Math.round(rc.width),
        h: Math.round(rc.height),
        text: (el.textContent || '').trim().slice(0, 14),
      });
    }
  }
  return small;
};

(async () => {
  const login = await fetch(`${API}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'C76dPmQFlOUZ3bvx' }),
  });
  const jar = (login.headers.getSetCookie?.() ?? []).map((raw) => {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    return { name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: '127.0.0.1', path: '/' };
  });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addCookies(jar);
  const page = await ctx.newPage();

  for (const route of ['/', '/admin', '/admin/tickets', '/admin/results']) {
    await page.goto(`${WEB}${route}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const small = await page.evaluate(PROBE);
    console.log(`\n=== ${route} （移动端 390px） ===`);
    if (small.length === 0) {
      console.log('  全部达标（≥44px）');
    } else {
      const grouped = {};
      for (const s of small) {
        const key = `${s.t}.${s.c} (${s.w}x${s.h})`;
        grouped[key] = (grouped[key] || 0) + 1;
      }
      for (const [k, n] of Object.entries(grouped).slice(0, 8)) console.log(`  ${k} × ${n}`);
      console.log(`  小目标总数：${small.length}`);
    }
  }
  await browser.close();
})().catch((e) => {
  console.error('[mobile-check] 失败：', e);
  process.exit(1);
});