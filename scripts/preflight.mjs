#!/usr/bin/env node
//
// Pre-deploy safety gate. Run before shipping the app or its rules.
//
//   node scripts/preflight.mjs
//
// WHY THIS EXISTS: deploying this release before the database is ready does not
// degrade the app, it breaks it outright — in two separate ways.
//
//   1. firestore.rules ends in a default-deny and has no match block for the
//      legacy `app/*` documents. The moment those rules land, the currently
//      live app loses access to all of its own data.
//
//   2. The new client reads per-entry collections. If the migration has not run,
//      those collections are empty and every flatmate sees a blank app with
//      correct-looking zeroes.
//
// Both failures are instant and total, so this gate refuses the deploy until
// the database is actually ready for it. Exit 0 = safe to deploy.

import { getAuth } from 'firebase-admin/auth';
import { db, ensureApp, PROJECT_ID } from './lib/firestore.mjs';

const problems = [];
const notes = [];

async function main() {
  console.log(`\nPre-deploy checks — project "${PROJECT_ID}"\n`);

  // getAuth() does not bootstrap the default app — it throws "The default
  // Firebase app does not exist". Initialise explicitly before using it.
  ensureApp();

  // ── 1. Firebase Authentication must be enabled ────────────────────────────
  // Without it, "Sign in with Google" cannot work and nobody gets into the app.
  try {
    await getAuth().getUserByEmail('preflight-probe@invalid.local');
    notes.push('Firebase Authentication is enabled.');
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      notes.push('Firebase Authentication is enabled.');
    } else if (err.code === 'auth/configuration-not-found') {
      problems.push(
        'Firebase Authentication is NOT enabled on this project.\n' +
        '      Nobody will be able to sign in — the app is unusable without it.\n' +
        '      Fix: Firebase Console -> Authentication -> Get started ->\n' +
        '           Sign-in method -> enable Google -> set a support email -> Save.'
      );
    } else {
      problems.push(`Could not verify Firebase Auth: ${err.message}`);
    }
  }

  // ── 2. The migration must have run ────────────────────────────────────────
  const [members, expenses, legacyMembers] = await Promise.all([
    db().collection('members').limit(1).get(),
    db().collection('expenses').limit(1).get(),
    db().collection('app').doc('members').get(),
  ]);

  const legacyCount = legacyMembers.exists ? (legacyMembers.data().list || []).length : 0;

  if (members.empty) {
    problems.push(
      'The /members collection is EMPTY — the schema migration has not run.\n' +
      (legacyCount
        ? `      ${legacyCount} member(s) are still in the legacy app/members document.\n`
        : '') +
      '      Deploying now would show every flatmate an empty app AND cut the\n' +
      '      current app off from its data.\n' +
      '      Fix: npm run backup && npm run migrate:dry && npm run migrate'
    );
  } else {
    notes.push(`/members has data (${members.size >= 1 ? 'migration has run' : ''}).`);
    if (expenses.empty) {
      notes.push('Note: /expenses is empty. Fine if the flat genuinely has no expenses logged.');
    }
  }

  // ── 3. At least one admin must exist ──────────────────────────────────────
  if (!members.empty) {
    const admins = await db().collection('members').where('isAdmin', '==', true).limit(2).get();
    if (admins.empty) {
      problems.push(
        'No member has isAdmin = true. Nobody could manage members, joint bills\n' +
        '      or monthly config after deploy.'
      );
    } else {
      notes.push(`${admins.size} admin(s) present.`);
    }
  }

  // ── 4. The bootstrap placeholder must be gone ─────────────────────────────
  const rules = await (await import('node:fs/promises')).readFile('firestore.rules', 'utf8');
  if (rules.includes('REPLACE_ME@gmail.com')) {
    problems.push('firestore.rules still contains the placeholder bootstrap email.');
  } else {
    const m = rules.match(/return '([^']+)';\s*\n\s*}\s*\n\s*\/\/ ── IDENTITY/);
    notes.push(`Bootstrap admin email set${m ? `: ${m[1]}` : ''}.`);
  }

  // ── Report ────────────────────────────────────────────────────────────────
  for (const n of notes) console.log(`  [ OK ] ${n}`);
  if (problems.length) {
    console.log('');
    for (const p of problems) console.log(`  [STOP] ${p}`);
    console.log(`\nDeploy blocked: ${problems.length} problem(s) must be fixed first.`);
    console.log('See SETUP.md for the full cutover order.\n');
    process.exit(1);
  }

  console.log('\nAll pre-deploy checks passed — safe to deploy.\n');
}

main().catch((err) => {
  console.error(`\npreflight could not run: ${err.message}`);
  process.exit(2);
});
