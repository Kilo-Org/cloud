import { describe, expect, it, vi } from 'vitest';
import { createPreviewStream } from './preview-stream';
import type { KiloChatClient } from './client';

function makeClientSpies() {
  const createMessage = vi.fn(async (p: { conversationId: string; text: string }) => ({
    messageId: 'm1',
    version: 1,
  }));
  const editMessage = vi.fn(
    async (p: { conversationId: string; messageId: string; text: string; version: number }) => ({
      messageId: p.messageId,
      version: p.version,
    })
  );
  const deleteMessage = vi.fn(async () => undefined);
  const client: KiloChatClient = {
    createMessage,
    editMessage,
    deleteMessage,
    sendText: async () => ({ messageId: 'm1' }),
  };
  return { client, createMessage, editMessage, deleteMessage };
}

describe('createPreviewStream', () => {
  it('finalize with no prior update POSTs once and returns messageId', async () => {
    const { client, createMessage, editMessage } = makeClientSpies();
    const stream = createPreviewStream({ client, conversationId: 'c1', throttleMs: 100 });
    const result = await stream.finalize('Hello');
    expect(result).toEqual({ messageId: 'm1' });
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(createMessage).toHaveBeenCalledWith({ conversationId: 'c1', text: 'Hello' });
    expect(editMessage).not.toHaveBeenCalled();
  });

  it('first update POSTs, subsequent update after throttle PATCHes with v++', async () => {
    vi.useFakeTimers();
    try {
      const { client, createMessage, editMessage } = makeClientSpies();
      const stream = createPreviewStream({ client, conversationId: 'c1', throttleMs: 100 });
      stream.update('H');
      await vi.advanceTimersByTimeAsync(0); // flush microtasks
      expect(createMessage).toHaveBeenCalledTimes(1);

      stream.update('Hel');
      await vi.advanceTimersByTimeAsync(100);
      expect(editMessage).toHaveBeenCalledTimes(1);
      expect(editMessage).toHaveBeenCalledWith({
        conversationId: 'c1',
        messageId: 'm1',
        text: 'Hel',
        version: 2,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces rapid updates within the throttle window into one PATCH', async () => {
    vi.useFakeTimers();
    try {
      const { client, editMessage } = makeClientSpies();
      const stream = createPreviewStream({ client, conversationId: 'c1', throttleMs: 100 });
      // Seed the preview with an initial POST.
      stream.update('H');
      await vi.advanceTimersByTimeAsync(0);
      // Three rapid updates while throttled.
      stream.update('He');
      stream.update('Hel');
      stream.update('Hell');
      await vi.advanceTimersByTimeAsync(100);
      expect(editMessage).toHaveBeenCalledTimes(1);
      expect(editMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Hell', version: 2 })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('deduplicates identical consecutive update text', async () => {
    vi.useFakeTimers();
    try {
      const { client, createMessage, editMessage } = makeClientSpies();
      const stream = createPreviewStream({ client, conversationId: 'c1', throttleMs: 100 });
      stream.update('H');
      await vi.advanceTimersByTimeAsync(0);
      stream.update('H'); // same text
      await vi.advanceTimersByTimeAsync(100);
      expect(createMessage).toHaveBeenCalledTimes(1);
      expect(editMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('finalize flushes pending updates and performs a final PATCH with the final text', async () => {
    vi.useFakeTimers();
    try {
      const { client, createMessage, editMessage } = makeClientSpies();
      const stream = createPreviewStream({ client, conversationId: 'c1', throttleMs: 100 });
      stream.update('H');
      await vi.advanceTimersByTimeAsync(0);
      stream.update('Hel'); // pending, not yet flushed
      const resultPromise = stream.finalize('Hello!');
      await vi.advanceTimersByTimeAsync(200);
      const result = await resultPromise;
      expect(result).toEqual({ messageId: 'm1' });
      expect(createMessage).toHaveBeenCalledTimes(1);
      // Exactly one PATCH with the final text and v=2.
      expect(editMessage).toHaveBeenCalledTimes(1);
      expect(editMessage).toHaveBeenCalledWith({
        conversationId: 'c1',
        messageId: 'm1',
        text: 'Hello!',
        version: 2,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('abort after create issues a DELETE; abort before create is a no-op', async () => {
    const { client, createMessage, deleteMessage } = makeClientSpies();
    const stream1 = createPreviewStream({ client, conversationId: 'c1', throttleMs: 100 });
    await stream1.abort();
    expect(deleteMessage).not.toHaveBeenCalled();

    const stream2 = createPreviewStream({ client, conversationId: 'c1', throttleMs: 100 });
    await stream2.finalize('done');
    expect(createMessage).toHaveBeenCalledTimes(1);
    await stream2.abort();
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledWith({ conversationId: 'c1', messageId: 'm1' });
  });

  it('abort swallows deleteMessage errors', async () => {
    const { client, deleteMessage } = makeClientSpies();
    deleteMessage.mockRejectedValueOnce(new Error('boom'));
    const stream = createPreviewStream({ client, conversationId: 'c1', throttleMs: 100 });
    await stream.finalize('done');
    await expect(stream.abort()).resolves.toBeUndefined();
  });

  it('versions increase monotonically across many updates', async () => {
    vi.useFakeTimers();
    try {
      const { client, editMessage } = makeClientSpies();
      const stream = createPreviewStream({ client, conversationId: 'c1', throttleMs: 50 });
      stream.update('a');
      await vi.advanceTimersByTimeAsync(0);
      for (const t of ['ab', 'abc', 'abcd', 'abcde']) {
        stream.update(t);
        await vi.advanceTimersByTimeAsync(50);
      }
      const versions = editMessage.mock.calls.map(([p]) => p.version);
      for (let i = 1; i < versions.length; i += 1) {
        expect(versions[i]).toBeGreaterThan(versions[i - 1]!);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
