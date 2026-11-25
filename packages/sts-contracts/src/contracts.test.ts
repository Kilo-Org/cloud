import { describe, expect, it } from 'vitest';
import {
  AUDIT_BATCH_MAX_COMPRESSED_BYTES,
  AUDIT_BATCH_MAX_DECOMPRESSED_BYTES,
  AuditBatchDecompressionLimitError,
  AuditBatchSchema,
  AuditBatchTooLargeError,
  type AuditEvent,
  decodeAuditBatch,
  encodeAuditBatch,
} from './audit';
import {
  BundleEtagSchema,
  BundleResultSchema,
  STS_BUNDLE_HTTP_PATH,
  bundleResultHttpStatus,
} from './bundle';

function auditEvent(filler: string): AuditEvent {
  return {
    specversion: '1.0',
    id: crypto.randomUUID(),
    source: 'kilo:sts:production',
    type: 'ai.kilo.sts.bundle.delivered',
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data: {
      classUid: 6003,
      activityId: 2,
      outcome: 'success',
      actor: { kind: 'workload', id: 'o11y' },
      attributes: { filler },
    },
  };
}

function randomFiller(bytes: number): string {
  const random = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = '';
  for (const byte of random) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe('audit batches', () => {
  it('round-trips a gzipped batch through the queue encoding', async () => {
    const batch = {
      schemaVersion: 1 as const,
      stream: 'sts:production:bundle:o11y',
      fromSeq: 1,
      toSeq: 3,
      events: [auditEvent('a'), auditEvent('b'), auditEvent('c')],
    };
    const encoded = await encodeAuditBatch(batch);
    expect(encoded.byteLength).toBeLessThan(AUDIT_BATCH_MAX_COMPRESSED_BYTES);
    expect(await decodeAuditBatch(encoded)).toEqual(batch);
  });

  it('refuses a batch whose compressed size is above the queue message limit', async () => {
    const batch = {
      schemaVersion: 1 as const,
      stream: 'sts:production:bundle:o11y',
      fromSeq: 1,
      toSeq: 500,
      events: Array.from({ length: 500 }, () => auditEvent(randomFiller(300))),
    };
    await expect(encodeAuditBatch(batch)).rejects.toBeInstanceOf(AuditBatchTooLargeError);
  });

  it('refuses a batch that compresses small but inflates past the decompressed limit', async () => {
    const repetitive = Object.fromEntries(
      Array.from({ length: 60 }, (_unused, index) => [`k${index}`, 'a'.repeat(512)])
    );
    const event = auditEvent('a');
    const batch = {
      schemaVersion: 1 as const,
      stream: 'sts:production:bundle:o11y',
      fromSeq: 1,
      toSeq: 40,
      events: Array.from({ length: 40 }, () => ({
        ...event,
        id: crypto.randomUUID(),
        data: { ...event.data, attributes: repetitive },
      })),
    };
    expect(JSON.stringify(batch).length).toBeGreaterThan(AUDIT_BATCH_MAX_DECOMPRESSED_BYTES);
    const error = await encodeAuditBatch(batch).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuditBatchTooLargeError);
    if (!(error instanceof AuditBatchTooLargeError)) throw new Error('expected a size error');
    expect(error.compressedBytes).toBeLessThan(AUDIT_BATCH_MAX_COMPRESSED_BYTES);
  });

  it('stops inflating a gzip bomb past the decompressed limit', async () => {
    const zeros = new Uint8Array(4 * AUDIT_BATCH_MAX_DECOMPRESSED_BYTES);
    const source = new ReadableStream<BufferSource>({
      start(controller) {
        controller.enqueue(zeros);
        controller.close();
      },
    });
    const bomb = new Uint8Array(
      await new Response(source.pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
    );
    expect(bomb.byteLength).toBeLessThan(AUDIT_BATCH_MAX_COMPRESSED_BYTES);
    await expect(decodeAuditBatch(bomb)).rejects.toBeInstanceOf(AuditBatchDecompressionLimitError);
  });

  it('requires the sequence range to match the event count', () => {
    const result = AuditBatchSchema.safeParse({
      schemaVersion: 1,
      stream: 'sts:production:bundle:o11y',
      fromSeq: 1,
      toSeq: 3,
      events: [auditEvent('a')],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an event that carries an extra field', () => {
    const event = { ...auditEvent('a'), extra: true };
    expect(() =>
      AuditBatchSchema.parse({
        schemaVersion: 1,
        stream: 'sts:production:bundle:o11y',
        fromSeq: 1,
        toSeq: 1,
        events: [event],
      })
    ).toThrow();
  });
});

describe('bundle results', () => {
  const ok = {
    status: 'ok' as const,
    workload: 'o11y',
    environment: 'production' as const,
    etag: `"${'a'.repeat(43)}"`,
    stale: false,
    fetchedAt: new Date().toISOString(),
    secrets: { O11Y_CF_AE_API_TOKEN: { value: 'value', version: 3 } },
    missing: [],
  };

  it('parses a complete ok bundle and rejects one with an unknown field', () => {
    expect(BundleResultSchema.parse(ok)).toEqual(ok);
    expect(BundleResultSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(BundleResultSchema.safeParse({ ...ok, fetchedAt: 'yesterday' }).success).toBe(false);
  });

  it('maps each result to the HTTP status the caller outside the account sees', () => {
    expect(bundleResultHttpStatus(ok)).toBe(200);
    expect(bundleResultHttpStatus({ status: 'not_modified', ...notModified() })).toBe(304);
    expect(bundleResultHttpStatus({ status: 'denied', reason: 'identity_rejected' })).toBe(401);
    expect(bundleResultHttpStatus({ status: 'denied', reason: 'unknown_workload' })).toBe(403);
    expect(bundleResultHttpStatus({ status: 'denied', reason: 'environment_mismatch' })).toBe(403);
    expect(
      bundleResultHttpStatus({
        status: 'unavailable',
        reason: 'manager_unreachable_no_copy',
        retryAfterSeconds: 60,
      })
    ).toBe(503);
  });

  it('accepts only a quoted base64url ETag of the documented length', () => {
    expect(BundleEtagSchema.safeParse(`"${'abc-_'.repeat(9)}"`).success).toBe(true);
    expect(BundleEtagSchema.safeParse(`${'a'.repeat(43)}`).success).toBe(false);
    expect(BundleEtagSchema.safeParse('""').success).toBe(false);
  });

  it('keeps the HTTP path the route table serves', () => {
    expect(STS_BUNDLE_HTTP_PATH).toBe('/v1/bundle');
  });
});

function notModified() {
  return {
    etag: `"${'b'.repeat(43)}"`,
    stale: true,
    fetchedAt: new Date().toISOString(),
  };
}
