import type { Context, Hono } from 'hono';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import { resolveSecret } from '../auth.js';
import type { HonoContext } from '../hono-context.js';
import { logger } from '../logger.js';
import { withDORetry } from '../utils/do-retry.js';
import {
  WORKTREE_SNAPSHOT_MAX_BYTES,
  WORKTREE_SNAPSHOT_ROUTE_PREFIX,
} from '../shared/worktree-snapshot.js';
import { getSandboxControlStub, isSandboxControlId } from './stub.js';
import {
  WORKTREE_SNAPSHOT_SHA256_PATTERN,
  worktreeSnapshotObjectKey,
  worktreeSnapshotReadsEnabled,
  worktreeSnapshotWritesEnabled,
} from './worktree-snapshot-authorization.js';
import { parseSandboxLaunchBearer, verifySandboxLaunchCredential } from './credential.js';

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

type AuthorizedSnapshotRoute = {
  sandboxId: string;
  allocationId: string;
  worktreeId: string;
  credential: string;
};

async function authorizeSandbox(
  c: Context<HonoContext>,
  input: AuthorizedSnapshotRoute
): Promise<boolean> {
  return withDORetry(
    () => getSandboxControlStub(c.env, input.sandboxId),
    stub =>
      stub.authorizeWorktreeSnapshot({
        allocationId: input.allocationId,
        worktreeId: input.worktreeId,
        credential: input.credential,
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
): Promise<AuthorizedSnapshotRoute | Response> {
  const sandboxId = c.req.param('sandboxId');
  if (!sandboxId || !isSandboxControlId(sandboxId)) return c.text('Invalid sandboxId', 400);
  const worktreeId = cloudAgentWorktreeIdSchema.safeParse(c.req.param('worktreeId'));
  if (!worktreeId.success) return c.text('Invalid worktree snapshot identity', 400);
  const token = parseSandboxLaunchBearer(c.req.header('Authorization') ?? null);
  if (token === null) return c.text('Unauthorized', 401);
  const secret = await resolveSecret(c.env.NEXTAUTH_SECRET);
  if (!secret) return c.text('Authentication unavailable', 503);
  const launch = verifySandboxLaunchCredential(token, secret);
  if (launch === null || launch.sandboxId !== sandboxId) return c.text('Unauthorized', 401);
  const target = {
    sandboxId,
    allocationId: launch.allocationId,
    worktreeId: worktreeId.data,
    credential: launch.credential,
  };
  let authorized: boolean;
  try {
    authorized = await authorizeSandbox(c, target);
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

function isDigestError(error: unknown): boolean {
  return error instanceof Error && /sha256|checksum|digest/i.test(error.message);
}

function fixedLengthBody(body: ReadableStream<Uint8Array>, length: number) {
  const controller = new AbortController();
  const reader = body.getReader();
  let received = 0;
  let sourceEnded = false;
  const source = new ReadableStream<Uint8Array>({
    async pull(output) {
      const chunk = await reader.read();
      if (chunk.done) {
        sourceEnded = true;
        output.close();
      } else {
        received += chunk.value.byteLength;
        output.enqueue(chunk.value);
      }
    },
    cancel: reason => reader.cancel(reason),
  });
  const fixed = new FixedLengthStream(length);
  const readable = fixed.readable;
  const settled = source
    .pipeTo(fixed.writable, { signal: controller.signal })
    .then(
      () => 'ok' as const,
      () => 'failed' as const
    )
    .finally(() => reader.releaseLock());
  return {
    readable,
    settled,
    received: () => received,
    sourceEnded: () => sourceEnded,
    abort: async () => {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await readable.cancel().catch(() => undefined);
    },
  };
}

async function discardIfCurrent(bucket: R2Bucket, key: string, etag: string): Promise<boolean> {
  const current = await bucket.head(key);
  if (!current || current.etag !== etag) return false;
  await bucket.delete(key);
  return true;
}

export function registerWorktreeSnapshotRoutes(app: Hono<HonoContext>): void {
  const base = `${WORKTREE_SNAPSHOT_ROUTE_PREFIX}/:sandboxId`;

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

    const body: ReadableStream<Uint8Array> | null = c.req.raw.body;
    if (!body) return c.text('Missing request body', 400);
    const bucket = c.env.WORKTREE_SNAPSHOTS_BUCKET;
    if (!bucket) return c.text('Worktree snapshot storage unavailable', 503);

    const key = worktreeSnapshotObjectKey(authorized.worktreeId);
    let current: R2Object | null;
    try {
      current = await bucket.head(key);
    } catch {
      return c.text('Worktree snapshot storage unavailable', 503);
    }
    const precondition: R2Conditional = current
      ? { etagMatches: current.etag }
      : { etagDoesNotMatch: '*' };

    let reauthorized: boolean;
    try {
      reauthorized = await authorizeSandbox(c, authorized);
    } catch {
      return c.text('Sandbox unavailable', 503);
    }
    if (!reauthorized) return c.text('Forbidden', 403);

    const streamed = fixedLengthBody(body, length);

    let stored: R2Object | null = null;
    let putError: unknown;
    try {
      stored = await bucket.put(key, streamed.readable, {
        sha256: digest,
        httpMetadata: { contentType: OBJECT_CONTENT_TYPE },
        customMetadata: { sha256: digest },
        onlyIf: precondition,
      });
    } catch (error) {
      putError = error;
    }

    if (putError !== undefined || stored === null) {
      await streamed.abort();
    }
    const pumped = await streamed.settled;
    const received = streamed.received();
    const overflow = received > length;
    const underflow = streamed.sourceEnded() && received < length;

    if (overflow || underflow) {
      logger
        .withFields({
          event: 'worktree_snapshot_upload_length_mismatch',
          sandboxId: authorized.sandboxId,
          worktreeId: authorized.worktreeId,
          declaredLength: length,
          received,
        })
        .warn('Worktree snapshot upload length mismatch');
      return c.text(overflow ? 'Body too large' : 'Body length mismatch', overflow ? 413 : 400);
    }
    if (putError !== undefined) {
      if (isDigestError(putError)) return c.text('Digest mismatch', 400);
      logger
        .withFields({
          event: 'worktree_snapshot_upload_failed',
          sandboxId: authorized.sandboxId,
          worktreeId: authorized.worktreeId,
        })
        .warn('Worktree snapshot upload failed');
      return c.text('Worktree snapshot storage unavailable', 503);
    }
    if (stored === null) return c.text('Snapshot upload conflict', 409);
    if (pumped === 'failed') {
      logger
        .withFields({
          event: 'worktree_snapshot_upload_pipe_failed',
          sandboxId: authorized.sandboxId,
          worktreeId: authorized.worktreeId,
        })
        .warn('Worktree snapshot upload body failed after storage write');
      return c.text('Worktree snapshot upload failed', 400);
    }

    let tombstoned: boolean;
    try {
      tombstoned = await isSnapshotTombstoned(c, authorized.sandboxId, authorized.worktreeId);
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
          sandboxId: authorized.sandboxId,
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
}
