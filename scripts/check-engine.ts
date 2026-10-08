/**
 * Plain checks for the decision logic. Run with: npx tsx scripts/check-engine.ts
 * No test framework needed; it throws on the first failure.
 */
import { buildSampleState } from '../src/data/sample'
import { engine } from '../src/engine/importance'
import { scoreCompletion } from '../src/engine/meaningful-work'
import { goalProgress, goalProgressChange, tasksForGoal } from '../src/engine/goals'
import { planDay } from '../src/engine/daily-plan'
import { isForToday, suggestable, suggestNext } from '../src/engine/next'
import { selectWeekReview, weekStartOf } from '../src/store/review'
import { countedCredits, netPoints } from '../src/engine/work-history'
import { isBlocked } from '../src/engine/relations'
import { addDays, todayISO, toISODate } from '../src/lib/dates'
import { reducer } from '../src/store/reducer'
import { goalFor, selectFocusTask, selectHome, selectReview } from '../src/store/selectors'
import type { AppState } from '../src/types'

let passed = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) throw new Error(`FAIL: ${name} ${detail}`)
  passed++
  console.log(`  ✓ ${name}${detail ? `  (${detail})` : ''}`)
}
const today = todayISO()
const rank = (s: AppState) =>
  engine.rank(
    s.tasks.filter((t) => t.status === 'open'),
    { state: s, today },
  )
const pos = (s: AppState, id: string) => rank(s).findIndex((r) => r.task.id === id)
const get = (s: AppState, id: string) => rank(s).find((r) => r.task.id === id)!

let s = buildSampleState()

console.log('Home')
const home = selectHome(s, today)
check('focus is the blueprint', home.focus?.task.id === 't-blueprint', home.focus?.reasons.join(' · '))
check('home list stays small', home.today.length <= 4, `${home.today.length} items`)
check(
  'no score numbers in labels',
  rank(s).every((r) => r.reasons.every((l) => !/\d+\.\d/.test(l))),
)

console.log('Quick wins')
check('10-minute trivial task is below the 90-minute high-impact task', pos(s, 't-tidy') > pos(s, 't-blueprint'))
check(
  '…and below the other meaningful work planned today',
  pos(s, 't-tidy') > pos(s, 't-ux'),
  `tidy #${pos(s, 't-tidy')}, review #${pos(s, 't-ux')}`,
)

console.log('Dependencies')
check(
  'blueprint explains it unlocks 2 other tasks',
  get(s, 't-blueprint').why.some((r) => r.short === 'Unlocks 2 other tasks'),
)
check('task model is blocked', get(s, 't-model').blocked)

console.log('Explanations')
check('waiting task is held out of suggestions', get(s, 't-announce').blocked)
check('Focus has full sentences', get(s, 't-blueprint').why.filter((r) => r.long).length >= 3)

console.log('Priority: user corrections')
const before = pos(s, 't-devenv')
s = reducer(s, { type: 'task/importance', id: 't-devenv', level: 'high', source: 'menu' })
check('marking important moves it up', pos(s, 't-devenv') < before, `#${before} → #${pos(s, 't-devenv')}`)
check(
  'importance change recorded',
  s.events.at(-1)?.type === 'task.importance_changed' && s.events.at(-1)?.data?.to === 'high',
)
const lowBefore = pos(s, 't-ux')
s = reducer(s, { type: 'task/importance', id: 't-ux', level: 'low', source: 'menu' })
check('marking not important moves it down', pos(s, 't-ux') > lowBefore)

console.log('Postpone')
s = reducer(s, { type: 'task/skip', id: 't-learn', plannedFor: addDays(today, 1), source: 'home', wasSuggested: false })
const learn = s.tasks.find((t) => t.id === 't-learn')!
check('postpone count goes up', learn.postponeCount === 1)
check(
  'skip and postpone both recorded',
  s.events
    .slice(-2)
    .map((e) => e.type)
    .join() === 'task.skipped,task.postponed',
)
check(
  'it leaves Today',
  !selectHome(s, today).today.some((r) => r.task.id === 't-learn') && selectHome(s, today).focus?.task.id !== 't-learn',
)

