import MarkdownIt from 'markdown-it';

// Raw HTML is disabled. All personal content comes from the Markdown document.
const markdown = new MarkdownIt({ html: false, linkify: true, typographer: false });
const sectionIds = { 专业技能: 'skills', 教育背景: 'education', 工作经历: 'experience', 项目经历: 'projects' };

export function plainText(value) {
  return markdown.parseInline(value, {}).flatMap((token) => token.children ?? [])
    .map((token) => ['text', 'code_inline', 'image'].includes(token.type) ? token.content : token.type === 'softbreak' ? ' ' : '')
    .join('').trim();
}

export function renderMarkdown(value) {
  const tokens = markdown.parse(value, {});
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== 'paragraph_open') continue;
    const label = plainText(tokens[index + 1]?.content ?? '');
    if (/^(项目描述|技术栈|主要职责)[：:]$/.test(label)) {
      tokens[index].attrSet('class', 'field-label');
      if (/^技术栈/.test(label) && tokens[index + 3]?.type === 'paragraph_open') {
        tokens[index + 3].attrSet('class', 'technology');
      }
    }
  }
  return markdown.renderer.render(tokens, markdown.options, {});
}

function headings(source, level) {
  const tokens = markdown.parse(source, {});
  return tokens.flatMap((token, index) => token.type === 'heading_open' && token.tag === `h${level}`
    ? [{ title: tokens[index + 1].content, start: token.map[0], end: token.map[1] }] : []);
}

function parseEntries(source) {
  const lines = source.split('\n');
  const entries = headings(source, 3);
  return {
    introHtml: renderMarkdown(lines.slice(0, entries[0]?.start ?? lines.length).join('\n')),
    entries: entries.map((entry, index) => {
      const body = lines.slice(entry.end, entries[index + 1]?.start ?? lines.length).join('\n');
      const time = body.match(/^\*\*时间[：:]\*\*\s*(.+)$/m);
      const [title, ...subtitle] = plainText(entry.title).split(/[｜|]/);
      return {
        title: title.trim(),
        subtitle: subtitle.join(' · ').trim(),
        date: time ? plainText(time[1]) : '',
        html: renderMarkdown(time ? body.replace(time[0], '') : body),
      };
    }),
  };
}

export function parseResume(source) {
  const normalized = source.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const sections = headings(normalized, 2);
  if (!sections.length) throw new Error('简历需要至少一个二级标题（例如 ## 专业技能）。');
  const preamble = lines.slice(0, sections[0].start).join('\n');
  const fields = [];
  const summary = preamble.replace(/^#{1,3}\s+.*$/gm, '').replace(
    /^[-*]\s+\*\*([^\n*]+?)[：:]\*\*\s*(.+)$/gm,
    (_, label, value) => {
      const inline = markdown.parseInline(value, {})[0]?.children ?? [];
      const href = inline.find((token) => token.type === 'link_open')?.attrGet('href');
      fields.push({ label: label.trim(), value: plainText(value), html: markdown.renderInline(value), href });
      return '';
    },
  ).trim();
  const profile = Object.fromEntries(fields.map((field) => [field.label, field]));
  for (const required of ['姓名', '求职岗位']) {
    if (!profile[required]?.value) throw new Error(`简历基本信息缺少「${required}」字段。`);
  }
  const usedIds = new Map();
  return {
    name: profile.姓名.value,
    role: profile.求职岗位.value,
    profile,
    fields,
    summary: plainText(summary.replace(/\n+/g, ' ')),
    summaryHtml: renderMarkdown(summary),
    sections: sections.map((section, index) => {
      const title = plainText(section.title);
      const base = sectionIds[title] ?? `section-${title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-')}`;
      const occurrence = (usedIds.get(base) ?? 0) + 1;
      usedIds.set(base, occurrence);
      const body = lines.slice(section.end, sections[index + 1]?.start ?? lines.length).join('\n');
      return { id: occurrence === 1 ? base : `${base}-${occurrence}`, title, ...parseEntries(body) };
    }),
  };
}

export function jsonLd(resume, url) {
  const person = {
    '@type': 'Person',
    '@id': `${url}#person`,
    name: resume.name,
    jobTitle: resume.role,
    url,
    description: resume.summary,
    ...(resume.profile.邮箱 && { email: resume.profile.邮箱.value }),
    ...(resume.profile.所在城市 && { homeLocation: { '@type': 'Place', name: resume.profile.所在城市.value } }),
    ...(resume.profile.GitHub?.href && { sameAs: [resume.profile.GitHub.href] }),
  };
  return JSON.stringify({ '@context': 'https://schema.org', '@type': 'ProfilePage', url, mainEntity: person })
    .replace(/</g, '\\u003c');
}
