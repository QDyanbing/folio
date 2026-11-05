import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import MarkdownIt from 'markdown-it';
import { parseResume } from '../src/lib/resume.mjs';
import { githubUsername, contributionUrl } from '../src/lib/github-contributions.mjs';
import { formatWorkExperience } from '../src/lib/work-experience.mjs';
import { serve } from './static-server.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = `${root}resume/dist`;
const screenshots = `${root}tmp/site-check`;
const source = await readFile(new URL('../高艳兵-个人简历.md', import.meta.url), 'utf8');
const resume = parseResume(source);
const entryCount = resume.sections.reduce((count, section) => count + section.entries.length, 0);
const lastSection = resume.sections.at(-1).id;
const username = githubUsername(resume.profile.GitHub?.href);
const workStart = resume.profile.工作开始时间?.value;
const initialTime = new Date('2026-11-02T04:00:00Z');
// Synthetic data is only used in browser tests; the website always requests the live API.
// Extra history and reverse ordering must still produce the latest 53-week chart.
const contributionFixture = { contributions: Array.from({ length: 800 }, (_, index) => ({
  date: new Date(Date.UTC(2026, 10, 7) - index * 86_400_000).toISOString().slice(0, 10),
  count: index < 371 ? index % 5 : 1000,
  level: index % 5,
})) };

async function downloadSnapshot(page, filename) {
  // Inspect the actual DOM passed to html2pdf, not just the visible website.
  await page.evaluate(() => {
    window.__pdfSnapshot = null;
    const observer = new MutationObserver(() => {
      const snapshot = document.querySelector('.pdf-export');
      if (!snapshot) return;
      window.__pdfSnapshot = {
        contributionBlocks: snapshot.querySelectorAll('[data-github-user]').length,
        squares: snapshot.querySelectorAll('.contributions-chart rect').length,
        entries: snapshot.querySelectorAll('article.resume-entry').length,
        text: snapshot.textContent,
      };
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 45_000 }),
    page.locator('.download-button').click(),
  ]);
  const pdf = await readFile(await download.path());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 10_000);
  assert.equal(download.suggestedFilename(), `${resume.name}-个人简历.pdf`);
  await download.saveAs(`${screenshots}/${filename}.pdf`);
  await page.waitForFunction(() => !document.querySelector('#download-resume').disabled);
  assert.equal(await page.locator('.html2pdf__overlay').count(), 0);
  const snapshot = await page.evaluate(() => window.__pdfSnapshot);
  assert.ok(snapshot, '未捕获到实际 PDF 快照');
  assert.equal(snapshot.entries, entryCount, 'PDF 缺少简历经历');
  assert.ok(snapshot.text.includes(resume.name));
  return snapshot;
}

