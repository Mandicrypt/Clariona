# MYOS — Phase 0 (v2)

A calm personal operating system. It shows what deserves attention now, and keeps everything else out of the way.

## Run it on your computer

You need Node.js (version 20 or newer).

1. Open a terminal in this folder.
2. Run `npm install` (only the first time).
3. Run `npm run dev`.
4. Open the address it shows, usually http://localhost:5173

## Accounts and cloud sync (Supabase)

MYOS works in two modes:

- **Local-only** (no Supabase settings): no accounts, data stays in this browser. Good for trying it out.
- **Account mode**: sign in, data is saved to your Supabase database and syncs across devices.
  It still works offline and catches up when you reconnect.

### Set up Supabase (once)

1. Create a free project at supabase.com.
2. In the Supabase dashboard, open **SQL Editor → New query**.
3. Paste the whole of `supabase/migrations/001_initial_schema.sql` and click **Run**.
   This creates the tables, the security rules (Row Level Security) and the indexes.
4. Open **Project Settings → API** and copy the **Project URL** and the **anon / publishable key**.
5. In this folder, copy `.env.example` to `.env.local` and paste the two values in.
   Never commit `.env.local`, and never use the `service_role` key in the app.
6. If you deploy (for example on Vercel), add the same two values as environment variables there.

7. In **SQL Editor**, also run `supabase/migrations/002_wallets.sql` (wallet sign-in), then
   `supabase/migrations/003_goals_notes.sql` (Phase 2: goals and notes), then
   `supabase/migrations/004_intelligence_rewards.sql` (Phase 3: rewards), then
   `supabase/migrations/005_recurring_tasks.sql` (recurring tasks and ongoing goals). All of them only add
   things; they are safe to run on a database that already has data, and safe to run twice.

By default Supabase asks new users to confirm their email. You can turn that off under
**Authentication → Sign In / Providers → Email** while testing.

### Wallet sign-in (Sign-In with Ethereum)

MYOS uses Supabase Auth's built-in Web3 sign-in. The wallet signs a standard Sign-In with
Ethereum message; Supabase verifies the signature on its server and starts a normal session.
No private keys, no recovery phrases, no transactions, no extra server code.

1. In Supabase, open **Authentication → Sign In / Providers → Web3 Wallet** and switch on **Ethereum**.
2. Open **Authentication → URL Configuration**. Set **Site URL** to your MYOS address
   (for example `https://myos.vercel.app`) and add it under **Redirect URLs** too.
   Supabase only accepts signatures made for these addresses. For local testing, add
   `http://localhost:5173/**`. Wallet sign-in needs `https`, or `localhost`; plain-http
   network addresses (like `http://192.168…`) won't work.
3. Optional, for phone wallets: get a free project id at cloud.reown.com and set
   `VITE_WALLETCONNECT_PROJECT_ID`. Without it, MYOS offers browser wallets only
   (MetaMask, Rabby, Coinbase Wallet and any other EIP-6963 wallet).

A wallet signs in to a MYOS account; it isn't the account itself. Wallets are recorded in the
`wallets` table by the database, from identities Supabase has verified. The app can read its
own wallets but can't add or change them.

### How sync works

```
UI → actions → reducer → AppState → persistence layer ─┬─ this device (localStorage)
                                                         └─ Supabase (PostgreSQL + RLS)
```

- The reducer, engine and pages know nothing about Supabase. Only `src/store/cloud/` does.
- Edited records: the latest `updated_at` wins.
- History (`work_events`, `user_events`) is append-only, in the app and in the database.
- Changes made offline are uploaded once the connection returns.
- The first time someone signs in on a device that already has MYOS data, they're asked
  whether to import it. Nothing on the device is deleted either way.

## Checks

- `npm run typecheck` — TypeScript
- `npm run lint` — code checks
- `npm run build` — production build into `dist/`
- `npm run build:single` — one self-contained HTML file in `dist-single/`
- `npm run check:engine` — checks the decision logic (ranking, dependencies, scoring, anti-gaming)
- `npm run check:sync` — checks cloud sync with two simulated devices (no Supabase needed)
- `npm run check:rewards` — checks scoring, anti-farming, multipliers, leaderboards, snapshots and wallet linking
- `npm run check:recurrence` — checks recurring tasks, ongoing goals, their rewards rules, sync and timezones
- `npm run check:token` — checks the token page settings (valid address, matching Buy link) and the Copy function

