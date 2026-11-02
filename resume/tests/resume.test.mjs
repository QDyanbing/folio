import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseResume, jsonLd, renderMarkdown } from '../src/lib/resume.mjs';

const actual = await readFile(new URL('../高艳兵-个人简历.md', import.meta.url), 'utf8');
const source = `# 个人简历
### 基本信息
- **姓名：** 测试原名
- **求职岗位：** 前端工程师
- **工作年限：** 8 年
- **GitHub：** [example](https://github.com/example)

擅长 **React**。

## 专业技能
- 组件设计与工程实践。

## 工作经历
### 示例公司｜前端工程师
**时间：** 2026-03 ~ 至今
- 负责研发与交付。
`;

test('current Markdown provides all profile fields, sections, and entries', () => {
  const resume = parseResume(actual);
  assert.ok(resume.name);
  assert.ok(resume.role);
  assert.equal(resume.sections.length, [...actual.matchAll(/^## /gm)].length);
  assert.equal(resume.sections.flatMap(({ entries }) => entries).length, [...actual.slice(actual.indexOf('\n## ')).matchAll(/^### /gm)].length);
  const fixture = parseResume(source);
  assert.equal(fixture.sections[1].entries[0].date, '2026-03 ~ 至今');
  assert.match(fixture.sections[1].entries[0].html, /负责研发与交付/);
});

test('content edits and additional sections flow through without template changes', () => {
  const edited = source.replace('测试原名', '测试姓名').replace('8 年', '9 年') + '\n## 个人文章\n\n新增内容测试。\n\n### 技术文章\n\n正文不应丢失。\n';
  const resume = parseResume(edited.replace(/\n/g, '\r\n'));
  assert.equal(resume.name, '测试姓名');
  assert.equal(resume.profile.工作年限.value, '9 年');
  assert.match(resume.sections.at(-1).introHtml, /新增内容测试/);
  assert.match(resume.sections.at(-1).entries[0].html, /正文不应丢失/);
  assert.equal(JSON.parse(jsonLd(resume, 'https://example.com/')).mainEntity.name, '测试姓名');
});

test('duplicate headings have distinct navigation anchors', () => {
  const resume = parseResume(source + '\n## 专业技能\n\n其他技能。\n');
  assert.equal(resume.sections.at(-1).id, 'skills-2');
});

test('missing required metadata fails clearly', () => {
  assert.throws(() => parseResume(source.replace(/^- \*\*姓名：\*\*.*\n/m, '')), /缺少「姓名」/);
});

test('raw HTML and script URLs are not executed; JSON-LD cannot close its script tag', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>\n\n[危险链接](javascript:alert(1))');
  assert.doesNotMatch(html, /<img|href="javascript:/);
  const resume = parseResume(source.replace('测试原名', '</script><script>alert(1)</script>'));
  assert.doesNotMatch(jsonLd(resume, 'https://example.com/'), /<\/script>/);
});