let r = buildSampleState()
r = reducer(r, {
  type: 'task/skip',
  id: 't-blueprint',
  plannedFor: addDays(today, 1),
  source: 'home',
  wasSuggested: true,
})
check(
  '"Not today" wins over a deadline',
  selectHome(r, today).focus?.task.id !== 't-blueprint',
  `now: ${selectHome(r, today).focus?.task.title}`,
)
check('…and counts as a postpone', r.tasks.find((t) => t.id === 't-blueprint')!.postponeCount === 1)

console.log('Completion')
const pre = s
const blueprint = s.tasks.find((t) => t.id === 't-blueprint')!
s = reducer(s, { type: 'task/complete', id: 't-blueprint', source: 'focus', wasSuggested: true })
const ev = s.workEvents.at(-1)!
check(
  'work event recorded with breakdown',
  ev.taskId === 't-blueprint' && ev.scoringVersion === 2 && !!ev.breakdown,
  `${ev.points} points`,
)
check(
  'dependents are now available',
  !isBlocked(
    s,
    s.tasks.find((t) => t.id === 't-model')!,
  ) &&
    !isBlocked(
      s,
      s.tasks.find((t) => t.id === 't-onboarding')!,
    ),
)
check('unblocked events recorded', s.events.filter((e) => e.type === 'task.unblocked').length === 2)
const next = suggestNext(s, today, blueprint, ['t-model', 't-onboarding'])
check(
  'next suggestion is newly unblocked work',
  ['t-model', 't-onboarding'].includes(next?.ranked.task.id ?? ''),
  `${next?.ranked.task.title} — ${next?.note}`,
)
check(
  'completion event knows it was suggested',
  s.events.find((e) => e.type === 'task.completed')?.wasSuggested === true,
)
void pre

console.log('Meaningful work and anti-gaming')
let g = buildSampleState()
const big = scoreCompletion(
  g.tasks.find((t) => t.id === 't-blueprint')!,
  g,
).points
const tiny = scoreCompletion(
  g.tasks.find((t) => t.id === 't-tidy')!,
  g,
).points
check('important work is worth far more than a trivial task', big > tiny * 4, `${big} vs ${tiny}`)
let farmed = 0
for (let i = 0; i < 20; i++) {
  g = reducer(g, { type: 'task/add', id: `farm-${i}`, task: { title: `Tiny ${i}`, plannedFor: today } })
  g = reducer(g, {
    type: 'task/update',
    id: `farm-${i}`,
    patch: { signals: { impact: 1, consequence: 1, userImportance: 'normal' }, effortMinutes: 5 },
  })
  g = reducer(g, { type: 'task/complete', id: `farm-${i}` })
  farmed += g.workEvents.at(-1)!.points
}
check(
  '20 tiny tasks are worth less than ~3 meaningful ones',
  farmed < big * 3,
  `20 tiny = ${farmed}, one real = ${big}`,
)
const lastFarm = g.workEvents.at(-1)!
check('repetition discount applies', lastFarm.breakdown!.repetition < 1, `x${lastFarm.breakdown!.repetition}`)

let inflated = buildSampleState()
const oneHigh = get(reducer(inflated, { type: 'task/importance', id: 't-devenv', level: 'high' }), 't-devenv').why.find(
  (r) => r.key === 'user-high',
)!.weight
for (const t of inflated.tasks.filter((t) => t.status === 'open'))
  inflated = reducer(inflated, { type: 'task/importance', id: t.id, level: 'high' })
const allHigh = get(inflated, 't-devenv').why.find((r) => r.key === 'user-high')!.weight
check(
  'marking everything important weakens each mark',
  allHigh < oneHigh / 2,
  `${oneHigh.toFixed(1)} → ${allHigh.toFixed(1)}`,
)

