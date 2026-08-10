import { describe, expect, it, vi } from 'vitest';
import { __test__ } from './index';

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
