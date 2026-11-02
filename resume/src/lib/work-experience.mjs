const calendar = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
});

// Metadata has month precision; completed years advance in the anniversary month.
export function formatWorkExperience(start, now = new Date()) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(start);
  if (!match || Number(match[1]) === 0) throw new Error('工作开始时间必须使用 YYYY-MM 格式，例如 2018-04。');
  const parts = Object.fromEntries(calendar.formatToParts(now).map(({ type, value }) => [type, value]));
  const months = (Number(parts.year) - Number(match[1])) * 12 + Number(parts.month) - Number(match[2]);
  return `${Math.max(0, Math.floor(months / 12))} 年`;
}