const effortCap = scoreCompletion({ ...g.tasks.find((t) => t.id === 't-ux')!, effortMinutes: 10000 }, g).breakdown
  .effort
check('inflated effort is capped', effortCap <= 1.45, `x${effortCap}`)

console.log('History is append-only')
{
  let h = buildSampleState()
  const eventsAtStart = h.events.length
  h = reducer(h, { type: 'task/importance', id: 't-ux', level: 'high', source: 'menu' })
  h = reducer(h, { type: 'task/complete', id: 't-ux' })
  const credit = h.workEvents.at(-1)!
  check(
    'completion adds a credit with a snapshot',
    credit.kind === 'credit' && credit.taskTitle === 'Review dashboard UX',
  )
  const pointsBefore = netPoints(h.workEvents)

  h = reducer(h, { type: 'task/reopen', id: 't-ux' })
  check(
    'reopening keeps the original WorkEvent',
    h.workEvents.some((e) => e.id === credit.id && e.points === credit.points),
  )
  const reversal = h.workEvents.at(-1)!
  check(
    'reopening appends a reversal instead',
    reversal.kind === 'reversal' && reversal.reverses === credit.id && reversal.points === -credit.points,
  )
  check('the reversed credit no longer counts', !countedCredits(h.workEvents).some((e) => e.id === credit.id))
  check('net total drops by exactly that credit', netPoints(h.workEvents) === pointsBefore - credit.points)

  h = reducer(h, { type: 'task/complete', id: 't-ux' })
  check(
    'completing again adds a fresh credit',
    countedCredits(h.workEvents).filter((e) => e.taskId === 't-ux').length === 1 &&
      h.workEvents.filter((e) => e.taskId === 't-ux').length === 3,
  )

  const logBeforeDelete = h.workEvents.length
  h = reducer(h, { type: 'task/delete', id: 't-ux' })
  check(
    'deleting a task keeps its WorkEvents',
    h.workEvents.length === logBeforeDelete && h.workEvents.some((e) => e.taskId === 't-ux'),
  )
  check(
    'deleted work still shows in the weekly review',
    selectReview(h, today).moved.some((m) => m.finished.some((f) => f.title === 'Review dashboard UX')),
  )
  const deleted = h.events.find((e) => e.type === 'task.deleted' && e.taskId === 't-ux')
  check('delete event keeps the task title', deleted?.data?.title === 'Review dashboard UX')
  const forTask = h.events.filter((e) => e.taskId === 't-ux').map((e) => e.type)
  check(
    'user corrections stay in the event history',
    h.events.length > eventsAtStart &&
      ['task.importance_changed', 'task.completed', 'task.reopened', 'task.deleted'].every((t) => forTask.includes(t)),
    forTask.join(', '),
  )
}

