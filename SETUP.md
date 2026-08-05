# Setup & Cutover Guide

> ## Current state — cutover is COMPLETE
>
> | Step | Status |
> |---|---|
> | 1. Bootstrap admin email | done — `wolverinemds7@gmail.com` |
> | 2. Google sign-in enabled | done |
> | 3. Service account + CI secret | done |
> | 4. Backup | done — `backups/2026-08-05T06-32-22-075Z` |
> | 5. Migration | done — ₹496 / ₹53,100 / ₹22,163 verified identical before and after |
> | 6. Rules + app deployed | done — unauthenticated reads *and* writes confirmed denied |
> | 7. Sign in and admit people | **your turn** — see below |
> | 8. API key referrer restriction | **outstanding** |
> | 9. Status page | done — <https://lucifer-stone.github.io/flat-expense-manager/> |
> | 10. Hosting consolidated | done — app on Firebase, status page on Pages |
>
> **Outstanding:** step 8, and eight residents still hold unclaimed history
> (see step 7). Cloud Storage remains unavailable on the Spark plan, so receipt
> uploads do not work — everything else does.

The steps below are kept as the reference procedure, and are what you would
follow again on a fresh project.

> **Read this before you start.** Step 5 migrates live financial data. Step 4 is
> a full backup and it is not optional.

---

## 1. Replace the bootstrap admin email

Open [`firestore.rules`](firestore.rules) and find:

```
function bootstrapAdminEmail() {
  return 'wolverinemds7@gmail.com';
}
```

Change it to **your own Google account email**. This is the one account that can
make itself the first admin — after which everyone else is invited through the
app. The deploy workflow refuses to run while the placeholder is still there.

This email is not a secret. It grants nothing to anyone who does not control
that Google account.

---

## 2. Enable Google sign-in

> **⚠️ VERIFIED NOT DONE — this is currently the blocker.**
> The Admin SDK reports `auth/configuration-not-found` for this project, which
> means Firebase Authentication has never been initialised. Until this step is
> done: nobody can sign in, and the migration cannot run (it pre-creates Auth
> users to get stable uids). Check any time with `npm run doctor`.

Firebase Console → **Authentication** → *Get started* → **Sign-in method** →
enable **Google** → set a support email → Save.

Then **Authentication → Settings → Authorized domains**, and confirm these are
listed (add any that are missing):

- `expense-manager-204.firebaseapp.com`
- `expense-manager-204.web.app`
- `localhost`

Also under **Settings → User account linking**, keep **"One account per email
address"** selected. The migration relies on it: pre-creating a user by email
means that when your flatmate later signs in with Google, they land on the same
uid and inherit their expense history.

---

## 3. Create a service account for scripts and CI

Google Cloud Console → **IAM & Admin → Service Accounts** → *Create service
account*.

- Name: `flatmate-ci`
- Grant these roles:
  - **Cloud Datastore User** — read/write Firestore (backup, migration, checks)
  - **Firebase Admin** — deploy hosting and rules

Then *Keys → Add key → Create new key → JSON*. A file downloads.

**Local use:**

```bash
# Windows PowerShell
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\to\flatmate-ci.json"

# macOS / Linux
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/flatmate-ci.json
```

**CI use:** GitHub → repo **Settings → Secrets and variables → Actions → New
repository secret**:

- Name: `FIREBASE_SERVICE_ACCOUNT`
- Value: the **entire contents** of the JSON file, braces included

Keep the file outside this repo. `.gitignore` blocks the obvious names, but the
safest place is somewhere the repo cannot reach.

---

## 4. Back up everything

```bash
npm install
npm run backup
```

Writes `backups/<timestamp>/` with every document and a SHA-256 manifest. Do not
continue until you see a sensible record count.

---

## 5. Migrate the data

The old schema kept all expenses in one array inside one document. Every save
rewrote the whole array, so two people logging an expense at the same moment
meant the second write erased the first. This step splits every entry into its
own document.

```bash
# a. Generate a mapping template from your existing members
node scripts/migrate.mjs --emit-map

# b. Edit scripts/member-map.json — add each person's real Google email.
#    Set "skip": true for anyone who has moved out.

# c. Rehearse. Writes nothing.
npm run migrate:dry

# d. If the totals look right, commit
npm run migrate
```

The migration verifies that expense, deposit and joint-bill totals match before
and after, and **fails loudly** if they do not. It leaves the old `app/*`
documents in place as a rollback path — delete them by hand once you are
confident, and the integrity checker will stop flagging the drift.

---

## 6. Deploy rules and app

```bash
npm install -g firebase-tools
firebase login
npm run deploy
```

**Verify the rules actually took effect.** In the Firebase Console →
**Firestore → Rules → Rules Playground**, simulate an unauthenticated `get` on
`/expenses/anything`. It must be **denied**. If it is allowed, the rules did not
deploy and your data is still open.

---

## 7. First sign-in and letting people in

1. Open the app. Sign in with the Google account from step 1 — you become admin.
2. Tell your flatmates the URL. **They sign in with Google themselves.**
3. Each one lands on a *"Waiting for approval"* screen and appears as a card in
   your **Manage → Members** tab, with their name, photo and email.
4. Tick **In mess** if they eat from the common kitchen, then **Approve**.
   They are let in automatically — no refresh needed on their side.

Nobody handles a password, and you never have to collect email addresses. A
request on its own grants **no** access: until you approve, that person cannot
read a single expense, balance or member record. This is enforced in
`firestore.rules`, not in the interface.

If you would rather pre-authorise someone before they ever sign in, **➕ Invite
Member** still does that — they skip the queue entirely.

### Unclaimed history

