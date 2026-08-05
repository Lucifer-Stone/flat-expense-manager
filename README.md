# 🏠 FlatMate Expense Manager

A shared-expense manager for a flat. Nine flatmates pay into a common pool;
individuals lay out their own money for groceries and bills and claim it back.
The app works out who is up and who is down, every month.

**Live app:** https://expense-manager-204.web.app
**Status page:** https://lucifer-stone.github.io/flat-expense-manager/

---

## How the money works

This is not a "split the bill" app. It runs a **common pool**:

| Concept | Meaning |
|---|---|
| **Deposit** | Money paid *into* the pool, split into a rent part and a mess part |
| **Individual expense** | A member spent their own money on groceries, cleaning, transport and *claims it back* |
| **Joint bill** | A flat-level bill — Rent, WiFi, Gas cylinder, Electricity — split across a set of members |
| **Mess member** | Someone in the shared cooking arrangement. Only mess members can claim food expenses |

Every balance on screen is derived, never stored:

```
net balance = deposits − individual claims − share of joint bills
```

Positive means your money is still sitting in the pool. Negative means the pool
owes you a refund. **Rent** is split across all residents; every other joint bill
is split only among mess members.

---

## Screens

| Tab | What's in it |
|---|---|
| 🏠 **Dashboard** | Pool balance, per-member overview, recent activity |
| ➕ **Add Entry** | Log an expense (individual or joint, with a receipt) or a deposit |
| 📋 **Ledger** | Individual expenses, joint bills and deposits — sortable, filterable, inline-editable |
| 📊 **Analytics** | Monthly summary in card or table form, plus category and per-member charts |
| 👥 **Manage** | Invite and manage members, and the cook attendance calendar |

---

## Architecture

Single-page app, no build step. The entire client is one file —
[`public/index.html`](public/index.html) — with React, Chart.js and the Firebase
SDK loaded from pinned CDN versions, and JSX compiled in the browser by Babel.

```
Browser ──── Google Sign-In ────► Firebase Auth
   │
   │  reads/writes gated by firestore.rules
   ▼
Cloud Firestore ── members, expenses, contributions, jointBills,
                    cookAttendance, config, invites, audit, _health
   ▲
   │  Admin SDK (bypasses rules)
   │
GitHub Actions ──► integrity checks every 30 min
   │
   └──────────────► status/history.json ──► GitHub Pages status page
```

### Data model

Each entry is **its own document**. This matters: the previous version kept every
expense in a single array inside one document and rewrote the whole array on each
save, so two people logging an expense seconds apart would silently lose one of
them.

| Collection | Key | Notes |
|---|---|---|
| `members/{uid}` | Firebase Auth uid | Doubles as the allowlist — no document, no access |
| `expenses/{id}` | auto | Individual claims |
| `contributions/{id}` | auto | Deposits into the pool |
| `jointBills/{id}` | auto | Flat-level bills with `applicableMembers` |
| `cookAttendance/{YYYY-MM-DD}` | date | One doc per day, so concurrent edits don't collide |
| `config/{YYYY-MM}` | month | Per-head rent and mess figures |
| `invites/{email}` | lowercased email | Pre-authorised residents (optional path) |
| `joinRequests/{uid}` | Firebase Auth uid | Self-service signups awaiting approval |
| `audit/{id}` | auto | Append-only; no client can rewrite it |
| `_health/latest` | — | Written by CI only; drives the in-app warning banner |

---

## Security

Authorisation is enforced in [`firestore.rules`](firestore.rules) and
[`storage.rules`](storage.rules), not in the UI. The client is assumed hostile —
anyone can read the app source and call Firestore directly, so every rule the
interface appears to apply is restated server-side.

- **Google Sign-In only.** No passwords, no PINs, no shared secrets.
- **Allowlist by construction.** Access requires a `/members/{uid}` document,
  which only an admin can create. A valid Google account alone gets you a
  waiting screen and nothing else.
- **Self-service signup, admin approval.** Anyone may sign in and request
  access; the request grants no read access to any expense, balance or member.
  An admin approves from a queue in the Manage tab, choosing mess membership at
  that point. Declining is recorded rather than deleted, so the person gets a
  clear answer and cannot re-request in a loop.
- **Ownership.** You can file and edit expenses only against yourself. Admins
  can act for anyone.
- **No self-escalation.** `isAdmin`, `isMessMember` and `active` are immutable
  to the member they describe. Only an existing admin can change them.
- **Server-side validation.** Amounts, dates, categories and the exact set of
  permitted fields are checked in the rules, not just in the form.
- **Immutable provenance.** `createdAt` and `createdBy` cannot be altered after
  creation. The audit log is append-only.
- **Receipts are gated.** Bills store a bucket path, and a download URL is minted
  per view for signed-in residents, rather than a permanent public link.

The Firebase `apiKey` in the client is a project identifier, not a credential —
[Google says so explicitly](https://firebase.google.com/docs/projects/api-keys).
It is safe in source; the rules are what protect the data.

---

## Observability

The app never stores a balance, so "is it accurate?" means "does re-deriving the
totals from raw records agree with what's on screen?"
[`scripts/integrity-check.mjs`](scripts/integrity-check.mjs) recomputes
everything independently and checks:

- Every expense, deposit and joint-bill share points at a member who exists
- Amounts are finite, positive and within range; dates are well-formed
- No suspected duplicate submissions
- No plaintext PINs survive from the old auth scheme
- Receipt links point inside our own storage bucket
- At least one active admin exists
- **The pool identity** — per-member balances must sum to the flat-level balance.
  Drift here means somebody is being shown a number that isn't true.

Results go to three places: the **status page**, the **`_health/latest`
document** the app reads to show a warning banner, and a **GitHub issue** when
something fails.

---

## Setup

Console steps, the data migration and CI secrets are in **[SETUP.md](SETUP.md)**.

## Commands

```bash
npm install
npm run backup        # export all Firestore data with a checksum manifest
npm run migrate:dry   # rehearse the schema migration, write nothing
npm run migrate       # run it, verifying totals before and after
npm run check         # data integrity report
npm run deploy        # hosting + rules + indexes
npm run serve         # local Firebase emulators
```

## Repository layout

```
public/            the app (Firebase Hosting root)
status/            the status page (GitHub Pages root)
scripts/           backup, migration, integrity checks, status builder
.github/workflows/ health cron + deploy pipeline
firestore.rules    authorisation — the real security boundary
storage.rules      receipt upload/download rules
```

## Licence

MIT.
