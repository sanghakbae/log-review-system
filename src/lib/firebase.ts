// Firebase-backed backend client.
//
// The app (src/App.tsx) was originally written against the Supabase JS client.
// During the migration to Firebase, this module re-implements the exact subset
// of that query/auth/storage surface the app used, backed by Firebase Auth /
// Firestore / Cloud Storage, and exports it as `backend`. App.tsx imports
// `{ backend, isBackendReady } from './lib/firebase'` — there is no remaining
// dependency on Supabase at runtime.
//
// Surface reproduced (all return `{ data, error }`):
//   .from(t).select(cols).order(c,{ascending}).eq()/.in()/.limit()/.maybeSingle()
//   .from(t).insert(row|rows)
//   .from(t).update(obj).eq()/.in()
//   .from(t).delete().eq()/.in().select()
//   .from(t).upsert(row|rows, { onConflict })
//   .auth.getSession()/.onAuthStateChange()/.signInWithOAuth()/.signOut()
//   .storage.from(bucket).download()/.upload()/.remove()/.list()
//   .functions.invoke('google-chat-webhook', { body })

import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithCredential,
  signOut as fbSignOut,
  type Auth,
  type User as FirebaseUser,
} from 'firebase/auth';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  documentId,
  getDocs,
  getFirestore,
  limit as fsLimit,
  orderBy as fsOrderBy,
  query,
  setDoc,
  updateDoc,
  where,
  type Firestore,
  type QueryConstraint,
} from 'firebase/firestore';
type AnyRecord = Record<string, unknown>;
type ErrLike = { message: string } | null;
type Result<T> = { data: T; error: ErrLike };
// The original Supabase client (used without schema generics) resolved list
// queries' `data` as `any[]` and single queries' `data` as `any`. Mirroring
// that exactly is important: a bare `any` (object) breaks `data.map(row => …)`
// under noImplicitAny because the callback param gets no contextual type,
// whereas `any[]` supplies it. Keep the two shapes distinct.
/* eslint-disable @typescript-eslint/no-explicit-any */
type RowRecord = { [key: string]: any };

// The schemaless Supabase client parses a `.select('a, b, c')` string into a
// row type with *named* properties (`{ a: any; b: any; c: any }`). App.tsx
// relies on that: `NonNullable<typeof data>[number]` and `...spread` casts only
// work with named props — an index signature (`{[k]:any}`) collapses to
// `unknown` under `& {}`. So we reproduce the column-string parsing at the type
// level instead of returning a bare `any[]`.
type TrimWS<S extends string> = S extends ` ${infer R}`
  ? TrimWS<R>
  : S extends `${infer R} `
    ? TrimWS<R>
    : S;
type SplitCols<S extends string> = S extends `${infer H},${infer T}`
  ? TrimWS<H> | SplitCols<T>
  : TrimWS<S>;
// Non-literal column strings fall back to an index signature.
type RowOf<S extends string> = string extends S ? RowRecord : { [K in SplitCols<S>]: any };

type ListResult<TRow extends RowRecord = RowRecord> = { data: TRow[] | null; error: ErrLike };
type SingleResult<TRow extends RowRecord = RowRecord> = { data: TRow | null; error: ErrLike };
// Internal loose shape returned by execute()/run*(); the public `then`/single
// casts narrow it to the typed Result above.
type RawResult = { data: any; error: ErrLike };
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Config / initialization
// ---------------------------------------------------------------------------

// File storage lives in Cloudflare R2 (via a Worker), so no Firebase
// storageBucket is needed here — only Auth + Firestore.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
};

export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey &&
    firebaseConfig.authDomain &&
    firebaseConfig.projectId &&
    firebaseConfig.appId,
);

// Whether the backend (Firebase) is configured and usable.
export const isBackendReady = isFirebaseConfigured;

let app: FirebaseApp | null = null;
let authInstance: Auth | null = null;
let dbInstance: Firestore | null = null;

if (isFirebaseConfigured) {
  app = initializeApp(firebaseConfig as Required<typeof firebaseConfig>);
  authInstance = getAuth(app);
  dbInstance = getFirestore(app);
} else {
  console.warn('Missing VITE_FIREBASE_* config; auth/data actions are disabled.');
}

