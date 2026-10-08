/**
 * Checks for recurring tasks and ongoing goals. Run with: npm run check:recurrence
 * No browser, no database: pure logic, two simulated devices and an in-memory cloud that
 * enforces the same uniqueness and link rules as the real database.
 */
import { buildSampleState } from '../src/data/sample'
import { allAwards } from '../src/engine/activity'
import { ACTIVITY_RULES } from '../src/engine/activity-config'
import { goalProgress } from '../src/engine/goals'
import { engine } from '../src/engine/importance'
import { isForToday, suggestable } from '../src/engine/next'
import * as rec from '../src/engine/recurrence'
import { goalConsistency, goalDays, routinesForWeek } from '../src/engine/routines'
import { isUuid, newId } from '../src/lib/id'
import { MemoryRepository } from '../src/store/cloud/memory-repository'
import { rowsToState, stateToRows } from '../src/store/cloud/rows'
import { emptyState, migrateSaved, STATE_VERSION } from '../src/store/persistence'
import { reducer, type Action } from '../src/store/reducer'
import { CATCH_UP_DAYS, ensureOccurrences, LOOKAHEAD_DAYS, occurrenceTask } from '../src/store/recurring'
import { selectWeekReview, weekStartOf } from '../src/store/review'
import { selectTaskGroups } from '../src/store/selectors'
import { SyncController } from '../src/store/sync/controller'
import { prepareImport } from '../src/store/sync/import'
import { mergeStates } from '../src/store/sync/merge'
import { repairReferences } from '../src/store/sync/repair'
import { stampChanges } from '../src/store/timestamps'
import type { AppState, RecurrenceFrequency } from '../src/types'

const memory = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
}

let passed = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) throw new Error(`FAIL: ${name} ${detail}`)
  passed++
  console.log(`  ✓ ${name}${detail ? `  (${detail})` : ''}`)
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Thursday 8 October 2026, 09:00 UTC. */
const NOW = new Date('2026-10-08T09:00:00.000Z')
const TODAY = '2026-10-08'
const R = (
  frequency: RecurrenceFrequency,
  startsOn: string,
  extra: Partial<rec.RecurrenceRule> = {},
): rec.RecurrenceRule => ({
  frequency,
  interval: 1,
  daysOfWeek: [],
  dayOfMonth: null,
  startsOn,
  endsOn: null,
  ...extra,
})

function world(initial: AppState = emptyState()) {
  let s = initial
  return {
    get: () => s,
    set: (n: AppState) => (s = n),
    go: (a: Action) => (s = stampChanges(s, reducer(s, a))),
    ensure: (now: Date = NOW) => (s = ensureOccurrences(s, now)),
  }
}
type World = ReturnType<typeof world>

function addSeries(
  w: World,
  title: string,
  rule: rec.RecurrenceRule,
  o: { goalId?: string; projectId?: string; tz?: string; now?: Date } = {},
) {
  const taskId = newId()
  const id = newId()
  w.go({ type: 'task/add', id: taskId, task: { title, goalId: o.goalId ?? null, projectId: o.projectId ?? null } })
  w.go({
    type: 'series/create',
    id,
    fromTaskId: taskId,
    rule,
    timezone: o.tz ?? 'Africa/Lagos',
    now: (o.now ?? NOW).toISOString(),
  })
  return id
}
const occ = (s: AppState, sid: string, date: string) =>
  s.tasks.find((t) => t.recurrenceId === sid && t.occurrenceDate === date)
const taskPoints = (s: AppState) => allAwards(s).filter((a) => a.kind === 'task')
const total = (s: AppState) => taskPoints(s).reduce((n, a) => n + a.points, 0)

/** Completes an occurrence "at" a moment, the way the app would have recorded it. */
function finish(w: World, sid: string, date: string, at = `${date}T09:00:00.000Z`, tz = 'Africa/Lagos') {
  const t = occ(w.get(), sid, date)!
  w.go({ type: 'task/complete', id: t.id })
  const s = w.get()
  const last = s.workEvents.filter((e) => e.taskId === t.id && e.kind === 'credit').at(-1)!
  w.set({
    ...s,
    tasks: s.tasks.map((x) => (x.id === t.id ? { ...x, completedAt: at } : x)),
    workEvents: s.workEvents.map((e) => (e.id === last.id ? { ...e, at, localDay: rec.dateInTimeZone(at, tz) } : e)),
  })
}

