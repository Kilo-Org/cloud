import type { Context, Hono } from 'hono';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { resolveSecret } from '../auth.js';
import type { HonoContext } from '../hono-context.js';
import { logger } from '../logger.js';
import {
  controlLogIdentitySchema,
  type ControlLogIdentity,
} from '../shared/control-diagnostics.js';
import { withDORetry } from '../utils/do-retry.js';
import { getSandboxControlStub } from './stub.js';
import {
  WORKTREE_SNAPSHOT_MAX_BYTES,
  WORKTREE_SNAPSHOT_ROUTE_PREFIX,
  WORKTREE_SNAPSHOT_SHA256_PATTERN,
  mintWorktreeSnapshotGrant,
  validateWorktreeSnapshotGrant,
  worktreeSnapshotObjectKey,
  worktreeSnapshotReadsEnabled,
  worktreeSnapshotWritesEnabled,
} from './worktree-snapshot-grant.js';

export { WORKTREE_SNAPSHOT_ROUTE_PREFIX };

const OBJECT_CONTENT_TYPE = 'application/gzip';

function declaredLength(header: string | undefined): number | undefined | 'invalid' {
  if (header === undefined) return undefined;
  if (!/^\d+$/.test(header)) return 'invalid';
  return Number(header);
}

function sha256Header(header: string | undefined): string | undefined {
  return header && WORKTREE_SNAPSHOT_SHA256_PATTERN.test(header) ? header.toLowerCase() : undefined;
}

type SnapshotRouteIdentity = {
  identity: ControlLogIdentity;
  worktreeId: string;
};

function routeIdentity(c: Context<HonoContext>): SnapshotRouteIdentity | undefined {
  const identity = controlLogIdentitySchema.safeParse({
    sandboxId: c.req.param('sandboxId'),
    allocationId: c.req.param('allocationId'),
    wrapperInstanceId: c.req.param('wrapperInstanceId'),
  });
  const worktreeId = cloudAgentWorktreeIdSchema.safeParse(c.req.param('worktreeId'));
  if (!identity.success || !worktreeId.success) return undefined;
  return { identity: identity.data, worktreeId: worktreeId.data };
}

async function authorizeSandbox(
  c: Context<HonoContext>,
  identity: ControlLogIdentity,
  worktreeId: string
): Promise<boolean> {
  return withDORetry(
    () => getSandboxControlStub(c.env, identity.sandboxId),
    stub =>
      stub.authorizeWorktreeSnapshot({
        allocationId: identity.allocationId,
        worktreeId,
      }),
    'authorizeWorktreeSnapshot'
  );
}

async function isSnapshotTombstoned(
  c: Context<HonoContext>,
  sandboxId: string,
  worktreeId: string
): Promise<boolean> {
  return withDORetry(
    () => getSandboxControlStub(c.env, sandboxId),
    stub => stub.isWorktreeSnapshotTombstoned({ worktreeId }),
    'isWorktreeSnapshotTombstoned'
  );
}

async function authorizeRequest(
  c: Context<HonoContext>
): Promise<SnapshotRouteIdentity | Response> {
  const target = routeIdentity(c);
  if (!target) return c.text('Invalid worktree snapshot identity', 400);
  const grant = validateWorktreeSnapshotGrant(
    c.req.header('Authorization') ?? null,
    await resolveSecret(c.env.NEXTAUTH_SECRET)
  );
  if (!grant) return c.text('Unauthorized', 401);
  if (
    grant.sandboxId !== target.identity.sandboxId ||
    grant.allocationId !== target.identity.allocationId ||
    grant.wrapperInstanceId !== target.identity.wrapperInstanceId
  ) {
    return c.text('Worktree snapshot scope mismatch', 403);
  }
  let authorized: boolean;
  try {
    authorized = await authorizeSandbox(c, target.identity, target.worktreeId);
  } catch {
    return c.text('Sandbox unavailable', 503);
  }
  if (!authorized) return c.text('Forbidden', 403);
  return target;
}