const requireDb = (): Firestore => {
  if (!dbInstance) throw new Error('Firebase is not configured');
  return dbInstance;
};

const PUBLIC_REQUESTS = 'lr_public_review_requests';
const REVIEW_REQUESTS = 'lr_review_requests';

// Public projection: only these fields are exposed to logged-out users.
const PUBLIC_FIELDS = ['title', 'requester_name', 'status', 'request_created_at', 'created_at'] as const;

const nowIso = () => new Date().toISOString();

const withId = (id: string, data: AnyRecord): AnyRecord => ({ ...data, id });

// Firestore rejects `undefined` field values; drop them.
const stripUndefined = (obj: AnyRecord): AnyRecord => {
  const out: AnyRecord = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};

// Build the public projection for a (possibly partial) review-request payload.
const buildPublicProjection = (payload: AnyRecord): AnyRecord => {
  const pub: AnyRecord = {};
  for (const field of PUBLIC_FIELDS) {
    if (payload[field] !== undefined) pub[field] = payload[field];
  }
  const body = payload.request_body as AnyRecord | undefined;
  if (body && typeof body === 'object') {
    pub.service_name = (body.serviceName as string | undefined) ?? '';
    const logFiles = body.logFiles as unknown[] | undefined;
    pub.log_file_count = Array.isArray(logFiles) ? logFiles.length : 0;
  }
  return pub;
};

// ---------------------------------------------------------------------------
// Query / mutation builder
// ---------------------------------------------------------------------------

const FIRESTORE_IN_LIMIT = 30;

const chunk = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

type Filter = { field: string; op: 'eq' | 'in'; value: unknown };
type Operation = 'select' | 'insert' | 'update' | 'delete' | 'upsert';

class FirestoreQueryBuilder<TRow extends RowRecord = RowRecord> implements PromiseLike<ListResult<TRow>> {
  private filters: Filter[] = [];
  private orderField: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private singleMode: 'none' | 'maybe' | 'strict' = 'none';
  private operation: Operation = 'select';
  private payload: AnyRecord | AnyRecord[] | null = null;
  private onConflict = 'id';
  private returnRows = false;

  constructor(private readonly table: string) {}

  // --- chainable selectors -------------------------------------------------
  // `select` re-types the row to the named columns parsed from the string, so
  // downstream `data` carries `{ col: any }` shape (see RowOf above).
  select<S extends string>(columns?: S): FirestoreQueryBuilder<RowOf<S>> {
    // After a mutation, `.select()` only flags that rows should be returned.
    if (this.operation !== 'select') {
      this.returnRows = true;
    }
    void columns;
    return this as unknown as FirestoreQueryBuilder<RowOf<S>>;
  }

  eq(field: string, value: unknown): this {
    this.filters.push({ field, op: 'eq', value });
    return this;
  }

  in(field: string, values: unknown[]): this {
    this.filters.push({ field, op: 'in', value: values });
    return this;
  }

