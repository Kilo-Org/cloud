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
import { declaredLength } from './bounded-body.js';

function decodeParam(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function routeIdentity(c: Context<HonoContext>) {
  return worktreeStateIdentitySchema.safeParse({
    userId: decodeParam(c.req.param('userId')),
    scopeId: decodeParam(c.req.param('scopeId')),
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

    if (c.req.header('Content-Type')?.split(';')[0].trim() !== 'application/gzip') {
      return c.text('Expected application/gzip', 415);
    }
    const encoding = c.req.header('Content-Encoding');
    if (encoding && encoding !== 'identity') return c.text('Unsupported encoding', 415);

    const length = declaredLength(c.req.header('Content-Length'));
    if (length === 'invalid') return c.text('Invalid length', 400);
    if (length === 0) return c.text('Missing request body', 400);
    if (length !== undefined && length > WORKTREE_STATE_MAX_BYTES) {
      return c.text('Body too large', 413);
    }
    const source = c.req.raw.body;
    if (!source) return c.text('Missing request body', 400);

    // Stream to R2 instead of buffering the whole bundle in the isolate; the
    // declared length already rejected the common oversized case, and this
    // transform bounds an undeclared (chunked) body too.
    let bytes = 0;
    let exceeded = false;
    const bounded = source.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > WORKTREE_STATE_MAX_BYTES) {
            exceeded = true;
            controller.error(new Error('worktree-state body exceeds the ceiling'));
            return;
          }
          controller.enqueue(chunk);
        },
      })
    );

    const expiresAt = Date.now() + WORKTREE_STATE_TTL_MS;
    const key = worktreeStateObjectKey(authorized.identity);
    try {
      await c.env.R2_BUCKET.put(key, bounded, {
        httpMetadata: { contentType: 'application/gzip' },
        customMetadata: { expiresAt: String(expiresAt) },
      });
    } catch {
      if (exceeded) return c.text('Body too large', 413);
      return c.text('Worktree state storage unavailable', 503);
    }
    if (bytes === 0) {
      await c.env.R2_BUCKET.delete(key).catch(() => undefined);
      return c.text('Missing request body', 400);
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
