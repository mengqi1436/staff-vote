/**
 * 设计验收审计：不靠肉眼，用浏览器读取真实渲染结果。
 *
 * 检查项与视觉方向无关（年鉴时代的「圆角必须为 0」「禁阴影」纪律已随方向废弃）：
 *   1. 没有横向溢出
 *   2. 可见文本里没有 em-dash / en-dash（硬禁令）
 *   3. 正文对比度 ≥ 4.5:1（大字 ≥ 3:1）
 *   4. 移动端可点击目标 ≥ 44px
 *   5. 页面实际用到的颜色（看是否跑出色板）
 *   6. 控制台错误
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(path.join(process.env.TEMP || '/tmp', 'sv-shot', 'node_modules', 'playwright'));

const API = 'http://127.0.0.1:3000/api';
const WEB = 'http://127.0.0.1:5173';
const ADMIN = { username: 'admin', password: 'C76dPmQFlOUZ3bvx' };

const ADMIN_ROUTES = [
  ['/admin'],
  ['/admin/ticket-types'],
  ['/admin/tickets'],
  ['/admin/departments'],
  ['/admin/employees'],
  ['/admin/criteria'],
  ['/admin/settings'],
  ['/admin/results'],
  ['/admin/results/print'],
  ['/admin/login'],
];
const VOTE_ROUTES = [['/'], ['/vote/done']];

const PROBE = () => {
  const out = {
    overflowX: 0,
    emDash: [],
    lowContrast: [],
    smallTargets: [],
    colors: {},
  };

  const describe = (el) => {
    const cls = typeof el.className === 'string' ? el.className : '';
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls.split(/\s+/).slice(0, 3).join('.') : ''}`;
  };

  out.overflowX = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);

  const luminance = (rgb) => {
    const lin = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  };
  const parse = (s) => {
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(s || '');
    return m ? { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] } : null;
  };
  const ratio = (a, b) => {
    const l1 = luminance(a);
    const l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const bgOf = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0.9) return c.rgb;
      node = node.parentElement;
    }
    return [255, 255, 255];
  };

  const OVERLAY = '.ant-modal,.ant-dropdown,.ant-select-dropdown,.ant-popover,.ant-notification,.ant-message,.ant-tooltip,.ant-drawer,.ant-picker-dropdown';

  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;

    const bg = parse(cs.backgroundColor);
    if (bg && bg.a > 0.1 && rect.width > 4 && rect.height > 4) {
      const key = `bg:${bg.rgb.join(',')}`;
      out.colors[key] = (out.colors[key] || 0) + 1;
    }

    const isLeafText =
      el.children.length === 0 && el.textContent && el.textContent.trim().length > 0;
    if (isLeafText) {
      const text = el.textContent.trim();
      if (/[\u2014\u2013]/.test(text)) out.emDash.push(text.slice(0, 36));

      const fg = parse(cs.color);
      if (fg && fg.a > 0.9 && rect.width > 8) {
        const cr = ratio(fg.rgb, bgOf(el));
        const size = parseFloat(cs.fontSize);
        const bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
        const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
        if (cr < need) {
          out.lowContrast.push({ el: describe(el), cr: Math.round(cr * 100) / 100, need, text: text.slice(0, 24) });
        }
        const key = `fg:${fg.rgb.join(',')}`;
        out.colors[key] = (out.colors[key] || 0) + 1;
      }
    }

    const clickable = el.matches('button,a,[role="button"],input,select,.ant-switch,.ant-btn');
    if (clickable && rect.width > 0 && rect.height < 44 && !el.closest(OVERLAY)) {
      out.smallTargets.push({ el: describe(el), w: Math.round(rect.width), h: Math.round(rect.height) });
    }
  }

  return out;
};

(async () => {
  const loginRes = await fetch(`${API}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  const cookieJar = (loginRes.headers.getSetCookie?.() ?? []).map((raw) => {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    return { name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: '127.0.0.1', path: '/' };
  });

  const browser = await chromium.launch();
  const findings = [];
  const consoleErrors = [];

  const run = async (routes, viewport, withAuth, label) => {
    const ctx = await browser.newContext({
      viewport,
      isMobile: viewport.width < 500,
      hasTouch: viewport.width < 500,
    });
    if (withAuth) await ctx.addCookies(cookieJar);
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`[${label}] ${msg.text().slice(0, 140)}`);
    });
    page.on('pageerror', (err) => consoleErrors.push(`[${label}] ${String(err).slice(0, 140)}`));

    for (const [route] of routes) {
      await page.goto(`${WEB}${route}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      const r = await page.evaluate(PROBE);
      findings.push({ label, route, viewport: `${viewport.width}x${viewport.height}`, ...r });
    }
    await ctx.close();
  };

  await run(ADMIN_ROUTES, { width: 1440, height: 900 }, true, 'desktop');
  await run(ADMIN_ROUTES.slice(0, 8), { width: 390, height: 844 }, true, 'mobile');
  await run(VOTE_ROUTES, { width: 1440, height: 900 }, false, 'vote-desktop');
  await run(VOTE_ROUTES, { width: 390, height: 844 }, false, 'vote-mobile');

  await browser.close();

  const total = (key) => findings.reduce((n, f) => n + f[key].length, 0);
  const lines = [];
  lines.push('================ 设计验收审计（Apple 风契约 v1） ================');
  lines.push('');
  lines.push(`横向溢出（应为 0）                    : ${findings.filter((f) => f.overflowX > 0).length} 页`);
  lines.push(`em-dash 违规（应为 0）                : ${total('emDash')}`);
  lines.push(`对比度不足（正文 <4.5:1）             : ${total('lowContrast')}`);
  lines.push(`小触摸目标（<44px，仅移动端需关注）    : ${findings.filter((f) => f.label.includes('mobile') || f.label.includes('vote')).reduce((n, f) => n + f.smallTargets.length, 0)}`);
  lines.push(`控制台错误                            : ${consoleErrors.length}`);
  lines.push('');

  const detail = (key, n = 5) => {
    const rows = findings.filter((f) => f[key].length > 0);
    for (const f of rows.slice(0, n)) {
      lines.push(`  · ${f.label} ${f.route} (${f.viewport}): ${JSON.stringify(f[key].slice(0, 3))}`);
    }
  };
  lines.push('--- 溢出页 ---');
  for (const f of findings.filter((x) => x.overflowX > 0)) {
    lines.push(`  · ${f.label} ${f.route} (${f.viewport}): 溢出 ${f.overflowX}px`);
  }
  lines.push('--- em-dash 样例 ---');
  detail('emDash');
  lines.push('--- 对比度不足样例 ---');
  detail('lowContrast');
  lines.push('--- 移动端小触摸目标样例 ---');
  for (const f of findings.filter((x) => (x.label.includes('mobile') || x.label.includes('vote')) && x.smallTargets.length > 0).slice(0, 5)) {
    lines.push(`  · ${f.label} ${f.route}: ${JSON.stringify(f.smallTargets.slice(0, 3))}`);
  }
  lines.push('--- 控制台错误 ---');
  for (const e of consoleErrors.slice(0, 10)) lines.push(`  · ${e}`);

  const colorTotals = {};
  for (const f of findings) {
    for (const [k, n] of Object.entries(f.colors)) colorTotals[k] = (colorTotals[k] || 0) + n;
  }
  lines.push('');
  lines.push('--- 实际用到的颜色（出现次数 top 16） ---');
  for (const [k, n] of Object.entries(colorTotals).sort((a, b) => b[1] - a[1]).slice(0, 16)) {
    lines.push(`  ${k.padEnd(24)} ${n}`);
  }

  const report = lines.join('\n');
  fs.mkdirSync(path.join(__dirname, 'review'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'review', 'audit.txt'), report, 'utf8');
  console.log(report);
})().catch((e) => {
  console.error('[audit] 失败：', e);
  process.exit(1);
});