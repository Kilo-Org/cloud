import { encodeAuditBatch, type AuditBatch, type AuditEvent } from '@kilocode/sts-contracts';
import {
  abortAllDurableObjects,
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src';
import { GENESIS_HASH, chainHash } from '../src/relay/chain';
import {
  axiomOk,
  axiomRequests,
  env,
  readArchived,
  recordingFetch,
  requestBodyOf,
  uniqueStream,
} from './helpers';

// STS's three token events, with the shapes `services/sts/src/audit/events.ts` builds
// (`tokenIssuedEvent`, `tokenDeniedEvent`, `tokenKeyRotatedEvent`); STS's
// test/worker/token-audit-events.test.ts checks the builders themselves at their largest. Here they
// go through the relay: decoded from a queue message, archived on the hash chain, and ingested
// into Axiom as one row each.

const JTIS = ['5a0f3a52-8d55-4d0e-9a0d-1f1b7f7d6a01', '5a0f3a52-8d55-4d0e-9a0d-1f1b7f7d6a02'];

const ISSUED: AuditEvent = {
  specversion: '1.0',
  id: crypto.randomUUID(),
  source: 'kilo:sts:production',
  type: 'ai.kilo.sts.token.issued',
  time: '2026-11-26T12:00:00.000Z',
  datacontenttype: 'application/json',
  data: {
    classUid: 6003,
    activityId: 1,
    outcome: 'success',
    actor: { kind: 'workload', id: 'web' },
    attributes: {
      workload: 'web',
      environment: 'production',
      identity: 'vercel',
      kid: 'k'.repeat(43),
      issuedAt: 1_795_608_000,
      expiresAt: 1_795_608_300,
      lifetimeSeconds: 300,
      attestationCapped: false,
      tokenCount: 2,
      jtis: JTIS,
      audiences: ['usage-ingest', 'gateway'],
      scopes: ['usage-ingest:sts.canary', 'gateway:models.read'],
    },
  },
};

const DENIED: AuditEvent = {
  specversion: '1.0',
  id: crypto.randomUUID(),
  source: 'kilo:sts:production',
  type: 'ai.kilo.sts.token.denied',
  time: '2026-11-26T12:00:01.000Z',
  datacontenttype: 'application/json',
  data: {
    classUid: 6003,
    activityId: 1,
    outcome: 'denied',
    outcomeDetail: 'scope_not_allowed',
    actor: { kind: 'workload', id: 'usage-ingest' },
    attributes: {
      environment: 'production',
      channel: 'worker-binding',
      reason: 'scope_not_allowed',
      workload: 'usage-ingest',
      audience: 'web',
      scope: 'web:admin',
      count: 3,
      windowStart: '2026-11-26T12:00:00.000Z',
      overflow: false,
      claims: [],
    },
  },
};

const ROTATED: AuditEvent = {
  specversion: '1.0',
  id: crypto.randomUUID(),
  source: 'kilo:sts:production',
  type: 'ai.kilo.sts.token_key.rotated',
  time: '2026-11-26T12:00:02.000Z',
  datacontenttype: 'application/json',
  data: {
    classUid: 6003,
    activityId: 3,
    outcome: 'success',
    outcomeDetail: 'activated',
    actor: { kind: 'system', id: 'sts:production' },
    attributes: {
      environment: 'production',
      change: 'activated',
      kid: 'n'.repeat(43),
      retiredKid: 'k'.repeat(43),
    },
  },
};

describe('STS token events through the relay', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await abortAllDurableObjects();
  });

  it('decodes, archives on the chain and ingests issued, denied and rotated events', async () => {
    const stream = uniqueStream('sts-tokens');
    const http = recordingFetch(axiomOk);
    vi.stubGlobal('fetch', http.impl);
    const batch: AuditBatch = {
      schemaVersion: 1,
      stream,
      fromSeq: 1,
      toSeq: 3,
      events: [ISSUED, DENIED, ROTATED],
    };

    const messages = createMessageBatch('kilo-audit', [
      {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        attempts: 1,
        body: (await encodeAuditBatch(batch)).buffer,
      },
    ]);
    const ctx = createExecutionContext();
    await worker.queue?.(messages, env);
    await waitOnExecutionContext(ctx);
    const result = await getQueueResult(messages, ctx);
    expect(result.retryBatch.retry).toBe(false);
    expect(result.retryMessages).toEqual([]);

    const archived = await readArchived(stream, 3);
    expect(archived.batch).toEqual(batch);
    expect(archived.prevHash).toBe(GENESIS_HASH);
    expect(archived.hash).toBe(await chainHash(GENESIS_HASH, batch));

    const [ingest] = axiomRequests(http.requests);
    expect(requestBodyOf(ingest)).toEqual(
      [ISSUED, DENIED, ROTATED].map(event => ({ ...event, _time: event.time }))
    );
  });
});