## How it's organised

```
src/
  app/          App, routes, navigation config, UI context (quick add, task editor)
  pages/        one file per screen
  components/   layout, navigation, tasks, projects, goals, inbox, focus, ui primitives
  engine/       importance engine (swappable) and meaningful work scoring
  store/        state, actions, selectors, saving to this browser
  data/         sample data
  types/        data model: Goal → Project → Milestone → Task → Outcome
  lib/          dates, ids, class names
```

## Goals, notes and the weekly review (Phase 2)

- Goals have a description, importance, target date and status (active, paused, completed, archived).
  Progress is never typed in: it's the share of linked tasks done (`src/engine/goals.ts`).
- Projects link to a goal; tasks serve a goal through their project, or directly.
- Notes link to a goal, a project and a task (each optional), can be archived, and are searchable.
- The engine gives a little more weight to tasks serving an important goal or one due soon.
- Weekly Review (`src/store/review.ts`) works in calendar weeks. Its recommendations come straight
  from the engine; accepting or rejecting one is recorded as a user event. Nothing changes unless accepted.
- Press `/` anywhere to search tasks, projects, goals, notes and inbox.

## Intelligence and Rewards (Phase 3)

Everything here is optional. MYOS works fully without a wallet.

**Intelligence** (`src/engine`): the same rule-based engine, with more context (stalled projects,
task age, unlocking other work, repeated postponing, workload). `daily-plan.ts` picks a few tasks
that fit the day, each with a short reason; you can accept, move to tomorrow, or skip.
`activity.ts` turns real work into an activity score. Every point value and daily cap is in
`activity-config.ts`. Nothing is rewarded for tiny tasks ticked straight away, reopening and
completing again, recreating the same task, or events recorded long after they claim to have happened.

**Rewards** (`src/rewards`, page: Rewards): final score = activity score × holder multiplier.
Eligibility ($20 minimum), the multiplier tiers, the top-10 split and the pools all live in
`rewards/config.ts`. Daily and weekly periods are UTC (weeks run Monday to Sunday), so a score is
the same on every device. A snapshot moves through
UPCOMING → SNAPSHOT_PENDING → SNAPSHOT_TAKEN → CALCULATING → DISTRIBUTION_PENDING → DISTRIBUTED,
and once taken it cannot be changed (the database refuses it).

**The MYOS token does not exist yet.** Nothing about it is invented. Until you set
`VITE_MYOS_TOKEN_CHAIN` and `VITE_MYOS_TOKEN_CONTRACT_ADDRESS`, the Rewards page shows a calm
"pre-launch" state. No ZEC or token is ever sent by this code.

**Mock mode** (for testing only): build with `VITE_MYOS_REWARDS_MOCK=true`. It shows fake balances,
a fake leaderboard and a simulated snapshot, always with a visible banner. It is chosen when the app
is built, never from browser storage, and it is ignored once a real token is configured.

**Linking a wallet for rewards** needs the `link-wallet` Supabase Edge Function
(`supabase/functions/link-wallet`). It checks the wallet's signature on the server. Deploy it with
the Supabase CLI: `supabase functions deploy link-wallet`. One wallet can belong to one account, and the
reward wallet can be changed once a week; a wallet chosen during a period counts from the next one.

**What is not built yet:** the scheduled job that takes real snapshots (it needs the token to read
balances and a price), real ZEC transfers, and server-side scoring. Until then, scores shown in the
app are calculated on your device for your information only. They are not authoritative.

Database rule tests live in `supabase/tests/` (run on a fresh test database; every line must say ok). Run `npm run check:rewards` for the reward logic.

## Recurring tasks and ongoing goals

**A series and its occurrences.** A recurring task is a *series* (the rule, a template, a start and
optional end, and a timezone). Each day it falls on is an *occurrence*: an ordinary task that points at
its series and its date (`recurrenceId`, `occurrenceDate`). Completion, Focus, the Daily Plan, Rewards and
Weekly Review all work on occurrences exactly as they do on any task. There is no second task system.
The rule maths is in `src/engine/recurrence.ts`; making and changing series is in `src/store/recurring.ts`.

