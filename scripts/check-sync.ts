/**
 * Checks for cloud sync, using two simulated devices and an in-memory cloud
 * that returns Postgres-shaped values. Run with: npm run check:sync
 */
import { buildSampleState } from '../src/data/sample'
import { countedCredits, netPoints, reconcileWorkLog } from '../src/engine/work-history'
import { isUuid, newId } from '../src/lib/id'
import { MemoryRepository } from '../src/store/cloud/memory-repository'
import { rowsToState } from '../src/store/cloud/rows'
import { emptyState, migrateSaved, STATE_VERSION } from '../src/store/persistence'
import { reducer, type Action } from '../src/store/reducer'
import { SyncController } from '../src/store/sync/controller'
import { diffStates } from '../src/store/sync/diff'
import { prepareImport } from '../src/store/sync/import'
import { mergeStates } from '../src/store/sync/merge'
import { stampChanges } from '../src/store/timestamps'
import type { AppState } from '../src/types'

// No browser here: give the controller somewhere harmless to keep its memory.
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
const tick = (ms = 2) => new Promise((r) => setTimeout(r, ms))

/** One device: its own state, sync controller and device storage. */
class Device {
  state: AppState
  sync: SyncController
  constructor(repo: MemoryRepository, userId: string, initial: AppState, base: AppState | null) {
    this.state = initial
    this.sync = new SyncController(
      {
        repo,
        userId,
        getState: () => this.state,
        applyMerge: (cloud, b) => (this.state = mergeStates(this.state, cloud, b)),
        listenToBrowser: false,
        pullEverySeconds: 3600,
      },
      base,
    )
  }
  do(action: Action) {
    this.state = stampChanges(this.state, reducer(this.state, action))
  }
  task(title: string) {
    return this.state.tasks.find((t) => t.title === title)
  }
}

