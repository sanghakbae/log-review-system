// One-off fix: the initial migration imported auth users with a malformed
// Google provider link (providerData.uid set to the email instead of the real
// Google federated `sub`). That makes a real Google sign-in throw
// auth/provider-already-linked. This unlinks the bogus google.com provider so
// sign-in re-links it correctly by verified email — uid and data are preserved.
//
// Run from repo root:
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
//   node scripts/fix-auth-providers.mjs                 # fix ALL imported users
//   node scripts/fix-auth-providers.mjs totoriverce@gmail.com   # fix one user

import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

initializeApp({ credential: applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID || 'log-review-system' });
const auth = getAuth();

const onlyEmail = process.argv[2];

const hasBogusGoogle = (user) =>
  (user.providerData || []).some((p) => p.providerId === 'google.com' && p.uid === user.email);

async function fixUser(user) {
  if (!hasBogusGoogle(user)) return false;
  await auth.updateUser(user.uid, { providersToUnlink: ['google.com'] });
  console.log(`  unlinked google.com from ${user.email} (uid ${user.uid})`);
  return true;
}

async function main() {
  let fixed = 0;
  if (onlyEmail) {
    const user = await auth.getUserByEmail(onlyEmail);
    if (await fixUser(user)) fixed += 1;
    else console.log(`  ${onlyEmail}: no bogus google link, skipped`);
  } else {
    let pageToken;
    do {
      const res = await auth.listUsers(1000, pageToken);
      for (const u of res.users) {
        if (await fixUser(u)) fixed += 1;
      }
      pageToken = res.pageToken;
    } while (pageToken);
  }
  console.log(`Done. Fixed ${fixed} user(s).`);
}

main().catch((e) => {
  console.error('Failed:', e);
  process.exit(1);
});
