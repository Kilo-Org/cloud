import type { Hono, Context } from 'hono';
import type { HonoContext } from '../hono-context.js';
import { resolveSecret } from '../auth.js';
import {
  WORKTREE_STATE_MAX_BYTES,
  WORKTREE_STATE_TTL_MS,
  worktreeStateIdentitySchema,
  worktreeStateObjectKey,
  type WorktreeStateIdentity,
} from '../shared/worktree-state.js';
import { validateWorktreeStateGrant } from './worktree-state-grant.js';

/**
 * Reads the body with a hard ceiling instead of trusting `Content-Length`,
 * which is a forbidden header the client's fetch layer may rewrite or drop.
 * Returns undefined once the ceiling is passed, so an oversized stream is
 * abandoned rather than buffered.
 */
async function readBoundedBody(request: Request): Promise<Uint8Array | undefined> {
  const stream: ReadableStream<Uint8Array> | null = request.body;
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > WORKTREE_STATE_MAX_BYTES) return undefined;
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function routeIdentity(c: Context<HonoContext>) {
  return worktreeStateIdentitySchema.safeParse({
    userId: c.req.param('userId'),
    scopeId: c.req.param('scopeId'),
  });
}

/**
 * Resolves the caller's grant against the route it is addressing. The grant is
 * minted per worktree scope, so a wrapper can only read and write the bundle
 * for the worktree it was attached to.
 */
async function authorize(
  c: Context<HonoContext>
): Promise<{ identity: WorktreeStateIdentity } | Response> {
  const identity = routeIdentity(c);
  if (!identity.success) return c.text('Invalid worktree state identity', 400);
  const grant = validateWorktreeStateGrant(
    c.req.header('Authorization') ?? null,
    await resolveSecret(c.env.NEXTAUTH_SECRET)
  );
  if (!grant) return c.text('Unauthorized', 401);
  if (grant.userId !== identity.data.userId || grant.scopeId !== identity.data.scopeId) {
    return c.text('Worktree state scope mismatch', 403);
  }
  return { identity: identity.data };
}

export function registerWorktreeStateRoutes(app: Hono<HonoContext>): void {
  app.put('/worktree-state/:userId/:scopeId', async c => {
    const authorized = await authorize(c);
    if (authorized instanceof Response) return authorized;

    const declaredLength = c.req.header('Content-Length');
    if (declaredLength && !/^\d+$/.test(declaredLength)) return c.text('Invalid length', 400);
    if (Number(declaredLength) > WORKTREE_STATE_MAX_BYTES) return c.text('Body too large', 413);

    const body = await readBoundedBody(c.req.raw);
    if (body === undefined) return c.text('Body too large', 413);
    if (body.byteLength === 0) return c.text('Missing request body', 400);

    const expiresAt = Date.now() + WORKTREE_STATE_TTL_MS;
    try {
      await c.env.R2_BUCKET.put(worktreeStateObjectKey(authorized.identity), body, {
        httpMetadata: { contentType: 'application/gzip' },
        customMetadata: { expiresAt: String(expiresAt) },
      });
    } catch {
      return c.text('Worktree state storage unavailable', 503);
    }
    return c.body(null, 204);
  });

  app.get('/worktree-state/:userId/:scopeId', async c => {
    const authorized = await authorize(c);
    if (authorized instanceof Response) return authorized;

    const key = worktreeStateObjectKey(authorized.identity);
    let object: R2ObjectBody | null;
    try {
      object = await c.env.R2_BUCKET.get(key);
    } catch {
      return c.text('Worktree state storage unavailable', 503);
    }
    if (!object) return c.text('Not found', 404);

    // R2 lifecycle rules are not guaranteed to have run; enforce the TTL here so
    // a stale bundle is never replayed onto a rebuilt worktree.
    const expiresAt = Number(object.customMetadata?.expiresAt ?? '');
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      await c.env.R2_BUCKET.delete(key).catch(() => undefined);
      return c.text('Not found', 404);
    }
    return c.body(object.body, 200, { 'Content-Type': 'application/gzip' });
  });

  app.delete('/worktree-state/:userId/:scopeId', async c => {
    const authorized = await authorize(c);
    if (authorized instanceof Response) return authorized;
    try {
      await c.env.R2_BUCKET.delete(worktreeStateObjectKey(authorized.identity));
    } catch {
      return c.text('Worktree state storage unavailable', 503);
    }
    return c.body(null, 204);
  });
}
