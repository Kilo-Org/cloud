import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { HonoContext } from '../hono-context.js';
import type { Env } from '../types.js';
import { WORKTREE_STATE_MAX_BYTES, WORKTREE_STATE_TTL_MS } from '../shared/worktree-state.js';
import { mintWorktreeStateGrant } from './worktree-state-grant.js';
import { registerWorktreeStateRoutes } from './worktree-state-routes.js';

const secret = 'test-worktree-state-secret';
const identity = { userId: 'usr_test', scopeId: 'worktree_abc' };
const route = `/worktree-state/${identity.userId}/${identity.scopeId}`;
const key = `worktree-state/v1/${identity.userId}/${identity.scopeId}/state.tar.gz`;
const bundle = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03]);

type StoredObject = { body: Uint8Array; customMetadata?: Record<string, string> };

function fixture() {
  const objects = new Map<string, StoredObject>();
  const put = vi.fn(async (name: string, body: ArrayBuffer, options?: R2PutOptions) => {
    objects.set(name, {
      body: new Uint8Array(body),
      ...(options?.customMetadata ? { customMetadata: options.customMetadata } : {}),
    });
    return { key: name };
  });
  const get = vi.fn(async (name: string) => {
    const stored = objects.get(name);
    if (!stored) return null;
    return {
      body: new Blob([stored.body]).stream(),
      customMetadata: stored.customMetadata,
    };
  });
  const remove = vi.fn(async (name: string) => void objects.delete(name));
  const env = {
    NEXTAUTH_SECRET: secret,
    R2_BUCKET: { put, get, delete: remove },
  } as unknown as Env;
  const app = new Hono<HonoContext>();
  registerWorktreeStateRoutes(app);
  const request = (path: string, init?: RequestInit) =>
    app.request(`http://worker.test${path}`, init, env);
  const authorization = (token = mintWorktreeStateGrant(identity, secret)) => `Bearer ${token}`;
  const upload = (body: BodyInit = bundle as BodyInit, path = route, token?: string) =>
    request(path, { method: 'PUT', headers: { Authorization: authorization(token) }, body });
  return { request, upload, authorization, objects, put, get, delete: remove };
}

describe('worktree state routes', () => {
  it('stores a bundle under the granted scope and reads it back', async () => {
    const f = fixture();
    expect((await f.upload()).status).toBe(204);
    expect(f.objects.get(key)?.body).toEqual(bundle);

    const response = await f.request(route, { headers: { Authorization: f.authorization() } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/gzip');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bundle);
  });

  it('rejects unauthenticated callers and grants minted for another worktree', async () => {
    const f = fixture();
    expect((await f.request(route, { method: 'PUT', body: bundle as BodyInit })).status).toBe(401);
    const other = mintWorktreeStateGrant({ ...identity, scopeId: 'worktree_other' }, secret);
    expect((await f.upload(bundle as BodyInit, route, other)).status).toBe(403);
    const otherUser = mintWorktreeStateGrant({ ...identity, userId: 'usr_other' }, secret);
    expect((await f.upload(bundle as BodyInit, route, otherUser)).status).toBe(403);
    expect(f.put).not.toHaveBeenCalled();
  });

  it('rejects an empty body and a body beyond the ceiling', async () => {
    const f = fixture();
    expect((await f.upload(new Uint8Array() as BodyInit)).status).toBe(400);
    const oversized = new Uint8Array(WORKTREE_STATE_MAX_BYTES + 1);
    expect((await f.upload(oversized as BodyInit)).status).toBe(413);
    expect(f.put).not.toHaveBeenCalled();
  });

  it('accepts a body without a declared length and stops reading an oversized stream', async () => {
    const f = fixture();
    // The wrapper's fetch layer owns Content-Length, so the route must not
    // depend on it and must still bound what it reads.
    expect((await f.upload()).status).toBe(204);
    expect(f.objects.get(key)?.body).toEqual(bundle);

    let produced = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const response = await f.request(route, {
      method: 'PUT',
      headers: { Authorization: f.authorization() },
      body: endless,
      // @ts-expect-error -- streamed request bodies require duplex
      duplex: 'half',
    });
    expect(response.status).toBe(413);
    expect(produced).toBeLessThanOrEqual(WORKTREE_STATE_MAX_BYTES + chunk.byteLength * 2);
    // Only the valid upload above reached storage.
    expect(f.put).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed declared length before reading the body', async () => {
    const f = fixture();
    expect(
      (
        await f.request(route, {
          method: 'PUT',
          headers: { Authorization: f.authorization(), 'Content-Length': 'nope' },
          body: bundle as BodyInit,
        })
      ).status
    ).toBe(400);
    expect(f.put).not.toHaveBeenCalled();
  });

  it('treats an expired bundle as absent and drops it', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      expect((await f.upload()).status).toBe(204);
      expect(Number(f.objects.get(key)?.customMetadata?.expiresAt)).toBe(
        Date.now() + WORKTREE_STATE_TTL_MS
      );
      vi.advanceTimersByTime(WORKTREE_STATE_TTL_MS + 1);
      const response = await f.request(route, { headers: { Authorization: f.authorization() } });
      expect(response.status).toBe(404);
      expect(f.objects.has(key)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports an absent bundle as 404 and supports explicit deletion', async () => {
    const f = fixture();
    expect((await f.request(route, { headers: { Authorization: f.authorization() } })).status).toBe(
      404
    );
    expect((await f.upload()).status).toBe(204);
    expect(
      (await f.request(route, { method: 'DELETE', headers: { Authorization: f.authorization() } }))
        .status
    ).toBe(204);
    expect(f.objects.has(key)).toBe(false);
  });

  it('round-trips a federated user id as a single encoded path segment', async () => {
    const federated = { userId: 'oauth/google:1234', scopeId: 'worktree_abc' };
    const path = `/worktree-state/${encodeURIComponent(federated.userId)}/${federated.scopeId}`;
    const objectKey = `worktree-state/v1/${encodeURIComponent(federated.userId)}/${federated.scopeId}/state.tar.gz`;
    const f = fixture();
    const token = mintWorktreeStateGrant(federated, secret);
    expect((await f.upload(bundle as BodyInit, path, token)).status).toBe(204);
    expect(f.objects.get(objectKey)?.body).toEqual(bundle);

    const response = await f.request(path, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bundle);
  });

  it('rejects identities that cannot appear in an object key', async () => {
    const f = fixture();
    const response = await f.request('/worktree-state/..%2Fetc/worktree_abc', {
      method: 'PUT',
      headers: { Authorization: f.authorization() },
      body: bundle as BodyInit,
    });
    expect(response.status).toBe(400);
    expect(f.put).not.toHaveBeenCalled();
  });
});
