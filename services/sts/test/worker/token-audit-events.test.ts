import {
  AuditBatchTooLargeError,
  AuditEventInvalidError,
  assertRelayable,
  encodeAuditBatch,
  type AuditEvent,
} from '@kilocode/sts-contracts';
import { describe, expect, it } from 'vitest';
import { tokenDeniedEvent, tokenIssuedEvent, tokenKeyRotatedEvent } from '../../src/audit/events';

// The token events as STS builds them, at their largest: they must pass the producer-side check
// before every append, and travel alone and in full batches. The audit relay's own tests decode,
// archive and ingest the same shapes (services/audit-relay/test/token-events.test.ts).

const STREAM = 'sts:production:tokens:3';
/** The longest names the schemas allow: a workload or audience of 63, a scope of 127 characters. */
const WORKLOAD = `w${'x'.repeat(62)}`;
const KID = 'k'.repeat(43);

function longest(index: number): { audience: string; scope: string } {
  const audience = `${index}${'a'.repeat(62)}`;
  return { audience, scope: `${audience}:${'p'.repeat(127 - audience.length - 1)}` };
}

function issued(): AuditEvent {
  return tokenIssuedEvent({
    environment: 'production',
    workload: WORKLOAD,
    identity: 'vercel',
    kid: KID,
    issuedAt: 1_795_600_000,
    expiresAt: 1_795_600_300,
    attestationCapped: true,
    tokens: Array.from({ length: 8 }, (_unused, index) => ({
      jti: crypto.randomUUID(),
      ...longest(index),
    })),
  });
}

function denied(): AuditEvent {
  return tokenDeniedEvent({
    environment: 'production',
    denial: {
      kind: 'token',
      channel: 'http',
      reason: 'environment_mismatch',
      actor: `vercel:team_${'t'.repeat(59)}/prj_${'p'.repeat(60)}`.slice(0, 256),
      ...longest(7),
      claims: Object.fromEntries(
        Array.from({ length: 16 }, (_unused, index) => [`claim_${index}`, 'v'.repeat(256)])
      ),
    },
    count: 1_000,
    windowStart: '2026-11-26T12:00:00.000Z',
    overflow: false,
  });
}

function rotated(): AuditEvent {
  return tokenKeyRotatedEvent({
    environment: 'production',
    change: { change: 'activated', kid: KID, retiredKid: 'r'.repeat(43) },
  });
}

describe('STS token audit events', () => {
  it('pass the producer-side check at their largest, alone and in a full batch', async () => {
    for (const event of [issued(), denied(), rotated()]) {
      await expect(assertRelayable(STREAM, event)).resolves.toBeUndefined();
    }
    expect(issued().data.attributes).toMatchObject({ tokenCount: 8 });
    expect(new TextEncoder().encode(JSON.stringify(denied())).byteLength).toBeLessThan(50_000);

    // 500 of the largest issued rows exceed one message; the relay splits such a batch in two.
    const events = Array.from({ length: 500 }, () => issued());
    const batch = { schemaVersion: 1 as const, stream: STREAM, fromSeq: 1, toSeq: 500, events };
    await expect(encodeAuditBatch(batch)).rejects.toBeInstanceOf(AuditBatchTooLargeError);
    const half = { ...batch, toSeq: 50, events: events.slice(0, 50) };
    await expect(encodeAuditBatch(half)).resolves.toBeInstanceOf(Uint8Array);
  });

  it('refuse an event with a nested attribute before it reaches the log or the queue', async () => {
    const event = issued();
    const nested = {
      ...event,
      data: { ...event.data, attributes: { ...event.data.attributes, tokens: { jti: 'x' } } },
    } as unknown as AuditEvent;
    await expect(assertRelayable(STREAM, nested)).rejects.toBeInstanceOf(AuditEventInvalidError);
  });
});
