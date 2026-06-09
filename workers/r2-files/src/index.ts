// Cloudflare Worker fronting an R2 bucket for the log-review-system app.
//
// The browser never holds R2 credentials. It calls this Worker with a Firebase
// ID token; the Worker verifies the token, then proxies file bytes to/from R2
// using the bucket binding (no S3 API token needed):
//   PUT  /object?path=<key>   -> upload (body = file bytes)
//   GET  /object?path=<key>   -> download
//   POST /list   { prefix }   -> list one "folder" level
//   POST /delete { paths }    -> delete keys
//
// Object keys mirror the old Supabase storage paths (e.g. `{requestId}/{file}`)
// so `lr_review_attachments.storage_path` stays valid after migration.

import { createRemoteJWKSet, jwtVerify } from 'jose';

interface Env {
  BUCKET: R2Bucket;
  FIREBASE_PROJECT_ID: string;
  ALLOWED_ORIGINS: string;
}

// Google's public keys for Firebase ID tokens (cached across requests).
const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
);

function allowedOrigin(env: Env, origin: string | null): string {
  const list = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (origin && list.includes(origin)) return origin;
  return list[0] ?? '*';
}

function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': allowedOrigin(env, origin),
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

async function verifyFirebaseToken(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return false;
  try {
    await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
      audience: env.FIREBASE_PROJECT_ID,
    });
    return true;
  } catch {
    return false;
  }
}

const cleanKey = (raw: string) => raw.replace(/^\/+/, '');

type ListItem = { name: string; id?: string; metadata?: Record<string, unknown> };

async function listLevel(env: Env, prefix: string): Promise<ListItem[]> {
  const p = prefix ? (prefix.endsWith('/') ? prefix : `${prefix}/`) : '';
  const items: ListItem[] = [];
  let cursor: string | undefined;
  do {
    const res = await env.BUCKET.list({ prefix: p, delimiter: '/', cursor });
    for (const obj of res.objects) {
      const leaf = obj.key.slice(p.length);
      if (leaf) items.push({ name: leaf, id: obj.key, metadata: {} });
    }
    for (const pre of res.delimitedPrefixes) {
      const leaf = pre.slice(p.length).replace(/\/$/, '');
      if (leaf) items.push({ name: leaf });
    }
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return items;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(env, origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (!(await verifyFirebaseToken(request, env))) {
      return json({ error: 'Unauthorized' }, 401, cors);
    }

    const url = new URL(request.url);
    const { pathname } = url;

    try {
      // --- file transfer (binding proxy) ---
      if (pathname === '/object') {
        const key = cleanKey(url.searchParams.get('path') ?? '');
        if (!key) return json({ error: 'Missing path' }, 400, cors);

        if (request.method === 'PUT') {
          await env.BUCKET.put(key, request.body, {
            httpMetadata: { contentType: request.headers.get('Content-Type') ?? 'application/octet-stream' },
          });
          return json({ ok: true, path: key }, 200, cors);
        }

        if (request.method === 'GET') {
          const obj = await env.BUCKET.get(key);
          if (!obj) return json({ error: 'Not found' }, 404, cors);
          const headers = new Headers(cors);
          headers.set('Content-Type', obj.httpMetadata?.contentType ?? 'application/octet-stream');
          headers.set('Content-Length', String(obj.size));
          return new Response(obj.body, { status: 200, headers });
        }

        return json({ error: 'Method not allowed' }, 405, cors);
      }

      // --- metadata operations (JSON) ---
      if (request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

        if (pathname === '/list') {
          const prefix = cleanKey(String(body.prefix ?? ''));
          return json({ items: await listLevel(env, prefix) }, 200, cors);
        }

        if (pathname === '/delete') {
          const paths = Array.isArray(body.paths) ? (body.paths as unknown[]).map((p) => cleanKey(String(p))) : [];
          if (paths.length === 0) return json({ ok: true, deleted: 0 }, 200, cors);
          await env.BUCKET.delete(paths);
          return json({ ok: true, deleted: paths.length }, 200, cors);
        }
      }

      return json({ error: 'Not found' }, 404, cors);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Internal error' }, 500, cors);
    }
  },
};