**Occurrence ids and duplicates.** An occurrence's id is derived from its series id and its date
(`deterministicId`), so every device that makes "Post on X, 8 Oct" makes the same row with the same
timestamps. The database also allows one occurrence per series per day
(`tasks_occurrence_unique`), and sync repair removes a duplicate if one ever appears.

**Generated lazily.** Only a small window is made: the last 6 days (so missed days stay visible),
today and tomorrow (`CATCH_UP_DAYS`, `LOOKAHEAD_DAYS`). Asking again changes nothing. Days that were
completed once are never made again, even if the task was deleted.

**This occurrence or the whole series.** Editing one occurrence changes only that day. "Entire series"
changes the template and rule for today and later open days. Earlier, finished and skipped days never
change. Skipping a day (status `skipped`) keeps it as history, earns nothing, and the series carries on.
A missed day is not moved to today: it stays on its own date, under Missed on the Tasks page.

**Ongoing and finite goals.** A goal is `finite` (target date, percentage) or `ongoing` (cadence,
optional end, no target date, no percentage). An ongoing goal shows consistency worked out from real
days: today, this week, current streak, last completed (`src/engine/routines.ts`). A day counts as done
when every routine due that day is done. A skipped or missed day breaks the streak; days with nothing
due are ignored. Routines don't count toward a finite goal's percentage.

**Rewards.** An occurrence is rewarded once, identified by series and date (not by task id or title), so
delete, recreate and complete can't earn twice. It only earns on its own day in the series' timezone
(`localDay` on the work record), so ticking tomorrow's early or backfilling last week's earns nothing.
Daily limits still apply. The Daily Plan, priorities and Weekly Review use the same engines; a routine
adds a small "commitment" signal and, after 3 or more misses in a week, a "Missed N times" note.

**Timezones.** Occurrence dates are calendar dates, not moments, so daylight saving can't move them.
"Today" for a series is the date in the series' own timezone (stored on the series; it defaults to the
device's). If you travel, edit the series and choose "Use this device's timezone".

**Dependencies.** Occurrences start with no dependencies: "after that task" has no stable meaning for a
task that repeats.

**Checks.** `npm run check:recurrence` covers the date rules, generation, rewards, goals, sync between
two devices, saved-data upgrades and timezones. `supabase/tests/005_recurring_rules.sql` checks the
database rules (run on a fresh test database; every line must say ok).

## The MYOS Token page

A public page at `/#/token` (so `myosapp.site/#/token`). It works without signing in, and signed-in
users reach it from the sidebar (or More on a phone). It has Buy, Copy CA, the full contract address,
token details, how to buy, and a tokenomics section.

**To update it, edit one file: `src/config/token.ts`.** Entries marked PLACEHOLDER are stand-ins
(contract address and Buy link). Fill in the tokenomics rows there when the numbers are final; an
empty row shows "To be announced". After editing, run `npm run check:token`. It confirms the address is
valid, that the Buy link contains the same address, and that Copy copies the full address.

This page is display-only. It does not switch Rewards on. Rewards uses `VITE_MYOS_TOKEN_CHAIN` and
`VITE_MYOS_TOKEN_CONTRACT_ADDRESS` (see Intelligence and Rewards above).

## How MYOS decides (src/engine)

- `importance.ts` — each factor (impact, deadline, goal, your importance, unblocking, postponing,
  momentum, effort) returns a *reason* with a weight. The score is the sum; the strongest reasons
  are the labels you see. Explanations always match the decision.
- `relations.ts` — the work hierarchy (Goal → Project → Milestone → Task) and dependency helpers.
- `next.ts` — what to suggest right after finishing something.
- `meaningful-work.ts` — work value for a finished task, with anti-gaming rules.
- `store/events.ts` — every correction you make is recorded as a `UserEvent` for future personalisation.

## Important design points

- **Importance engine:** `src/engine/importance.ts`. The UI only calls `engine.rank()`.
  To change how MYOS decides, replace the engine. No screen needs rewriting.
- **Meaningful work:** `src/engine/meaningful-work.ts` scores a finished task by how much it
  mattered, and stores a `WorkEvent`. No tokens, no wallets.
- **Data:** saved in this browser only (localStorage). No accounts, database or Supabase yet.
  Settings → "Restore sample data" or "Start with a clean slate".
