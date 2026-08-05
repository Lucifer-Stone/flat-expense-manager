#!/usr/bin/env node
//
// Migrates the legacy layout (six documents each holding one giant array) to
// per-entry collections keyed by Firebase Auth uid.
//
// WHY: `db.collection('app').doc('expenses').set({list: next})` rewrites the
// whole array on every save. Two flatmates logging an expense within a few
// seconds of each other means the second write silently erases the first. That
// is a data-loss bug, not a performance one.
//
// Usage:
//   node scripts/migrate.mjs --emit-map    # 1. write a mapping template
//   (edit scripts/member-map.json, fill in each member's Google email)
//   npm run backup                         # 2. ALWAYS back up first
//   npm run migrate:dry                    # 3. rehearse, change nothing
//   npm run migrate                        # 4. commit
//
// The legacy app/* documents are LEFT IN PLACE as a rollback path. Delete them
// by hand only once you are confident.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { getAuth } from 'firebase-admin/auth';
import { db, ensureApp, commitAll, plain } from './lib/firestore.mjs';

const MAP_PATH = 'scripts/member-map.json';
const args = process.argv.slice(2);
const EMIT_MAP = args.includes('--emit-map');
const COMMIT = args.includes('--commit');
const DRY = !COMMIT;

const log = (...a) => console.log(...a);
const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');

async function legacy(name) {
  const snap = await db().collection('app').doc(name).get();
  if (!snap.exists) return null;
  const d = plain(snap.data());
  return d.list ?? d.data ?? null;
}

// ── Step 1: emit a mapping template ─────────────────────────────────────────
async function emitMap() {
  const members = (await legacy('members')) || [];
  if (!members.length) throw new Error('No legacy members found at app/members.');

  const template = {
    _comment:
      'Fill in the real Google account email for each member, then run: npm run migrate:dry. ' +
      'Set "skip": true for anyone who has moved out — their historical records are kept, ' +
      'but they get no login and are marked inactive.',
    members: Object.fromEntries(
      members.map((m) => [
        m.id,
        { name: m.name, email: '', isAdmin: !!m.isAdmin, isMessMember: !!m.isMessMember, skip: false },
      ])
    ),
  };

  if (existsSync(MAP_PATH)) {
    throw new Error(`${MAP_PATH} already exists — refusing to overwrite it.`);
  }
  await writeFile(MAP_PATH, JSON.stringify(template, null, 2));
  log(`Wrote ${MAP_PATH} with ${members.length} members.`);
  log('Edit it to add each person\'s Google email, then run: npm run migrate:dry');
}

// ── Resolve legacy member ids to Firebase Auth uids ─────────────────────────
// Pre-creating the Auth user by email gives us a stable uid now. Because
// Firebase defaults to "one account per email address", when that person later
// signs in with Google they land on this exact uid and inherit their history.
async function resolveUids(map) {
  ensureApp();  // getAuth() requires an initialised app
  const auth = getAuth();
  const out = {};

  for (const [legacyId, m] of Object.entries(map.members)) {
    if (m.skip) {
      out[legacyId] = { uid: `inactive:${legacyId}`, ...m, active: false };
      continue;
    }
    const email = (m.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      throw new Error(`Member "${m.name}" (legacy id ${legacyId}) has no valid email in ${MAP_PATH}.`);
    }

    let user;
    try {
      user = await auth.getUserByEmail(email);
      log(`  ${m.name.padEnd(12)} ${email.padEnd(32)} existing uid ${user.uid}`);
    } catch (err) {
      if (err.code !== 'auth/user-not-found') throw err;
      if (DRY) {
        log(`  ${m.name.padEnd(12)} ${email.padEnd(32)} would CREATE auth user`);
        out[legacyId] = { uid: `pending:${legacyId}`, ...m, email, active: true };
        continue;
      }
      user = await auth.createUser({ email, displayName: m.name, emailVerified: false });
      log(`  ${m.name.padEnd(12)} ${email.padEnd(32)} created uid ${user.uid}`);
    }
    out[legacyId] = { uid: user.uid, ...m, email, active: true };
  }
  return out;
}

