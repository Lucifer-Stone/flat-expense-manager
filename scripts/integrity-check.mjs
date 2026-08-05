#!/usr/bin/env node
//
// Data integrity checker.
//
// The app never stores a balance — every rupee on screen is derived at render
// time from raw records. So "is the app accurate?" is really two questions:
//
//   1. Are the raw records well-formed and internally consistent?
//   2. Does re-deriving the totals independently produce the same answer the
//      app would show?
//
// This script answers both by recomputing everything from scratch, using its
// own arithmetic rather than importing the app's. If the two ever disagree,
// that disagreement is the signal.
//
// Usage:
//   npm run check                 # human-readable
//   npm run check:json            # machine-readable, for CI
//   node scripts/integrity-check.mjs --publish   # also write _health/latest
//
// Exit code is 0 when healthy, 1 when any check FAILS. Warnings do not fail
// the run — they are things worth looking at, not things that are wrong.

import { db, readAll, plain } from './lib/firestore.mjs';

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const PUBLISH = args.includes('--publish');

const EXPENSE_CATEGORIES = ['Groceries', 'Utilities', 'Kitchen', 'Cleaning', 'Transport', 'Misc'];
const JOINT_CATEGORIES = ['Rent', 'WiFi Bill', 'Gas (Cylinder)', 'Current / Electricity Bill'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Money tolerance. Joint bills divide by member count and produce repeating
// decimals, so exact equality is the wrong test. One rupee across the whole
// flat is well inside "nobody would notice or care".
const EPSILON = 1.0;

const checks = [];
const add = (id, name, status, detail, extra = {}) =>
  checks.push({ id, name, status, detail, ...extra });

const money = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

async function main() {
  const [members, expenses, contributions, jointBills, cook, config, joinRequests] = await Promise.all([
    readAll('members'),
    readAll('expenses'),
    readAll('contributions'),
    readAll('jointBills'),
    readAll('cookAttendance'),
    readAll('config'),
    readAll('joinRequests'),
  ]);

  const memberById = new Map(members.map((m) => [m.id, m]));
  const tomorrow = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);

  // ── 1. Is anyone still able to administer this thing? ─────────────────────
  const activeAdmins = members.filter((m) => m.isAdmin && m.active !== false);
  if (activeAdmins.length === 0) {
    add('admin.exists', 'At least one active admin', 'fail',
      'There are NO active admins. Nobody can add members, log joint bills or edit config. ' +
      'Restore one via the Firebase console.');
  } else if (activeAdmins.length === 1) {
    add('admin.exists', 'At least one active admin', 'warn',
      `Only one active admin (${activeAdmins[0].name}). If they lose account access, the flat is locked out. ` +
      'Consider promoting a second.', { count: 1 });
  } else {
    add('admin.exists', 'At least one active admin', 'pass',
      `${activeAdmins.length} active admins.`, { count: activeAdmins.length });
  }

  // ── 2. Member records well-formed ─────────────────────────────────────────
  const badMembers = members.filter(
    (m) => !m.name || typeof m.name !== 'string' || typeof m.isAdmin !== 'boolean' || typeof m.isMessMember !== 'boolean'
  );
  add('members.schema', 'Member records well-formed',
    badMembers.length ? 'fail' : 'pass',
    badMembers.length ? `${badMembers.length} malformed: ${badMembers.map((m) => m.id).join(', ')}`
                      : `All ${members.length} member records valid.`,
    { count: members.length });

  // Leftover plaintext PINs from the pre-auth era must be gone.
  const withPins = members.filter((m) => m.pin !== undefined);
  add('members.nopins', 'No plaintext PINs remain',
    withPins.length ? 'fail' : 'pass',
    withPins.length
      ? `${withPins.length} member record(s) still carry a plaintext "pin" field. Anyone who can read ` +
        'the members collection can read these. Remove the field.'
      : 'No legacy pin fields present.',
    { count: withPins.length });

  // ── 3. Expenses ───────────────────────────────────────────────────────────
  const expOrphans = expenses.filter((e) => !memberById.has(e.memberId));
  add('expenses.orphans', 'Every expense belongs to a real member',
    expOrphans.length ? 'fail' : 'pass',
    expOrphans.length
      ? `${expOrphans.length} expense(s) reference a member that no longer exists ` +
        `(${money(expOrphans.reduce((s, e) => s + (Number(e.amount) || 0), 0))} unattributed). ` +
        'These vanish from per-member views but still count in flat totals — the classic ' +
        '"the numbers do not add up" bug.'
      : `All ${expenses.length} expenses attributed.`,
    { count: expOrphans.length, ids: expOrphans.slice(0, 20).map((e) => e.id) });

  const expBadAmount = expenses.filter((e) => !isFiniteNum(e.amount) || e.amount <= 0 || e.amount > 1_000_000);
  add('expenses.amounts', 'Expense amounts sane',
    expBadAmount.length ? 'fail' : 'pass',
    expBadAmount.length
      ? `${expBadAmount.length} expense(s) with a non-finite, zero, negative or absurd amount.`
      : 'All expense amounts positive and within range.',
    { count: expBadAmount.length, ids: expBadAmount.slice(0, 20).map((e) => e.id) });

  const expBadDate = expenses.filter((e) => !DATE_RE.test(e.date || '') || e.date > tomorrow);
  add('expenses.dates', 'Expense dates valid and not in the future',
    expBadDate.length ? 'warn' : 'pass',
    expBadDate.length
      ? `${expBadDate.length} expense(s) with a malformed or future date. These silently drop out of ` +
        'monthly views while still appearing in all-time totals.'
      : 'All expense dates well-formed.',
    { count: expBadDate.length, ids: expBadDate.slice(0, 20).map((e) => e.id) });

  const expBadCat = expenses.filter((e) => !EXPENSE_CATEGORIES.includes(e.category));
  add('expenses.categories', 'Expense categories recognised',
    expBadCat.length ? 'warn' : 'pass',
    expBadCat.length
      ? `${expBadCat.length} expense(s) use an unknown category. The category chart cannot ` +
        'render these, so the pie chart will not sum to the flat total.'
      : 'All categories recognised.',
    { count: expBadCat.length });

  // Non-mess members must not have claims — the UI blocks it, so any hit here
  // means the record predates the rule or was written outside the app.
  const messViolations = expenses.filter((e) => {
    const m = memberById.get(e.memberId);
    return m && m.isMessMember === false;
  });
  add('expenses.messrule', 'Only mess members have claims',
    messViolations.length ? 'warn' : 'pass',
    messViolations.length
      ? `${messViolations.length} expense(s) claimed by non-mess members ` +
        `(${money(messViolations.reduce((s, e) => s + (Number(e.amount) || 0), 0))}). ` +
        'Either they were in the mess when it was logged, or this bypassed the app.'
      : 'No non-mess claims.',
    { count: messViolations.length });

  // ── 4. Contributions ──────────────────────────────────────────────────────
  const contrOrphans = contributions.filter((c) => !memberById.has(c.memberId));
  add('contributions.orphans', 'Every deposit belongs to a real member',
    contrOrphans.length ? 'fail' : 'pass',
    contrOrphans.length
      ? `${contrOrphans.length} deposit(s) reference a missing member.`
      : `All ${contributions.length} deposits attributed.`,
    { count: contrOrphans.length, ids: contrOrphans.slice(0, 20).map((c) => c.id) });

  const contrBad = contributions.filter(
    (c) =>
      !isFiniteNum(Number(c.rentAmount ?? 0)) ||
      !isFiniteNum(Number(c.messAmount ?? 0)) ||
      Number(c.rentAmount ?? 0) < 0 ||
      Number(c.messAmount ?? 0) < 0
  );
  add('contributions.amounts', 'Deposit amounts sane',
    contrBad.length ? 'fail' : 'pass',
    contrBad.length ? `${contrBad.length} deposit(s) with negative or non-numeric amounts.`
                    : 'All deposit amounts valid.',
    { count: contrBad.length });

  // ── 5. Joint bills ────────────────────────────────────────────────────────
  const billBadMembers = jointBills.filter(
    (b) => !Array.isArray(b.applicableMembers) || b.applicableMembers.length === 0
  );
  add('jointbills.split', 'Every joint bill has someone to split across',
    billBadMembers.length ? 'fail' : 'pass',
    billBadMembers.length
      ? `${billBadMembers.length} joint bill(s) have an empty applicableMembers list. The app divides ` +
        'by this length, so these are charged to nobody and silently leak from the pool.'
      : `All ${jointBills.length} joint bills have a valid split set.`,
    { count: billBadMembers.length, ids: billBadMembers.slice(0, 20).map((b) => b.id) });

  const billGhostMembers = jointBills.filter(
    (b) => Array.isArray(b.applicableMembers) && b.applicableMembers.some((id) => !memberById.has(id))
  );
  add('jointbills.ghosts', 'Joint bill splits reference real members',
    billGhostMembers.length ? 'fail' : 'pass',
    billGhostMembers.length
      ? `${billGhostMembers.length} joint bill(s) split across at least one member who no longer exists. ` +
        'Their share is charged to a ghost, so per-member shares no longer sum to the bill total.'
      : 'All split targets exist.',
    { count: billGhostMembers.length, ids: billGhostMembers.slice(0, 20).map((b) => b.id) });

  const billBadReceipt = jointBills.filter(
    (b) => b.receiptUrl && !String(b.receiptUrl).startsWith('https://firebasestorage.googleapis.com/')
  );
  add('jointbills.receipts', 'Receipt links point at our own bucket',
    billBadReceipt.length ? 'fail' : 'pass',
    billBadReceipt.length
      ? `${billBadReceipt.length} bill(s) have a receipt URL pointing somewhere other than Firebase ` +
        'Storage. Treat as hostile — "View Receipt" would send a flatmate offsite.'
      : 'All receipt links in-bucket.',
    { count: billBadReceipt.length });

  // ── 6. Duplicate detection ────────────────────────────────────────────────
  // Same member, same amount, same date, same category — almost always a
  // double-submit from a slow network, and it quietly inflates someone's claim.
  const seen = new Map();
  const dupes = [];
  for (const e of expenses) {
    const key = `${e.memberId}|${e.amount}|${e.date}|${e.category}|${e.description || ''}`;
    if (seen.has(key)) dupes.push({ id: e.id, twin: seen.get(key), amount: e.amount });
    else seen.set(key, e.id);
  }
  add('expenses.duplicates', 'No suspected duplicate expenses',
    dupes.length ? 'warn' : 'pass',
    dupes.length
      ? `${dupes.length} expense(s) are byte-identical to another entry ` +
        `(${money(dupes.reduce((s, d) => s + (Number(d.amount) || 0), 0))}). Likely double-submits.`
      : 'No duplicates detected.',
    { count: dupes.length, ids: dupes.slice(0, 20).map((d) => d.id) });

  // ── 7. THE POOL IDENTITY — the load-bearing check ─────────────────────────
  // Recomputed independently of the app. Every rupee deposited is either still
  // in the pool or has been claimed back. If per-member balances stop summing
  // to the flat-level balance, the app is showing at least one person a number
  // that is not true.
  const totalDeposits = contributions.reduce(
    (s, c) => s + (Number(c.rentAmount) || 0) + (Number(c.messAmount) || 0), 0);
  const totalClaims = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const totalJoint = jointBills.reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const flatBalance = totalDeposits - totalClaims - totalJoint;

  let sumOfMemberBalances = 0;
  const perMember = members.map((m) => {
    const deposited = contributions
      .filter((c) => c.memberId === m.id)
      .reduce((s, c) => s + (Number(c.rentAmount) || 0) + (Number(c.messAmount) || 0), 0);
    const claimed = expenses
      .filter((e) => e.memberId === m.id)
      .reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const jointShare = jointBills
      .filter((b) => Array.isArray(b.applicableMembers) && b.applicableMembers.includes(m.id))
      .reduce((s, b) => s + (Number(b.amount) || 0) / b.applicableMembers.length, 0);
    const balance = deposited - claimed - jointShare;
    sumOfMemberBalances += balance;
    return { id: m.id, name: m.name, deposited, claimed, jointShare, balance };
  });

  const drift = Math.abs(flatBalance - sumOfMemberBalances);
  add('pool.identity', 'Per-member balances sum to the flat balance',
    drift > EPSILON ? 'fail' : 'pass',
    drift > EPSILON
      ? `DRIFT OF ${money(drift)}. The flat-level pool balance is ${money(flatBalance)} but the nine ` +
        `member balances add up to ${money(sumOfMemberBalances)}. Money is being counted against ` +
        'members who do not exist, or a joint bill is split across a stale member list. ' +
        'Somebody is being shown a wrong number right now.'
      : `Balances reconcile. Pool holds ${money(flatBalance)} across ${members.length} members.`,
    { drift: Math.round(drift * 100) / 100 });

  // ── 8. Legacy drift — the old array docs vs the live collections ──────────
  // If the legacy documents still exist and disagree with the new collections,
  // something is still writing to the old layout, which means two sources of
  // truth and a guaranteed divergence.
  const legacySnap = await db().collection('app').doc('expenses').get();
  if (legacySnap.exists) {
    const legacyList = plain(legacySnap.data()).list || [];
    const legacyTotal = legacyList.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const diff = Math.abs(legacyTotal - totalClaims);
    add('legacy.drift', 'Legacy documents not diverging',
      diff > EPSILON ? 'warn' : 'pass',
      diff > EPSILON
        ? `The legacy app/expenses document totals ${money(legacyTotal)} but the live expenses ` +
          `collection totals ${money(totalClaims)}. Either an old client is still writing to the ` +
          'legacy layout, or the legacy doc is simply a stale rollback snapshot (expected after ' +
          'migration — delete it once you are confident).'
        : 'Legacy and live totals agree.',
      { legacyTotal, liveTotal: totalClaims });
  } else {
    add('legacy.drift', 'Legacy documents not diverging', 'pass',
      'Legacy app/* documents removed — single source of truth.');
  }

  // ── 9. Access queue not being ignored ─────────────────────────────────────
  // A request sitting unanswered for days is usually an admin who never saw the
  // notification, and to the person waiting it is indistinguishable from being
  // silently refused.
  const pending = joinRequests.filter((r) => r.status !== 'declined');
  const stale = pending.filter((r) => {
    const t = r.requestedAt ? new Date(r.requestedAt).getTime() : null;
    return t && Date.now() - t > 3 * 86400e3;
  });
  add('access.queue', 'No access requests left waiting',
    stale.length ? 'warn' : 'pass',
    stale.length
      ? `${stale.length} access request(s) pending more than 3 days: ` +
        `${stale.map((r) => r.email).slice(0, 5).join(', ')}. They are stuck on the waiting screen.`
      : pending.length
        ? `${pending.length} request(s) pending, none stale.`
        : 'No requests waiting.',
    { count: pending.length, stale: stale.length });

  // Anyone in the queue who is ALREADY a member means approval half-completed:
  // the member document was created but the request was never cleared.
  const orphanRequests = pending.filter((r) => memberById.has(r.id));
  if (orphanRequests.length) {
    add('access.orphaned', 'Access queue matches membership', 'warn',
      `${orphanRequests.length} request(s) belong to people who are already members. ` +
      'Approval created the member record but did not clear the request. Safe to dismiss.',
      { count: orphanRequests.length });
  }

  // ── 10. Cook attendance shape ─────────────────────────────────────────────
  const badCook = cook.filter((c) => !DATE_RE.test(c.id) || !['full', 'half', 'absent'].includes(c.state));
  add('cook.schema', 'Cook attendance well-formed',
    badCook.length ? 'warn' : 'pass',
    badCook.length ? `${badCook.length} attendance record(s) malformed.` : `${cook.length} days recorded.`,
    { count: cook.length });

  // ── Assemble the report ───────────────────────────────────────────────────
  const failed = checks.filter((c) => c.status === 'fail');
  const warned = checks.filter((c) => c.status === 'warn');

  const report = {
    checkedAt: new Date().toISOString(),
    status: failed.length ? 'fail' : warned.length ? 'warn' : 'pass',
    summary: { total: checks.length, passed: checks.length - failed.length - warned.length,
               warnings: warned.length, failures: failed.length },
    totals: {
      members: members.length,
      activeMembers: members.filter((m) => m.active !== false).length,
      expenses: expenses.length,
      contributions: contributions.length,
      jointBills: jointBills.length,
      totalDeposits: Math.round(totalDeposits),
      totalClaims: Math.round(totalClaims),
      totalJointBills: Math.round(totalJoint),
      poolBalance: Math.round(flatBalance),
      balanceDrift: Math.round(drift * 100) / 100,
    },
    checks,
    perMember: perMember.map((p) => ({ ...p, balance: Math.round(p.balance) })),
  };

  if (PUBLISH) {
    // The Admin SDK bypasses rules, which is why only CI can write this doc.
    await db().collection('_health').doc('latest').set(report);
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const icon = { pass: ' OK ', warn: 'WARN', fail: 'FAIL' };
    console.log(`\nFlatMate data integrity — ${report.checkedAt}\n`);
    for (const c of checks) console.log(`  [${icon[c.status]}] ${c.name}\n           ${c.detail}\n`);
    console.log('─'.repeat(72));
    console.log(`  Deposits ${money(totalDeposits)}   Claims ${money(totalClaims)}   ` +
                `Joint ${money(totalJoint)}   Pool ${money(flatBalance)}`);
    console.log(`  ${report.summary.passed} passed, ${report.summary.warnings} warnings, ` +
                `${report.summary.failures} failures`);
  }

  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nIntegrity check could not run: ${err.message}`);
  process.exit(2);
});
