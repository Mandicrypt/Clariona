/**
 * Checks for the activity score and MYOS Rewards. Run with: npm run check:rewards
 */
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { verifyMessage } from 'viem'
import { buildSampleState } from '../src/data/sample'
import { mockModeAllowed } from '../src/rewards/config'
import { allAwards, activityBetween } from '../src/engine/activity'
import { ACTIVITY_RULES } from '../src/engine/activity-config'
import { emptyState } from '../src/store/persistence'
import { reducer, type Action } from '../src/store/reducer'
import { stampChanges } from '../src/store/timestamps'
import { REWARDS_CONFIG, type RewardsConfig } from '../src/rewards/config'
import { evaluateHolding, finalScore } from '../src/rewards/eligibility'
import { allocate, estimatedReward, rankCandidates, shortAddress, type Candidate } from '../src/rewards/leaderboard'
import { formatCountdown, msUntilSnapshot, periodAt, previousPeriod } from '../src/rewards/periods'
import { advance, canMove, takeSnapshot } from '../src/rewards/snapshot'
import { ChainHoldingVerifier, MockHoldingVerifier, TokenNotLaunchedError } from '../src/rewards/balance'
import { mockParticipants } from '../src/rewards/mock'
import { buildLinkMessage, parseLinkMessage, validateLinkMessage } from '../supabase/functions/_shared/link-message'
import type { AppState } from '../src/types'

let passed = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) throw new Error(`FAIL: ${name} ${detail}`)
  passed++
  console.log(`  ✓ ${name}${detail ? `  (${detail})` : ''}`)
}
const cfg = REWARDS_CONFIG
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()

/** A state where we control when tasks were created and completed. */
function world() {
  let s: AppState = emptyState()
  const go = (a: Action) => (s = stampChanges(s, reducer(s, a)))
  // Backdate a task and its "created" history entry together, like real data.
  const age = (id: string, minutesAgo: number) =>
    (s = {
      ...s,
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, createdAt: at(minutesAgo) } : t)),
      events: s.events.map((e) => (e.type === 'task.created' && e.taskId === id ? { ...e, at: at(minutesAgo) } : e)),
    })
  const add = (id: string, impact: 1 | 2 | 3 | 4 | 5 = 3, createdMinutesAgo = 600) => {
    go({ type: 'task/add', id, task: { title: id } })
    s = { ...s, tasks: s.tasks.map((t) => (t.id === id ? { ...t, signals: { ...t.signals, impact } } : t)) }
    age(id, createdMinutesAgo)
  }
  return { get: () => s, set: (n: AppState) => (s = n), go, add }
}
const total = (s: AppState) => allAwards(s).reduce((n, a) => n + a.points, 0)

