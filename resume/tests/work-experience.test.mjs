import test from 'node:test';
import assert from 'node:assert/strict';
import { formatWorkExperience } from '../src/lib/work-experience.mjs';

test('completed years change in the anniversary month, using Shanghai time', () => {
  assert.equal(formatWorkExperience('2018-04', new Date('2026-11-02T04:00:00Z')), '8 年');
  assert.equal(formatWorkExperience('2018-04', new Date('2027-01-01T00:00:00Z')), '8 年');
  assert.equal(formatWorkExperience('2018-04', new Date('2027-03-31T15:59:59Z')), '8 年');
  assert.equal(formatWorkExperience('2018-04', new Date('2027-03-31T16:00:00Z')), '9 年');
  assert.equal(formatWorkExperience('2024-02', new Date('2025-01-31T16:00:00Z')), '1 年');
});

test('less than one year and future starts never produce negative experience', () => {
  const now = new Date('2026-11-02T04:00:00Z');
  assert.equal(formatWorkExperience('2025-12', now), '0 年');
  assert.equal(formatWorkExperience('2026-11', now), '0 年');
  assert.equal(formatWorkExperience('2027-04', now), '0 年');
});

test('invalid metadata fails clearly instead of silently normalizing a wrong date', () => {
  for (const value of ['', '8 年', '2018', '2018-4', '2018-00', '2018-13', '2018-04-01', '0000-04']) {
    assert.throws(() => formatWorkExperience(value), /工作开始时间.*YYYY-MM/);
  }
});
