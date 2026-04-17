import { describe, expect, it, vi } from 'vitest';
import { createPreviewStream } from './preview-stream';
import type { KiloChatClient } from './client';

function makeClientSpies() {
  const createMessage = vi.fn(async () => ({ messageId: 'm1' }));
  const editMessage = vi.fn(async (p: { messageId: string }) => ({
    messageId: p.messageId,
    stale: false,
  }));
  const deleteMessage = vi.fn(async () => undefined);
  const client: KiloChatClient = {
    createMessage,
    editMessage,
    deleteMessage,
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
    expect(createMessage).toHaveBeenCalledWith({
      conversationId: 'c1',
      content: [{ type: 'text', text: 'Hello' }],
    });
    expect(editMessage).not.toHaveBeenCalled();
  });

  it('first update POSTs, subsequent update after throttle PATCHes with timestamp', async () => {
    vi.useFakeTimers();
    try {
      const { client, createMessage, editMessage } = makeClientSpies();
      const stream = createPreviewStream({ client, conversationId: 'c1', throttleMs: 100 });
      stream.update('H');
      await vi.advanceTimersByTimeAsync(0);
      expect(createMessage).toHaveBeenCalledTimes(1);

      stream.update('Hel');
      await vi.advanceTimersByTimeAsync(100);
      expect(editMessage).toHaveBeenCalledTimes(1);
      expect(editMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'c1',
          messageId: 'm1',
          content: [{ type: 'text', text: 'Hel' }],
          timestamp: expect.any(Number),
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces rapid updates within the throttle window into one PATCH', async () => {
    vi.useFakeTimers();
    try {
      const { client, editMessage } = makeClientSpies();
      const stream = createPreviewStream({ client, conversationId: 'c1', throttleMs: 100 });
      stream.update('H');
      await vi.advanceTimersByTimeAsync(0);
      stream.update('He');
      stream.update('Hel');
      stream.update('Hell');
      await vi.advanceTimersByTimeAsync(100);
      expect(editMessage).toHaveBeenCalledTimes(1);
      expect(editMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: [{ type: 'text', text: 'Hell' }] })
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
      stream.update('Hel');
      const resultPromise = stream.finalize('Hello!');
      await vi.advanceTimersByTimeAsync(200);
      const result = await resultPromise;
      expect(result).toEqual({ messageId: 'm1' });
      expect(createMessage).toHaveBeenCalledTimes(1);
      expect(editMessage).toHaveBeenCalledTimes(1);
      expect(editMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'c1',
          messageId: 'm1',
          content: [{ type: 'text', text: 'Hello!' }],
          timestamp: expect.any(Number),
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('abort after create issues a DELETE; abort before create is a no-op', async () => {
    const { client, createMessage, deleteMessage } = makeClientSpies();
    const stream1 = createPreviewStream({
      client,
      conversationId: 'c1',
      throttleMs: 100,
      onWarn: () => {},
    });
    await stream1.abort();
    expect(deleteMessage).not.toHaveBeenCalled();

    const stream2 = createPreviewStream({
      client,
      conversationId: 'c1',
      throttleMs: 100,
      onWarn: () => {},
    });
    stream2.update('partial');
    await new Promise(resolve => setImmediate(resolve));
    expect(createMessage).toHaveBeenCalledTimes(1);
    await stream2.abort();
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledWith({ conversationId: 'c1', messageId: 'm1' });
  });

  it('abort swallows deleteMessage errors', async () => {
    const { client, deleteMessage } = makeClientSpies();
    deleteMessage.mockRejectedValueOnce(new Error('boom'));
    const stream = createPreviewStream({
      client,
      conversationId: 'c1',
      throttleMs: 100,
      onWarn: () => {},
    });
    stream.update('partial');
    await new Promise(resolve => setImmediate(resolve));
    await expect(stream.abort()).resolves.toBeUndefined();
  });

  it('does not claim text was applied when a streaming PATCH is stale', async () => {
    vi.useFakeTimers();
    try {
      const { client, editMessage } = makeClientSpies();
      editMessage.mockImplementationOnce(async p => ({
        messageId: p.messageId,
        stale: true,
      }));
      const stream = createPreviewStream({
        client,
        conversationId: 'c1',
        throttleMs: 100,
        onWarn: () => {},
      });
      stream.update('H');
      await vi.advanceTimersByTimeAsync(0);
      stream.update('Hello');
      await vi.advanceTimersByTimeAsync(100);
      expect(editMessage).toHaveBeenCalledTimes(1);

      // Finalize with the same text that the stale PATCH carried: must PATCH again,
      // because the remote preview never actually shows that text.
      await stream.finalize('Hello');
      expect(editMessage).toHaveBeenCalledTimes(2);
      expect(editMessage.mock.calls[1]![0]).toEqual(
        expect.objectContaining({ content: [{ type: 'text', text: 'Hello' }] })
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