async function main() {
  console.log('Activity score: what counts')
  {
    const w = world()
    w.add('normal', 3)
    w.go({ type: 'task/complete', id: 'normal' })
    check('normal task: +10', total(w.get()) === ACTIVITY_RULES.points.task)
    w.add('big', 5)
    w.go({ type: 'task/complete', id: 'big' })
    check('high-priority task: +15', total(w.get()) === 25)
    w.add('tiny', 1)
    w.go({ type: 'task/complete', id: 'tiny' })
    check('small task: +5', total(w.get()) === 30)
  }

  console.log('Activity score: anti-farming')
  {
    const w = world()
    w.add('quick', 3, 2) // created 2 minutes ago
    w.go({ type: 'task/complete', id: 'quick' })
    check('create-and-tick within 10 minutes earns nothing', total(w.get()) === 0, allAwards(w.get())[0]?.note)

    const r = world()
    r.add('flip', 3)
    r.go({ type: 'task/complete', id: 'flip' })
    for (let i = 0; i < 5; i++) {
      r.go({ type: 'task/reopen', id: 'flip' })
      r.go({ type: 'task/complete', id: 'flip' })
    }
    check('completing and reopening 6 times earns once', total(r.get()) === 10 && allAwards(r.get()).length === 1)
    r.go({ type: 'task/reopen', id: 'flip' })
    check('left reopened: earns nothing', total(r.get()) === 0)

    const f = world()
    for (let i = 0; i < 12; i++) {
      f.add(`t${i}`, 1)
      f.go({ type: 'task/complete', id: `t${i}` })
    }
    check(
      '12 tiny tasks: only 3 count',
      total(f.get()) === 3 * ACTIVITY_RULES.points.trivialTask,
      `${total(f.get())} pts`,
    )

    const c = world()
    for (let i = 0; i < 20; i++) {
      c.add(`n${i}`, 5)
      c.go({ type: 'task/complete', id: `n${i}` })
    }
    check(
      'daily task cap holds (20 big tasks)',
      total(c.get()) === ACTIVITY_RULES.limits.taskPointsPerDay,
      `${total(c.get())} pts`,
    )

    const d = world()
    d.add('del', 3)
    d.go({ type: 'task/complete', id: 'del' })
    d.go({ type: 'task/delete', id: 'del' })
    d.go({ type: 'task/add', id: 'del2', task: { title: 'del' } }) // recreated just now
    d.go({ type: 'task/complete', id: 'del2' })
    check('delete + recreate + complete at once earns nothing extra', total(d.get()) === 10)

    const dup = world()
    dup.add('x', 3)
    dup.go({ type: 'task/complete', id: 'x' })
    const replayed = {
      ...dup.get(),
      workEvents: [...dup.get().workEvents, ...dup.get().workEvents],
      events: [...dup.get().events, ...dup.get().events],
    }
    check('replayed / duplicated events count once', total(replayed) === 10)
    check('award ids are unique', new Set(allAwards(replayed).map((a) => a.id)).size === allAwards(replayed).length)
    const tampered = { ...dup.get(), workEvents: dup.get().workEvents.map((e) => ({ ...e, points: 99999 })) }
    check('a tampered "points" field changes nothing', total(tampered) === 10)
  }

  console.log('Activity score: focus, plan, review, streak, milestone, caps')
  {
    const w = world()
    w.add('a', 3)
    w.go({ type: 'focus/session', id: 'a', minutes: 25 })
    w.go({ type: 'focus/session', id: 'a', minutes: 30 })
    check('focus session ≥15 min: +5, once per task per day', total(w.get()) === 5)
    w.go({ type: 'focus/session', id: 'a', minutes: 8 })
    w.add('b', 3)
    w.go({ type: 'focus/session', id: 'b', minutes: 9 })
    check('short sessions earn nothing', total(w.get()) === 5)
    for (const id of ['c', 'd', 'e', 'f']) {
      w.add(id, 3)
      w.go({ type: 'focus/session', id, minutes: 40 })
    }
    check(`focus capped at ${ACTIVITY_RULES.limits.focusSessionsPerDay} per day`, total(w.get()) === 20)

    const today = new Date().toISOString().slice(0, 10)
    const p = world()
    p.add('p1', 3)
    p.add('p2', 3)
    const localToday = new Date().toLocaleDateString('en-CA')
    p.go({ type: 'plan/decide', id: 'p1', accepted: true, today: localToday })
    p.go({ type: 'plan/decide', id: 'p2', accepted: true, today: localToday })
    p.go({ type: 'task/complete', id: 'p1' })
    check('plan not complete until every accepted item is done', !allAwards(p.get()).some((a) => a.kind === 'plan'))
    p.go({ type: 'task/complete', id: 'p2' })
    check(
      'completed daily plan: +10',
      allAwards(p.get()).some((a) => a.kind === 'plan' && a.points === 10),
    )

    const r = world()
    r.go({ type: 'review/complete', week: today })
    r.go({ type: 'review/complete', week: today })
    check('weekly review: +25, once per week', total(r.get()) === 25 && r.get().events.length === 1)

    const st = world()
    st.add('y', 3, 3000)
    st.add('z', 3, 3000)
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    st.go({ type: 'task/complete', id: 'y' })
    st.set({ ...st.get(), workEvents: st.get().workEvents.map((e) => ({ ...e, at: yesterday })) })
    st.go({ type: 'task/complete', id: 'z' })
    check(
      'working two days in a row: streak +10',
      allAwards(st.get()).some((a) => a.kind === 'streak' && a.points === 10),
    )

    let m = buildSampleState()
    const mGo = (a: Action) => (m = stampChanges(m, reducer(m, a)))
    m = { ...m, tasks: m.tasks.map((t) => (t.milestoneId === 'm-prototype' ? t : t)) }
    const protoTasks = m.tasks.filter((t) => t.milestoneId === 'm-prototype').map((t) => t.id)
    for (const id of ['t-blueprint', ...protoTasks]) mGo({ type: 'task/complete', id })
    check(
      'finishing every task of a milestone: +30',
      allAwards(m).some((a) => a.kind === 'milestone' && a.label === 'Working prototype'),
      `${protoTasks.length} tasks`,
    )

    const cap = world()
    for (let i = 0; i < 12; i++) {
      cap.add(`k${i}`, 5)
      cap.go({ type: 'task/complete', id: `k${i}` })
      cap.go({ type: 'focus/session', id: `k${i}`, minutes: 30 })
    }
    cap.go({ type: 'review/complete', week: today })
    check(
      `all points per day capped at ${ACTIVITY_RULES.limits.pointsPerDay}`,
      total(cap.get()) <= ACTIVITY_RULES.limits.pointsPerDay,
      `${total(cap.get())} pts`,
    )
    const day = activityBetween(
      cap.get(),
      new Date(Date.now() - 86_400_000).toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    )
    check('period totals come from the same awards', day.total === total(cap.get()))
  }

  console.log('Eligibility and multiplier tiers')
  check('no wallet / nothing held: not eligible', !evaluateHolding(0, cfg).eligible)
  check(
    '$19.99: not eligible',
    !evaluateHolding(19.99, cfg).eligible && Math.abs(evaluateHolding(19.99, cfg).shortfallUsd - 0.01) < 1e-9,
  )
  check(
    'exactly $20: eligible at 1.00×',
    evaluateHolding(20, cfg).eligible && evaluateHolding(20, cfg).multiplier === 1,
  )
  const tiers: [number, number][] = [
    [49.99, 1],
    [50, 1.1],
    [99.99, 1.1],
    [100, 1.25],
    [249.99, 1.25],
    [250, 1.5],
    [499.99, 1.5],
    [500, 1.75],
    [999.99, 1.75],
    [1000, 2],
    [2499.99, 2],
    [2500, 2.25],
    [1_000_000, 2.25],
  ]
  check(
    'every tier boundary',
    tiers.every(([usd, m]) => evaluateHolding(usd, cfg).multiplier === m),
  )
  check(
    'the brief’s examples: 1,000 × 1.00 / 1.75 / 2.25',
    finalScore(1000, 1) === 1000 && finalScore(1000, 1.75) === 1750 && finalScore(1000, 2.25) === 2250,
  )
  const custom: RewardsConfig = {
    ...cfg,
    minimumUsd: 10,
    multiplierTiers: [
      { minUsd: 10, multiplier: 1 },
      { minUsd: 30, multiplier: 3 },
    ],
  }
  check(
    'tiers and minimum are configuration',
    evaluateHolding(15, custom).eligible && evaluateHolding(30, custom).multiplier === 3,
  )

  console.log('Leaderboard')
  const people: Candidate[] = [
    { userId: 'a', address: '0x' + 'a'.repeat(40), activityScore: 1000, holderUsd: 20 },
    { userId: 'b', address: '0x' + 'b'.repeat(40), activityScore: 1000, holderUsd: 500 },
    { userId: 'c', address: '0x' + 'c'.repeat(40), activityScore: 1000, holderUsd: 2500 },
    { userId: 'd', address: '0x' + 'd'.repeat(40), activityScore: 2000, holderUsd: 19 },
    { userId: 'e', address: '0x' + 'e'.repeat(40), activityScore: 1500, holderUsd: 20 },
  ]
  const ranked = rankCandidates(people, cfg)
  check(
    'ranked by final score, not activity',
    ranked.map((r) => r.userId).join('') === 'cbea',
    ranked.map((r) => `${r.userId}:${r.finalScore}`).join(' '),
  )
  check('below the minimum is not ranked, however active', !ranked.some((r) => r.userId === 'd'))
  check(
    'ties break the same way every time',
    rankCandidates([...people].reverse(), cfg)
      .map((r) => r.userId)
      .join('') === 'cbea',
  )
  check('addresses are shortened', shortAddress('0x82a3000000000000000000000000000000091af') === '0x82a3…91af')

  console.log('Top 10 and reward allocation')
  const crowd = rankCandidates(mockParticipants('daily'), cfg)
  const { allocations, unallocated } = allocate(crowd, cfg.pools.daily, cfg)
  check('only the top 10 are paid', allocations.length === 10 && allocations.every((a) => a.rank <= 10))
  check('amounts match the table', allocations.map((a) => a.amount).join(',') === '3,2,1.5,1,0.7,0.5,0.4,0.3,0.3,0.3')
  check(
    '…and add up to exactly 10 ZEC',
    Math.round(allocations.reduce((s, a) => s + a.amount, 0) * 1e8) === 10e8 && unallocated === 0,
  )
  const few = allocate(ranked, cfg.pools.daily, cfg)
  check(
    'fewer than 10 eligible: their shares stay in the pool',
    few.allocations.length === 4 && Math.abs(few.unallocated - 2.5) < 1e-9,
  )
  check(
    'estimated reward per rank',
    estimatedReward(1, cfg.pools.daily, cfg) === 3 && estimatedReward(11, cfg.pools.daily, cfg) === null,
  )
  check(
    'weekly pool not decided yet: no estimates invented',
    estimatedReward(1, cfg.pools.weekly, cfg) === null &&
      allocate(ranked, cfg.pools.weekly, cfg).allocations.length === 0,
  )
  let threw = false
  try {
    allocate(ranked, cfg.pools.daily, { ...cfg, distribution: [50, 30] })
  } catch {
    threw = true
  }
  check('a distribution that doesn’t add up to 100% is refused', threw)

  console.log('Periods and countdown')
  const monday = new Date('2026-10-05T15:30:00Z')
  const d1 = periodAt('daily', monday)
  check(
    'daily period is the UTC day',
    d1.startsAt === '2026-10-05T00:00:00.000Z' && d1.endsAt === '2026-10-06T00:00:00.000Z',
  )
  const w1 = periodAt('weekly', new Date('2026-10-11T23:59:59Z'))
  check(
    'weekly period is Monday–Sunday (UTC)',
    w1.startsAt === '2026-10-05T00:00:00.000Z' && w1.endsAt === '2026-10-12T00:00:00.000Z',
  )
  check('previous period', previousPeriod(d1).startsAt === '2026-10-04T00:00:00.000Z')
  check(
    'countdown counts down to the snapshot',
    formatCountdown(msUntilSnapshot(d1, monday)) === '08:30:00' &&
      msUntilSnapshot(d1, new Date('2026-10-07T00:00:00Z')) === 0,
  )

  console.log('Balances')
  let notLaunched = false
  try {
    await new ChainHoldingVerifier({ balanceOf: async () => 1n }, { usdPrice: async () => 1 }).verify('0xabc')
  } catch (e) {
    notLaunched = e instanceof TokenNotLaunchedError
  }
  check('real verification refuses to run before the token exists', notLaunched)
  const fakeToken = { chain: 'eip155:0', contractAddress: '0xtest', symbol: 'TEST', decimals: 18 }
  const chain = new ChainHoldingVerifier(
    { balanceOf: async () => 400n * 10n ** 18n },
    { usdPrice: async () => 0.25 },
    fakeToken,
  )
  const h = await chain.verify('0xabc')
  check('chain verifier: balance × price, labelled chain', h.usd === 100 && h.source === 'chain')
  const mockV = new MockHoldingVerifier(new Map([['0xabc', 250]]))
  check(
    'mock verifier is always labelled mock',
    (await mockV.verify('0xABC')).source === 'mock' && (await mockV.verify('0xABC')).usd === 250,
  )

  console.log('Snapshots')
  const period = periodAt('daily', new Date('2026-10-04T12:00:00Z'))
  const parts = mockParticipants('daily').map((p) => ({
    userId: p.userId,
    address: p.address,
    activityScore: p.activityScore,
  }))
  const holdings = new Map(mockParticipants('daily').map((p) => [p.address.toLowerCase(), p.holderUsd]))
  let early = false
  try {
    await takeSnapshot(period, parts, new MockHoldingVerifier(holdings), cfg, new Date('2026-10-04T20:00:00Z'))
  } catch {
    early = true
  }
  check('no snapshot before the period ends', early)
  const after = new Date('2026-10-05T00:00:05Z')
  const snap = await takeSnapshot(period, parts, new MockHoldingVerifier(holdings), cfg, after)
  check(
    'snapshot ranks with verified balances',
    snap.state === 'SNAPSHOT_TAKEN' && snap.entries.length > 10 && snap.balanceSource === 'mock',
  )
  let frozen = false
  try {
    ;(snap.entries[0] as { finalScore: number }).finalScore = 999999
  } catch {
    frozen = true
  }
  check('a taken snapshot is immutable', frozen && Object.isFrozen(snap.entries))
  holdings.set(snap.entries[0].address.toLowerCase(), 0)
  check('later balance changes don’t touch it', snap.entries[0].multiplier > 0)
  const configBefore = JSON.stringify(snap.config)
  ;(cfg.distribution as number[])[0] = 30 // same value, but proves the snapshot holds its own copy
  check('it keeps its own copy of the config', JSON.stringify(snap.config) === configBefore && snap.config !== cfg)
  let skipped = false
  try {
    advance(snap, 'DISTRIBUTED')
  } catch {
    skipped = true
  }
  check('states can’t be skipped', skipped && !canMove('DISTRIBUTED', 'UPCOMING'))
  const calc = advance(snap, 'CALCULATING')
  const pending = advance(calc, 'DISTRIBUTION_PENDING')
  const done = advance(pending, 'DISTRIBUTED')
  check(
    'states move forward to DISTRIBUTED with allocations',
    done.state === 'DISTRIBUTED' && done.allocations.length === 10 && done.distributedAt !== null,
  )
  check('…and the ranking never changes on the way', JSON.stringify(done.entries) === JSON.stringify(snap.entries))
  const dupes = [...parts.slice(0, 3), { ...parts[0], address: '0x' + '9'.repeat(40), activityScore: 99999 }]
  const dupSnap = await takeSnapshot(period, dupes, new MockHoldingVerifier(holdings), cfg, after)
  check(
    'wallet switching: one entry per user, second wallet ignored',
    dupSnap.entries.filter((e) => e.userId === parts[0].userId).length <= 1 &&
      !dupSnap.entries.some((e) => e.activityScore === 99999),
  )

  console.log('Mock mode can never become production behaviour')
  check('mock mode is off by default', mockModeAllowed(undefined, false) === false)
  check(
    'mock mode needs the explicit setting',
    mockModeAllowed('true', false) === true &&
      mockModeAllowed('yes', false) === false &&
      mockModeAllowed('1', false) === false,
  )
  check('a configured real token overrides a leftover mock setting', mockModeAllowed('true', true) === false)

  console.log('Hardening: wallet switching, duplicate wallets, backdating, duplicates, time zones')
  {
    const p = periodAt('daily', new Date('2026-10-04T12:00:00Z'))
    const h = new Map([
      ['0x' + 'a'.repeat(40), 100],
      ['0x' + 'b'.repeat(40), 2500],
    ])
    const v = new MockHoldingVerifier(h)
    const done = new Date('2026-10-05T00:00:05Z')
    const switched = await takeSnapshot(
      p,
      [
        {
          userId: 'steady',
          address: '0x' + 'a'.repeat(40),
          activityScore: 500,
          walletSelectedAt: '2026-09-01T00:00:00Z',
        },
        {
          userId: 'switcher',
          address: '0x' + 'b'.repeat(40),
          activityScore: 500,
          walletSelectedAt: '2026-10-04T23:00:00Z',
        },
      ],
      v,
      cfg,
      done,
    )
    check(
      'a wallet chosen during the period is left out of that snapshot',
      switched.entries.length === 1 && switched.entries[0].userId === 'steady',
    )
    check(
      '…with a clear reason recorded',
      switched.excluded?.[0]?.userId === 'switcher' && /changed during this period/.test(switched.excluded[0].reason),
    )
    const nextPeriod = periodAt('daily', new Date('2026-10-05T12:00:00Z'))
    const later = await takeSnapshot(
      nextPeriod,
      [
        {
          userId: 'switcher',
          address: '0x' + 'b'.repeat(40),
          activityScore: 500,
          walletSelectedAt: '2026-10-04T23:00:00Z',
        },
      ],
      v,
      cfg,
      new Date('2026-10-06T00:00:05Z'),
    )
    check('…and counts from the next period', later.entries.length === 1)
    const twice = await takeSnapshot(
      p,
      [
        { userId: 'one', address: '0x' + 'a'.repeat(40), activityScore: 300 },
        { userId: 'two', address: '0X' + 'A'.repeat(40), activityScore: 900 },
      ],
      v,
      cfg,
      done,
    )
    check(
      'one wallet can’t be entered by two accounts (any letter case)',
      twice.entries.length === 1 && twice.excluded?.length === 1,
    )

    const w = world()
    w.add('late', 3, 60 * 80) // created 80 hours ago
    w.go({ type: 'task/complete', id: 'late' })
    const fresh = total(w.get())
    const old = w.get().workEvents.at(-1)!
    w.set({
      ...w.get(),
      workEvents: w.get().workEvents.map((e) => (e.id === old.id ? { ...e, at: at(60 * 72), receivedAt: at(1) } : e)),
    })
    check('an event claiming to be 3 days old, received now, earns nothing', fresh === 10 && total(w.get()) === 0)
    w.set({
      ...w.get(),
      workEvents: w.get().workEvents.map((e) => (e.id === old.id ? { ...e, at: at(60 * 20), receivedAt: at(1) } : e)),
    })
    check('…while work synced after a day offline still counts', total(w.get()) === 10)

    const d = world()
    for (const id of ['copy-a', 'copy-b', 'copy-c']) {
      d.go({ type: 'task/add', id, task: { title: 'Reply to emails' } })
      d.set({
        ...d.get(),
        tasks: d.get().tasks.map((t) => (t.id === id ? { ...t, createdAt: at(600) } : t)),
        events: d.get().events.map((e) => (e.taskId === id && e.type === 'task.created' ? { ...e, at: at(600) } : e)),
      })
      d.go({ type: 'task/complete', id })
    }
    check('recreating the same task and ticking it again earns once a day', total(d.get()) === 10)

    check(
      'activity days are UTC days, the same on every device',
      allAwards(w.get()).every((a) => a.day === new Date(a.at).toISOString().slice(0, 10)),
    )
  }

  console.log('Wallet link message (signature checked by the server function)')
  const key = generatePrivateKey()
  const acct = privateKeyToAccount(key)
  const msg = buildLinkMessage({
    domain: 'myos-alpha.vercel.app',
    address: acct.address,
    userId: 'user-1',
    chainId: 1,
    issuedAt: new Date().toISOString(),
  })
  const sig = await acct.signMessage({ message: msg })
  const parsed = parseLinkMessage(msg)!
  const opts = { userId: 'user-1', allowedDomains: ['myos-alpha.vercel.app'], now: new Date() }
  check(
    'valid message passes',
    validateLinkMessage(parsed, opts) === null &&
      (await verifyMessage({ address: acct.address, message: msg, signature: sig })),
  )
  check('signed for another account: refused', validateLinkMessage(parsed, { ...opts, userId: 'user-2' }) !== null)
  check(
    'signed for another website: refused',
    validateLinkMessage(parsed, { ...opts, allowedDomains: ['evil.example'] }) !== null,
  )
  check(
    'old signature: refused',
    validateLinkMessage(parsed, { ...opts, now: new Date(Date.now() + 30 * 60_000) }) !== null,
  )
  const other = privateKeyToAccount(generatePrivateKey())
  const forged = await other.signMessage({ message: msg })
  check(
    'someone else’s signature for this wallet: refused',
    !(await verifyMessage({ address: acct.address, message: msg, signature: forged })),
  )

  console.log(`\nAll ${passed} reward checks passed.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
