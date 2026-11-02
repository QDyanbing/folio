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

test('empty, malformed, duplicated and incomplete calendars fail instead of implying zero contributions', () => {
  assert.throws(() => contributionCalendar({ contributions: [] }));
  assert.throws(() => contributionCalendar({ contributions: [{ date: '2026-02-30', count: 1, level: 1 }] }));
  assert.throws(() => contributionCalendar({ contributions: [{ date: '2026-01-01', count: -1, level: 1 }] }));
  assert.throws(() => contributionCalendar({ contributions: [{ date: '2026-01-01', count: 1, level: 8 }] }));
  const day = { date: '2026-01-01', count: 1, level: 1 };
  assert.throws(() => contributionCalendar({ contributions: [day, day] }));
  assert.throws(() => contributionCalendar({ contributions: [day, { ...day, date: '2026-01-03' }] }));
});
