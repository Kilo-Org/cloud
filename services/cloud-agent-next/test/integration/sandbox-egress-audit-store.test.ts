import {
  buildEgressAuditRequest,
  GetEgressAuditResponseSchema,
} from '@kilocode/worker-utils/egress-audit';
import { EgressAuditStore } from '../../src/sandbox-containers/egress-audit.js';
import { env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { egressAuditStore } from '../../src/egress/sandbox-egress.js';
import type { EgressAuditRequest } from '../../src/shared/egress-audit.js';

// A logical sandbox of a provider without a Containers allocation (for example Vercel).
const logicalSandboxId = 'ses-egress-store-0001';
const PREFIX = 'containers:egress-audit:chunk:';

function request(decision: EgressAuditRequest['decision']): EgressAuditRequest {
  return {
    requestId: crypto.randomUUID(),
    allocationRef: 'alloc-0001',
    timestamp: '2026-11-14T12:00:00.000Z',
    method: 'GET',
    hostname: 'example.com',
    protocol: 'https:',
    port: 443,
    decision,
  };
}

afterEach(async () => {
  await reset();
});

describe('egress audit store of a logical sandbox', () => {
  it('preserves request and connection scope after storage reload and accepts historical rows', async () => {
    const store = egressAuditStore(env, { logicalSandboxId });
    const legacy = await store.recordEgressRequest(request('allowed'));
    const connection = await store.recordEgressRequest(
      buildEgressAuditRequest({
        ...request('allowed'),
        scope: 'connection',
        method: 'CONNECT',
        url: new URL('https://example.com/private?token=secret'),
      })
    );
    const http = await store.recordEgressRequest(
      buildEgressAuditRequest({
        ...request('denied'),
        method: 'POST',
        url: new URL('https://example.com/private?token=secret'),
      })
    );
    const page = await runInDurableObject(store, async (_instance, state) => {
      const reloaded = new EgressAuditStore(state.storage);
      return GetEgressAuditResponseSchema.parse(await reloaded.getEgressAudit());
    });
    expect(page.records).toEqual([legacy, connection, http]);
    expect(page.records.map(row => row.scope)).toEqual([undefined, 'connection', 'request']);
    expect(JSON.stringify(page)).not.toMatch(/private|token|secret/);
  });

  it('stores rows and starts no container, sets no alarm and writes nothing else', async () => {
    const store = egressAuditStore(env, { logicalSandboxId });
    const allowed = await store.recordEgressRequest(request('allowed'));
    const denied = await store.recordEgressRequest(request('denied'));
    await expect(store.getEgressAudit()).resolves.toEqual({
      records: [allowed, denied],
      nextCursor: null,
    });

    const sameObject = egressAuditStore(env, {
      containerId: env.SANDBOX_CONTAINERS.idFromName(logicalSandboxId).toString(),
    });
    await expect(sameObject.getEgressAudit()).resolves.toEqual({
      records: [allowed, denied],
      nextCursor: null,
    });

    await runInDurableObject(store, async (_instance, state) => {
      expect(state.container).toBeUndefined();
      await expect(state.storage.getAlarm()).resolves.toBeNull();
      const keys = [...(await state.storage.list()).keys()];
      expect(keys).toEqual([`${PREFIX}0000000000000000`]);
    });
  });
});
