import { contributionCalendar, contributionUrl, CONTRIBUTION_COLORS } from './github-contributions.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FRESH_FOR = 5 * 60 * 1000;

function svgElement(tag: string, attributes: Record<string, string | number>, text?: string) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text) element.textContent = text;
  return element;
}

function renderCalendar(container: HTMLElement, calendar: ReturnType<typeof contributionCalendar>) {
  const chart = container.querySelector<HTMLElement>('[data-chart]')!;
  const total = container.querySelector<HTMLAnchorElement>('[data-total]')!;
  const left = 34;
  const top = 22;
  const step = 13;
  const size = 10;
  const width = left + calendar.weeks * step;
  const svg = svgElement('svg', {
    viewBox: `0 0 ${width} ${top + 7 * step}`,
    width,
    height: top + 7 * step,
    role: 'img',
    'aria-label': `${calendar.start} 至 ${calendar.end}，${calendar.total.toLocaleString('en-US')} 次 GitHub 贡献`,
  });
  const labelStyle = { fill: '#57606a', 'font-size': 10, 'font-family': 'Arial, sans-serif' };
  for (const month of calendar.months) {
    svg.append(svgElement('text', { x: left + month.week * step, y: 12, ...labelStyle }, month.label));
  }
  for (const [day, label] of [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']] as const) {
    svg.append(svgElement('text', { x: 0, y: top + day * step + 8, ...labelStyle }, label));
  }
  calendar.cells.forEach((day, index) => {
    if (!day) return;
    const square = svgElement('rect', {
      x: left + Math.floor(index / 7) * step,
      y: top + (index % 7) * step,
      width: size,
      height: size,
      rx: 2,
      fill: CONTRIBUTION_COLORS[day.level],
      stroke: day.level === 0 ? '#d4d8dd' : 'rgba(27,31,35,0.08)',
      'stroke-width': 0.5,
      'data-date': day.date,
      'data-count': day.count,
    });
    square.append(svgElement('title', {}, `${day.date}：${day.count} 次贡献`));
    svg.append(square);
  });
  chart.replaceChildren(svg);
  total.textContent = `近一年 ${calendar.total.toLocaleString('en-US')} 次贡献`;
  total.title = `${calendar.start} 至 ${calendar.end} · ${container.dataset.githubUser}`;
  container.querySelector<HTMLElement>('[data-calendar]')!.hidden = false;
  container.querySelector<HTMLElement>('[data-feedback]')!.hidden = true;
  container.dataset.state = 'ready';
  container.removeAttribute('data-pdf-exclude');
  const scroll = container.querySelector<HTMLElement>('.contributions-scroll')!;
  // Narrow screens initially show the most recent weeks; the PDF uses the full year.
  scroll.scrollLeft = scroll.scrollWidth;
}

export function setupContributions() {
  const container = document.querySelector<HTMLElement>('[data-github-user]');
  if (!container) return;
  const message = container.querySelector<HTMLElement>('[data-message]')!;
  const feedback = container.querySelector<HTMLElement>('[data-feedback]')!;
  const retry = container.querySelector<HTMLButtonElement>('[data-retry]')!;
  let pending: Promise<void> | null = null;
  let loadedAt = 0;
  feedback.hidden = false;

  function refresh(): Promise<void> {
    if (pending) return pending;
    if (loadedAt && Date.now() - loadedAt < FRESH_FOR) return Promise.resolve();
    container!.setAttribute('aria-busy', 'true');
    // Only a successful refresh makes this optional block part of the PDF.
    container!.setAttribute('data-pdf-exclude', '');
    retry.hidden = true;
    message.textContent = '正在加载 GitHub 贡献…';
    pending = (async () => {
      try {
        const response = await fetch(contributionUrl(container!.dataset.githubUser), {
          signal: AbortSignal.timeout(12_000), credentials: 'omit', referrerPolicy: 'no-referrer',
        });
        if (!response.ok) throw new Error(`GitHub 贡献接口返回 ${response.status}`);
        const calendar = contributionCalendar(await response.json());
        renderCalendar(container!, calendar);
        loadedAt = Date.now();
      } catch (error) {
        container!.dataset.state = loadedAt ? 'stale' : 'error';
        feedback.hidden = false;
        message.textContent = loadedAt ? '暂时无法更新，当前显示上次加载的贡献数据。' : '暂时无法加载 GitHub 贡献，请重试。';
        retry.hidden = false;
        throw error;
      } finally {
        container!.setAttribute('aria-busy', 'false');
        pending = null;
      }
    })();
    return pending;
  }

  retry.addEventListener('click', () => { void refresh().catch(() => {}); });
  document.addEventListener('resume:before-export', (event) => {
    const prepare = event as CustomEvent<{ waitUntil: (promise: Promise<unknown>) => void }>;
    // Failed or timed-out requests leave the whole block excluded, but must
    // not prevent the rest of the resume from downloading.
    prepare.detail.waitUntil(refresh().catch(() => {}));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh().catch(() => {});
  });
  void refresh().catch(() => {});
}
