import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextOccurrence, taskLimits, validateRepeat } from '../src/host/computer/task-schedule.js'
const daily = { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai', missed: 'once' }
const next = (repeat, after) => new Date(nextOccurrence(repeat, Date.parse(after))).toISOString()
test('daily and weekly schedules preserve local wall time and choose strictly future occurrences', () => {
  assert.equal(next(daily, '2026-11-01T00:00Z'), '2026-11-01T01:00:00.000Z')
  assert.equal(next(daily, '2026-11-01T01:00Z'), '2026-11-02T01:00:00.000Z')
  assert.equal(next({ ...daily, kind: 'weekly', weekdays: [1, 5] }, '2026-11-02T02:00Z'), '2026-11-06T01:00:00.000Z')
  assert.equal(next({ ...daily, timeZone: 'Asia/Kathmandu' }, '2026-11-01T00:00Z'), '2026-11-01T03:15:00.000Z')
})
test('DST missing times skip the date, including weekly schedules a week away', () => {
  const spring = { ...daily, time: '02:30', timeZone: 'America/New_York' }
  assert.equal(next(spring, '2026-03-08T00:00Z'), '2026-03-09T06:30:00.000Z')
  assert.equal(next({ ...spring, kind: 'weekly', weekdays: [7] }, '2026-03-01T08:00Z'), '2026-03-15T06:30:00.000Z')
})
test('DST repeated wall time runs only at its first instant, never twice', () => {
  const fall = { ...daily, time: '01:30', timeZone: 'America/New_York' }
  assert.equal(next(fall, '2026-11-01T00:00Z'), '2026-11-01T05:30:00.000Z')
  assert.equal(next(fall, '2026-11-01T05:30Z'), '2026-11-02T06:30:00.000Z')
  assert.equal(next(fall, '2026-11-01T06:00Z'), '2026-11-02T06:30:00.000Z')
})
test('invalid recurrence and limits cannot silently use defaults', () => {
  for (const value of [null, [], {}, { ...daily, kind: 'monthly' }, { ...daily, time: '24:00' },
    { ...daily, timeZone: 'Unknown' }, { ...daily, missed: 'replay' }, { ...daily, weekdays: [1] },
    { ...daily, kind: 'weekly', weekdays: [] }, { ...daily, kind: 'weekly', weekdays: [1, 1] },
    { ...daily, kind: 'weekly', weekdays: [0] }, { ...daily, extra: true }]) assert.throws(() => validateRepeat(value))
  for (const value of [null, 0, -1, '60000', Infinity, 86400001]) assert.throws(() => taskLimits({ maxRunMs: value }))
  assert.deepEqual(taskLimits({}), { maxRunMs: 3600000, stallMs: 600000 })
})
