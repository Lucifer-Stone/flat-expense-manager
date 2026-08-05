#!/usr/bin/env node
//
// Environment doctor. Reports what is actually true about the live project —
// credentials, Firestore contents and schema version, Auth users, Storage
// buckets — so setup problems surface here rather than mid-migration.
//
//   node scripts/doctor.mjs
//
// Read-only. Writes nothing.

import { getAuth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';
import { db, ensureApp, PROJECT_ID, plain } from './lib/firestore.mjs';

const ok = (s) => `  [ OK ] ${s}`;
const no = (s) => `  [FAIL] ${s}`;
const warn = (s) => `  [WARN] ${s}`;
const info = (s) => `         ${s}`;

const LEGACY_DOCS = ['members', 'expenses', 'contributions', 'jointBills', 'cookAttendance', 'config'];
const NEW_COLLECTIONS = ['members', 'expenses', 'contributions', 'jointBills', 'cookAttendance', 'config', 'invites', 'audit', '_health'];

async function main() {
  console.log(`\nFlatMate environment doctor — project "${PROJECT_ID}"\n`);

  ensureApp();

  // ── Credentials ───────────────────────────────────────────────────────────
  console.log('CREDENTIALS');
  try {
    await db().collection('app').limit(1).get();
    console.log(ok('Firestore reachable with admin credentials'));
  } catch (err) {
    console.log(no(`Cannot reach Firestore: ${err.message}`));
    console.log(info('Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT. See SETUP.md step 3.'));
    process.exit(1);
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  console.log('\nAUTHENTICATION');
  try {
    const list = await getAuth().listUsers(1000);
    if (!list.users.length) {
      console.log(warn('No Firebase Auth users exist yet.'));
      console.log(info('Expected before migration — the migration creates them from member-map.json.'));
    } else {
      console.log(ok(`${list.users.length} Auth user(s) registered`));
      for (const u of list.users.slice(0, 12)) {
        const providers = u.providerData.map((p) => p.providerId).join(',') || 'none';
        console.log(info(`${(u.email || '(no email)').padEnd(34)} ${providers.padEnd(16)} uid ${u.uid}`));
      }
    }
  } catch (err) {
    console.log(no(`Cannot list Auth users: ${err.message}`));
    console.log(info('The service account likely lacks the "Firebase Authentication Admin" role.'));
  }

  // ── Legacy schema ─────────────────────────────────────────────────────────
  console.log('\nLEGACY SCHEMA  (app/* — one document per collection, the old layout)');
  let legacyRows = 0;
  for (const name of LEGACY_DOCS) {
    const snap = await db().collection('app').doc(name).get();
    if (!snap.exists) { console.log(info(`app/${name.padEnd(16)} absent`)); continue; }
    const d = plain(snap.data());
    const n = Array.isArray(d.list) ? d.list.length : Object.keys(d.data || {}).length;
    legacyRows += n;
    const bytes = JSON.stringify(d).length;
    console.log(info(`app/${name.padEnd(16)} ${String(n).padStart(5)} entries   ~${(bytes / 1024).toFixed(1)} KB`));
    if (bytes > 800_000) {
      console.log(warn(`app/${name} is close to Firestore's 1 MB per-document limit — writes will start failing.`));
    }
  }
  console.log(legacyRows ? warn(`${legacyRows} records still in the legacy layout — migration not yet run.`)
                         : ok('No legacy records.'));

  // ── New schema ────────────────────────────────────────────────────────────
  console.log('\nCURRENT SCHEMA  (per-entry collections, what the new app expects)');
  let newRows = 0;
  for (const name of NEW_COLLECTIONS) {
    const snap = await db().collection(name).get();
    newRows += snap.size;
    console.log(info(`${name.padEnd(20)} ${String(snap.size).padStart(5)} documents`));
  }
  if (newRows === 0) {
    console.log(warn('Target collections are empty. The deployed app will show no data until the migration runs.'));
  } else {
    console.log(ok(`${newRows} documents in the current schema.`));
  }

  // ── Schema drift ──────────────────────────────────────────────────────────
  console.log('\nSCHEMA VERDICT');
  if (legacyRows > 0 && newRows === 0) {
    console.log(warn('DB is on the OLD schema; the app in this repo reads the NEW one.'));
    console.log(info('-> Run: npm run backup, then npm run migrate:dry, then npm run migrate'));
  } else if (legacyRows > 0 && newRows > 0) {
    console.log(warn('BOTH schemas hold data. Fine right after migration (legacy kept as rollback).'));
    console.log(info('-> Once happy, delete the app/* documents so there is one source of truth.'));
  } else if (newRows > 0) {
    console.log(ok('DB is on the current schema and matches the app.'));
  }

  // ── Storage ───────────────────────────────────────────────────────────────
  console.log('\nCLOUD STORAGE  (receipt uploads)');
  const candidates = [`${PROJECT_ID}.firebasestorage.app`, `${PROJECT_ID}.appspot.com`];
  let found = false;
  for (const name of candidates) {
    try {
      const [exists] = await getStorage().bucket(name).exists();
      if (exists) {
        console.log(ok(`Bucket "${name}" exists and is accessible`));
        found = true;
      } else {
        console.log(info(`Bucket "${name}" — not found`));
      }
    } catch (err) {
      const msg = err.message || '';
      if (/billing|Blaze|not enabled|403/i.test(msg)) {
        console.log(warn(`Bucket "${name}": ${msg.split('\n')[0].slice(0, 140)}`));
      } else {
        console.log(info(`Bucket "${name}" — ${msg.split('\n')[0].slice(0, 120)}`));
      }
    }
  }
  if (!found) {
    console.log(warn('No usable Storage bucket. Receipt uploads on joint bills will fail.'));
    console.log(info('Cloud Storage needs the Blaze plan on projects created after Oct 2024.'));
    console.log(info('Everything else in the app works without it.'));
  }

  // ── Rules deployed? ───────────────────────────────────────────────────────
  console.log('\nSECURITY RULES');
  console.log(info('The Admin SDK bypasses rules, so this script cannot test them.'));
  console.log(info('Verify in Console -> Firestore -> Rules -> Playground:'));
  console.log(info('  unauthenticated get on /expenses/anything  MUST be denied.'));

  console.log('');
}

main().catch((err) => {
  console.error(`\ndoctor failed: ${err.message}`);
  process.exit(1);
});