  order(field: string, opts?: { ascending?: boolean }): this {
    this.orderField = field;
    this.orderAsc = opts?.ascending !== false;
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  // maybeSingle/single resolve to a single row object, not an array.
  maybeSingle(): PromiseLike<SingleResult<TRow>> {
    this.singleMode = 'maybe';
    return { then: (onf, onr) => this.execute().then(onf as never, onr) };
  }

  single(): PromiseLike<SingleResult<TRow>> {
    this.singleMode = 'strict';
    return { then: (onf, onr) => this.execute().then(onf as never, onr) };
  }

  // --- mutations -----------------------------------------------------------
  insert(payload: AnyRecord | AnyRecord[]): this {
    this.operation = 'insert';
    this.payload = payload;
    return this;
  }

  update(payload: AnyRecord): this {
    this.operation = 'update';
    this.payload = payload;
    return this;
  }

  delete(): this {
    this.operation = 'delete';
    return this;
  }

  upsert(payload: AnyRecord | AnyRecord[], opts?: { onConflict?: string }): this {
    this.operation = 'upsert';
    this.payload = payload;
    this.onConflict = opts?.onConflict ?? 'id';
    return this;
  }

  // --- execution -----------------------------------------------------------
  then<TResult1 = ListResult<TRow>, TResult2 = never>(
    onfulfilled?: ((value: ListResult<TRow>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled as never, onrejected);
  }

  private async execute(): Promise<RawResult> {
    try {
      switch (this.operation) {
        case 'select':
          return await this.runSelect();
        case 'insert':
          return await this.runInsert();
        case 'update':
          return await this.runUpdate();
        case 'delete':
          return await this.runDelete();
        case 'upsert':
          return await this.runUpsert();
      }
    } catch (error) {
      return { data: null, error: { message: error instanceof Error ? error.message : 'Unknown error' } };
    }
  }

  private async fetchMatchingDocs(): Promise<{ id: string; data: AnyRecord }[]> {
    const db = requireDb();
    const col = collection(db, this.table);
    const inFilter = this.filters.find((f) => f.op === 'in');

    const runQuery = async (extra: QueryConstraint[]): Promise<{ id: string; data: AnyRecord }[]> => {
      const constraints: QueryConstraint[] = [...extra];
      for (const f of this.filters) {
        // The `id` filter targets the document ID, not a stored field.
        if (f.op === 'eq') constraints.push(where(f.field === 'id' ? documentId() : f.field, '==', f.value));
      }
      if (this.orderField) constraints.push(fsOrderBy(this.orderField, this.orderAsc ? 'asc' : 'desc'));
      if (this.limitN != null) constraints.push(fsLimit(this.limitN));
      const snap = await getDocs(query(col, ...constraints));
      return snap.docs.map((d) => ({ id: d.id, data: d.data() as AnyRecord }));
    };

    if (inFilter) {
      const values = (inFilter.value as unknown[]) ?? [];
      if (values.length === 0) return [];
      const inField = inFilter.field === 'id' ? documentId() : inFilter.field;
      const batches = await Promise.all(
        chunk(values, FIRESTORE_IN_LIMIT).map((batch) => runQuery([where(inField, 'in', batch)])),
      );
      // Merge and de-duplicate by id (chunks are disjoint, but be safe).
      const seen = new Map<string, { id: string; data: AnyRecord }>();
      for (const row of batches.flat()) seen.set(row.id, row);
      return Array.from(seen.values());
    }

    return runQuery([]);
  }

  private async runSelect(): Promise<RawResult> {
    const rows = await this.fetchMatchingDocs();
    const data = rows.map((r) => withId(r.id, r.data));

    if (this.singleMode !== 'none') {
      return { data: data[0] ?? null, error: null };
    }
    return { data, error: null };
  }

  private async runInsert(): Promise<RawResult> {
    const db = requireDb();
    const rows = Array.isArray(this.payload) ? this.payload : [this.payload!];
    const written: AnyRecord[] = [];

    for (const raw of rows) {
      const id = (raw.id as string | undefined) ?? crypto.randomUUID();
      const record = stripUndefined({
        ...raw,
        id,
        created_at: (raw.created_at as string | undefined) ?? nowIso(),
        updated_at: nowIso(),
      });
      await setDoc(doc(db, this.table, id), record);
      if (this.table === REVIEW_REQUESTS) await this.syncPublic(id, record);
      written.push(withId(id, record));
    }

    return { data: this.returnRows ? written : null, error: null };
  }

  private async runUpdate(): Promise<RawResult> {
    const db = requireDb();
    const patch = stripUndefined({ ...(this.payload as AnyRecord), updated_at: nowIso() });
    const matches = await this.fetchMatchingDocs();
    const updated: AnyRecord[] = [];

    for (const match of matches) {
      await updateDoc(doc(db, this.table, match.id), patch);
      if (this.table === REVIEW_REQUESTS) await this.syncPublic(match.id, patch);
      updated.push(withId(match.id, { ...match.data, ...patch }));
    }

    return { data: this.returnRows ? updated : null, error: null };
  }

  private async runDelete(): Promise<RawResult> {
    const db = requireDb();
    const matches = await this.fetchMatchingDocs();
    const deleted: AnyRecord[] = [];

    for (const match of matches) {
      await deleteDoc(doc(db, this.table, match.id));
      if (this.table === REVIEW_REQUESTS) {
        await deleteDoc(doc(db, PUBLIC_REQUESTS, match.id)).catch(() => undefined);
      }
      deleted.push(withId(match.id, match.data));
    }

    return { data: this.returnRows ? deleted.map((d) => ({ id: d.id })) : null, error: null };
  }

  private async runUpsert(): Promise<RawResult> {
    const db = requireDb();
    const rows = Array.isArray(this.payload) ? this.payload : [this.payload!];
    const written: AnyRecord[] = [];

    for (const raw of rows) {
      const record = stripUndefined({ ...raw, updated_at: nowIso() });

      if (this.onConflict === 'id') {
        const id = (raw.id as string | undefined) ?? crypto.randomUUID();
        record.id = id;
        await setDoc(doc(db, this.table, id), record, { merge: true });
        if (this.table === REVIEW_REQUESTS) await this.syncPublic(id, record);
        written.push(withId(id, record));
        continue;
      }

      // Conflict on a non-id field (e.g. name, url, slot_index): find the
      // existing doc by that field, update it; otherwise create a new doc.
      const conflictValue = raw[this.onConflict];
      const col = collection(db, this.table);
      const existing = await getDocs(query(col, where(this.onConflict, '==', conflictValue), fsLimit(1)));
      if (!existing.empty) {
        const target = existing.docs[0];
        await setDoc(doc(db, this.table, target.id), record, { merge: true });
        written.push(withId(target.id, record));
      } else {
        const created = await addDoc(col, { ...record, created_at: (raw.created_at as string | undefined) ?? nowIso() });
        written.push(withId(created.id, record));
      }
    }

    return { data: this.returnRows ? written : null, error: null };
  }

  private async syncPublic(id: string, payload: AnyRecord): Promise<void> {
    const db = requireDb();
    const pub = buildPublicProjection(payload);
    if (Object.keys(pub).length === 0) return;
    pub.id = id;
    await setDoc(doc(db, PUBLIC_REQUESTS, id), pub, { merge: true });
  }
}

// ---------------------------------------------------------------------------
// Auth shim
// ---------------------------------------------------------------------------

type ShimSession = {
  user: { id: string; email: string | null; user_metadata: { full_name: string; name: string } };
} | null;

// --- Google Identity Services (GIS) ----------------------------------------
//
// Google sign-in is done via GIS (a Google ID token obtained client-side) and
// exchanged for a Firebase session with signInWithCredential. This avoids the
// `<project>.firebaseapp.com/__/auth/handler` popup/redirect entirely, so it
// works on the custom domain without cross-origin storage-partitioning issues.
// Requires the app origin in the OAuth client's "Authorized JavaScript origins".

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

/* eslint-disable @typescript-eslint/no-explicit-any */
let gisScriptPromise: Promise<void> | null = null;
const loadGis = (): Promise<void> => {
  if (gisScriptPromise) return gisScriptPromise;
  gisScriptPromise = new Promise<void>((resolve, reject) => {
    if ((window as any).google?.accounts?.id) return resolve();
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google Identity Services'));
    document.head.appendChild(script);
  });
  return gisScriptPromise;
};

// Show a small modal with the official Google button; resolve with the ID token.
const requestGoogleIdToken = async (): Promise<string> => {
  await loadGis();
  const google = (window as any).google;
  return new Promise<string>((resolve, reject) => {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:2147483647;display:flex;align-items:center;justify-content:center';
    const box = document.createElement('div');
    box.style.cssText =
      'background:#fff;padding:28px 32px;border-radius:14px;display:flex;flex-direction:column;gap:18px;align-items:center;box-shadow:0 10px 40px rgba(0,0,0,.25)';
    const title = document.createElement('div');
    title.textContent = 'Google 계정으로 로그인';
    title.style.cssText = 'font-size:15px;font-weight:600;color:#0f172a';
    const buttonHost = document.createElement('div');
    const cancel = document.createElement('button');
    cancel.textContent = '취소';
    cancel.style.cssText = 'font-size:13px;color:#64748b;background:none;border:0;cursor:pointer';
    box.append(title, buttonHost, cancel);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    let settled = false;
    const cleanup = () => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    cancel.onclick = () => fail(new Error('cancelled'));
    overlay.onclick = (event) => {
      if (event.target === overlay) fail(new Error('cancelled'));
    };

    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      auto_select: false,
      cancel_on_tap_outside: true,
      callback: (response: any) => {
        if (settled) return;
        if (response?.credential) {
          settled = true;
          cleanup();
          resolve(response.credential as string);
        } else {
          fail(new Error('No credential returned'));
        }
      },
    });
    google.accounts.id.renderButton(buttonHost, {
      theme: 'outline',
      size: 'large',
      text: 'signin_with',
      width: 260,
    });
  });
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const toSession = (user: FirebaseUser | null): ShimSession => {
  if (!user) return null;
  const displayName = user.displayName ?? '';
  return {
    user: {
      id: user.uid,
      email: user.email,
      user_metadata: { full_name: displayName, name: displayName },
    },
  };
};

const authShim = {
  async getSession(): Promise<{ data: { session: ShimSession } }> {
    if (!authInstance) return { data: { session: null } };
    const auth = authInstance;
    const user = await new Promise<FirebaseUser | null>((resolve) => {
      const unsub = onAuthStateChanged(auth, (u) => {
        unsub();
        resolve(u);
      });
    });
    return { data: { session: toSession(user) } };
  },

  onAuthStateChange(
    callback: (event: 'SIGNED_IN' | 'SIGNED_OUT', session: ShimSession) => void,
  ): { data: { subscription: { unsubscribe: () => void } } } {
    if (!authInstance) {
      return { data: { subscription: { unsubscribe: () => undefined } } };
    }
    const unsubscribe = onAuthStateChanged(authInstance, (user) => {
      callback(user ? 'SIGNED_IN' : 'SIGNED_OUT', toSession(user));
    });
    return { data: { subscription: { unsubscribe } } };
  },

  async signInWithOAuth(_opts?: { provider?: string; options?: unknown }): Promise<Result<unknown>> {
    if (!authInstance) return { data: null, error: { message: 'Firebase is not configured' } };
    if (!GOOGLE_CLIENT_ID) return { data: null, error: { message: 'VITE_GOOGLE_CLIENT_ID is not configured' } };
    try {
      const idToken = await requestGoogleIdToken();
      const credential = GoogleAuthProvider.credential(idToken);
      await signInWithCredential(authInstance, credential);
      return { data: null, error: null };
    } catch (error) {
      // User dismissed the Google dialog — not an error worth surfacing.
      if (error instanceof Error && error.message === 'cancelled') return { data: null, error: null };
      return { data: null, error: { message: error instanceof Error ? error.message : 'Sign-in failed' } };
    }
  },

  async signOut(): Promise<Result<unknown>> {
    if (!authInstance) return { data: null, error: null };
    try {
      await fbSignOut(authInstance);
      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: { message: error instanceof Error ? error.message : 'Sign-out failed' } };
    }
  },
};