Because the migration ran before eight residents' Google addresses were known,
their records are parked on **unclaimed placeholder members**: Asad, Tabrez,
Abdur Rahman, Saad, Asif, Abid, Wasi and Zeeshan.

This is safe. Their deposits and expenses still belong to real member documents,
so flat totals and every balance continue to reconcile — `npm run check` is
green. What is deferred is only *whose login* the history sits behind.

When one of them signs in, their approval card shows a dropdown. Pick
**“This is Abid”** before hitting Approve, and their deposits, expenses and
joint-bill shares transfer onto their new account and the placeholder is
retired. Approve without picking anyone and they start from zero, leaving the
placeholder for someone else.

Get this right the first time: the transfer cannot be undone from the app. If
you do mis-assign someone, restore from `backups/` and re-run the migration.

**Declining** records the decision rather than deleting it, so the person sees a
clear answer instead of silence, and cannot re-request in a loop. Clearing a
declined request lets them try again.

After the migration, confirm `npm run check` reports **no plaintext PINs
remain**.

---

## 8. Restrict the API key

The Firebase `apiKey` in `public/index.html` is a project identifier, not a
credential — [Google documents this explicitly](https://firebase.google.com/docs/projects/api-keys).
It is safe in source. But you should still restrict where it works:

Google Cloud Console → **APIs & Services → Credentials** → your browser key →
**Application restrictions → HTTP referrers**, then add:

```
https://expense-manager-204.web.app/*
https://expense-manager-204.firebaseapp.com/*
```

Now the key is useless from anyone else's page.

---

## 9. Turn on the status page

GitHub → repo **Settings → Pages** → **Source: GitHub Actions**.

Then **Actions** tab → **Health & Status** → *Run workflow*. After it completes,
your status page is live at:

```
https://lucifer-stone.github.io/flat-expense-manager/
```

It re-runs every 30 minutes. If anything goes down — or the books stop
reconciling — it opens a GitHub issue labelled `automated-alert`.

**Why GitHub Pages and not Firebase Hosting:** a status page must not share
infrastructure with the thing it monitors. If Firebase has an outage, this page
stays up and reports it.

---

## 10. Consolidate hosting

You mentioned the app is live on both GitHub Pages and Firebase Hosting. Two
copies drift, and the stale one keeps working against the same database — which
is exactly how an un-migrated client resurrects the lost-write bug.

- **Firebase Hosting → the app.** Already configured, and it deploys rules
  atomically with the app.
- **GitHub Pages → the status page only.** Configured in step 9.

Since the old app lived at the repo root and `index.html` has now moved into
`public/`, GitHub Pages will no longer find an app to serve — the consolidation
is already done by this repo's structure. Just confirm under **Settings → Pages**
that the source is **GitHub Actions**, not "Deploy from a branch".

---

## Routine operations

| Task | Command |
|---|---|
| **Inspect the live environment** | `npm run doctor` |
| **Check it is safe to deploy** | `npm run preflight` |
| Back up all data | `npm run backup` |
| Check data integrity | `npm run check` |
| Machine-readable check | `npm run check:json` |
| Refresh status page locally | `node scripts/build-status.mjs` |
| Deploy everything | `npm run deploy` |
| Deploy only rules | `npm run deploy:rules` |
| Run locally against emulators | `npm run serve` |

`npm run doctor` is the one to reach for first when something looks wrong — it
reports credentials, Auth state, both schema versions side by side, and whether
a Storage bucket exists.

### The deploy gate

`scripts/preflight.mjs` runs automatically in the deploy workflow and **blocks
the deploy** unless Firebase Auth is enabled and the migration has run. This is
not bureaucracy: `firestore.rules` ends in a default-deny with no match block
for the legacy `app/*` documents, so shipping the rules before the migration
would instantly cut the running app off from its own data. The gate exists so a
routine `git push` cannot cause that.

---

## Known limitations

Worth knowing rather than discovering later:

1. **"Cannot delete the last admin" is not enforced by rules.** Firestore rules
   cannot count documents in a collection. The app blocks it and
   `integrity-check.mjs` alarms if it ever happens, but a determined admin with
   a script could still lock everyone out. Keep two admins.

2. **Storage rules cannot read the members allowlist.** Cloud Storage rules have
   no access to Firestore, so receipt reads are gated on "signed in with a
   verified Google account" rather than "is a resident of this flat". Attaching
   a receipt is admin-only in Firestore rules, and paths are unguessable.

3. **Receipts uploaded before the migration stay publicly linkable.** The old
   code stored permanent public download URLs. Anyone holding such a link can
   still open it. New uploads store a path and mint a URL per view. To close the
   old ones, delete and re-upload those receipts.

4. **Cloud Storage is not provisioned — receipt uploads cannot work yet.**
   Verified directly: listing this project's buckets via the Admin SDK returns
   **zero buckets**, and both `expense-manager-204.firebasestorage.app` and
   `expense-manager-204.appspot.com` return HTTP 404.

   Cloud Firestore *is* provisioned and holds your data — that is a different
   product from Cloud Storage, and having one does not give you the other. Since
   October 2024, Cloud Storage requires the **Blaze** plan; this project is on
   **Spark**.

   Consequence: the "Upload Receipt" field on joint bills will fail. Everything
   else — expenses, deposits, balances, charts, cook attendance — is unaffected.
   Two options:
   - Upgrade to Blaze. At nine users the cost is effectively zero, and it also
     unlocks TOTP multi-factor auth via Identity Platform.
   - Leave it. The status page will show *Receipt Storage* red, which is honest.
     Log joint bills without attachments.

5. **JSX is still compiled in the browser by Babel.** Fine for nine people, but
   it means every visitor transpiles ~1,700 lines on load, and it forces
   `unsafe-eval` in the Content-Security-Policy. Moving to a build step would
   let that policy get considerably stricter.