console.log('Explicit postponement is respected')
{
  const tomorrow = addDays(today, 1)
  let q = buildSampleState()
  q = reducer(q, { type: 'task/plan', id: 't-blueprint', plannedFor: tomorrow, source: 'menu' })
  const bp = q.tasks.find((t) => t.id === 't-blueprint')!
  check('due-today task moved to tomorrow is not "for today"', bp.dueOn === today && !isForToday(bp, today))
  check('…and is not the Home focus', selectHome(q, today).focus?.task.id !== 't-blueprint')
  check('…nor in the Home Today list', !selectHome(q, today).today.some((r) => r.task.id === 't-blueprint'))
  check('…nor what Focus opens', selectFocusTask(q, today)?.id !== 't-blueprint')
  check('…nor anywhere in suggestions', !suggestable(q, today).some((r) => r.task.id === 't-blueprint'))
  check(
    'it comes back on its planned day',
    selectHome(q, tomorrow).focus?.task.id === 't-blueprint',
    `tomorrow's focus: ${selectHome(q, tomorrow).focus?.task.title}`,
  )

  // suggestNext: a newly unblocked task the user planned for later stays put.
  let n = buildSampleState()
  n = reducer(n, { type: 'task/plan', id: 't-model', plannedFor: addDays(today, 3), source: 'menu' })
  n = reducer(n, { type: 'task/plan', id: 't-onboarding', plannedFor: addDays(today, 3), source: 'menu' })
  const bp2 = n.tasks.find((t) => t.id === 't-blueprint')!
  n = reducer(n, { type: 'task/complete', id: 't-blueprint' })
  const nx = suggestNext(n, today, bp2, ['t-model', 't-onboarding'])
  check(
    'suggestNext respects explicit postponement',
    !['t-model', 't-onboarding'].includes(nx?.ranked.task.id ?? ''),
    `suggested: ${nx?.ranked.task.title}`,
  )

  // A due-tomorrow task the user pushed further is not pulled back by suggestNext either.
  let d = buildSampleState()
  d = reducer(d, { type: 'task/plan', id: 't-monad-req', plannedFor: addDays(today, 4), source: 'menu' })
  d = reducer(d, { type: 'task/deadline', id: 't-monad-req', dueOn: tomorrow, source: 'editor' })
  const ux = d.tasks.find((t) => t.id === 't-ux')!
  d = reducer(d, { type: 'task/complete', id: 't-ux' })
  check(
    'suggestNext ignores a near deadline the user planned past',
    suggestNext(d, today, ux, [])?.ranked.task.id !== 't-monad-req',
  )
}

console.log('Phase 2: goals')
{
  let g = buildSampleState()
  const p0 = goalProgress(g, 'g-mvp')
  check(
    'goal progress is derived from linked work',
    p0.total > 0 && p0.done === g.tasks.filter((t) => t.projectId === 'p-myos' && t.status === 'done').length,
    `${p0.done}/${p0.total}`,
  )
  g = reducer(g, { type: 'task/complete', id: 't-ux' })
  const p1 = goalProgress(g, 'g-mvp')
  check(
    'completing linked work moves the goal',
    p1.done === p0.done + 1 && (p1.percent ?? 0) > (p0.percent ?? 0),
    `${p0.percent}% → ${p1.percent}%`,
  )
  check(
    'weekly change is measured from real completions',
    goalProgressChange(g, 'g-mvp', addDays(today, -7) + 'T00:00:00.000Z', new Date(Date.now() + 1000).toISOString()) >
      0,
  )
  // A task directly on a goal (no project) counts too.
  g = reducer(g, { type: 'task/add', id: 'direct', task: { title: 'Read Rust book', goalId: 'g-skills' } })
  check('tasks linked straight to a goal count', goalProgress(g, 'g-skills').total === 2)

  // Goal importance feeds the existing engine (no second engine).
  let e = buildSampleState()
  const before = get(e, 't-outreach').score
  e = reducer(e, { type: 'goal/update', id: 'g-income', patch: { importance: 'high' } })
  check(
    'a task serving an important goal ranks higher',
    get(e, 't-outreach').score > before,
    `${before.toFixed(1)} → ${get(e, 't-outreach').score.toFixed(1)}`,
  )
  e = reducer(e, { type: 'goal/update', id: 'g-income', patch: { targetDate: addDays(today, 3) } })
  check(
    '…and higher again when its goal is due soon',
    get(e, 't-outreach').why.some((r) => r.key === 'goal-target'),
  )
  e = reducer(e, { type: 'goal/status', id: 'g-income', status: 'paused' })
  check('a paused goal stops adding weight', !get(e, 't-outreach').why.some((r) => r.key.startsWith('goal')))
}

