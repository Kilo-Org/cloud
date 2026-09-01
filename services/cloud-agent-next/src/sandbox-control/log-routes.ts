import type { Hono, Context } from 'hono';
import type { HonoContext } from '../hono-context.js';
import { resolveSecret } from '../auth.js';
import {
  CONTROL_LOG_MAX_BATCH_BYTES,
  controlLogBatchSchema,
  controlLogIdentitySchema,
  controlLogSandboxIdSchema,
  controlLogWrapperIdSchema,
  type ControlLogIdentity,
} from '../shared/control-diagnostics.js';
import { validateControlLogUploadGrant } from './log-upload-grant.js';

function archivePrefix(identity: ControlLogIdentity): string {
  return `logs/control/${[identity.sandboxId, identity.allocationId, identity.wrapperInstanceId]
    .map(encodeURIComponent)
    .join('/')}/`;
}

async function readBoundedBody(request: Request): Promise<string | undefined> {
  const stream: ReadableStream<Uint8Array> | null = request.body;
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > CONTROL_LOG_MAX_BATCH_BYTES) return undefined;
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
}

function routeIdentity(c: Context<HonoContext>) {
  return controlLogIdentitySchema.safeParse({
    sandboxId: c.req.param('sandboxId'),
    allocationId: c.req.param('allocationId'),
    wrapperInstanceId: c.req.param('wrapperInstanceId'),
  });
}

export function registerControlLogRoutes(
  app: Hono<HonoContext>,
  requireInternalApi: (c: Context<HonoContext>) => Response | null
): void {
  app.put('/sandbox-logs/:sandboxId/:allocationId/:wrapperInstanceId/:batchId', async c => {
    const identity = routeIdentity(c);
    const batchId = controlLogWrapperIdSchema.safeParse(c.req.param('batchId'));
    if (!identity.success || !batchId.success) return c.text('Invalid log identity', 400);
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

    if (c.req.header('Content-Type')?.split(';')[0].trim() !== 'application/json') {
      return c.text('Expected application/json', 415);
    }
    const encoding = c.req.header('Content-Encoding');
    if (encoding && encoding !== 'identity') return c.text('Unsupported encoding', 415);
    const declaredLength = c.req.header('Content-Length');
    if (declaredLength && !/^\d+$/.test(declaredLength)) return c.text('Invalid length', 400);
    if (Number(declaredLength) > CONTROL_LOG_MAX_BATCH_BYTES) return c.text('Body too large', 413);

    let body: unknown;
    try {
      const text = await readBoundedBody(c.req.raw);
      if (text === undefined) return c.text('Body too large', 413);
      body = JSON.parse(text);
    } catch {
      return c.text('Invalid log batch', 400);
    }
    const batch = controlLogBatchSchema.safeParse(body);
    if (!batch.success) return c.text('Invalid log batch', 400);
    try {
      await c.env.R2_BUCKET.put(
        `${archivePrefix(identity.data)}${batchId.data}.json`,
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
    return c.body(null, 204);
  });

  app.get('/internal/sandbox-logs/:sandboxId', async c => {
    const unauthorized = requireInternalApi(c);
    if (unauthorized) return unauthorized;
    const sandboxId = controlLogSandboxIdSchema.safeParse(c.req.param('sandboxId'));
    const cursor = c.req.query('cursor');
    if (!sandboxId.success || (cursor && cursor.length > 4096)) {
      return c.text('Invalid log query', 400);
    }
    try {
      const listed = await c.env.R2_BUCKET.list({
        prefix: `logs/control/${encodeURIComponent(sandboxId.data)}/`,
        limit: 100,
        ...(cursor ? { cursor } : {}),
        include: ['customMetadata'],
      });
      c.header('Cache-Control', 'no-store');
      return c.json({
        objects: listed.objects.map(object => ({
          key: object.key,
          size: object.size,
          uploaded: object.uploaded.toISOString(),
          sequence: object.customMetadata?.sequence,
        })),
        cursor: listed.truncated ? listed.cursor : null,
      });
    } catch {
      return c.text('Log storage unavailable', 503);
    }
  });

  app.get(
    '/internal/sandbox-logs/:sandboxId/:allocationId/:wrapperInstanceId/:batchId',
    async c => {
      const unauthorized = requireInternalApi(c);
      if (unauthorized) return unauthorized;
      const identity = routeIdentity(c);
      const batchId = controlLogWrapperIdSchema.safeParse(c.req.param('batchId'));
      if (!identity.success || !batchId.success) return c.text('Invalid log identity', 400);
      try {
        const object = await c.env.R2_BUCKET.get(
          `${archivePrefix(identity.data)}${batchId.data}.json`
        );
        if (!object) return c.text('Not found', 404);
        return new Response(object.body, {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      } catch {
        return c.text('Log storage unavailable', 503);
      }
    }
  );
}