// ── Step 2/3: build the write plan ──────────────────────────────────────────
async function buildPlan(idMap) {
  const writes = [];
  const stats = {};
  const warnings = [];
  const uidOf = (legacyId) => idMap[legacyId]?.uid ?? null;
  const now = new Date();

  // Members ------------------------------------------------------------------
  for (const [legacyId, m] of Object.entries(idMap)) {
    if (m.uid.startsWith('inactive:') || m.uid.startsWith('pending:')) {
      if (m.uid.startsWith('pending:')) continue; // dry-run placeholder
    }
    writes.push({
      ref: db().collection('members').doc(m.uid),
      data: {
        name: m.name,
        email: m.email || '',
        isAdmin: !!m.isAdmin,
        isMessMember: !!m.isMessMember,
        active: m.active !== false,
        joinedAt: now,
        legacyId,
      },
      merge: true,
    });
    // Pre-authorise the email so the allowlist is populated from day one.
    if (m.email) {
      writes.push({
        ref: db().collection('invites').doc(m.email.toLowerCase()),
        data: { name: m.name, isMessMember: !!m.isMessMember, invitedBy: 'migration', invitedAt: now },
        merge: true,
      });
    }
  }
  stats.members = Object.keys(idMap).length;

  // Expenses -----------------------------------------------------------------
  const expenses = (await legacy('expenses')) || [];
  let expTotal = 0;
  for (const e of expenses) {
    const uid = uidOf(e.memberId);
    if (!uid) {
      warnings.push(`Expense ${e.id} references unknown member "${e.memberId}" — SKIPPED (${money(e.amount)})`);
      continue;
    }
    expTotal += Number(e.amount) || 0;
    writes.push({
      ref: db().collection('expenses').doc(e.id),
      data: {
        memberId: uid,
        amount: Number(e.amount) || 0,
        category: e.category || 'Misc',
        description: e.description || '',
        date: e.date,
        createdAt: e.date ? new Date(e.date) : now,
        createdBy: uid,
        migratedFrom: e.id,
      },
    });
  }
  stats.expenses = expenses.length;
  stats.expenseTotal = expTotal;

  // Contributions ------------------------------------------------------------
  const contributions = (await legacy('contributions')) || [];
  let contrTotal = 0;
  for (const c of contributions) {
    const uid = uidOf(c.memberId);
    if (!uid) {
      warnings.push(`Deposit ${c.id} references unknown member "${c.memberId}" — SKIPPED`);
      continue;
    }
    contrTotal += (Number(c.rentAmount) || 0) + (Number(c.messAmount) || 0);
    writes.push({
      ref: db().collection('contributions').doc(c.id),
      data: {
        memberId: uid,
        rentAmount: Number(c.rentAmount) || 0,
        messAmount: Number(c.messAmount) || 0,
        date: c.date,
        createdAt: c.date ? new Date(c.date) : now,
        createdBy: uid,
        migratedFrom: c.id,
      },
    });
  }
  stats.contributions = contributions.length;
  stats.contributionTotal = contrTotal;

  // Joint bills --------------------------------------------------------------
  const jointBills = (await legacy('jointBills')) || [];
  let billTotal = 0;
  for (const b of jointBills) {
    const applicable = (b.applicableMembers || []).map(uidOf).filter(Boolean);
    if (!applicable.length) {
      warnings.push(`Joint bill ${b.id} (${money(b.amount)}) has no resolvable members — SKIPPED`);
      continue;
    }
    if (applicable.length !== (b.applicableMembers || []).length) {
      warnings.push(
        `Joint bill ${b.id}: ${(b.applicableMembers || []).length - applicable.length} member(s) ` +
          'could not be resolved. The per-head split will change.'
      );
    }
    billTotal += Number(b.amount) || 0;
    writes.push({
      ref: db().collection('jointBills').doc(b.id),
      data: {
        category: b.category,
        amount: Number(b.amount) || 0,
        date: b.date,
        applicableMembers: applicable,
        // Legacy receipts keep their public download URL; new uploads use paths.
        receiptUrl: b.receiptUrl || '',
        createdAt: b.date ? new Date(b.date) : now,
        createdBy: uidOf(b.loggedBy) || 'migration',
        migratedFrom: b.id,
      },
    });
  }
  stats.jointBills = jointBills.length;
  stats.jointBillTotal = billTotal;

  // Cook attendance ----------------------------------------------------------
  const cook = (await legacy('cookAttendance')) || {};
  for (const [day, state] of Object.entries(cook)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      warnings.push(`Cook attendance key "${day}" is not YYYY-MM-DD — SKIPPED`);
      continue;
    }
    writes.push({
      ref: db().collection('cookAttendance').doc(day),
      data: { state, updatedBy: 'migration', updatedAt: now },
    });
  }
  stats.cookAttendance = Object.keys(cook).length;

  // Config -------------------------------------------------------------------
  const config = (await legacy('config')) || {};
  for (const [month, cfg] of Object.entries(config)) {
    writes.push({
      ref: db().collection('config').doc(month),
      data: {
        rent: Number(cfg.rent) || 0,
        mess: Number(cfg.mess) || 0,
        updatedBy: 'migration',
        updatedAt: now,
      },
    });
  }
  stats.config = Object.keys(config).length;

  return { writes, stats, warnings };
}