async function main() {
  console.log('Daily')
  const daily = R('daily', '2026-10-08')
  check('every day from the start date', eq(rec.occurrenceDates(daily, '2026-10-08', '2026-10-14').length, 7))
  check(
    'nothing before the start date',
    eq(rec.occurrenceDates(R('daily', '2026-10-10'), '2026-10-08', '2026-10-14'), [
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
    ]),
  )
  check(
    'nothing after the end date',
    rec.occurrenceDates(R('daily', '2026-10-08', { endsOn: '2026-10-12' }), '2026-10-01', '2026-10-31').length === 5,
  )
  check(
    'every 3 days',
    eq(rec.occurrenceDates(R('daily', '2026-10-08', { interval: 3 }), '2026-10-08', '2026-10-14'), [
      '2026-10-08',
      '2026-10-11',
      '2026-10-14',
    ]),
  )
  check(
    'on the start date and the end date themselves',
    rec.occursOn(R('daily', '2026-10-08', { endsOn: '2026-10-08' }), '2026-10-08') &&
      !rec.occursOn(R('daily', '2026-10-08', { endsOn: '2026-10-08' }), '2026-10-09'),
  )

  console.log('Weekly')
  check(
    'chosen weekdays only (Mon, Wed, Fri)',
    eq(rec.occurrenceDates(R('weekly', '2026-10-05', { daysOfWeek: [0, 2, 4] }), '2026-10-05', '2026-10-11'), [
      '2026-10-05',
      '2026-10-07',
      '2026-10-09',
    ]),
  )
  check(
    'weekdays not chosen never occur',
    ![1, 3, 5, 6].some((d) =>
      rec
        .occurrenceDates(R('weekly', '2026-10-05', { daysOfWeek: [0, 2, 4] }), '2026-10-05', '2026-12-31')
        .some((x) => rec.weekdayOf(x) === d),
    ),
  )
  check(
    'every 2 weeks',
    eq(rec.occurrenceDates(R('weekly', '2026-10-05', { daysOfWeek: [0], interval: 2 }), '2026-10-05', '2026-11-08'), [
      '2026-10-05',
      '2026-10-19',
      '2026-11-02',
    ]),
  )
  check(
    'no weekday chosen means the start date’s weekday',
    eq(rec.occurrenceDates(R('weekly', '2026-10-07'), '2026-10-07', '2026-10-21'), [
      '2026-10-07',
      '2026-10-14',
      '2026-10-21',
    ]),
  )
  check(
    'starting mid-week skips the days before the start',
    eq(rec.occurrenceDates(R('weekly', '2026-10-07', { daysOfWeek: [0, 2, 4] }), '2026-10-05', '2026-10-16'), [
      '2026-10-07',
      '2026-10-09',
      '2026-10-12',
      '2026-10-14',
      '2026-10-16',
    ]),
  )
  check('Monday is 0 and Sunday is 6', rec.weekdayOf('2026-10-05') === 0 && rec.weekdayOf('2026-10-11') === 6)

  console.log('Monthly')
  check(
    'the 15th of each month',
    eq(rec.occurrenceDates(R('monthly', '2026-10-01', { dayOfMonth: 15 }), '2026-10-01', '2026-12-31'), [
      '2026-10-15',
      '2026-11-15',
      '2026-12-15',
    ]),
  )
  check(
    'the 31st uses the last day of shorter months',
    eq(rec.occurrenceDates(R('monthly', '2027-01-31', { dayOfMonth: 31 }), '2027-01-01', '2027-04-30'), [
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
      '2027-04-30',
    ]),
  )
  check(
    'February in a leap year',
    rec.occurrenceDates(R('monthly', '2028-01-31', { dayOfMonth: 31 }), '2028-02-01', '2028-02-29')[0] === '2028-02-29',
  )
  check(
    'every 2 months',
    eq(rec.occurrenceDates(R('monthly', '2026-10-31', { dayOfMonth: 31, interval: 2 }), '2026-10-01', '2027-03-31'), [
      '2026-10-31',
      '2026-12-31',
      '2027-02-28',
    ]),
  )
  check(
    'no day chosen means the start date’s day',
    eq(rec.occurrenceDates(R('monthly', '2026-10-30'), '2026-10-30', '2027-02-28'), [
      '2026-10-30',
      '2026-11-30',
      '2026-12-30',
      '2027-01-30',
      '2027-02-28',
    ]),
  )
  check(
    'next and previous occurrence',
    rec.nextOccurrence(R('weekly', '2026-10-05', { daysOfWeek: [0, 2, 4] }), '2026-10-09') === '2026-10-12' &&
      rec.previousOccurrence(R('weekly', '2026-10-05', { daysOfWeek: [0, 2, 4] }), '2026-10-12') === '2026-10-09',
  )
  check(
    'a finished series has no next occurrence',
    rec.nextOccurrence(R('daily', '2026-10-01', { endsOn: '2026-10-05' }), '2026-10-05') === null,
  )
  check(
    'described in plain words',
    rec.describeRule(daily) === 'Daily' &&
      rec.describeRule(R('weekly', '2026-10-05', { daysOfWeek: [0, 2], interval: 2 })) ===
        'Every 2 weeks on Mon, Wed' &&
      rec.describeRule(R('monthly', '2026-10-15')) === 'Monthly on day 15',
  )

  console.log('Occurrence identity')
  const sid = newId()
  check(
    'the same series and day always give the same id',
    rec.occurrenceId(sid, TODAY) === rec.occurrenceId(sid, TODAY),
  )
  check(
    'a different day or series gives a different id',
    rec.occurrenceId(sid, TODAY) !== rec.occurrenceId(sid, '2026-10-09') &&
      rec.occurrenceId(sid, TODAY) !== rec.occurrenceId(newId(), TODAY),
  )
  check('it is a valid UUID', isUuid(rec.occurrenceId(sid, TODAY)))
  check(
    '1,000 days give 1,000 different ids',
    new Set(Array.from({ length: 1000 }, (_, i) => rec.occurrenceId(sid, rec.addDaysTo('2026-01-01', i)))).size ===
      1000,
  )

  console.log('Generating occurrences: lazy, bounded, never twice')
  let w = world()
  const x = addSeries(w, 'Post on X', R('daily', TODAY))
  check(
    'creating the series makes today’s occurrence',
    occ(w.get(), x, TODAY)?.status === 'open' && occ(w.get(), x, TODAY)?.plannedFor === TODAY,
  )
  check('…and tomorrow’s, ready in advance', occ(w.get(), x, '2026-10-09') !== undefined)
  check('…but nothing further ahead (no thousands of future rows)', w.get().tasks.length === 1 + LOOKAHEAD_DAYS)
  const again = ensureOccurrences(w.get(), NOW)
  check('asking again makes nothing and returns the same state', again === w.get())
  const sameTwice = ensureOccurrences(
    ensureOccurrences(w.get(), new Date('2026-10-09T09:00:00Z')),
    new Date('2026-10-09T09:00:00Z'),
  )
  check('a new day makes exactly one more, however often it is asked', sameTwice.tasks.length === 3)
  let month = w.get()
  for (let i = 1; i <= 30; i++)
    month = ensureOccurrences(month, new Date(Date.parse('2026-10-08T09:00:00Z') + i * 86_400_000))
  check(
    '30 days of use gives about one per day, not an avalanche',
    month.tasks.length === 32,
    `${month.tasks.length} rows`,
  )
  const missedWeek = ensureOccurrences({ ...w.get(), tasks: [] }, new Date('2026-10-20T09:00:00Z'))
  check(
    'after a long break only a bounded catch-up is made',
    missedWeek.tasks.length <= CATCH_UP_DAYS + LOOKAHEAD_DAYS + 1,
    `${missedWeek.tasks.length} rows`,
  )
  const future = world()
  addSeries(future, 'Starts next year', R('daily', '2027-03-01'))
  check(
    'a series starting far ahead makes nothing early',
    future.get().tasks.every((t) => t.occurrenceDate === '2027-03-01') && future.get().tasks.length === 1,
  )
  check(
    'deterministic: another device builds the identical row',
    eq(occurrenceTask(w.get().series[0], '2026-10-09'), occurrenceTask(w.get().series[0], '2026-10-09')),
  )

  console.log('Completing and skipping')
  w = world()
  const post = addSeries(w, 'Post on X', R('daily', '2026-10-06'), { now: new Date('2026-10-08T09:00:00Z') })
  finish(w, post, '2026-10-08')
  check(
    'completing an occurrence leaves the others alone',
    occ(w.get(), post, '2026-10-08')?.status === 'done' && occ(w.get(), post, '2026-10-09')?.status === 'open',
  )
  check(
    'it is the same task, not recycled',
    w.get().tasks.filter((t) => t.occurrenceDate === '2026-10-08').length === 1,
  )
  w.go({ type: 'occurrence/skip', id: occ(w.get(), post, '2026-10-07')!.id })
  const skipped = occ(w.get(), post, '2026-10-07')!
  check(
    'skipping marks just that day',
    skipped.status === 'skipped' && occ(w.get(), post, '2026-10-09')?.status === 'open',
  )
  check('the series stays active', w.get().series[0].active)
  check(
    'a skipped occurrence earns nothing and leaves no work record',
    w.get().workEvents.every((e) => e.taskId !== skipped.id),
  )
  check('it is not made again', ensureOccurrences(w.get(), NOW) === w.get())
  check(
    'and it stays in history',
    w.get().tasks.some((t) => t.id === skipped.id),
  )
  check(
    'skipping is recorded',
    w.get().events.some((e) => e.type === 'occurrence.skipped' && e.taskId === skipped.id),
  )
  w.go({ type: 'task/reopen', id: skipped.id })
  check('a skip can be undone', occ(w.get(), post, '2026-10-07')?.status === 'open')

  console.log('Missed days')
  w = world()
  const miss = addSeries(w, 'Post on X', R('daily', '2026-10-06'), { now: new Date('2026-10-07T09:00:00Z') })
  w.ensure(new Date('2026-10-08T09:00:00Z'))
  const yesterday = occ(w.get(), miss, '2026-10-07')!
  check(
    'yesterday’s open occurrence is kept, not moved',
    yesterday.status === 'open' && yesterday.plannedFor === '2026-10-07' && occ(w.get(), miss, TODAY) !== undefined,
  )
  check('today has its own occurrence', occ(w.get(), miss, TODAY)?.plannedFor === TODAY)
  check(
    'yesterday’s is not part of today',
    !isForToday(yesterday, TODAY) && isForToday(occ(w.get(), miss, TODAY)!, TODAY),
  )
  check(
    'and is never suggested',
    !suggestable(w.get(), TODAY).some((r) => r.task.id === yesterday.id) &&
      suggestable(w.get(), TODAY).some((r) => r.task.id === occ(w.get(), miss, TODAY)!.id),
  )
  const groups = selectTaskGroups(w.get(), TODAY)
  check(
    'Tasks shows it under Missed',
    groups.missed.some((t) => t.id === yesterday.id) && !groups.today.some((r) => r.task.id === yesterday.id),
  )
  w.go({ type: 'task/plan', id: yesterday.id, plannedFor: TODAY, source: 'list' })
  check(
    'unless you chose to do it today, which wins',
    isForToday(
      w.get().tasks.find((t) => t.id === yesterday.id)!,
      TODAY,
    ),
  )

  console.log('Editing one occurrence, or the whole series')
  w = world()
  const ed = addSeries(w, 'Post on X', R('daily', '2026-10-06'), { now: new Date('2026-10-08T09:00:00Z') })
  finish(w, ed, '2026-10-06')
  const today = occ(w.get(), ed, TODAY)!
  w.go({ type: 'task/update', id: today.id, patch: { title: 'Post on X (thread)' } })
  check(
    'editing one occurrence leaves the series and the others alone',
    w.get().series[0].title === 'Post on X' && occ(w.get(), ed, '2026-10-09')?.title === 'Post on X',
  )
  w.go({
    type: 'series/update',
    id: ed,
    patch: { template: { title: 'Post on X and LinkedIn', effortMinutes: 30 } },
    now: NOW.toISOString(),
  })
  check(
    'editing the series updates today and later',
    occ(w.get(), ed, TODAY)?.title === 'Post on X and LinkedIn' &&
      occ(w.get(), ed, '2026-10-09')?.title === 'Post on X and LinkedIn' &&
      occ(w.get(), ed, TODAY)?.effortMinutes === 30,
  )
  check(
    'past occurrences stay exactly as they were',
    occ(w.get(), ed, '2026-10-06')?.title === 'Post on X' && occ(w.get(), ed, '2026-10-06')?.status === 'done',
  )
  const idsBefore = w
    .get()
    .tasks.map((t) => t.id)
    .sort()
  w.go({
    type: 'series/update',
    id: ed,
    patch: { rule: { frequency: 'weekly', daysOfWeek: [0, 4] } },
    now: NOW.toISOString(),
  })
  check(
    'changing the pattern removes later open days that no longer fit',
    occ(w.get(), ed, TODAY) === undefined &&
      occ(w.get(), ed, '2026-10-09') !== undefined &&
      occ(w.get(), ed, '2026-10-06')?.status === 'done',
    `${idsBefore.length} → ${w.get().tasks.length}`,
  )
  w.go({ type: 'series/stop', id: ed, now: NOW.toISOString() })
  check(
    'stopping keeps history and removes only later open days',
    !w.get().series[0].active &&
      occ(w.get(), ed, '2026-10-06')?.status === 'done' &&
      occ(w.get(), ed, '2026-10-09') === undefined,
  )
  check('a stopped series makes nothing new', ensureOccurrences(w.get(), new Date('2026-11-01T09:00:00Z')) === w.get())
  w.go({ type: 'series/delete', id: ed })
  check(
    'deleting a series keeps finished occurrences as ordinary tasks',
    w.get().series.length === 0 &&
      w
        .get()
        .tasks.some(
          (t) => t.title === 'Post on X' && t.status === 'done' && t.recurrenceId === null && t.occurrenceDate === null,
        ),
  )

  console.log('Rewards: legitimate recurrence earns, farming does not')
  const P = ACTIVITY_RULES.points
  const L = ACTIVITY_RULES.limits
  w = world()
  const days = ['2026-10-08', '2026-10-09', '2026-10-10']
  const rw = addSeries(w, 'Post on X', R('daily', '2026-10-08'), { now: new Date('2026-10-08T09:00:00Z') })
  for (const d of days) {
    w.ensure(new Date(`${d}T08:00:00Z`))
    finish(w, rw, d)
  }
  check(
    'three days of the same task each earn points',
    taskPoints(w.get()).filter((a) => a.points > 0).length === 3 && total(w.get()) === 3 * P.task,
    `${total(w.get())} points`,
  )
  check('each is on its own day', new Set(taskPoints(w.get()).map((a) => a.day)).size === 3)

  const one = world()
  const dup = addSeries(one, 'Post on X', R('daily', TODAY))
  finish(one, dup, TODAY)
  const first = total(one.get())
  one.go({ type: 'task/reopen', id: occ(one.get(), dup, TODAY)!.id })
  finish(one, dup, TODAY)
  check('complete, reopen, complete again earns once', total(one.get()) === first && first === P.task)
  const done = occ(one.get(), dup, TODAY)!
  one.go({ type: 'task/delete', id: done.id })
  check(
    'deleting a finished occurrence does not bring it back',
    ensureOccurrences(one.get(), NOW) === one.get() || occ(ensureOccurrences(one.get(), NOW), dup, TODAY) === undefined,
  )
  // The same occurrence reappears (a device or version that doesn't know): finishing it earns nothing more.
  const series0 = one.get().series[0]
  one.set({ ...one.get(), tasks: [...one.get().tasks, { ...occurrenceTask(series0, TODAY), id: newId() }] })
  finish(one, dup, TODAY)
  check('delete → recreate → complete earns nothing more', total(one.get()) === P.task, `${total(one.get())}`)
  check(
    '…and the repeat completion is recorded as worth 0',
    one
      .get()
      .workEvents.filter((e) => e.recurrenceId === dup && e.occurrenceDate === TODAY)
      .slice(-1)[0].points === 0,
  )
  for (let i = 0; i < 4; i++) {
    one.set({ ...one.get(), tasks: [...one.get().tasks, { ...occurrenceTask(series0, TODAY), id: newId() }] })
    finish(one, dup, TODAY)
  }
  check('doing it again and again all day still earns once', total(one.get()) === P.task)

  const plain = world()
  for (let i = 0; i < 4; i++) {
    const id = newId()
    plain.go({ type: 'task/add', id, task: { title: 'Post on X' } })
    plain.set({
      ...plain.get(),
      tasks: plain.get().tasks.map((t) => (t.id === id ? { ...t, createdAt: '2026-10-01T00:00:00.000Z' } : t)),
    })
    plain.go({ type: 'task/complete', id })
  }
  check('ordinary same-title tasks are still limited to once a day', total(plain.get()) <= P.task)

  const late = world()
  const lt = addSeries(late, 'Post on X', R('daily', '2026-10-06'), { now: new Date('2026-10-08T09:00:00Z') })
  finish(late, lt, '2026-10-07', '2026-10-08T09:00:00.000Z') // yesterday's, done today
  check('finishing a missed day later earns nothing', total(late.get()) === 0)
  finish(late, lt, '2026-10-09', '2026-10-08T09:00:00.000Z') // tomorrow's, ticked in advance
  check('ticking tomorrow’s in advance earns nothing', total(late.get()) === 0)
  check(
    '…and says why',
    taskPoints(late.get()).every((a) => a.note === 'Done on a different day than its date'),
  )
  finish(late, lt, '2026-10-08')
  check('doing today’s still earns', total(late.get()) === P.task)

  const lag = world()
  const lg = addSeries(lag, 'Post on X', R('daily', '2026-10-09'), {
    tz: 'Africa/Lagos',
    now: new Date('2026-10-08T23:30:00Z'),
  })
  finish(lag, lg, '2026-10-09', '2026-10-08T23:30:00.000Z', 'Africa/Lagos')
  check(
    '00:30 in Lagos counts as Lagos’s new day, even though it is still yesterday in UTC',
    total(lag.get()) === P.task,
  )

  const many = world()
  for (let i = 0; i < 40; i++) {
    const s = addSeries(many, `Habit ${i}`, R('daily', TODAY))
    finish(many, s, TODAY)
  }
  check(
    'recurrence does not get around the daily limits',
    total(many.get()) === Math.min(40 * P.task, L.taskPointsPerDay),
    `${total(many.get())} of a ${L.taskPointsPerDay}-point cap`,
  )

  console.log('Ongoing goals and consistency')
  w = world()
  w.go({
    type: 'goal/add',
    id: 'ongoing',
    title: 'Maintain daily social media presence',
    importance: 'high',
    kind: 'ongoing',
    cadence: 'daily',
  })
  w.go({ type: 'goal/add', id: 'finite', title: 'Launch MYOS', kind: 'finite', targetDate: '2026-12-01' })
  const g = w.get().goals
  check(
    'an ongoing goal needs no target date',
    g[0].kind === 'ongoing' && g[0].targetDate === null && g[0].cadence === 'daily' && g[0].endsOn === null,
  )
  check(
    'a finite goal keeps its target date',
    g[1].kind === 'finite' && g[1].targetDate === '2026-12-01' && g[1].cadence === null,
  )
  w.go({ type: 'goal/update', id: 'ongoing', patch: { targetDate: '2027-01-01' } })
  const [xs, ls, ts] = ['Post on X', 'Post on LinkedIn', 'Post on Telegram'].map((t) =>
    addSeries(w, t, R('daily', '2026-10-02'), { goalId: 'ongoing', now: new Date('2026-10-02T09:00:00Z') }),
  )
  w.ensure(NOW)
  const all = [xs, ls, ts]
  check(
    'each routine is linked to the goal',
    w
      .get()
      .tasks.filter((t) => t.recurrenceId)
      .every((t) => t.goalId === 'ongoing'),
  )
  check(
    'catch-up fills in the recent days',
    occ(w.get(), xs, '2026-10-02') !== undefined && occ(w.get(), xs, '2026-10-09') !== undefined,
  )
  w.go({ type: 'occurrence/skip', id: occ(w.get(), ts, '2026-10-03')!.id })
  for (const d of ['2026-10-03']) for (const s of [xs, ls]) finish(w, s, d)
  for (const d of ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']) for (const s of all) finish(w, s, d)
  finish(w, xs, '2026-10-08')
  const c = goalConsistency(w.get(), 'ongoing', TODAY)
  check('today: 1 of 3 done', c.today.done === 1 && c.today.total === 3, `${c.today.done}/${c.today.total}`)
  check(
    'this week: 3 complete days out of 4 so far (Mon–Thu)',
    c.week.complete === 3 && c.week.of === 4,
    `${c.week.complete}/${c.week.of}`,
  )
  check(
    'streak: 4 days (today unfinished neither counts nor breaks it; the skipped day ends it)',
    c.streak === 4,
    `${c.streak}`,
  )
  check('last completed: today', c.lastCompleted === TODAY, String(c.lastCompleted))
  check('three routines are active', c.activeRoutines === 3)
  const grid = goalDays(w.get(), 'ongoing', '2026-10-02', TODAY, TODAY)
  check(
    'the calendar shows missed, partial (skipped), done and today in progress',
    eq(
      grid.map((d) => d.state),
      ['missed', 'partial', 'done', 'done', 'done', 'done', 'partial'],
    ),
    grid.map((d) => d.state).join(' '),
  )
  const wk = routinesForWeek(w.get(), '2026-10-05', TODAY)
  check(
    'weekly review: per routine, X 4 of 4 and the others 3 of 4',
    wk.find((r) => r.series.id === xs)?.done === 4 &&
      wk.find((r) => r.series.id === ls)?.done === 3 &&
      wk.every((r) => r.expected === 4),
  )
  const review = selectWeekReview(w.get(), weekStartOf(TODAY), TODAY)
  check('the review includes the routines', review.routines.length === 3)
  check('missed routine days are not counted as overdue tasks', review.summary.overdue === 0)
  check(
    '…nor listed as things needing attention',
    !review.attention.some((a) => a.taskId && w.get().tasks.find((t) => t.id === a.taskId)?.recurrenceId),
  )
  check('an ongoing goal has no percentage', goalProgress(w.get(), 'ongoing').percent === null)
  const wk2 = review.goals.find((x) => x.goal.id === 'ongoing')
  check('the review shows its consistency instead', wk2?.consistency?.of === 4 && wk2.consistency.complete === 3)

  const sk = world()
  sk.go({ type: 'goal/add', id: 'og', title: 'Routine', kind: 'ongoing', cadence: 'daily' })
  const only = addSeries(sk, 'Walk', R('daily', '2026-10-04'), { goalId: 'og', now: new Date('2026-10-04T09:00:00Z') })
  sk.ensure(NOW)
  for (const d of ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']) finish(sk, only, d)
  check(
    'four days in a row: a 4-day streak even before today is done',
    goalConsistency(sk.get(), 'og', TODAY).streak === 4,
  )
  finish(sk, only, TODAY)
  check('and 5 once today is done', goalConsistency(sk.get(), 'og', TODAY).streak === 5)
  const brk = world()
  brk.go({ type: 'goal/add', id: 'og', title: 'Routine', kind: 'ongoing', cadence: 'daily' })
  const bs = addSeries(brk, 'Walk', R('daily', '2026-10-04'), { goalId: 'og', now: new Date('2026-10-04T09:00:00Z') })
  brk.ensure(NOW)
  for (const d of ['2026-10-04', '2026-10-05', '2026-10-07']) finish(brk, bs, d) // 10-06 missed
  check('a missed day breaks the streak', goalConsistency(brk.get(), 'og', TODAY).streak === 1)
  const weeklyOnly = world()
  weeklyOnly.go({ type: 'goal/add', id: 'wg', title: 'Weekly habit', kind: 'ongoing', cadence: 'weekly' })
  const wsid = addSeries(weeklyOnly, 'Review analytics', R('weekly', '2026-09-28', { daysOfWeek: [0] }), {
    goalId: 'wg',
    now: new Date('2026-09-28T09:00:00Z'),
  })
  weeklyOnly.ensure(new Date('2026-10-05T09:00:00Z'))
  finish(weeklyOnly, wsid, '2026-09-28')
  finish(weeklyOnly, wsid, '2026-10-05')
  check(
    'a weekly routine isn’t broken by the days it isn’t due',
    goalConsistency(weeklyOnly.get(), 'wg', '2026-10-08').streak === 2,
  )
  const fin = world()
  fin.go({ type: 'goal/add', id: 'fg', title: 'Launch', kind: 'finite', targetDate: '2026-12-01' })
  fin.go({ type: 'task/add', id: 'ft1', task: { title: 'A', goalId: 'fg' } })
  fin.go({ type: 'task/add', id: 'ft2', task: { title: 'B', goalId: 'fg' } })
  fin.go({ type: 'task/complete', id: 'ft1' })
  const fr = addSeries(fin, 'Weekly update', R('weekly', TODAY), { goalId: 'fg' })
  finish(fin, fr, TODAY)
  const fp = goalProgress(fin.get(), 'fg')
  check('a finite goal behaves as before: 1 of 2, 50%', fp.done === 1 && fp.total === 2 && fp.percent === 50)
  check('…and its routines don’t inflate the count', fp.total === 2)

  console.log('Priorities and the daily plan use the same engine')
  const pe = world()
  pe.go({ type: 'goal/add', id: 'pg', title: 'Presence', kind: 'ongoing', cadence: 'daily', importance: 'normal' })
  // One routine that was missed all week, and one that was missed only yesterday.
  const ps = addSeries(pe, 'Post on X', R('daily', '2026-10-04'), {
    goalId: 'pg',
    now: new Date('2026-10-04T09:00:00Z'),
  })
  const ps2 = addSeries(pe, 'Post on LinkedIn', R('daily', '2026-10-07'), {
    goalId: 'pg',
    now: new Date('2026-10-07T09:00:00Z'),
  })
  pe.ensure(NOW)
  const todaysTask = occ(pe.get(), ps2, TODAY)!
  const ranked = engine.rank([todaysTask], { state: pe.get(), today: TODAY })[0]
  check(
    'today’s occurrence is suggested like any task',
    suggestable(pe.get(), TODAY).some((r) => r.task.id === todaysTask.id),
  )
  check(
    'it is explained as “Due today · Daily commitment”',
    eq(ranked.reasons, ['Due today', 'Daily commitment']),
    ranked.reasons.join(' · '),
  )
  pe.go({ type: 'goal/update', id: 'pg', patch: { importance: 'high' } })
  const imp = engine.rank([occ(pe.get(), ps2, TODAY)!], { state: pe.get(), today: TODAY })[0]
  check(
    'on an important ongoing goal: “Part of an important ongoing goal”',
    imp.reasons.includes('Part of an important ongoing goal'),
    imp.reasons.join(' · '),
  )
  const bad = engine.rank([occ(pe.get(), ps, TODAY)!], { state: pe.get(), today: TODAY })[0]
  check(
    'missing it several times this week is mentioned, in plain words',
    bad.why.some((r) => r.key === 'routine-missed' && /Missed 4 times this week/.test(r.short ?? '')),
    bad.reasons.join(' · '),
  )
  check(
    '…and only after several misses: one missed day adds no pressure',
    !imp.why.some((r) => r.key === 'routine-missed'),
  )
  const once = world()
  const os = addSeries(once, 'Post on X', R('daily', '2026-10-07'), { now: new Date('2026-10-07T09:00:00Z') })
  once.ensure(NOW)
  const oneMiss = engine.rank([occ(once.get(), os, TODAY)!], { state: once.get(), today: TODAY })[0]
  check('a single missed day (on its own) adds no pressure', !oneMiss.why.some((r) => r.key === 'routine-missed'))
  const plain2 = world()
  plain2.go({ type: 'task/add', id: 'pl', task: { title: 'Plain', plannedFor: TODAY, dueOn: TODAY } })
  const routineScore = engine.rank([occ(once.get(), os, TODAY)!], { state: once.get(), today: TODAY })[0].score
  const plainScore = engine.rank([plain2.get().tasks[0]], { state: plain2.get(), today: TODAY })[0].score
  check(
    'a routine is only nudged, never made dominant (small extra, same engine)',
    routineScore - plainScore <= 4 && routineScore >= plainScore,
    `${plainScore.toFixed(1)} vs ${routineScore.toFixed(1)}`,
  )

  console.log('Sync: two devices, offline, no duplicates')
  const repo = new MemoryRepository()
  const user = newId()
  const cloudNow = async () => rowsToState(await repo.load(user), STATE_VERSION)
  class Device {
    state: AppState
    sync: SyncController
    constructor(initial: AppState, base: AppState | null) {
      this.state = initial
      this.sync = new SyncController(
        {
          repo,
          userId: user,
          getState: () => this.state,
          applyMerge: (cloud, b) => (this.state = mergeStates(this.state, cloud, b)),
          listenToBrowser: false,
          pullEverySeconds: 3600,
        },
        base,
      )
    }
    do(a: Action) {
      this.state = stampChanges(this.state, reducer(this.state, a))
    }
    ensure(now: Date) {
      this.state = ensureOccurrences(this.state, now)
    }
  }
  const start = await cloudNow()
  const laptop = new Device(
    stampChanges(emptyState(), { ...emptyState(), settings: { ...emptyState().settings } }),
    start,
  )
  await laptop.sync.pull()
  const tId = newId()
  const sId = newId()
  laptop.do({ type: 'task/add', id: tId, task: { title: 'Post on X' } })
  laptop.do({
    type: 'series/create',
    id: sId,
    fromTaskId: tId,
    rule: R('daily', TODAY),
    timezone: 'Africa/Lagos',
    now: NOW.toISOString(),
  })
  check('laptop uploads the series and its occurrences', await laptop.sync.flush())
  const cloud1 = await cloudNow()
  check(
    'the cloud has the series with its rule and timezone',
    cloud1.series.length === 1 &&
      cloud1.series[0].frequency === 'daily' &&
      cloud1.series[0].timezone === 'Africa/Lagos' &&
      cloud1.series[0].startsOn === TODAY,
  )
  check(
    '…and today’s and tomorrow’s occurrences',
    cloud1.tasks.length === 2 && cloud1.tasks.every((t) => t.recurrenceId === sId),
  )
  const phone = new Device(cloud1, cloud1)
  phone.ensure(NOW)
  check(
    'the phone sees the series and today’s occurrence',
    phone.state.series[0]?.id === sId && occ(phone.state, sId, TODAY) !== undefined,
  )
  check('…and making today’s occurrence there adds no duplicate', phone.state.tasks.length === 2)
  phone.do({ type: 'task/complete', id: occ(phone.state, sId, TODAY)!.id })
  check('phone completes it and uploads', await phone.sync.flush())
  await laptop.sync.pull()
  laptop.ensure(NOW)
  check(
    'the laptop sees it done, with no duplicate made',
    occ(laptop.state, sId, TODAY)?.status === 'done' && laptop.state.tasks.length === 2,
  )
  check(
    'the completion remembers which occurrence it was',
    laptop.state.workEvents.some((e) => e.recurrenceId === sId && e.occurrenceDate === TODAY && e.localDay === TODAY),
  )

  const tomorrow = new Date('2026-10-09T09:00:00Z')
  laptop.ensure(tomorrow)
  phone.ensure(tomorrow)
  const nextA = occ(laptop.state, sId, '2026-10-10')
  const nextB = occ(phone.state, sId, '2026-10-10')
  check(
    'both devices make tomorrow’s occurrence independently, with the same id',
    nextA !== undefined && nextA.id === nextB?.id,
  )
  check('both upload without clashing', (await laptop.sync.flush()) && (await phone.sync.flush()))
  await laptop.sync.pull()
  await phone.sync.pull()
  const cloud2 = await cloudNow()
  check(
    'the cloud holds exactly one occurrence for that day',
    cloud2.tasks.filter((t) => t.occurrenceDate === '2026-10-10').length === 1,
  )
  check(
    'both devices end up identical',
    eq(laptop.state.tasks.map((t) => t.id).sort(), phone.state.tasks.map((t) => t.id).sort()),
  )
  check(
    'the completed one stayed completed everywhere',
    occ(laptop.state, sId, TODAY)?.status === 'done' && occ(phone.state, sId, TODAY)?.status === 'done',
  )

  repo.offline = true
  const offTask = newId()
  const offSeries = newId()
  phone.do({ type: 'task/add', id: offTask, task: { title: 'Read for 20 minutes' } })
  phone.do({
    type: 'series/create',
    id: offSeries,
    fromTaskId: offTask,
    rule: R('daily', '2026-10-09'),
    timezone: 'Africa/Lagos',
    now: tomorrow.toISOString(),
  })
  check(
    'offline: the upload fails but nothing is lost',
    !(await phone.sync.flush()) && phone.state.series.some((s) => s.id === offSeries),
  )
  const reloaded = migrateSaved(JSON.parse(JSON.stringify(phone.state)))!
  check(
    'offline: the series survives a reload',
    reloaded.series.some((s) => s.id === offSeries) &&
      eq(
        reloaded.series.find((s) => s.id === offSeries),
        phone.state.series.find((s) => s.id === offSeries),
      ),
  )
  repo.offline = false
  check('back online: it syncs', await phone.sync.pull())
  await laptop.sync.pull()
  check(
    'and appears on the other device without duplicates',
    laptop.state.series.some((s) => s.id === offSeries) &&
      laptop.state.tasks.filter((t) => t.recurrenceId === offSeries).length ===
        phone.state.tasks.filter((t) => t.recurrenceId === offSeries).length,
  )

  const rows = stateToRows(phone.state, user)
  const back = rowsToState(JSON.parse(JSON.stringify(rows)), STATE_VERSION)
  check(
    'series survive the trip to database rows and back',
    eq(
      back.series.find((s) => s.id === sId),
      phone.state.series.find((s) => s.id === sId),
    ),
  )
  check(
    '…as do occurrence links and the new history fields',
    back.tasks.every((t) =>
      eq(
        [t.recurrenceId, t.occurrenceDate],
        [
          phone.state.tasks.find((x) => x.id === t.id)!.recurrenceId,
          phone.state.tasks.find((x) => x.id === t.id)!.occurrenceDate,
        ],
      ),
    ) && back.workEvents.some((e) => e.recurrenceId === sId && e.localDay === TODAY),
  )
  check(
    '…and goal kinds',
    eq(
      rowsToState(stateToRows(w.get(), user), STATE_VERSION).goals.map((x) => [
        x.kind,
        x.cadence,
        x.endsOn,
        x.targetDate,
      ]),
      w.get().goals.map((x) => [x.kind, x.cadence, x.endsOn, x.targetDate]),
    ),
  )

  const orphanState = world()
  const og = addSeries(orphanState, 'Post on X', R('daily', TODAY))
  const copy = {
    ...occurrenceTask(orphanState.get().series[0], TODAY),
    id: newId(),
    createdAt: '2030-01-01T00:00:00.000Z',
  }
  const doubled = repairReferences({ ...orphanState.get(), tasks: [...orphanState.get().tasks, copy] })
  check(
    'if two ids ever exist for one day, the extra is removed',
    doubled.tasks.filter((t) => t.occurrenceDate === TODAY).length === 1,
  )
  const finishedWins = world()
  const fw = addSeries(finishedWins, 'Post on X', R('daily', TODAY))
  finish(finishedWins, fw, TODAY)
  const rival = {
    ...occurrenceTask(finishedWins.get().series[0], TODAY),
    id: newId(),
    createdAt: '2000-01-01T00:00:00.000Z',
  }
  const kept = repairReferences({ ...finishedWins.get(), tasks: [...finishedWins.get().tasks, rival] })
  check(
    '…and the finished one is the one kept',
    kept.tasks.filter((t) => t.occurrenceDate === TODAY).length === 1 &&
      kept.tasks.find((t) => t.occurrenceDate === TODAY)!.status === 'done',
  )
  const gone = repairReferences({ ...orphanState.get(), series: [] })
  check(
    'a series deleted elsewhere leaves its occurrences as ordinary tasks',
    gone.tasks.every((t) => t.recurrenceId === null && t.occurrenceDate === null) && og.length > 0,
  )

  console.log('Saved data and existing users')
  const v3 = JSON.parse(JSON.stringify(buildSampleState()))
  v3.version = 3
  delete v3.series
  for (const t of v3.tasks) {
    delete t.recurrenceId
    delete t.occurrenceDate
  }
  for (const gl of v3.goals) {
    delete gl.kind
    delete gl.cadence
    delete gl.endsOn
  }
  const up = migrateSaved(v3)!
  check(
    'an older save upgrades to the current version',
    up.version === STATE_VERSION && Array.isArray(up.series) && up.series.length === 0,
  )
  check(
    'existing tasks are not recurring',
    up.tasks.every((t) => t.recurrenceId === null && t.occurrenceDate === null),
  )
  check(
    'existing goals are finite, with their target dates',
    up.goals.every((x) => x.kind === 'finite' && x.cadence === null) && up.goals.some((x) => x.targetDate !== null),
  )
  check(
    'nothing was lost',
    up.tasks.length === v3.tasks.length &&
      up.goals.length === v3.goals.length &&
      up.workEvents.length === v3.workEvents.length,
  )
  check('an empty state is valid', emptyState().series.length === 0 && emptyState().version === STATE_VERSION)
  check(
    'the sample/demo state is valid',
    buildSampleState().version === STATE_VERSION && buildSampleState().series.length === 0,
  )
  const imp2 = prepareImport({
    ...emptyState(),
    series: [
      {
        ...world().get().series[0],
        ...({} as object),
        id: 'legacy-series',
        projectId: null,
        goalId: null,
        title: 'x',
        frequency: 'daily',
        interval: 1,
        daysOfWeek: [],
        dayOfMonth: null,
        startsOn: TODAY,
        endsOn: null,
        timezone: 'UTC',
        active: true,
        createdAt: NOW.toISOString(),
        effortMinutes: null,
        signals: { impact: 3, consequence: 2, userImportance: 'normal' },
        checklist: [],
        links: [],
      },
    ],
  })
  check('importing old data gives series proper ids', isUuid(imp2.series[0].id))

  console.log('Time zones and dates')
  const late1 = new Date('2026-10-08T23:30:00Z')
  check(
    'the same moment is different dates in different places',
    rec.dateInTimeZone(late1, 'UTC') === '2026-10-08' &&
      rec.dateInTimeZone(late1, 'Africa/Lagos') === '2026-10-09' &&
      rec.dateInTimeZone(late1, 'America/Los_Angeles') === '2026-10-08' &&
      rec.dateInTimeZone(late1, 'Pacific/Kiritimati') === '2026-10-09',
  )
  check(
    'an unknown timezone falls back safely',
    rec.dateInTimeZone(late1, 'Mars/Phobos') === '2026-10-08' && !rec.isValidTimeZone('Mars/Phobos'),
  )
  const tzw = world()
  const tzs = addSeries(tzw, 'Post on X', R('daily', '2026-10-09'), { tz: 'Africa/Lagos', now: late1 })
  check(
    'just before midnight UTC, Lagos already has its next day’s occurrence',
    occ(tzw.get(), tzs, '2026-10-09') !== undefined,
  )
  const la = world()
  const las = addSeries(la, 'Post on X', R('daily', '2026-10-08'), { tz: 'America/Los_Angeles', now: late1 })
  check(
    '…while Los Angeles is still on the 8th, with the 9th prepared',
    occ(la.get(), las, '2026-10-08')?.status === 'open',
  )
  const dstDays = rec.occurrenceDates(R('daily', '2026-10-30'), '2026-10-30', '2026-11-03')
  check(
    'clocks going back (1 Nov, New York) doesn’t repeat or skip a day',
    eq(dstDays, ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']),
  )
  const dstSpring = rec.occurrenceDates(R('daily', '2026-03-06'), '2026-03-06', '2026-03-10')
  check(
    'clocks going forward (8 Mar) doesn’t repeat or skip a day',
    eq(dstSpring, ['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']),
  )
  check(
    'a weekly rule keeps its weekday across the clock change',
    rec
      .occurrenceDates(R('weekly', '2026-10-26', { daysOfWeek: [0] }), '2026-10-26', '2026-11-16')
      .every((d) => rec.weekdayOf(d) === 0),
  )
  check(
    'a year boundary is fine',
    eq(rec.occurrenceDates(R('daily', '2026-12-30'), '2026-12-30', '2027-01-02'), [
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]),
  )

  console.log(`\nAll ${passed} recurrence checks passed.`)
}

main().catch((e) => {
  console.error(e.message ?? e)
  process.exit(1)
})
