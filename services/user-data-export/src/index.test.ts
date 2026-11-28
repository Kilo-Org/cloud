import { describe, expect, it, vi } from 'vitest';
import worker, { __test__ } from './index';

describe('download URL expiration', () => {
  const now = Date.parse('2026-08-09T03:00:00.000Z');

  it('uses five minutes when the export remains available longer', () => {
    expect(__test__.downloadExpiration('2026-08-09T04:00:00.000Z', now)).toEqual({
      expiresIn: 300,
      expiresAt: '2026-08-09T03:05:00.000Z',
    });
  });

  it('does not outlive the export retention deadline', () => {
    expect(__test__.downloadExpiration('2026-08-09T03:01:00.000Z', now)).toEqual({
      expiresIn: 60,
      expiresAt: '2026-08-09T03:01:00.000Z',
    });
    expect(__test__.downloadExpiration('2026-08-09T02:59:59.000Z', now)).toBeNull();
  });
});

describe('internal request parsing', () => {
  it('rejects chunked bodies larger than 16 KiB without relying on content-length', async () => {
    const request = new Request('https://worker.local/internal', {
      method: 'POST',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('x'.repeat(16_385)));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    await expect(__test__.readJson(request)).rejects.toThrow('Request body is too large');
  });
});

describe('dispatch authorization', () => {
  const message = {
    version: 1,
    operation: 'generate',
    exportId: 'f6ba5ce5-9061-4f7f-9ec6-76f047573f1c',
    generation: 0,
  } as const;

  it("does not enqueue or acknowledge another user's export", async () => {
    const state = {
      exportGenerationBelongsToUser: vi.fn().mockResolvedValue(false),
      markOutboxGenerationSent: vi.fn(),
    };
    const queue = { send: vi.fn() };

    await expect(__test__.dispatchExport(message, 'other-user', state, queue)).resolves.toBe(
      'not_found'
    );
    expect(state.exportGenerationBelongsToUser).toHaveBeenCalledWith(
      message.exportId,
      message.generation,
      'other-user'
    );
    expect(queue.send).not.toHaveBeenCalled();
    expect(state.markOutboxGenerationSent).not.toHaveBeenCalled();
  });

  it('enqueues an owned export without putting the assertion in the message', async () => {
    const state = {
      exportGenerationBelongsToUser: vi.fn().mockResolvedValue(true),
      markOutboxGenerationSent: vi.fn(),
    };
    const queue = { send: vi.fn() };

    await expect(__test__.dispatchExport(message, 'owner-user', state, queue)).resolves.toBe(
      'accepted'
    );
    expect(queue.send).toHaveBeenCalledWith(message);
    expect(state.markOutboxGenerationSent).toHaveBeenCalledWith(
      message.exportId,
      message.generation
    );
  });
});

describe('authentication contract', () => {
  type ExportEnv = Parameters<typeof worker.fetch>[1];

  const request = (key: string) =>
    new Request('https://worker.local/internal/exports/dispatch', {
      method: 'POST',
      headers: { 'x-internal-api-key': key, authorization: 'Bearer assertion' },
      body: '{}',
    });

  /** The bindings this contract test needs; the routes it reaches read nothing else. */
  const envOf = (bindings: Record<string, unknown>) => bindings as unknown as ExportEnv;

  const readable = { get: async () => 'stored-value' };
  const unreadable = {
    get: async () => {
      throw new Error('SecretUnavailableError: NEXTAUTH_SECRET');
    },
  };

  it('answers 503 with Retry-After at the edge when the secret source is unavailable', async () => {
    // `sts` without the binding is a source failure, not a credential failure.
    const response = await worker.fetch(request('candidate-key'), envOf({ SECRETS_SOURCE: 'sts' }));

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('30');
  });

  it('keeps 401 for a wrong internal key', async () => {
    const response = await worker.fetch(
      request('wrong-key'),
      envOf({ INTERNAL_API_SECRET: readable, NEXTAUTH_SECRET: readable })
    );

    expect(response.status).toBe(401);
  });

  it('does not confirm a correct internal key when another secret cannot be read', async () => {
    const env = envOf({ INTERNAL_API_SECRET: readable, NEXTAUTH_SECRET: unreadable });

    // Reading every secret before judging the credential makes both keys indistinguishable.
    await expect(__test__.authenticatedUserId(request('wrong-key'), env)).resolves.toEqual({
      status: 'unavailable',
    });
    await expect(__test__.authenticatedUserId(request('stored-value'), env)).resolves.toEqual({
      status: 'unavailable',
    });
  });
});