await mkdir(screenshots, { recursive: true });
const server = await serve(output);
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH && { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }),
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.clock.setFixedTime(initialTime);
  if (username) await page.route(contributionUrl(username), (route) => route.fulfill({ json: contributionFixture }));
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.url, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  if (username) {
    await page.waitForSelector('[data-github-user][data-state="ready"]');
    assert.equal(await page.locator('.contributions-chart rect').count(), 371);
    assert.equal(await page.locator('.contributions-chart rect').first().getAttribute('data-date'), '2025-11-02');
    assert.equal(await page.locator('.contributions-chart rect').last().getAttribute('data-date'), '2026-11-07');
    assert.match(await page.locator('[data-total]').textContent(), /740/);
  }
  assert.equal(await page.locator('h1').textContent(), resume.name);
  if (workStart) {
    assert.equal(await page.locator('[data-work-start]').getAttribute('data-work-start'), workStart);
    assert.equal(await page.locator('[data-work-start]').textContent(), formatWorkExperience(workStart, initialTime));
  }
  assert.equal(await page.locator('article.resume-entry').count(), entryCount);
  assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), process.env.SITE_URL ? new URL('/', process.env.SITE_URL).href : 'https://gaoyanbing.com/');
  const schema = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent());
  assert.equal(schema.mainEntity.name, resume.name);
  if (resume.profile.GitHub?.href) assert.equal(schema.mainEntity.sameAs[0], resume.profile.GitHub.href);
  // Compare every substantial text token, including the last bullet, with the actual page.
  const visible = (await page.locator('main').innerText()).replace(/[\s｜|·：:]/g, '');
  // The start-date metadata is rendered as calculated experience and checked separately.
  const printableSource = source.replace(/^- \*\*工作开始时间[：:]\*\*.*$/m, '');
  const tokens = new MarkdownIt().parse(printableSource, {}).flatMap((token) => token.children ?? []);
  for (const token of tokens.filter((token) => token.type === 'text' && token.content.trim().length >= 7)) {
    assert.ok(visible.includes(token.content.replace(/[\s｜|·：:]/g, '')), `正文缺失：${token.content}`);
  }
  await page.screenshot({ path: `${screenshots}/desktop.png` });
  await page.locator(`[id="${lastSection}"]`).scrollIntoViewIfNeeded();
  await page.locator(`[id="${lastSection}"]`).screenshot({ path: `${screenshots}/projects.png` });
  const anniversary = new Date('2027-03-31T16:00:00Z');
  if (workStart) {
    // The same built HTML must update when returning to the page in a later year.
    await page.clock.setFixedTime(anniversary);
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    assert.equal(await page.locator('[data-work-start]').textContent(), formatWorkExperience(workStart, anniversary));
    await page.clock.setFixedTime(initialTime);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    assert.equal(await page.locator('[data-work-start]').textContent(), formatWorkExperience(workStart, initialTime));
    // Advance the date without a lifecycle event: clicking download must refresh
    // the value before the actual PDF snapshot is rendered.
    await page.clock.setFixedTime(anniversary);
    await page.evaluate(() => {
      window.__exportedWorkExperience = null;
      const observer = new MutationObserver(() => {
        const field = document.querySelector('.pdf-export [data-work-start]');
        if (field) {
          window.__exportedWorkExperience = field.textContent;
          observer.disconnect();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 90_000 }), page.locator('.download-button').click()]);
  assert.equal(download.suggestedFilename(), `${resume.name}-个人简历.pdf`);
  const pdf = await readFile(await download.path());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 10_000);
  if (workStart) assert.equal(await page.evaluate(() => window.__exportedWorkExperience), formatWorkExperience(workStart, anniversary));
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
  if (workStart) assert.match(await staticPage.locator('[data-work-start]').textContent(), /^\d+ 年$/);
  await noScript.close();
  if (username) {
    // Export initiated before the API responds must wait for the actual chart.
    const waitingPage = await browser.newPage();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await waitingPage.route(contributionUrl(username), async (route) => { await gate; await route.fulfill({ json: contributionFixture }); });
    await waitingPage.goto(server.url, { waitUntil: 'domcontentloaded' });
    const delayedDownload = downloadSnapshot(waitingPage, 'resume-delayed-contributions');
    await waitingPage.waitForFunction(() => document.querySelector('#download-resume').disabled);
    assert.equal(await waitingPage.locator('.download-button').isDisabled(), true);
    assert.equal(await waitingPage.locator('[data-github-user]').getAttribute('data-state'), 'loading');
    release();
    const delayedSnapshot = await delayedDownload;
    assert.equal(delayedSnapshot.contributionBlocks, 1);
    assert.equal(delayedSnapshot.squares, 371);
    assert.equal(await waitingPage.locator('.contributions-chart rect').count(), 371);
    await waitingPage.close();
    // An unavailable API must not block a complete PDF or leave an empty card.
    const recoveryPage = await browser.newPage();
    recoveryPage.on('pageerror', (error) => errors.push(error.message));
    await recoveryPage.clock.setFixedTime(initialTime);
    let unavailable = true;
    await recoveryPage.route(contributionUrl(username), (route) => unavailable
      ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.fulfill({ json: contributionFixture }));
    await recoveryPage.goto(server.url);
    await recoveryPage.waitForSelector('[data-github-user][data-state="error"]');
    assert.equal(await recoveryPage.locator('.contributions-chart rect').count(), 0);
    const failedSnapshot = await downloadSnapshot(recoveryPage, 'resume-without-contributions');
    assert.equal(failedSnapshot.contributionBlocks, 0);
    assert.doesNotMatch(failedSnapshot.text, /暂时无法|正在加载 GitHub|重新加载/);
    assert.equal(await recoveryPage.locator('[data-retry]').isVisible(), true);
    // A later successful retry restores the chart in the next PDF.
    unavailable = false;
    await recoveryPage.locator('[data-retry]').click();
    await recoveryPage.waitForSelector('[data-github-user][data-state="ready"]');
    const recoveredSnapshot = await downloadSnapshot(recoveryPage, 'resume-recovered-contributions');
    assert.equal(recoveredSnapshot.contributionBlocks, 1);
    assert.equal(recoveredSnapshot.squares, 371);
    // If a later refresh fails, omit even the old chart from the PDF while
    // retaining the website's existing data and retry controls.
    unavailable = true;
    await recoveryPage.clock.setFixedTime(new Date(initialTime.getTime() + 6 * 60_000));
    const staleSnapshot = await downloadSnapshot(recoveryPage, 'resume-stale-contributions');
    assert.equal(staleSnapshot.contributionBlocks, 0);
    assert.equal(await recoveryPage.locator('[data-github-user]').getAttribute('data-state'), 'stale');
    assert.equal(await recoveryPage.locator('[data-calendar]').isVisible(), true);
    assert.equal(await recoveryPage.locator('[data-retry]').isVisible(), true);
    await recoveryPage.close();
    for (const failure of ['network', 'timeout']) {
      const failurePage = await browser.newPage();
      failurePage.on('pageerror', (error) => errors.push(error.message));
      // Withhold the response to exercise the real 12-second request timeout.
      await failurePage.route(contributionUrl(username), (route) => failure === 'network' ? route.abort('failed') : undefined);
      await failurePage.goto(server.url, { waitUntil: 'domcontentloaded' });
      const failedSnapshot = await downloadSnapshot(failurePage, `resume-contributions-${failure}`);
      assert.equal(failedSnapshot.contributionBlocks, 0);
      assert.doesNotMatch(failedSnapshot.text, /暂时无法|正在加载 GitHub|重新加载/);
      assert.equal(await failurePage.locator('[data-github-user]').getAttribute('data-state'), 'error');
      assert.equal(await failurePage.locator('[data-retry]').isVisible(), true);
      await failurePage.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log('通过：全文完整性、SEO、结构化数据、工作年限跨年刷新及 PDF 同步、即时 PDF、贡献热力图、等待数据后导出、贡献接口失败/断网/超时降级导出、失败重试恢复、过期图表排除、动态内容导出、390/320px 布局、禁用 JavaScript 阅读。');
  console.log(`截图：${screenshots}`);
} finally {
  await browser.close();
  await server.close();
}