// ---------------------------------------------------------------------------
// Storage shim — backed by a Cloudflare R2 Worker (presigned URLs)
// ---------------------------------------------------------------------------
//
// The browser holds no R2 credentials. It calls the Worker (authenticated with
// the Firebase ID token); the Worker proxies file bytes to/from R2 via its
// binding, and handles list/delete. Object keys mirror the old Supabase paths,
// so the `bucket` argument here is logical-only and not part of the key.

type StorageListItem = { name: string; id?: string; metadata?: AnyRecord };

const R2_WORKER_URL = (import.meta.env.VITE_R2_WORKER_URL as string | undefined)?.replace(/\/+$/, '');

const getIdToken = async (): Promise<string | null> => {
  const user = authInstance?.currentUser;
  return user ? user.getIdToken() : null;
};

const authHeader = async (): Promise<Record<string, string>> => {
  const token = await getIdToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const callWorker = async (route: string, body: unknown): Promise<Response> => {
  if (!R2_WORKER_URL) throw new Error('VITE_R2_WORKER_URL is not configured');
  return fetch(`${R2_WORKER_URL}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(body),
  });
};

const objectUrl = (path: string) => {
  if (!R2_WORKER_URL) throw new Error('VITE_R2_WORKER_URL is not configured');
  return `${R2_WORKER_URL}/object?path=${encodeURIComponent(path)}`;
};

const storageBucketShim = (_bucket: string) => ({
  async download(path: string): Promise<Result<Blob>> {
    try {
      const res = await fetch(objectUrl(path), { headers: await authHeader() });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      return { data: await res.blob(), error: null };
    } catch (error) {
      return { data: null as unknown as Blob, error: { message: error instanceof Error ? error.message : 'Download failed' } };
    }
  },

  async upload(path: string, file: Blob, opts?: { contentType?: string; upsert?: boolean }): Promise<Result<unknown>> {
    try {
      // R2 overwrites by default, so `upsert` needs no special handling.
      const res = await fetch(objectUrl(path), {
        method: 'PUT',
        headers: {
          'Content-Type': opts?.contentType ?? file.type ?? 'application/octet-stream',
          ...(await authHeader()),
        },
        body: file,
      });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      return { data: { path }, error: null };
    } catch (error) {
      return { data: null, error: { message: error instanceof Error ? error.message : 'Upload failed' } };
    }
  },

  async remove(paths: string[]): Promise<Result<unknown>> {
    try {
      const res = await callWorker('/delete', { paths });
      if (!res.ok) throw new Error(`Remove failed (${res.status})`);
      return { data: paths.map((path) => ({ name: path })), error: null };
    } catch (error) {
      return { data: null, error: { message: error instanceof Error ? error.message : 'Remove failed' } };
    }
  },

  async list(
    prefix: string,
    opts?: { limit?: number; offset?: number; sortBy?: { column: string; order: string } },
  ): Promise<Result<StorageListItem[]>> {
    try {
      // The Worker enumerates one level fully; return empty for any non-zero
      // offset so the caller's offset-paging loop terminates (same as before).
      const offset = opts?.offset ?? 0;
      if (offset > 0) return { data: [], error: null };

      const res = await callWorker('/list', { prefix });
      if (!res.ok) throw new Error(`List failed (${res.status})`);
      const { items } = (await res.json()) as { items: StorageListItem[] };
      return { data: items ?? [], error: null };
    } catch (error) {
      return { data: [], error: { message: error instanceof Error ? error.message : 'List failed' } };
    }
  },
});

// ---------------------------------------------------------------------------
// Functions shim (Google Chat webhook relay, client-side)
// ---------------------------------------------------------------------------

const isGoogleChatWebhookUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'chat.googleapis.com';
  } catch {
    return false;
  }
};

type RelayBody = { webhookUrl?: string; webhookUrls?: string[]; payload?: { text?: string } };

const functionsShim = {
  async invoke(name: string, options?: { body?: RelayBody }): Promise<Result<{ ok: boolean; results: unknown[] }>> {
    if (name !== 'google-chat-webhook') {
      return { data: null as never, error: { message: `Unknown function: ${name}` } };
    }

    const body = options?.body ?? {};
    const text = body.payload?.text?.trim() ?? '';
    if (!text) return { data: null as never, error: { message: 'Missing message text' } };

    const webhookUrls = Array.from(
      new Set(
        [body.webhookUrl, ...(body.webhookUrls ?? [])].filter(
          (url): url is string => Boolean(url && url.trim()),
        ),
      ),
    );
    if (webhookUrls.length === 0) return { data: null as never, error: { message: 'Missing webhook URL' } };
    if (webhookUrls.some((url) => !isGoogleChatWebhookUrl(url))) {
      return { data: null as never, error: { message: 'Invalid Google Chat webhook URL' } };
    }

    const results = await Promise.all(
      webhookUrls.map(async (url) => {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
          });
          return { ok: response.ok, status: response.status };
        } catch (error) {
          return { ok: false, status: 0, error: error instanceof Error ? error.message : 'Unknown error' };
        }
      }),
    );

    const ok = results.every((r) => r.ok);
    return { data: { ok, results }, error: null };
  },
};

// ---------------------------------------------------------------------------
// Public backend client object
// ---------------------------------------------------------------------------

export const backend = {
  from(table: string): FirestoreQueryBuilder {
    // Reads of the public view are routed to the dedicated public collection.
    return new FirestoreQueryBuilder(table === PUBLIC_REQUESTS ? PUBLIC_REQUESTS : table);
  },
  auth: authShim,
  storage: { from: storageBucketShim },
  functions: functionsShim,
};

export type BackendClient = typeof backend;