async function main() {
  const repo = new MemoryRepository()
  const user = newId()
  const cloudNow = async () => rowsToState(await repo.load(user), STATE_VERSION)

  console.log('New account and first sync')
  const firstCloud = await cloudNow()
  const laptop = new Device(
    repo,
    user,
    stampChanges(emptyState(), { ...emptyState(), settings: { ...emptyState().settings } }),
    firstCloud,
  )
  await laptop.sync.pull()
  check('settings row created', repo.count(user, 'settings') === 1)
  check('new account starts empty, no sample data', (await cloudNow()).tasks.length === 0)

  console.log('Create on laptop, appears on phone')
  const projectId = newId()
  laptop.do({ type: 'project/add', id: projectId, title: 'MYOS' })
  laptop.do({ type: 'task/add', task: { title: 'Finish Supabase integration', projectId } })
  check('laptop upload succeeds', await laptop.sync.flush())
  const phoneStart = await cloudNow()
  const phone = new Device(repo, user, phoneStart, phoneStart)
  check(
    'phone sees the project',
    phone.state.projects.some((p) => p.title === 'MYOS'),
  )
  check('phone sees the task linked to it', phone.task('Finish Supabase integration')?.projectId === projectId)

  console.log('Edit on phone, appears on laptop')
  const taskId = phone.task('Finish Supabase integration')!.id
  await tick()
  phone.do({ type: 'task/update', id: taskId, patch: { title: 'Finish MYOS cloud sync' } })
  await phone.sync.flush()
  await laptop.sync.pull()
  check('laptop shows the new title', laptop.task('Finish MYOS cloud sync')?.id === taskId)
  check('no duplicate task', laptop.state.tasks.length === 1)

  console.log('Conflicting edits: latest change wins everywhere')
  phone.do({ type: 'task/update', id: taskId, patch: { description: 'phone note' } })
  await tick(5)
  laptop.do({ type: 'task/update', id: taskId, patch: { description: 'laptop note (later)' } })
  await phone.sync.flush()
  await laptop.sync.pull()
  await phone.sync.pull()
  check('laptop keeps the later edit', laptop.state.tasks[0].description === 'laptop note (later)')
  check('phone gets the later edit', phone.state.tasks[0].description === 'laptop note (later)')

  console.log('Postgres round trip is stable')
  const writesBefore = repo.writes
  await laptop.sync.pull()
  await phone.sync.pull()
  check(
    'nothing re-uploads after a clean sync',
    repo.writes === writesBefore,
    `${repo.writes - writesBefore} extra writes`,
  )

  console.log('Work history syncs and stays append-only')
  laptop.do({ type: 'task/complete', id: taskId })
  await laptop.sync.flush()
  laptop.do({ type: 'task/reopen', id: taskId })
  await laptop.sync.flush()
  await phone.sync.pull()
  check('phone has the credit and the reversal', phone.state.workEvents.length === 2)
  check(
    'reversal cancels the credit on both',
    countedCredits(phone.state.workEvents).length === 0 && netPoints(laptop.state.workEvents) === 0,
  )
  check('task is open on the phone', phone.state.tasks[0].status === 'open')
  laptop.do({ type: 'task/complete', id: taskId })
  await laptop.sync.flush()
  laptop.do({ type: 'task/delete', id: taskId })
  await laptop.sync.flush()
  check('deleting the task keeps its work history in the cloud', repo.count(user, 'work_events') === 3)
  check(
    '…and its user events',
    (await cloudNow()).events.some((e) => e.type === 'task.deleted' && e.taskId === taskId),
  )

  console.log('Deletes propagate and are not undone by stale devices')
  await phone.sync.pull()
  check('phone removes the deleted task', !phone.state.tasks.some((t) => t.id === taskId))
  await phone.sync.pull()
  check('it stays deleted after another sync', repo.count(user, 'tasks') === 0)

  console.log('Offline changes sync later')
  repo.offline = true
  phone.do({ type: 'inbox/add', text: 'Call John' })
  phone.do({ type: 'note/add', id: newId(), title: 'Offline thought' })
  check('upload fails while offline', !(await phone.sync.flush()))
  check('status reports the problem', phone.sync.status.state === 'error' || phone.sync.status.state === 'offline')
  check('local data still usable', phone.state.inbox.length === 1)
  repo.offline = false
  check('reconnect: sync resumes', await phone.sync.pull())
  await laptop.sync.pull()
  check(
    'laptop receives the offline changes',
    laptop.state.inbox[0]?.text === 'Call John' && laptop.state.notes.length === 1,
  )

  console.log('Settings sync')
  laptop.do({ type: 'settings/update', patch: { theme: 'dark', name: 'Izuchukwu' } })
  await laptop.sync.flush()
  await phone.sync.pull()
  check(
    'theme and name reach the phone',
    phone.state.settings.theme === 'dark' && phone.state.settings.name === 'Izuchukwu',
  )

  console.log('Undo keeps history')
  const u = new Device(repo, user, laptop.state, laptop.state)
  u.do({ type: 'task/add', id: newId(), task: { title: 'Undo me' } })
  const before = u.state
  u.do({ type: 'task/complete', id: u.task('Undo me')!.id })
  const after = u.state
  const fixes = reconcileWorkLog(before.tasks, after.workEvents, newId, new Date().toISOString())
  const undone = { ...before, workEvents: [...after.workEvents, ...fixes], events: after.events }
  check(
    'undoing a completion keeps the credit and adds a reversal',
    undone.workEvents.length === after.workEvents.length + 1,
  )
  check('…so it no longer counts', !countedCredits(undone.workEvents).some((e) => e.taskId === u.task('Undo me')!.id))
  check('a diff never deletes history', diffStates(after, undone, user).appends.work_events.length === 1)

  console.log('Importing this device’s old data')
  const legacy = buildSampleState()
  legacy.tasks[0] = { ...legacy.tasks[0], status: 'done', completedAt: new Date().toISOString() }
  const imported = stampChanges(emptyState(), prepareImport(legacy))
  const ids = [
    ...imported.tasks,
    ...imported.projects,
    ...imported.goals,
    ...imported.milestones,
    ...imported.notes,
    ...imported.inbox,
  ].map((x) => x.id)
  check('every id is a UUID', ids.every(isUuid) && imported.workEvents.every((e) => isUuid(e.id) && isUuid(e.taskId)))
  check(
    'nothing dropped',
    imported.tasks.length === legacy.tasks.length &&
      imported.workEvents.length === legacy.workEvents.length &&
      imported.notes.length === legacy.notes.length,
  )
  const taskIds = new Set(imported.tasks.map((t) => t.id))
  check(
    'dependencies still point at the right tasks',
    imported.tasks.every((t) => t.dependsOn.every((d) => taskIds.has(d))),
  )
  const blueprint = imported.tasks.find((t) => t.title === 'Finish MYOS product blueprint')!
  check(
    'relationships survive',
    imported.projects.some((p) => p.id === blueprint.projectId) &&
      imported.notes.some((n) => n.taskId === blueprint.id && n.goalId !== null),
  )
  check(
    'UUIDs that already existed are kept',
    prepareImport({ ...legacy, tasks: [{ ...legacy.tasks[0], id: taskId }] }).tasks[0].id === taskId,
  )

  const user2 = newId()
  const importer = new Device(repo, user2, imported, await rowsToState(await repo.load(user2), STATE_VERSION))
  await importer.sync.pull()
  const cloud2 = rowsToState(await repo.load(user2), STATE_VERSION)
  check(
    'import uploads everything',
    cloud2.tasks.length === legacy.tasks.length &&
      cloud2.workEvents.length === legacy.workEvents.length &&
      cloud2.goals.length === 3,
  )
  check(
    'imported data round-trips with no changes left',
    JSON.stringify(diffStates(cloud2, importer.state, user2)) === JSON.stringify(diffStates(cloud2, cloud2, user2)),
  )
  check(
    'accounts stay separate',
    (await cloudNow()).tasks.every((t) => t.title !== 'Finish MYOS product blueprint'),
  )

  console.log('Phase 2: goals and note links sync')
  const goalId = newId()
  laptop.do({
    type: 'goal/add',
    id: goalId,
    title: 'Become a stronger Web3 developer',
    importance: 'high',
    targetDate: '2027-01-31',
  })
  laptop.do({ type: 'project/update', id: projectId, patch: { goalId } })
  const t2 = newId()
  laptop.do({ type: 'task/add', id: t2, task: { title: 'Study ERC-20 architecture', projectId } })
  const noteId = newId()
  laptop.do({ type: 'note/add', id: noteId, title: 'ERC-20 notes', goalId, taskId: t2 })
  await laptop.sync.flush()
  await phone.sync.pull()
  const pg = phone.state.goals.find((g) => g.id === goalId)
  check(
    'goal with importance and target date reaches the phone',
    pg?.importance === 'high' && pg?.targetDate === '2027-01-31',
  )
  check('project → goal link syncs', phone.state.projects.find((p) => p.id === projectId)?.goalId === goalId)
  const pn = phone.state.notes.find((n) => n.id === noteId)
  check('note → goal and note → task links sync', pn?.goalId === goalId && pn?.taskId === t2)
  phone.do({ type: 'goal/status', id: goalId, status: 'completed' })
  phone.do({ type: 'note/archive', id: noteId, archived: true })
  await phone.sync.flush()
  await laptop.sync.pull()
  check('completing a goal syncs', laptop.state.goals.find((g) => g.id === goalId)?.status === 'completed')
  check('archiving a note syncs', laptop.state.notes.find((n) => n.id === noteId)?.archivedAt !== null)
  laptop.do({ type: 'task/delete', id: t2 })
  check(
    'deleting a task unlinks its notes, keeps the note',
    laptop.state.notes.find((n) => n.id === noteId)?.taskId === null,
  )
  await laptop.sync.flush()
  const writes = repo.writes
  await laptop.sync.pull()
  await phone.sync.pull()
  check(
    'new fields round-trip without endless re-uploads',
    repo.writes === writes + 0 || repo.writes === writes + 1,
    `${repo.writes - writes} write(s)`,
  )

  console.log('Hardening: a device deletes a task while another edits its note')
  {
    const taskId = newId()
    const noteId = newId()
    laptop.do({ type: 'task/add', id: taskId, task: { title: 'Deploy contract' } })
    laptop.do({ type: 'note/add', id: noteId, title: 'Deploy notes', taskId })
    await laptop.sync.flush()
    await phone.sync.pull()
    laptop.do({ type: 'task/delete', id: taskId })
    await laptop.sync.flush()
    await new Promise((r) => setTimeout(r, 5))
    phone.do({ type: 'note/update', id: noteId, patch: { body: 'Edited offline' } })
    await phone.sync.flush() // refused: the task is gone in the cloud
    await phone.sync.pull()
    const cloudNote = (await cloudNow()).notes.find((n) => n.id === noteId)
    check('sync recovers instead of failing forever', phone.sync.status.state === 'synced')
    check(
      '…the note edit arrives, its dead link cleared',
      cloudNote?.body === 'Edited offline' && cloudNote?.taskId === null,
    )
    check('…and the phone shows the same', phone.state.notes.find((n) => n.id === noteId)?.taskId === null)
  }

  console.log('Phase 2: older saved data upgrades')
  const v2 = buildSampleState() as unknown as Record<string, unknown> & {
    tasks: { id: string; noteIds: string[] }[]
    goals: Record<string, unknown>[]
    notes: Record<string, unknown>[]
  }
  v2.version = 2
  v2.tasks.find((t) => t.id === 't-blueprint')!.noteIds = ['n-principles']
  for (const n of v2.notes) {
    delete n.taskId
    delete n.goalId
    delete n.archivedAt
  }
  v2.goals[0].status = 'achieved'
  for (const g of v2.goals) {
    delete g.importance
    delete g.targetDate
  }
  const upgraded = migrateSaved(v2 as never)!
  check('version moves to the current version', upgraded.version === STATE_VERSION)
  check(
    'old task → note link becomes note → task',
    upgraded.notes.find((n) => n.id === 'n-principles')?.taskId === 't-blueprint',
  )
  check(
    'old list is cleared, one source of truth',
    upgraded.tasks.every((t) => t.noteIds.length === 0),
  )
  check(
    '"achieved" goals become "completed"',
    upgraded.goals[0].status === 'completed' && upgraded.goals[0].completedAt !== null,
  )
  check(
    'missing goal fields get safe defaults',
    upgraded.goals.every((g) => g.importance === 'normal' || g.importance === 'high'),
  )

  console.log(`\nAll ${passed} sync checks passed.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