function digestFromObject(object: R2Object): string | undefined {
  const stored = object.customMetadata?.sha256;
  if (stored && WORKTREE_SNAPSHOT_SHA256_PATTERN.test(stored)) return stored.toLowerCase();
  const checksum = object.checksums?.sha256;
  if (!checksum) return undefined;
  return [...new Uint8Array(checksum)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function discardIfCurrent(bucket: R2Bucket, key: string, etag: string): Promise<boolean> {
  const current = await bucket.head(key);
  if (!current || current.etag !== etag) return false;
  await bucket.delete(key);
  return true;
}

export function registerWorktreeSnapshotRoutes(app: Hono<HonoContext>): void {
  const base = `${WORKTREE_SNAPSHOT_ROUTE_PREFIX}/:sandboxId/:allocationId/:wrapperInstanceId`;

  app.put(`${base}/:worktreeId`, async c => {
    if (!worktreeSnapshotWritesEnabled(c.env)) return c.text('Not found', 404);
    const authorized = await authorizeRequest(c);
    if (authorized instanceof Response) return authorized;

    const length = declaredLength(c.req.header('Content-Length'));
    if (length === undefined) return c.text('Content-Length required', 411);
    if (length === 'invalid') return c.text('Invalid length', 400);
    if (length === 0) return c.text('Missing request body', 400);
    if (length > WORKTREE_SNAPSHOT_MAX_BYTES) return c.text('Body too large', 413);

    const digest = sha256Header(c.req.header('x-kilo-sha256'));
    if (!digest) return c.text('Invalid sha256 digest', 400);

    const encoding = c.req.header('Content-Encoding');
    if (encoding && encoding !== 'identity') return c.text('Unsupported encoding', 415);

    const body = c.req.raw.body;
    if (!body) return c.text('Missing request body', 400);
    const bucket = c.env.WORKTREE_SNAPSHOTS_BUCKET;
    if (!bucket) return c.text('Worktree snapshot storage unavailable', 503);

    const key = worktreeSnapshotObjectKey(authorized.worktreeId);
    let stored: R2Object;
    try {
      stored = await bucket.put(key, body, {
        sha256: digest,
        httpMetadata: { contentType: OBJECT_CONTENT_TYPE },
        customMetadata: { sha256: digest },
      });
    } catch (error) {
      if (error instanceof Error && /sha256|checksum|digest/i.test(error.message)) {
        return c.text('Digest mismatch', 400);
      }
      logger
        .withFields({
          event: 'worktree_snapshot_upload_failed',
          sandboxId: authorized.identity.sandboxId,
          worktreeId: authorized.worktreeId,
        })
        .warn('Worktree snapshot upload failed');
      return c.text('Worktree snapshot storage unavailable', 503);
    }

    let tombstoned: boolean;
    try {
      tombstoned = await isSnapshotTombstoned(
        c,
        authorized.identity.sandboxId,
        authorized.worktreeId
      );
    } catch {
      return c.text('Sandbox unavailable', 503);
    }
    if (!tombstoned) return c.body(null, 204);

    try {
      await discardIfCurrent(bucket, key, stored.etag);
    } catch {
      logger
        .withFields({
          event: 'worktree_snapshot_discard_failed',
          sandboxId: authorized.identity.sandboxId,
          worktreeId: authorized.worktreeId,
        })
        .warn('Worktree snapshot discard failed');
    }
    return c.text('Forbidden', 403);
  });

  app.get(`${base}/:worktreeId`, async c => {
    if (!worktreeSnapshotReadsEnabled(c.env)) return c.text('Not found', 404);
    const authorized = await authorizeRequest(c);
    if (authorized instanceof Response) return authorized;
    const bucket = c.env.WORKTREE_SNAPSHOTS_BUCKET;
    if (!bucket) return c.text('Worktree snapshot storage unavailable', 503);
    let object: R2ObjectBody | null;
    try {
      object = await bucket.get(worktreeSnapshotObjectKey(authorized.worktreeId));
    } catch {
      return c.text('Worktree snapshot storage unavailable', 503);
    }
    if (!object) return c.text('Not found', 404);
    const digest = digestFromObject(object);
    if (!digest) return c.text('Worktree snapshot storage unavailable', 503);
    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType ?? OBJECT_CONTENT_TYPE,
        'Content-Length': String(object.size),
        'x-kilo-sha256': digest,
        'Cache-Control': 'no-store',
      },
    });
  });

  app.post(`${base}/:worktreeId/renew`, async c => {
    if (!worktreeSnapshotWritesEnabled(c.env)) return c.text('Not found', 404);
    const authorized = await authorizeRequest(c);
    if (authorized instanceof Response) return authorized;
    const secret = await resolveSecret(c.env.NEXTAUTH_SECRET);
    if (!secret) return c.text('Authentication unavailable', 503);
    return c.json({ grant: mintWorktreeSnapshotGrant(authorized.identity, secret) });
  });
}
