const DAY = 86_400_000;
const CALENDAR_WEEKS = 53;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const CONTRIBUTION_COLORS = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'];

export function githubUsername(href) {
  try {
    const url = new URL(href);
    const username = url.pathname.replace(/^\/+|\/+$/g, '');
    return url.hostname === 'github.com' && /^https?:$/.test(url.protocol)
      && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(username) ? username : null;
  } catch { return null; }
}

export function contributionUrl(username) {
  if (!githubUsername(`https://github.com/${username}`)) throw new Error('GitHub 用户名无效。');
  return `https://github-contributions-api.jogruber.de/v4/${encodeURIComponent(username)}?y=last`;
}

export function contributionCalendar(payload) {
  if (!Array.isArray(payload?.contributions) || !payload.contributions.length) {
    throw new Error('GitHub 贡献数据格式无效。');
  }
  const sortedDays = payload.contributions.map((day) => {
    const time = Date.parse(`${day?.date}T00:00:00Z`);
    if (typeof day?.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)
      || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== day.date) {
      throw new Error('GitHub 贡献记录无效。');
    }
    return { date: day.date, count: day.count, level: day.level, time };
  }).sort((left, right) => left.time - right.time);
  // Keep the latest 53 calendar weeks, including the partial last week.
  // Extra history from the API is harmless and does not affect the displayed total.
  const end = sortedDays.at(-1).time;
  const start = end - (new Date(end).getUTCDay() + (CALENDAR_WEEKS - 1) * 7) * DAY;
  const days = sortedDays.filter((day) => day.time >= start);
  if (days.some((day) => !Number.isSafeInteger(day.count) || day.count < 0
    || !Number.isInteger(day.level) || day.level < 0 || day.level > 4)) {
    throw new Error('GitHub 贡献记录无效。');
  }
  if (days.some((day, index) => index > 0 && day.time - days[index - 1].time !== DAY)) {
    throw new Error('GitHub 贡献日期缺失或重复。');
  }
  const offset = new Date(days[0].time).getUTCDay();
  const weeks = Math.ceil((offset + days.length) / 7);
  const months = [];
  for (let index = 0; index < days.length; index += 1) {
    const date = new Date(days[index].time);
    const week = Math.floor((offset + index) / 7);
    if ((index === 0 || date.getUTCDate() === 1)
      && (index === 0 || week >= months.at(-1).week + 3)
      && (index === 0 || week < weeks - 2)) {
      months.push({ label: MONTHS[date.getUTCMonth()], week });
    }
  }
  return {
    days,
    weeks,
    months,
    total: days.reduce((total, day) => total + day.count, 0),
    cells: Array.from({ length: weeks * 7 }, (_, index) => days[index - offset] ?? null),
    start: days[0].date,
    end: days.at(-1).date,
  };
}
