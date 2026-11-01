import { refused } from './contract.js'
const DAY = 86400000
export function validateRepeat(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['kind', 'time', 'timeZone', 'weekdays', 'missed'].includes(key))
    || !['daily', 'weekly'].includes(value.kind) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time ?? '')
    || typeof value.timeZone !== 'string' || value.timeZone.length > 100
    || !['once', 'skip'].includes(value.missed)
    || (value.kind === 'daily' && value.weekdays !== undefined)
    || (value.kind === 'weekly' && (!Array.isArray(value.weekdays) || !value.weekdays.length || value.weekdays.length > 7
      || new Set(value.weekdays).size !== value.weekdays.length || value.weekdays.some(n => !Number.isInteger(n) || n < 1 || n > 7)))) {
    throw refused('invalid', 'Choose a daily or weekly schedule, time zone and missed-run policy.')
  }
  try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(0) }
  catch { throw refused('invalid', 'Choose a valid IANA time zone.') }
  return structuredClone(value)
}
function parts(time, zone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(time).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]))
}
const epoch = p => Date.UTC(p.year, p.month - 1, p.day, p.hour ?? 0, p.minute ?? 0, p.second ?? 0)
export function nextOccurrence(repeat, after) {
  validateRepeat(repeat)
  const local = parts(after, repeat.timeZone), [hour, minute] = repeat.time.split(':').map(Number)
  const day = Date.UTC(local.year, local.month - 1, local.day)
  for (let i = 0; i < 16; i++) {
    const date = new Date(day + i * DAY)
    if (repeat.kind === 'weekly' && !repeat.weekdays.includes(date.getUTCDay() || 7)) continue
    const wall = day + i * DAY + hour * 3600000 + minute * 60000
    // Both sides of a DST transition; choose the first instant of a repeated wall time.
    const offsets = new Set([-36, 0, 36].map(h => { const probe = wall + h * 3600000; return epoch(parts(probe, repeat.timeZone)) - probe }))
    const matches = [...offsets].map(offset => wall - offset).filter(time => epoch(parts(time, repeat.timeZone)) === wall).sort((a, b) => a - b)
    if (matches[0] > after) return matches[0]
  }
  throw refused('invalid', 'The next scheduled time could not be resolved.')
}
export function taskLimits(args) {
  const maxRunMs = args.maxRunMs === undefined ? 3600000 : args.maxRunMs, stallMs = args.stallMs === undefined ? 600000 : args.stallMs
  if (![maxRunMs, stallMs].every(n => Number.isSafeInteger(n) && n >= 60000 && n <= 86400000)) {
    throw refused('invalid', 'Task time limits must be between 1 minute and 24 hours.')
  }
  return { maxRunMs, stallMs }
}
