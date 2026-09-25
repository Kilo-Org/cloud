import type { Hono, Context } from 'hono';
import type { HonoContext } from '../hono-context.js';
import { resolveSecret } from '../auth.js';
import { logger } from '../logger.js';
import {
  CONTROL_LOG_ARCHIVE_NAME,
  CONTROL_LOG_MAX_ARCHIVE_BYTES,
  CONTROL_LOG_MAX_BATCH_BYTES,
  controlLogBatchSchema,
  controlLogIdentitySchema,
  controlLogWrapperIdSchema,
  isUnreapedOwnedProcessDiagnostic,
  OWNED_PROCESS_CLEANUP_UNREAPED,
  type ControlLogBatch,
  type ControlLogIdentity,
} from '../shared/control-diagnostics.js';
import { validateControlLogUploadGrant } from './log-upload-grant.js';
import { declaredLength, readBoundedBytes } from './bounded-body.js';

function reportUnreapedOwnedProcessCleanup(
  identity: ControlLogIdentity,
  batch: ControlLogBatch
): void {
  for (const record of batch.records) {
    if (!isUnreapedOwnedProcessDiagnostic(record)) continue;
    logger
      .withFields({
        logTag: 'owned_process_unreaped',
        sessionId: record.fields.sessionId,
        sandboxId: identity.sandboxId,
      })
      .error(OWNED_PROCESS_CLEANUP_UNREAPED);
  }
}

function archivePrefix(identity: ControlLogIdentity): string {
  return `logs/control/${[identity.sandboxId, identity.allocationId, identity.wrapperInstanceId]
    .map(encodeURIComponent)
    .join('/')}/`;
}

function mediaType(header: string | undefined): string | undefined {
  return header?.split(';')[0].trim();
}

function routeIdentity(c: Context<HonoContext>) {
  return controlLogIdentitySchema.safeParse({
    sandboxId: c.req.param('sandboxId'),
    allocationId: c.req.param('allocationId'),
    wrapperInstanceId: c.req.param('wrapperInstanceId'),
  });
}

async function authorizeIdentity(
  c: Context<HonoContext>
): Promise<{ identity: ControlLogIdentity } | Response> {
  const identity = routeIdentity(c);
  if (!identity.success) return c.text('Invalid log identity', 400);
  const grant = validateControlLogUploadGrant(
    c.req.header('Authorization') ?? null,
    await resolveSecret(c.env.NEXTAUTH_SECRET)
  );
  if (!grant) return c.text('Unauthorized', 401);
  if (
    grant.sandboxId !== identity.data.sandboxId ||
    grant.allocationId !== identity.data.allocationId ||
    grant.wrapperInstanceId !== identity.data.wrapperInstanceId
  )
    return c.text('Log scope mismatch', 403);
  return { identity: identity.data };
}

export function registerControlLogRoutes(app: Hono<HonoContext>): void {
  app.put(
    `/sandbox-logs/:sandboxId/:allocationId/:wrapperInstanceId/${CONTROL_LOG_ARCHIVE_NAME}`,
    async c => {
      const authorized = await authorizeIdentity(c);
      if (authorized instanceof Response) return authorized;
      if (mediaType(c.req.header('Content-Type')) !== 'application/gzip') {
        return c.text('Expected application/gzip', 415);
      }
      const encoding = c.req.header('Content-Encoding');
      if (encoding && encoding !== 'identity') return c.text('Unsupported encoding', 415);
      const length = declaredLength(c.req.header('Content-Length'));
      if (length === 'invalid') return c.text('Invalid length', 400);
      if (length !== undefined && length > CONTROL_LOG_MAX_ARCHIVE_BYTES) {
        return c.text('Body too large', 413);
      }
      const body = await readBoundedBytes(c.req.raw, CONTROL_LOG_MAX_ARCHIVE_BYTES);
      if (body === undefined) return c.text('Body too large', 413);
      if (body.byteLength === 0) return c.text('Missing request body', 400);
      try {
        await c.env.R2_BUCKET.put(
          `${archivePrefix(authorized.identity)}${CONTROL_LOG_ARCHIVE_NAME}`,
          body,
          { httpMetadata: { contentType: 'application/gzip' } }
        );
      } catch {
        return c.text('Log storage unavailable', 503);
      }
      return c.body(null, 204);
    }
  );

  app.put('/sandbox-logs/:sandboxId/:allocationId/:wrapperInstanceId/:batchId', async c => {
    const authorized = await authorizeIdentity(c);
    if (authorized instanceof Response) return authorized;
    const batchId = controlLogWrapperIdSchema.safeParse(c.req.param('batchId'));
    if (!batchId.success) return c.text('Invalid log identity', 400);

    if (mediaType(c.req.header('Content-Type')) !== 'application/json') {
      return c.text('Expected application/json', 415);
    }
    const encoding = c.req.header('Content-Encoding');
    if (encoding && encoding !== 'identity') return c.text('Unsupported encoding', 415);
    const length = declaredLength(c.req.header('Content-Length'));
    if (length === 'invalid') return c.text('Invalid length', 400);
    if (length !== undefined && length > CONTROL_LOG_MAX_BATCH_BYTES) {
      return c.text('Body too large', 413);
    }

    let parsed: unknown;
    try {
      const bytes = await readBoundedBytes(c.req.raw, CONTROL_LOG_MAX_BATCH_BYTES);
      if (bytes === undefined) return c.text('Body too large', 413);
      parsed = JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
      );
    } catch {
      return c.text('Invalid log batch', 400);
    }
    const batch = controlLogBatchSchema.safeParse(parsed);
    if (!batch.success) return c.text('Invalid log batch', 400);
    let stored: unknown;
    try {
      stored = await c.env.R2_BUCKET.put(
        `${archivePrefix(authorized.identity)}${batchId.data}.json`,
        JSON.stringify(batch.data),
        {
          onlyIf: { etagDoesNotMatch: '*' },
          httpMetadata: { contentType: 'application/json' },
          customMetadata: { sequence: String(batch.data.sequence) },
        }
      );
    } catch {
      return c.text('Log storage unavailable', 503);
    }
    if (stored) reportUnreapedOwnedProcessCleanup(authorized.identity, batch.data);
    return c.body(null, 204);
  });
}
