import test from 'node:test';
import assert from 'node:assert/strict';
import { githubUsername, contributionUrl, contributionCalendar } from '../src/lib/github-contributions.mjs';

test('GitHub account comes from the profile URL and rejects other hosts or paths', () => {
  assert.equal(githubUsername('https://github.com/QDyanbing/'), 'QDyanbing');
  assert.equal(githubUsername('https://example.com/QDyanbing'), null);
  assert.equal(githubUsername('https://github.com/QDyanbing/repository'), null);
  assert.equal(githubUsername(undefined), null);
  assert.equal(contributionUrl('QDyanbing'), 'https://github-contributions-api.jogruber.de/v4/QDyanbing?y=last');
});

test('calendar preserves real daily counts, uses UTC weekdays, and pads partial weeks', () => {
  const result = contributionCalendar({ contributions: [
    { date: '2024-03-01', count: 4, level: 2 },
    { date: '2024-02-28', count: 0, level: 0 },
    { date: '2024-02-29', count: 3, level: 1 },
  ] });
  assert.equal(result.total, 7);
  assert.equal(result.cells.length, 7);
  assert.equal(result.cells[0], null);
  assert.equal(result.cells[3].date, '2024-02-28');
  assert.equal(result.cells[4].date, '2024-02-29');
  assert.equal(result.cells[5].date, '2024-03-01');
  assert.equal(result.cells[6], null);
});

for (const [length, end] of [[368, '2026-11-04'], [369, '2026-11-05'], [370, '2026-11-06'], [371, '2026-11-07']]) {
  test(`last-year calendar accepts ${length} days across 53 weeks without truncating contributions`, () => {
    const contributions = Array.from({ length }, (_, index) => ({
      date: new Date(Date.UTC(2025, 10, 2) + index * 86_400_000).toISOString().slice(0, 10),
      count: index + 1,
      level: index % 5,
    }));
    const result = contributionCalendar({ contributions });
    assert.equal(result.days.length, length);
    assert.equal(result.weeks, 53);
    assert.equal(result.total, length * (length + 1) / 2);
    assert.equal(result.start, '2025-11-02');
    assert.equal(result.end, end);
    assert.equal(result.cells[length - 1].date, end);
    assert.equal(result.cells[length - 1].count, length);
    assert.ok(result.cells.slice(length).every((day) => day === null));
  });
}

for (const length of [372, 800]) {
  test(`${length} records in reverse order are cropped by date to the latest 53 weeks`, () => {
    const contributions = Array.from({ length }, (_, index) => {
      const date = new Date(Date.UTC(2026, 10, 5) - index * 86_400_000).toISOString().slice(0, 10);
      return { date, count: date < '2025-11-02' ? 1000 : 1, level: 1 };
    });
    const result = contributionCalendar({ contributions });
    assert.equal(result.start, '2025-11-02');
    assert.equal(result.end, '2026-11-05');
    assert.equal(result.weeks, 53);
    assert.equal(result.days.length, 369);
    assert.equal(result.total, 369);
    assert.equal(result.cells.filter(Boolean).length, 369);
    assert.equal(contributions[0].date, '2026-11-05', 'input order must remain unchanged');
  });
}

test('the displayed date range advances by a week on Sunday', () => {
  const result = contributionCalendar({ contributions: Array.from({ length: 372 }, (_, index) => ({
    date: new Date(Date.UTC(2025, 10, 2) + index * 86_400_000).toISOString().slice(0, 10),
    count: 1,
    level: 1,
  })) });
  assert.equal(result.start, '2025-11-09');
  assert.equal(result.end, '2026-11-08');
  assert.equal(result.weeks, 53);
  assert.equal(result.days.length, 365);
  assert.equal(result.total, 365);
});

test('irrelevant historical counts, gaps and duplicates do not invalidate displayed days', () => {
  const result = contributionCalendar({ contributions: [
    { date: '2023-01-01', count: -1, level: 8 },
    { date: '2023-01-01', count: null, level: null },
    { date: '2026-11-05', count: 3, level: 1 },
  ] });
  assert.equal(result.days.length, 1);
  assert.equal(result.start, '2026-11-05');
  assert.equal(result.end, '2026-11-05');
  assert.equal(result.total, 3);
});

test('empty, malformed, duplicated and incomplete calendars fail instead of implying zero contributions', () => {
  assert.throws(() => contributionCalendar({ contributions: [] }));
  assert.throws(() => contributionCalendar({ contributions: [null] }), /GitHub 贡献记录无效/);
  assert.throws(() => contributionCalendar({ contributions: [{ date: '2026-02-30', count: 1, level: 1 }] }));
  assert.throws(() => contributionCalendar({ contributions: [{ date: '2026-01-01', count: -1, level: 1 }] }));
  assert.throws(() => contributionCalendar({ contributions: [{ date: '2026-01-01', count: 1, level: 8 }] }));
  const day = { date: '2026-01-01', count: 1, level: 1 };
  assert.throws(() => contributionCalendar({ contributions: [day, day] }));
  assert.throws(() => contributionCalendar({ contributions: [day, { ...day, date: '2026-01-03' }] }));
});
