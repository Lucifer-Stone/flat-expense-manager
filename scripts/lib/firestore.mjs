// Shared Firebase Admin bootstrap for all scripts.
//
// Credentials are resolved in this order:
//   1. FIREBASE_SERVICE_ACCOUNT  — the full service-account JSON as a string.
//      This is what GitHub Actions uses (stored as a repository secret).
//   2. GOOGLE_APPLICATION_CREDENTIALS — a path to the JSON key file. Standard
//      Google tooling convention; use this locally.
//   3. Application Default Credentials — e.g. `gcloud auth application-default login`.
//
// The Admin SDK bypasses security rules by design. That is why the key must
// never be committed; .gitignore covers *-service-account.json and secrets/.

import { initializeApp, cert, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'expense-manager-204';

function resolveCredential() {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (inline && inline.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(inline);
    } catch {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT is set but is not valid JSON. Paste the entire ' +
          'downloaded key file contents, including the outer braces.'
      );
    }
    return { credential: cert(parsed), source: 'FIREBASE_SERVICE_ACCOUNT env' };
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return {
      credential: applicationDefault(),
      source: `GOOGLE_APPLICATION_CREDENTIALS (${process.env.GOOGLE_APPLICATION_CREDENTIALS})`,
    };
  }

  return { credential: applicationDefault(), source: 'application default credentials' };
}

let cached = null;

/**
 * Initialise the Admin app exactly once.
 *
 * Call this before touching getAuth() or getStorage(). Those helpers do NOT
 * bootstrap the default app themselves — they throw "The default Firebase app
 * does not exist" — so any script that reaches for Auth before Firestore has to
 * initialise explicitly.
 */
export function ensureApp() {
  if (getApps().length) return;
  const { credential, source } = resolveCredential();
  try {
    initializeApp({ credential, projectId: PROJECT_ID });
  } catch (err) {
    throw new Error(
      `Could not initialise Firebase Admin using ${source}.\n` +
        `  ${err.message}\n\n` +
        'See SETUP.md ("Service account for scripts and CI") for how to create a key.'
    );
  }
}

export function db() {
  if (cached) return cached;
  ensureApp();
  cached = getFirestore();
  cached.settings({ ignoreUndefinedProperties: true });
  return cached;
}

/** Read every document in a collection as {id, ...data}. */
export async function readAll(collection) {
  const snap = await db().collection(collection).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * Write many documents with automatic batching. Firestore caps a batch at 500
 * writes, and these scripts can exceed that once there is a year of expenses.
 */
export async function commitAll(writes, { chunkSize = 400 } = {}) {
  let written = 0;
  for (let i = 0; i < writes.length; i += chunkSize) {
    const batch = db().batch();
    for (const w of writes.slice(i, i + chunkSize)) {
      if (w.op === 'delete') batch.delete(w.ref);
      else batch.set(w.ref, w.data, { merge: w.merge ?? false });
    }
    await batch.commit();
    written += Math.min(chunkSize, writes.length - i);
  }
  return written;
}

/** Convert Firestore Timestamps to ISO strings so output is JSON-safe. */
export function plain(value) {
  if (value === null || value === undefined) return value;
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}