console.log('Phase 2: weekly review recommendations')
{
  let w = buildSampleState()
  const review = selectWeekReview(w, weekStartOf(today), today)
  check(
    'recommendations come from the engine, at most 3',
    review.recommendations.length > 0 && review.recommendations.length <= 3,
  )
  const first = review.recommendations[0].ranked.task.id
  const top = suggestable(w, today).filter((r) => !isForToday(r.task, today))[0].task.id
  check('…in the engine’s own order', first === top)
  w = reducer(w, {
    type: 'recommendation/decide',
    id: first,
    accepted: true,
    plannedFor: review.nextWeekStart,
    source: 'review',
  })
  check('accepting plans it for next week', w.tasks.find((t) => t.id === first)?.plannedFor === review.nextWeekStart)
  check('…and records the decision', w.events.at(-1)?.type === 'recommendation.accepted')
  const second = selectWeekReview(w, weekStartOf(today), today).recommendations.find((r) => r.decision === null)!.ranked
    .task.id
  const plannedBefore = w.tasks.find((t) => t.id === second)!.plannedFor
  w = reducer(w, { type: 'recommendation/decide', id: second, accepted: false, source: 'review' })
  check('rejecting changes nothing about the task', w.tasks.find((t) => t.id === second)!.plannedFor === plannedBefore)
  const after = selectWeekReview(w, weekStartOf(today), today)
  check(
    'rejected item is not suggested again this week',
    !after.recommendations.some((r) => r.ranked.task.id === second),
  )
  check(
    'accepted item stays visible as planned',
    after.recommendations.some((r) => r.ranked.task.id === first && r.decision === 'accepted'),
  )
}

console.log('Audit: goal lifecycle keeps relationships and history')
{
  let g = buildSampleState()
  g = reducer(g, { type: 'task/complete', id: 't-ux' })
  const work = g.workEvents.length
  const links = () => ({
    projects: g.projects.filter((p) => p.goalId === 'g-mvp').length,
    tasks: tasksForGoal(g, 'g-mvp').length,
    notes: g.notes.filter((n) => n.goalId === 'g-mvp').length,
  })
  const before = links()
  const progress = goalProgress(g, 'g-mvp')
  for (const status of ['paused', 'completed', 'archived', 'active'] as const) {
    g = reducer(g, { type: 'goal/status', id: 'g-mvp', status })
    const now = links()
    check(
      `→ ${status}: links and work history intact`,
      JSON.stringify(now) === JSON.stringify(before) &&
        g.workEvents.length === work &&
        goalProgress(g, 'g-mvp').done === progress.done,
    )
  }
  g = reducer(g, { type: 'goal/status', id: 'g-mvp', status: 'completed' })
  const completedAt = g.goals.find((x) => x.id === 'g-mvp')!.completedAt
  g = reducer(g, { type: 'goal/status', id: 'g-mvp', status: 'archived' })
  check(
    'archiving a completed goal keeps when it was completed',
    g.goals.find((x) => x.id === 'g-mvp')!.completedAt === completedAt && completedAt !== null,
  )
  g = reducer(g, { type: 'goal/status', id: 'g-mvp', status: 'active' })
  check(
    'restoring clears archived and completed dates',
    g.goals.find((x) => x.id === 'g-mvp')!.archivedAt === null &&
      g.goals.find((x) => x.id === 'g-mvp')!.completedAt === null,
  )
}

console.log('Audit: one rule for which goal a task serves')
{
  let g = buildSampleState()
  // A task in a project (goal g-mvp) that is also linked straight to another goal.
  g = reducer(g, { type: 'task/update', id: 't-ux', patch: { goalId: 'g-skills' } })
  const t = g.tasks.find((x) => x.id === 't-ux')!
  check('a direct goal link wins over the project’s goal', goalFor(g, t)?.id === 'g-skills')
  const counted = g.goals.reduce((n, goal) => n + tasksForGoal(g, goal.id).filter((x) => x.id === 't-ux').length, 0)
  check('…and the task is counted under exactly one goal', counted === 1)
  g = reducer(g, { type: 'task/update', id: 't-ux', patch: { goalId: null } })
  check(
    'clearing it falls back to the project’s goal',
    goalFor(
      g,
      g.tasks.find((x) => x.id === 't-ux')!,
    )?.id === 'g-mvp',
  )
}

