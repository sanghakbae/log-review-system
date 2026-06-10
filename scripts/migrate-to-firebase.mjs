// One-off migration: Supabase (Postgres + Auth + Storage) -> Firebase
// (Firestore + Auth) + Cloudflare R2 (files).
//
// This is the ONLY place that still talks to Supabase, and it runs manually,
// off the app's runtime path. Delete it once the cutover is verified.
//
// Prerequisites (env vars):
//   SUPABASE_URL                  e.g. https://gfybyxbrmkwbzuyhyqiv.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY     service role key (bypasses RLS — keep secret)
//   GOOGLE_APPLICATION_CREDENTIALS  path to a Firebase service-account JSON
//   FIREBASE_PROJECT_ID           (optional) defaults to log-review-system
//   R2_BUCKET_NAME                (optional) defaults to log-review-uploads
//
// The storage step copies files to R2 via the already-logged-in `wrangler`
// CLI (run `wrangler login` once) — no R2 API token needed. Run this script
// from the repo root.
//
// Run:
//   node scripts/migrate-to-firebase.mjs            # full migration
//   node scripts/migrate-to-firebase.mjs --dry-run  # report counts, write nothing
//   node scripts/migrate-to-firebase.mjs --only=auth,data,storage

import { spawn } from 'node:child_process';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

// --- config ---------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'log-review-system';

const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'log-review-uploads';
const WORKER_DIR = path.resolve(process.cwd(), 'workers/r2-files');

// Supabase storage bucket the files currently live in.
const STORAGE_BUCKET = 'review-uploads';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.split('=')[1].split(',') : ['auth', 'data', 'storage'];

// Migration order matters: profiles first (FK target), then independent
// settings tables, then requests, then request-dependent tables.
const TABLES = [
  'lr_profiles',
  'lr_service_names',
  'lr_google_chat_webhooks',
  'lr_review_prompt_settings',
  'lr_review_prompt_scripts',
  'lr_ai_settings',
  'lr_review_requests',
  'lr_review_attachments',
  'lr_review_results',
  'lr_review_logs',
];

const PUBLIC_REQUESTS = 'lr_public_review_requests';

function requireEnv() {
  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) missing.push('GOOGLE_APPLICATION_CREDENTIALS');
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
}

requireEnv();

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

initializeApp({
  credential: applicationDefault(),
  projectId: FIREBASE_PROJECT_ID,
});
const db = getFirestore();
const auth = getAuth();

const log = (...m) => console.log(...m);

// Upload one object to R2 via the logged-in wrangler CLI (no R2 token needed).
function r2Put(key, buffer, contentType) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'npx',
      ['wrangler', 'r2', 'object', 'put', `${R2_BUCKET_NAME}/${key}`, '--pipe', '--remote', '--content-type', contentType],
      { cwd: WORKER_DIR, stdio: ['pipe', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `wrangler exit ${code}`))));
    child.stdin.end(buffer);
  });
}

// --- 1. Auth users (uid-preserving) ---------------------------------------

async function migrateAuthUsers() {
  log('\n=== Auth users ===');
  const users = [];
  let page = 1;
  // supabase admin paginates 50/page by default; loop until empty.
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    if (!data?.users?.length) break;
    users.push(...data.users);
    if (data.users.length < 1000) break;
    page += 1;
  }
  log(`Found ${users.length} Supabase auth users`);

  // NOTE: do NOT fabricate a google.com providerData entry. The provider uid
  // must be the real Google federated `sub` (unknown here). A wrong value (e.g.
  // the email) makes a real Google sign-in fail with auth/provider-already-linked.
  // Import with a verified email only; Google links itself on first sign-in.
  const toImport = users.map((u) => ({
    uid: u.id, // preserve the uid so all FK references stay valid
    email: u.email,
    emailVerified: true,
    displayName: u.user_metadata?.full_name || u.user_metadata?.name || undefined,
    photoURL: u.user_metadata?.avatar_url || undefined,
  }));

  if (DRY_RUN) {
    log(`[dry-run] would import ${toImport.length} users`);
    return;
  }

  // importUsers handles up to 1000 at a time.
  for (let i = 0; i < toImport.length; i += 1000) {
    const batch = toImport.slice(i, i + 1000);
    const res = await auth.importUsers(batch);
    log(`Imported ${res.successCount} users, ${res.failureCount} failures`);
    res.errors?.forEach((e) => console.error('  import error:', e.index, e.error?.message));
  }
}

// --- 2. Firestore collections ---------------------------------------------

