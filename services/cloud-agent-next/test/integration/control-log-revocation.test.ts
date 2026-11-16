import { env, evictDurableObject, reset, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSecret } from '../../src/auth.js';
import type { AllocationKind } from '../../src/control-plane/sandbox/allocation.js';
import { allocation } from '../../src/control-plane/sandbox/sqlite-schema.js';
import type { HonoContext } from '../../src/hono-context.js';
import { registerControlLogRoutes } from '../../src/sandbox-control/log-routes.js';
import { mintControlLogUploadGrant } from '../../src/sandbox-control/log-upload-grant.js';

const batch = JSON.stringify({
  version: 1,
  sequence: 0,
  droppedRecords: 0,
  records: [{ timestamp: 100, event: 'wrapper.lifecycle', fields: { phase: 'starting' } }],
});
const uploads = [
  { name: 'batch', contentType: 'application/json', body: batch },
  { name: 'archive', contentType: 'application/gzip', body: 'synthetic archive bytes' },
] as const;

async function fixture(kind: AllocationKind = 'connected') {
  const identity = {
    sandboxId: `sbx_log_${crypto.randomUUID()}`,
    allocationId: crypto.randomUUID(),
    wrapperInstanceId: crypto.randomUUID(),
  };
  const stub = env.SANDBOX_CONTROL.getByName(identity.sandboxId);
  await stub.getAllocationState();
  async function setAllocation(state: AllocationKind, allocationId = identity.allocationId) {
    await runInDurableObject(stub, async (_instance, context) => {
      const db = drizzle(context.storage);
      const row = {
        id: 'current',
        state,
        allocation_id: allocationId,
        // The connection and diagnostic wrapper identities are independent.
        wrapper_id: 'connection-wrapper',
        last_frame_at: 100,
        last_activity_at: 100,
        stop_attempt: 0,
        stop_pending: false,
      };
      await db
        .insert(allocation)
        .values(row)
        .onConflictDoUpdate({ target: allocation.id, set: row });
    });
  }
  await setAllocation(kind);
  const app = new Hono<HonoContext>();
  registerControlLogRoutes(app);
  const secret = await resolveSecret(env.NEXTAUTH_SECRET);
  if (!secret) throw new Error('Missing test secret');
  const grant = mintControlLogUploadGrant(identity, secret);
  function upload(spec: (typeof uploads)[number], body: BodyInit = spec.body) {
    const filename = spec.name === 'archive' ? 'files.tar.gz' : `${crypto.randomUUID()}.json`;
    const suffix = filename.endsWith('.json') ? filename.slice(0, -5) : filename;
    const prefix = `${identity.sandboxId}/${identity.allocationId}/${identity.wrapperInstanceId}`;
    return {
      key: `logs/control/${prefix}/${filename}`,
      response: app.request(
        `http://worker.test/sandbox-logs/${prefix}/${suffix}`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${grant}`, 'Content-Type': spec.contentType },
          body,
        },
        env
      ),
    };
  }
  return { identity, stub, setAllocation, upload };
}

afterEach(async () => {
  await reset();
});

describe('control log allocation revocation', () => {
  it('rejects unknown allocations and identities belonging to another sandbox', async () => {
    const f = await fixture();
    const unknownSandboxId = `sbx_log_${crypto.randomUUID()}`;
    const other = env.SANDBOX_CONTROL.getByName(unknownSandboxId);
    expect(await other.isLogUploadAuthorized({ ...f.identity, sandboxId: unknownSandboxId })).toBe(
      false
    );
    expect(
      await f.stub.isLogUploadAuthorized({ ...f.identity, sandboxId: 'another-sandbox' })
    ).toBe(false);
    expect(
      await f.stub.isLogUploadAuthorized({ ...f.identity, allocationId: 'another-allocation' })
    ).toBe(false);
  });

  it.each(['creating', 'starting', 'connected', 'disconnected'] as const)(
    'accepts current %s allocation logs without refreshing liveness',
    async kind => {
      const f = await fixture(kind);
      const before = await f.stub.getAllocationState();
      for (const spec of uploads) {
        const upload = f.upload(spec);
        expect((await upload.response).status).toBe(204);
        const object = await env.R2_BUCKET.get(upload.key);
        expect(await object?.text()).toBe(spec.body);
      }
      expect(await f.stub.getAllocationState()).toEqual(before);
    }
  );

  it.each(['stopping', 'stopped'] as const)('rejects %s allocations before writing', async kind => {
    const f = await fixture(kind);
    for (const spec of uploads) {
      const upload = f.upload(spec);
      expect((await upload.response).status).toBe(403);
      expect(await env.R2_BUCKET.head(upload.key)).toBeNull();
    }
  });

  it('rejects an old grant after allocation replacement and eviction', async () => {
    const f = await fixture();
    await f.setAllocation('connected', crypto.randomUUID());
    await evictDurableObject(f.stub);
    for (const spec of uploads) {
      const upload = f.upload(spec);
      expect((await upload.response).status).toBe(403);
      expect(await env.R2_BUCKET.head(upload.key)).toBeNull();
    }
  });

  it('rejects a grant after the owner reports the provider stopped', async () => {
    const f = await fixture();
    expect((await f.upload(uploads[0]).response).status).toBe(204);
    await f.stub.reportProviderGone();
    expect((await f.stub.getAllocationState()).kind).toBe('stopped');
    const upload = f.upload(uploads[0]);
    expect((await upload.response).status).toBe(403);
    expect(await env.R2_BUCKET.head(upload.key)).toBeNull();
  });

  it.each(uploads)('rechecks the allocation after reading a $name body', async spec => {
    const f = await fixture();
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          reading.resolve();
          await release.promise;
          controller.enqueue(new TextEncoder().encode(spec.body));
          controller.close();
        },
      },
      { highWaterMark: 0 }
    );
    const upload = f.upload(spec, body);
    await reading.promise;
    await f.stub.reportProviderGone();
    release.resolve();
    expect((await upload.response).status).toBe(403);
    expect(await env.R2_BUCKET.head(upload.key)).toBeNull();
  });
});