// ── Verify the migration reproduced the same money ──────────────────────────
async function verify(stats) {
  const sum = async (coll, fields) => {
    const snap = await db().collection(coll).get();
    return snap.docs.reduce(
      (s, d) => s + fields.reduce((t, f) => t + (Number(d.data()[f]) || 0), 0),
      0
    );
  };

  const checks = [
    ['Expense total', stats.expenseTotal, await sum('expenses', ['amount'])],
    ['Deposit total', stats.contributionTotal, await sum('contributions', ['rentAmount', 'messAmount'])],
    ['Joint bill total', stats.jointBillTotal, await sum('jointBills', ['amount'])],
  ];

  log('\nVerification (legacy vs migrated):');
  let ok = true;
  for (const [label, before, after] of checks) {
    const match = Math.abs(before - after) < 0.01;
    if (!match) ok = false;
    log(`  ${match ? 'OK  ' : 'FAIL'} ${label.padEnd(20)} ${money(before).padStart(14)} -> ${money(after)}`);
  }
  return ok;
}

async function main() {
  if (EMIT_MAP) return emitMap();

  if (!existsSync(MAP_PATH)) {
    throw new Error(
      `${MAP_PATH} not found.\nRun this first:  node scripts/migrate.mjs --emit-map`
    );
  }
  const map = JSON.parse(await readFile(MAP_PATH, 'utf8'));

  log(DRY ? '=== DRY RUN — nothing will be written ===\n' : '=== COMMITTING MIGRATION ===\n');
  log('Resolving Google accounts to Firebase Auth uids:');
  const idMap = await resolveUids(map);

  const { writes, stats, warnings } = await buildPlan(idMap);

  log('\nPlan:');
  log(`  members         ${String(stats.members).padStart(5)}`);
  log(`  expenses        ${String(stats.expenses).padStart(5)}   ${money(stats.expenseTotal)}`);
  log(`  contributions   ${String(stats.contributions).padStart(5)}   ${money(stats.contributionTotal)}`);
  log(`  jointBills      ${String(stats.jointBills).padStart(5)}   ${money(stats.jointBillTotal)}`);
  log(`  cookAttendance  ${String(stats.cookAttendance).padStart(5)}`);
  log(`  config          ${String(stats.config).padStart(5)}`);
  log(`  ---> ${writes.length} document writes`);

  if (warnings.length) {
    log(`\n${warnings.length} WARNING(S):`);
    warnings.forEach((w) => log(`  ! ${w}`));
  }

  if (DRY) {
    log('\nDry run complete. Nothing was written.');
    log('If the numbers above look right:  npm run backup  &&  npm run migrate');
    return;
  }

  log('\nWriting...');
  const n = await commitAll(writes);
  log(`Wrote ${n} documents.`);

  const ok = await verify(stats);
  if (!ok) {
    log('\nTOTALS DO NOT MATCH. Do not delete the legacy app/* documents.');
    log('Investigate before letting anyone use the app.');
    process.exit(1);
  }

  log('\nMigration complete and verified.');
  log('The legacy app/* documents were left untouched as a rollback path.');
  log('Next: deploy rules with  npm run deploy:rules');
}

main().catch((err) => {
  console.error(`\nMigration FAILED: ${err.message}`);
  process.exit(1);
});
