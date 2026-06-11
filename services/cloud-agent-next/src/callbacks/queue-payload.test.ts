import { describe, expect, it, vi } from 'vitest';
import type { CallbackJob } from './types.js';
import {
  CALLBACK_QUEUE_MAX_SERIALIZED_BYTES,
  fitCallbackJobToQueueLimit,
  serializedCallbackJobByteLength,
} from './queue-payload.js';

function callbackJob(lastAssistantMessageText: string): CallbackJob {
  return {
    target: { url: 'https://example.com/callback' },
    payload: {
      sessionId: 'agent_callback_size',
      cloudAgentSessionId: 'agent_callback_size',
      messageId: 'msg_callback_size',
      status: 'completed',
      lastAssistantMessageText,
    },
  };
}

function actualSerializedCallbackJobByteLength(job: CallbackJob): number {
  return new TextEncoder().encode(JSON.stringify(job)).byteLength;
}

describe('fitCallbackJobToQueueLimit', () => {
  it('leaves callback jobs within the queue limit unchanged', () => {
    const job = callbackJob('Done');

    const result = fitCallbackJobToQueueLimit(job);

    expect(result).toEqual({
      status: 'ready',
      job,
      serializedByteLength: serializedCallbackJobByteLength(job),
    });
    expect(result.status === 'ready' && result.job).toBe(job);
    expect(job.payload.lastAssistantMessageTextTruncation).toBeUndefined();
  });

  it('omits oversized assistant text so consumers cannot treat a prefix as complete', () => {
    const assistantText = 'a'.repeat(CALLBACK_QUEUE_MAX_SERIALIZED_BYTES * 2);

    const result = fitCallbackJobToQueueLimit(callbackJob(assistantText));

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;

    expect(actualSerializedCallbackJobByteLength(result.job)).toBe(result.serializedByteLength);
    expect(result.serializedByteLength).toBeLessThanOrEqual(CALLBACK_QUEUE_MAX_SERIALIZED_BYTES);
    expect(result.job.payload.lastAssistantMessageText).toBeUndefined();
    expect(result.job.payload.lastAssistantMessageTextTruncation).toEqual({
      originalUtf8ByteLength: assistantText.length,
      retainedUtf8ByteLength: 0,
    });
  });

  it('measures and fits oversized callback jobs without materializing serialized JSON', () => {
    const job = callbackJob('😀"\\\n\ud800'.repeat(CALLBACK_QUEUE_MAX_SERIALIZED_BYTES));
    job.target.headers = { 'x-callback-context': 'line 1\nline 2' };
    const expectedByteLength = new TextEncoder().encode(JSON.stringify(job)).byteLength;
    const stringify = vi.spyOn(JSON, 'stringify');

    expect(serializedCallbackJobByteLength(job)).toBe(expectedByteLength);
    const result = fitCallbackJobToQueueLimit(job);

    expect(result.status).toBe('ready');
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
  });

  it('does not split a multi-byte Unicode character in a truncated error', () => {
    const errorMessage = '😀'.repeat(CALLBACK_QUEUE_MAX_SERIALIZED_BYTES);
    const job = callbackJob('');
    job.payload.status = 'failed';
    delete job.payload.lastAssistantMessageText;
    job.payload.errorMessage = errorMessage;

    const result = fitCallbackJobToQueueLimit(job);

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;

    const retainedText = result.job.payload.errorMessage ?? '';
    expect(retainedText.endsWith('😀')).toBe(true);
    expect(result.job.payload.errorMessageTruncation).toEqual({
      originalUtf8ByteLength: new TextEncoder().encode(errorMessage).byteLength,
      retainedUtf8ByteLength: new TextEncoder().encode(retainedText).byteLength,
    });
    expect(actualSerializedCallbackJobByteLength(result.job)).toBe(result.serializedByteLength);
    expect(result.serializedByteLength).toBeLessThanOrEqual(CALLBACK_QUEUE_MAX_SERIALIZED_BYTES);
  });

  it('accounts for JSON escaping, callback headers, and error messages', () => {
    const escapedText = '"\\\n'.repeat(CALLBACK_QUEUE_MAX_SERIALIZED_BYTES);
    const job = callbackJob(escapedText);
    job.target.headers = { 'x-callback-context': '"\\\n'.repeat(5_000) };
    job.payload.errorMessage = '"\\\n'.repeat(5_000);

    const result = fitCallbackJobToQueueLimit(job);

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;

    expect(result.job.target.headers).toEqual(job.target.headers);
    expect(result.job.payload.errorMessage).toBe(job.payload.errorMessage);
    expect(result.job.payload.lastAssistantMessageText).toBeUndefined();
    expect(result.job.payload.lastAssistantMessageTextTruncation).toEqual({
      originalUtf8ByteLength: new TextEncoder().encode(escapedText).byteLength,
      retainedUtf8ByteLength: 0,
    });
    expect(actualSerializedCallbackJobByteLength(result.job)).toBe(result.serializedByteLength);
    expect(result.serializedByteLength).toBeLessThanOrEqual(CALLBACK_QUEUE_MAX_SERIALIZED_BYTES);
  });

  it('truncates oversized failure errors so the terminal callback is still delivered', () => {
    const errorMessage = 'provider failure: '.repeat(CALLBACK_QUEUE_MAX_SERIALIZED_BYTES);
    const job = callbackJob('');
    job.payload.status = 'failed';
    delete job.payload.lastAssistantMessageText;
    job.payload.errorMessage = errorMessage;

    const result = fitCallbackJobToQueueLimit(job);

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;

    expect(result.job.payload.errorMessage?.length).toBeLessThan(errorMessage.length);
    expect(result.job.payload.errorMessageTruncation).toEqual({
      originalUtf8ByteLength: new TextEncoder().encode(errorMessage).byteLength,
      retainedUtf8ByteLength: new TextEncoder().encode(result.job.payload.errorMessage).byteLength,
    });
    expect(actualSerializedCallbackJobByteLength(result.job)).toBe(result.serializedByteLength);
    expect(result.serializedByteLength).toBeLessThanOrEqual(CALLBACK_QUEUE_MAX_SERIALIZED_BYTES);
  });

  it('rejects a callback whose fixed fields exceed the queue limit', () => {
    const job = callbackJob('assistant output');
    job.target.headers = {
      'x-callback-context': 'x'.repeat(CALLBACK_QUEUE_MAX_SERIALIZED_BYTES * 2),
    };

    const result = fitCallbackJobToQueueLimit(job);

    expect(result).toMatchObject({
      status: 'too-large',
      maximumByteLength: CALLBACK_QUEUE_MAX_SERIALIZED_BYTES,
    });
  });
});