console.log('Audit: weekly review over time')
{
  let r = buildSampleState()
  const thisWeek = weekStartOf(today)
  const lastWeek = addDays(thisWeek, -7)
  // The review uses the person's local weeks, so count with local dates too.
  const localDate = (iso: string) => toISODate(new Date(iso))
  const lastWeekDone = r.workEvents.filter((e) => localDate(e.at) >= lastWeek && localDate(e.at) < thisWeek).length
  check(
    'previous weeks can be reviewed',
    selectWeekReview(r, lastWeek, today).summary.completed === lastWeekDone,
    `${lastWeekDone} done last week`,
  )
  check('past weeks offer no recommendations', selectWeekReview(r, lastWeek, today).recommendations.length === 0)
  const before = selectWeekReview(r, thisWeek, today).goals.find((x) => x.goal.id === 'g-mvp')?.tasksCompleted ?? 0
  r = reducer(r, { type: 'task/complete', id: 't-ux' })
  r = reducer(r, { type: 'goal/status', id: 'g-mvp', status: 'completed' })
  const done = selectWeekReview(r, thisWeek, today).goals.find((x) => x.goal.id === 'g-mvp')
  check(
    'a goal completed this week still shows, marked completed',
    done?.completedThisWeek === true && done.tasksCompleted === before + 1,
  )
  const completedBeforeDelete = selectWeekReview(r, thisWeek, today).summary.completed
  r = reducer(r, { type: 'task/delete', id: 't-ux' })
  const afterDelete = selectWeekReview(r, thisWeek, today)
  check(
    'deleted work still counts in its week',
    afterDelete.summary.completed === completedBeforeDelete &&
      afterDelete.completed.some((c) => c.items.some((i) => i.title === 'Review dashboard UX')),
  )
  let n = buildSampleState()
  n = reducer(n, { type: 'project/add', id: 'fresh', title: 'Brand new project' })
  n = reducer(n, { type: 'task/add', task: { title: 'First step', projectId: 'fresh' } })
  n = reducer(n, { type: 'goal/add', id: 'fresh-goal', title: 'Brand new goal' })
  const flagged = selectWeekReview(n, thisWeek, today).attention.map((a) => a.key)
  check(
    'brand-new projects and goals are not flagged as stalled',
    !flagged.includes('project-fresh') && !flagged.includes('goal-fresh-goal'),
  )
}

console.log('Phase 3: intelligence')
{
  // Stalled project: MandiCrypt last moved 1 day ago in the sample; age it to 20 days.
  let st = buildSampleState()
  const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString()
  st = {
    ...st,
    projects: st.projects.map((p) => (p.id === 'p-mandi' ? { ...p, createdAt: ago(40) } : p)),
    workEvents: st.workEvents.map((e) => (e.projectId === 'p-mandi' ? { ...e, at: ago(20) } : e)),
  }
  check(
    'a quiet project is flagged as stalled',
    get(st, 't-outreach').why.some((r) => r.key === 'stalled' && r.short === 'Project has stalled'),
  )
  check('…but an active one is not', !get(st, 't-ux').why.some((r) => r.key === 'stalled'))
  let fresh = reducer(buildSampleState(), { type: 'project/add', id: 'p-new', title: 'New thing' })
  fresh = reducer(fresh, { type: 'task/add', id: 'nt', task: { title: 'First step', projectId: 'p-new' } })
  check('a brand-new project is never "stalled"', !get(fresh, 'nt').why.some((r) => r.key === 'stalled'))

  // Task age.
  let old = buildSampleState()
  old = {
    ...old,
    tasks: old.tasks.map((t) =>
      t.id === 't-devenv' ? { ...t, createdAt: new Date(Date.now() - 60 * 86_400_000).toISOString() } : t,
    ),
  }
  check(
    'long-open work gets a small, capped nudge',
    get(old, 't-devenv').why.some((r) => r.key === 'age' && r.weight <= 2),
  )

  // Deadline pressure and overdue.
  let dl = buildSampleState()
  dl = reducer(dl, { type: 'task/deadline', id: 't-devenv', dueOn: addDays(today, 2) })
  const near = get(dl, 't-devenv').score
  dl = reducer(dl, { type: 'task/deadline', id: 't-devenv', dueOn: addDays(today, 1) })
  const nearer = get(dl, 't-devenv').score
  dl = reducer(dl, { type: 'task/deadline', id: 't-devenv', dueOn: addDays(today, -2) })
  check('deadline pressure grows as the date approaches', nearer > near && get(dl, 't-devenv').score > nearer)
  check(
    'overdue work says so',
    get(dl, 't-devenv').reasons[0] === 'Overdue' || get(dl, 't-devenv').reasons.includes('Overdue'),
  )
  check(
    'reason wording: unlocks / postponed',
    get(buildSampleState(), 't-blueprint').why.some((r) => r.short === 'Unlocks 2 other tasks') &&
      get(buildSampleState(), 't-outreach').why.some((r) => r.short === 'Postponed 2 times'),
  )
}

