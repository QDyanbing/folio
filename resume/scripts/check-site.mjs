import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import MarkdownIt from 'markdown-it';
import { parseResume } from '../src/lib/resume.mjs';
import { githubUsername, contributionUrl } from '../src/lib/github-contributions.mjs';
import { serve } from './static-server.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = `${root}resume/dist`;
const screenshots = `${root}tmp/site-check`;
const source = await readFile(new URL('../高艳兵-个人简历.md', import.meta.url), 'utf8');
const resume = parseResume(source);
const entryCount = resume.sections.reduce((count, section) => count + section.entries.length, 0);
const lastSection = resume.sections.at(-1).id;
const username = githubUsername(resume.profile.GitHub?.href);
// Synthetic data is only used in browser tests; the website always requests the live API.
const contributionFixture = { contributions: Array.from({ length: 366 }, (_, index) => ({
  date: new Date(Date.UTC(2025, 10, 2) + index * 86_400_000).toISOString().slice(0, 10),
  count: index % 5,
  level: index % 5,
})) };
await mkdir(screenshots, { recursive: true });
const server = await serve(output);
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH && { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }),
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  if (username) await page.route(contributionUrl(username), (route) => route.fulfill({ json: contributionFixture }));
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.url, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  if (username) {
    await page.waitForSelector('[data-github-user][data-state="ready"]');
    assert.equal(await page.locator('.contributions-chart rect').count(), 366);
    assert.match(await page.locator('[data-total]').textContent(), /730/);
  }
  assert.equal(await page.locator('h1').textContent(), resume.name);
  assert.equal(await page.locator('article.resume-entry').count(), entryCount);
  assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), process.env.SITE_URL ? new URL('/', process.env.SITE_URL).href : 'https://gaoyanbing.com/');
  const schema = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent());
  assert.equal(schema.mainEntity.name, resume.name);
  if (resume.profile.GitHub?.href) assert.equal(schema.mainEntity.sameAs[0], resume.profile.GitHub.href);
  // Compare every substantial text token, including the last bullet, with the actual page.
  const visible = (await page.locator('main').innerText()).replace(/[\s｜|·：:]/g, '');
  const tokens = new MarkdownIt().parse(source, {}).flatMap((token) => token.children ?? []);
  for (const token of tokens.filter((token) => token.type === 'text' && token.content.trim().length >= 7)) {
    assert.ok(visible.includes(token.content.replace(/[\s｜|·：:]/g, '')), `正文缺失：${token.content}`);
  }
  await page.screenshot({ path: `${screenshots}/desktop.png` });
  await page.locator(`[id="${lastSection}"]`).scrollIntoViewIfNeeded();
  await page.locator(`[id="${lastSection}"]`).screenshot({ path: `${screenshots}/projects.png` });
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 90_000 }), page.locator('.download-button').click()]);
  assert.equal(download.suggestedFilename(), `${resume.name}-个人简历.pdf`);
  const pdf = await readFile(await download.path());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 10_000);
  await download.saveAs(`${screenshots}/resume.pdf`);
  await page.waitForFunction(() => !document.querySelector('#download-resume').disabled);
  // Verify click-time DOM capture, including a future async data component and canvas.
  await page.evaluate(() => {
    document.addEventListener('resume:before-export', (event) => {
      event.detail.waitUntil(new Promise((resolve) => setTimeout(() => {
        const content = document.querySelector('.resume-content');
        content.innerHTML = '<section class="resume-section"><h2>动态内容测试</h2><p style="font-size:28px;color:#c22;">LIVE PDF 2026 - 此内容仅在点击下载时插入</p><canvas width="200" height="80"></canvas></section>';
        const context = content.querySelector('canvas').getContext('2d');
        context.fillStyle = '#294f40'; context.fillRect(10, 10, 180, 60);
        resolve();
      }, 50)));
    }, { once: true });
  });
  const [dynamicDownload] = await Promise.all([page.waitForEvent('download', { timeout: 90_000 }), page.locator('.download-button').click()]);
  await dynamicDownload.saveAs(`${screenshots}/resume-dynamic.pdf`);
  assert.notDeepEqual(await readFile(await dynamicDownload.path()), pdf);
  await page.waitForFunction(() => !document.querySelector('#download-resume').disabled);
  assert.equal(await page.locator('.pdf-export').count(), 0);
  assert.equal((await fetch(`${server.url}/robots.txt`)).status, 200);
  assert.equal((await fetch(`${server.url}/sitemap.xml`)).status, 200);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(server.url, { waitUntil: 'networkidle' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px 页面存在横向溢出`);
    await page.screenshot({ path: `${screenshots}/mobile-${width}.png` });
    if (width === 390) {
      const [mobileDownload] = await Promise.all([page.waitForEvent('download', { timeout: 90_000 }), page.locator('.download-button').click()]);
      await mobileDownload.saveAs(`${screenshots}/resume-mobile.pdf`);
      await page.waitForFunction(() => !document.querySelector('#download-resume').disabled);
    }
  }
  const noScript = await browser.newContext({ javaScriptEnabled: false });
  const staticPage = await noScript.newPage();
  await staticPage.goto(server.url);
  assert.equal(await staticPage.locator('article.resume-entry').count(), entryCount);
  assert.equal(await staticPage.locator('#download-resume').isVisible(), false);
  await noScript.close();
  if (username) {
    // Export initiated before the API responds must wait for the actual chart.
    const waitingPage = await browser.newPage();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await waitingPage.route(contributionUrl(username), async (route) => { await gate; await route.fulfill({ json: contributionFixture }); });
    await waitingPage.goto(server.url, { waitUntil: 'domcontentloaded' });
    const delayedDownload = waitingPage.waitForEvent('download', { timeout: 90_000 });
    await waitingPage.locator('.download-button').click();
    assert.equal(await waitingPage.locator('.download-button').isDisabled(), true);
    assert.equal(await waitingPage.locator('[data-github-user]').getAttribute('data-state'), 'loading');
    release();
    await delayedDownload;
    assert.equal(await waitingPage.locator('.contributions-chart rect').count(), 366);
    await waitingPage.close();
    // An unavailable API shows a retry UI and recovers without reloading the page.
    const recoveryPage = await browser.newPage();
    let attempts = 0;
    await recoveryPage.route(contributionUrl(username), (route) => ++attempts === 1
      ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.fulfill({ json: contributionFixture }));
    await recoveryPage.goto(server.url);
    await recoveryPage.waitForSelector('[data-github-user][data-state="error"]');
    assert.equal(await recoveryPage.locator('.contributions-chart rect').count(), 0);
    await recoveryPage.locator('[data-retry]').click();
    await recoveryPage.waitForSelector('[data-github-user][data-state="ready"]');
    assert.equal(await recoveryPage.locator('.contributions-chart rect').count(), 366);
    await recoveryPage.close();
  }
  assert.deepEqual(errors, []);
  console.log('通过：全文完整性、SEO、结构化数据、即时 PDF、贡献热力图、等待数据后导出、接口失败重试、动态内容导出、390/320px 布局、禁用 JavaScript 阅读。');
  console.log(`截图：${screenshots}`);
} finally {
  await browser.close();
  await server.close();
}
