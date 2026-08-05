#!/usr/bin/env node
//
// Full Firestore export. RUN THIS BEFORE THE MIGRATION, and ideally on a
// schedule afterwards.
//
//   npm run backup
//
// Writes backups/<timestamp>/*.json plus a manifest with document counts and a
// SHA-256 of each file, so you can prove a restore matches what was taken.
//
// This captures both the legacy single-document layout (app/expenses etc.) and
// the new per-entry collections, so it is safe to run at any point during the
// migration.

import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { db, plain, PROJECT_ID } from './lib/firestore.mjs';

const LEGACY_DOCS = ['members', 'expenses', 'contributions', 'jointBills', 'cookAttendance', 'config'];
const COLLECTIONS = ['members', 'expenses', 'contributions', 'jointBills', 'cookAttendance', 'config', 'invites', 'audit'];

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join('backups', stamp);
  await mkdir(outDir, { recursive: true });

  console.log(`Backing up project "${PROJECT_ID}" -> ${outDir}\n`);

  const manifest = { project: PROJECT_ID, takenAt: new Date().toISOString(), files: {} };

  // 1. Legacy layout: the six documents under the `app` collection.
  const legacy = {};
  for (const name of LEGACY_DOCS) {
    const snap = await db().collection('app').doc(name).get();
    if (snap.exists) {
      legacy[name] = plain(snap.data());
      const rows = legacy[name].list?.length ?? Object.keys(legacy[name].data ?? {}).length;
      console.log(`  legacy app/${name.padEnd(15)} ${String(rows).padStart(5)} entries`);
    }
  }
  if (Object.keys(legacy).length) {
    const body = JSON.stringify(legacy, null, 2);
    await writeFile(path.join(outDir, 'legacy-app-docs.json'), body);
    manifest.files['legacy-app-docs.json'] = { sha256: sha256(body), docs: Object.keys(legacy).length };
  } else {
    console.log('  (no legacy app/* documents found — already migrated?)');
  }

  // 2. New layout: per-entry collections.
  console.log('');
  for (const name of COLLECTIONS) {
    const snap = await db().collection(name).get();
    if (snap.empty) continue;
    const docs = snap.docs.map((d) => ({ id: d.id, ...plain(d.data()) }));
    const body = JSON.stringify(docs, null, 2);
    await writeFile(path.join(outDir, `${name}.json`), body);
    manifest.files[`${name}.json`] = { sha256: sha256(body), docs: docs.length };
    console.log(`  ${name.padEnd(22)} ${String(docs.length).padStart(5)} documents`);
  }

  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const total = Object.values(manifest.files).reduce((s, f) => s + f.docs, 0);
  console.log(`\nDone. ${total} records across ${Object.keys(manifest.files).length} files.`);
  console.log(`Restore point: ${outDir}`);
}

main().catch((err) => {
  console.error(`\nBackup FAILED: ${err.message}`);
  process.exit(1);
});