async function fetchAll(table) {
  const rows = [];
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase.from(table).select('*').range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function commitInBatches(writes) {
  // writes: array of { ref, data }
  for (let i = 0; i < writes.length; i += 500) {
    const batch = db.batch();
    for (const w of writes.slice(i, i + 500)) batch.set(w.ref, w.data, { merge: true });
    await batch.commit();
  }
}

function publicProjection(req) {
  const body = req.request_body || {};
  return {
    id: req.id,
    title: req.title ?? '',
    requester_name: req.requester_name ?? '',
    status: req.status ?? '',
    request_created_at: req.request_created_at ?? req.created_at ?? null,
    created_at: req.created_at ?? null,
    service_name: body.serviceName ?? req.service_name ?? '',
    log_file_count: Array.isArray(body.logFiles) ? body.logFiles.length : 0,
  };
}

async function migrateData() {
  log('\n=== Firestore collections ===');
  const attachmentsByRequest = {};

  for (const table of TABLES) {
    const rows = await fetchAll(table);
    log(`${table}: ${rows.length} rows`);

    if (table === 'lr_review_attachments') {
      for (const r of rows) {
        attachmentsByRequest[r.request_id] = (attachmentsByRequest[r.request_id] || 0) + 1;
      }
    }

    if (DRY_RUN) continue;

    const writes = rows.map((row) => ({ ref: db.collection(table).doc(String(row.id)), data: row }));
    await commitInBatches(writes);
  }

  // Build the public projection collection from review requests.
  const requests = await fetchAll('lr_review_requests');
  log(`${PUBLIC_REQUESTS}: ${requests.length} docs`);
  if (!DRY_RUN) {
    const writes = requests.map((req) => {
      const pub = publicProjection(req);
      // Prefer attachment count when the request body has no logFiles preview.
      if (!pub.log_file_count && attachmentsByRequest[req.id]) {
        pub.log_file_count = attachmentsByRequest[req.id];
      }
      return { ref: db.collection(PUBLIC_REQUESTS).doc(String(req.id)), data: pub };
    });
    await commitInBatches(writes);
  }
}

// --- 3. Storage files ------------------------------------------------------

async function listStoragePaths(prefix = '') {
  const paths = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase.storage.from(STORAGE_BUCKET).list(prefix, {
      limit: 1000,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw error;
    if (!data?.length) break;
    for (const item of data) {
      const itemPath = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id || item.metadata) {
        paths.push(itemPath);
      } else {
        paths.push(...(await listStoragePaths(itemPath)));
      }
    }
    if (data.length < 1000) break;
    offset += 1000;
  }
  return paths;
}

async function migrateStorage() {
  log('\n=== Storage files (-> Cloudflare R2) ===');
  const paths = await listStoragePaths();
  log(`Found ${paths.length} objects under ${STORAGE_BUCKET}/`);
  if (DRY_RUN) return;

  // Keys are kept identical to the Supabase paths (no bucket prefix) so
  // lr_review_attachments.storage_path stays valid against the R2 Worker.
  let copied = 0;
  for (const path of paths) {
    const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(path);
    if (error || !data) {
      console.error(`  download failed: ${path} — ${error?.message ?? 'no data'}`);
      continue;
    }
    const buffer = Buffer.from(await data.arrayBuffer());
    try {
      await r2Put(path, buffer, data.type || 'application/octet-stream');
    } catch (err) {
      console.error(`  upload failed: ${path} — ${err instanceof Error ? err.message : err}`);
      continue;
    }
    copied += 1;
    if (copied % 25 === 0) log(`  copied ${copied}/${paths.length}`);
  }
  log(`Copied ${copied}/${paths.length} objects to R2 bucket ${R2_BUCKET_NAME}`);
}

// --- main ------------------------------------------------------------------

async function main() {
  log(`Migration starting${DRY_RUN ? ' (DRY RUN)' : ''}`);
  log(`Supabase: ${SUPABASE_URL}`);
  log(`Firebase: ${FIREBASE_PROJECT_ID}`);
  if (ONLY.includes('storage')) log(`R2 bucket: ${R2_BUCKET_NAME}`);
  log(`Steps: ${ONLY.join(', ')}`);

  if (ONLY.includes('auth')) await migrateAuthUsers();
  if (ONLY.includes('data')) await migrateData();
  if (ONLY.includes('storage')) await migrateStorage();

  log('\nDone.');
}

main().catch((err) => {
  console.error('\nMigration failed:', err);
  process.exit(1);
});
