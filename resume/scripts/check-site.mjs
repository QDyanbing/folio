import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import MarkdownIt from 'markdown-it';
import { parseResume } from '../src/lib/resume.mjs';
import { serve } from './static-server.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = `${root}resume/dist`;
const screenshots = `${root}tmp/site-check`;
const source = await readFile(new URL('../高艳兵-个人简历.md', import.meta.url), 'utf8');
const resume = parseResume(source);
const entryCount = resume.sections.reduce((count, section) => count + section.entries.length, 0);
const lastSection = resume.sections.at(-1).id;
await mkdir(screenshots, { recursive: true });
const server = await serve(output);
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH && { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }),
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.url, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
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
  assert.equal(await staticPage.locator('#export-actions').isVisible(), false);
  assert.match(await staticPage.locator('noscript').innerText(), /打印/);
  await noScript.close();
  assert.deepEqual(errors, []);
  console.log('通过：全文完整性、SEO、结构化数据、即时 PDF 下载、动态内容导出、390/320px 布局、禁用 JavaScript 阅读。');
  console.log(`截图：${screenshots}`);
} finally {
  await browser.close();
  await server.close();
}
