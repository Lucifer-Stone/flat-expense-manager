#!/usr/bin/env node
//
// Inspects the live Firebase Authentication configuration: which sign-in
// providers are actually enabled, and which domains are authorised to start a
// sign-in flow.
//
//   node scripts/check-auth-config.mjs
//
// Exists because "The requested action is invalid." on /__/auth/handler is
// emitted for several unrelated causes, and the console does not make the
// difference obvious. Read-only.

import { GoogleAuth } from 'google-auth-library';
import { PROJECT_ID } from './lib/firestore.mjs';

const BASE = 'https://identitytoolkit.googleapis.com/admin/v2/projects';

async function main() {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const token = (await client.getAccessToken()).token;
  const call = async (path) => {
    const res = await fetch(`${BASE}/${PROJECT_ID}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  console.log(`\nFirebase Auth configuration — ${PROJECT_ID}\n`);

  // ── Which identity providers are switched on? ─────────────────────────────
  const idps = await call('/defaultSupportedIdpConfigs');
  console.log('SIGN-IN PROVIDERS');
  if (idps.status !== 200) {
    console.log(`  [FAIL] HTTP ${idps.status}: ${idps.body?.error?.message || 'unknown'}`);
    if (idps.status === 403) {
      console.log('         The service account lacks permission to read Auth config.');
      console.log('         Grant it "Firebase Authentication Admin" in IAM, or just');
      console.log('         check the console directly.');
    }
  } else {
    const list = idps.body.defaultSupportedIdpConfigs || [];
    if (!list.length) {
      console.log('  [FAIL] NO sign-in providers are enabled.');
      console.log('         This is exactly what produces "The requested action is invalid."');
      console.log('         Enabling Authentication and enabling a PROVIDER are two');
      console.log('         separate steps, and only the first has been done.');
      console.log('');
      console.log('         Fix: Firebase Console -> Authentication -> Sign-in method');
      console.log('              -> Google -> Enable -> pick a support email -> Save');
    } else {
      for (const p of list) {
        const id = (p.name || '').split('/').pop();
        const on = p.enabled === true;
        console.log(`  [${on ? ' OK ' : 'OFF '}] ${id}${p.clientId ? `  (OAuth client ${p.clientId.slice(0, 28)}…)` : '  (no OAuth client!)'}`);
        if (on && !p.clientId) {
          console.log('         Enabled but has no OAuth client ID — the provider is');
          console.log('         half-configured. Toggle it off and on again in the console.');
        }
      }
      if (!list.some((p) => (p.name || '').endsWith('google.com') && p.enabled)) {
        console.log('  [FAIL] google.com is not enabled — the app only offers Google sign-in.');
      }
    }
  }

  // ── Which domains may start a sign-in? ────────────────────────────────────
  const cfg = await call('/config');
  console.log('\nAUTHORISED DOMAINS');
  if (cfg.status !== 200) {
    console.log(`  [FAIL] HTTP ${cfg.status}: ${cfg.body?.error?.message || 'unknown'}`);
  } else {
    const domains = cfg.body.authorizedDomains || [];
    const need = [`${PROJECT_ID}.web.app`, `${PROJECT_ID}.firebaseapp.com`, 'localhost'];
    for (const d of domains) console.log(`         ${d}`);
    const missing = need.filter((d) => !domains.includes(d));
    console.log(missing.length
      ? `  [FAIL] Missing: ${missing.join(', ')} — sign-in from those origins will be rejected.`
      : '  [ OK ] All expected domains authorised.');

    // A couple of other things that break the handler in confusing ways.
    const quota = cfg.body.signIn?.allowDuplicateEmails;
    console.log('\nACCOUNT LINKING');
    console.log(quota === true
      ? '  [WARN] "Multiple accounts per email" is ON. A Google sign-in will create a\n' +
        '         NEW uid rather than linking to the migrated account, so history\n' +
        '         would not follow the person in. Recommend turning this off.'
      : '  [ OK ] One account per email address — Google sign-in links to the\n' +
        '         existing migrated account, preserving history.');
  }

  console.log('');
}

main().catch((err) => {
  console.error(`\ncheck failed: ${err.message}`);
  process.exit(1);
});
