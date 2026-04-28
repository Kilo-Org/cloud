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

  it('first POST includes inReplyToMessageId when provided', async () => {
    const { client, createMessage } = makeClientSpies();
    const stream = createPreviewStream({
      client,
      conversationId: 'c1',
      throttleMs: 100,
      inReplyToMessageId: 'parent-msg-1',
    });
    await stream.finalize('Hello');
    expect(createMessage).toHaveBeenCalledWith({
      conversationId: 'c1',
      content: [{ type: 'text', text: 'Hello' }],
      inReplyToMessageId: 'parent-msg-1',
    });
  });

  it('first update POST includes inReplyToMessageId, subsequent PATCHes do not', async () => {
    vi.useFakeTimers();
    try {
      const { client, createMessage, editMessage } = makeClientSpies();
      const stream = createPreviewStream({
        client,
        conversationId: 'c1',
        throttleMs: 100,
        inReplyToMessageId: 'parent-msg-1',
      });
      stream.update('H');
      await vi.advanceTimersByTimeAsync(0);
      expect(createMessage).toHaveBeenCalledWith({
        conversationId: 'c1',
        content: [{ type: 'text', text: 'H' }],
        inReplyToMessageId: 'parent-msg-1',
      });

      stream.update('Hello');
      await vi.advanceTimersByTimeAsync(100);
      expect(editMessage).toHaveBeenCalledWith(
        expect.not.objectContaining({ inReplyToMessageId: expect.anything() })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('two synchronous updates while idle only issue one createMessage (no double-POST race)', async () => {
    // Regression: before the fix, both synchronous update() calls could enter
    // the `phase === 'idle' && !inFlight` branch, each calling flushOnce()
    // which would each see messageId === undefined and POST, producing two
    // messages where the second orphans the first.
    vi.useFakeTimers();
    try {
      let resolveCreate!: (v: { messageId: string }) => void;
      const { client, createMessage, editMessage } = makeClientSpies();
      // Make createMessage hang until we resolve it manually, so the inFlight
      // guard is the only thing preventing the second call from entering.
      createMessage.mockImplementation(
        () =>
          new Promise(resolve => {
            resolveCreate = resolve;
          })
      );

      const stream = createPreviewStream({
        client,
        conversationId: 'c1',
        throttleMs: 100,
        onWarn: () => {},
      });

      // Two synchronous update() calls before any microtask runs.
      stream.update('first');
      stream.update('second');

      // Only ONE createMessage should have been called.
      expect(createMessage).toHaveBeenCalledTimes(1);
      expect(createMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: [{ type: 'text', text: 'first' }] })
      );

      // Resolve the first POST so the stream can move forward.
      resolveCreate({ messageId: 'm1' });
      await vi.advanceTimersByTimeAsync(0);

      // The second text ('second') should now flush via PATCH, not a second POST.
      await vi.advanceTimersByTimeAsync(100);
      expect(createMessage).toHaveBeenCalledTimes(1); // still only one POST
      expect(editMessage).toHaveBeenCalledTimes(1);
      expect(editMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'm1',
          content: [{ type: 'text', text: 'second' }],
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('splits text exceeding the per-block cap into multiple content blocks', async () => {
    const { client, createMessage } = makeClientSpies();
    const stream = createPreviewStream({ client, conversationId: 'c1', throttleMs: 100 });
    // 20 000 chars -> 8000 + 8000 + 4000 = 3 blocks (cap 8000 per block).
    const longText = 'a'.repeat(20_000);
    await stream.finalize(longText);
    expect(createMessage).toHaveBeenCalledTimes(1);
    const { content } = createMessage.mock.calls[0]![0] as {
      content: Array<{ type: string; text: string }>;
    };
    expect(content).toHaveLength(3);
    expect(content.every(b => b.type === 'text')).toBe(true);
    expect(content.every(b => b.text.length <= 8000)).toBe(true);
    expect(content.map(b => b.text).join('')).toBe(longText);
  });

  it('warns when the finalize PATCH itself is stale', async () => {
    vi.useFakeTimers();
    try {
      const { client, editMessage } = makeClientSpies();
      const warnings: string[] = [];
      const stream = createPreviewStream({
        client,
        conversationId: 'c1',
        throttleMs: 100,
        onWarn: (msg: string) => warnings.push(msg),
      });
      stream.update('H');
      await vi.advanceTimersByTimeAsync(0);

      // Make the finalize PATCH return stale
      editMessage.mockImplementationOnce(async p => ({
        messageId: p.messageId,
        stale: true,
      }));
      await stream.finalize('Final');
      expect(editMessage).toHaveBeenCalledTimes(1);
      expect(warnings).toContain('final editMessage was stale — remote preview may be outdated');
    } finally {
      vi.useRealTimers();
    }
  });
});
