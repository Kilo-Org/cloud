import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HonoContext } from '../hono-context.js';
import type { Env } from '../types.js';
import { registerControlLogRoutes } from './log-routes.js';
import { mintControlLogUploadGrant } from './log-upload-grant.js';

const secret = 'test-secret';
const identity = {
  sandboxId: 'sandbox_logs',
  allocationId: 'allocation_logs',
  wrapperInstanceId: '0fce125c-54a3-4143-b503-b7775c4d2135',
};

function fixture() {
  const isLogUploadAuthorized = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const reserveLogUpload = vi.fn().mockResolvedValue(true);
  const getByName = vi.fn(() => ({ isLogUploadAuthorized, reserveLogUpload }));
  const put = vi.fn();
  const env = {
    NEXTAUTH_SECRET: secret,
    SANDBOX_CONTROL: { getByName },
    R2_BUCKET: { put },
  } as unknown as Env;
  const app = new Hono<HonoContext>();
  registerControlLogRoutes(app);
  function upload(grant = mintControlLogUploadGrant(identity, secret)) {
    return app.request(
      `http://worker.test/sandbox-logs/${identity.sandboxId}/${identity.allocationId}/${identity.wrapperInstanceId}/files.tar.gz`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${grant}`, 'Content-Type': 'application/gzip' },
        body: 'synthetic archive',
      },
      env
    );
  }
  return { isLogUploadAuthorized, reserveLogUpload, getByName, put, upload, app, env };
}

afterEach(() => vi.useRealTimers());

describe('control log authorization failures', () => {
  it.each(['admission', 'storage'] as const)(
    'fails closed when %s authorization fails',
    async at => {
      const f = fixture();
      if (at === 'storage') f.isLogUploadAuthorized.mockResolvedValueOnce(true);
      f.isLogUploadAuthorized.mockRejectedValueOnce(new Error('allocation unavailable'));
      const response = await f.upload();
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('Log authorization unavailable');
      expect(f.put).not.toHaveBeenCalled();
    }
  );

  it('bounds an unavailable allocation read', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.isLogUploadAuthorized.mockReturnValue(new Promise(() => {}));
    const response = f.upload();
    await vi.advanceTimersByTimeAsync(5_001);
    expect((await response).status).toBe(503);
    expect(f.put).not.toHaveBeenCalled();
  });

  it('retries a transient allocation read before accepting the upload', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.isLogUploadAuthorized.mockRejectedValueOnce(
      Object.assign(new Error('transient allocation error'), { retryable: true })
    );
    const response = f.upload();
    await vi.runAllTimersAsync();
    expect((await response).status).toBe(204);
    expect(f.put).toHaveBeenCalledOnce();
  });

  it.each([
    'invalid-grant',
    mintControlLogUploadGrant({ ...identity, allocationId: 'another-allocation' }, secret),
  ])('rejects invalid or mismatched grants before resolving an allocation', async grant => {
    const f = fixture();
    const response = await f.upload(grant);
    expect([401, 403]).toContain(response.status);
    expect(f.getByName).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
  });
});

describe('upload quota admission precedes buffering', () => {
  const endpoints = [
    ['files.tar.gz', 'application/gzip'],
    ['0fce125c-54a3-4143-b503-b7775c4d2136', 'application/json'],
  ] as const;
  const url = (suffix: string) =>
    `http://worker.test/sandbox-logs/${identity.sandboxId}/${identity.allocationId}/${identity.wrapperInstanceId}/${suffix}`;
  const headers = (type: string) => ({
    Authorization: `Bearer ${mintControlLogUploadGrant(identity, secret)}`,
    'Content-Type': type,
  });
  it.each(endpoints)('rejects exhausted quota without reading %s', async (suffix, type) => {
    const f = fixture();
    f.reserveLogUpload.mockResolvedValue(false);
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) =>
      controller.close()
    );
    const body = new ReadableStream({ pull }, { highWaterMark: 0 });
    const request = new Request(url(suffix), {
      method: 'PUT',
      headers: headers(type),
      body,
      duplex: 'half',
    } as RequestInit);
    const response = await f.app.request(request, undefined, f.env);
    expect(response.status).toBe(429);
    expect(pull).not.toHaveBeenCalled();
    expect(f.reserveLogUpload).toHaveBeenCalledOnce();
    expect(f.put).not.toHaveBeenCalled();
  });
  it.each(endpoints)('charges a streamed overflow attempt for %s', async (suffix, type) => {
    const f = fixture();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          expect(f.reserveLogUpload).toHaveBeenCalledOnce();
          controller.enqueue(new Uint8Array([1, 2]));
          controller.close();
        },
      },
      { highWaterMark: 0 }
    );
    const request = new Request(url(suffix), {
      method: 'PUT',
      headers: { ...headers(type), 'Content-Length': '1' },
      body,
      duplex: 'half',
    } as RequestInit);
    const response = await f.app.request(request, undefined, f.env);
    expect(response.status).toBe(413);
    expect(f.reserveLogUpload).toHaveBeenCalledWith(identity, 1);
    expect(f.put).not.toHaveBeenCalled();
  });
  it('charges a stalled upload before its read deadline', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const request = new Request(url('files.tar.gz'), {
      method: 'PUT',
      headers: { ...headers('application/gzip'), 'Content-Length': '1' },
      body: new ReadableStream(),
      duplex: 'half',
    } as RequestInit);
    const pending = f.app.request(request, undefined, f.env);
    await vi.advanceTimersByTimeAsync(30_001);
    expect((await pending).status).toBe(408);
    expect(f.reserveLogUpload).toHaveBeenCalledWith(identity, 1);
    expect(f.put).not.toHaveBeenCalled();
  });
});