console.log('Phase 3: daily plan')
{
  let p = buildSampleState()
  const plan = planDay(p, today)
  check('suggests a short list', plan.items.length >= 1 && plan.items.length <= 5, `${plan.items.length} items`)
  check(
    'every suggestion explains why',
    plan.items.every((i) => i.reason.length > 0),
  )
  check(
    'uses the engine’s order (no second priority system)',
    plan.items[0].task.id === suggestable(p, today).filter((r) => isForToday(r.task, today))[0].task.id,
  )
  check(
    'fits the time you have',
    plan.items.reduce((s, i) => s + i.minutes, 0) <= p.settings.dailyMinutes || plan.items.length === 1,
  )
  p = reducer(p, { type: 'settings/update', patch: { dailyMinutes: 60 } })
  const small = planDay(p, today)
  check(
    'less time → fewer items, and today’s planned work is flagged as too much',
    small.items.length < plan.items.length && small.overloaded,
  )
  p = buildSampleState()
  const first = planDay(p, today).items.find((i) => !isForToday(i.task, today)) ?? planDay(p, today).items[1]
  p = reducer(p, { type: 'plan/decide', id: first.task.id, accepted: true, today, source: 'home' })
  check(
    'accept: planned for today, recorded',
    isForToday(
      p.tasks.find((t) => t.id === first.task.id)!,
      today,
    ) && p.events.at(-1)?.type === 'plan.accepted',
  )
  check(
    '…and stays on the plan as accepted',
    planDay(p, today).items.some((i) => i.task.id === first.task.id && i.status === 'accepted'),
  )
  const second = planDay(p, today).items.find((i) => i.status === 'suggested')!
  p = reducer(p, { type: 'plan/decide', id: second.task.id, accepted: false, today, source: 'home' })
  check(
    'reject: gone from today’s plan, task unchanged',
    !planDay(p, today).items.some((i) => i.task.id === second.task.id),
  )
  const third = planDay(p, today).items.find((i) => i.status === 'suggested')!
  p = reducer(p, { type: 'task/skip', id: third.task.id, plannedFor: addDays(today, 1), source: 'home' })
  check(
    'postpone: moved to tomorrow, off today’s plan',
    !planDay(p, today).items.some((i) => i.task.id === third.task.id),
  )
  p = reducer(p, { type: 'task/complete', id: first.task.id })
  const after = planDay(p, today)
  check(
    'complete: shown as done, plan complete when every accepted item is done',
    after.items.some((i) => i.task.id === first.task.id && i.status === 'done') && after.complete,
  )
}

console.log('Cycles')
const c = reducer(buildSampleState(), { type: 'task/depend', id: 't-blueprint', on: 't-model' })
check('a dependency loop is refused', !c.tasks.find((t) => t.id === 't-blueprint')!.dependsOn.includes('t-model'))

console.log(`\nAll ${passed} checks passed.`)
