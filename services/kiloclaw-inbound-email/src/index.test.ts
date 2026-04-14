import { describe, expect, it, vi } from 'vitest';
import { buildQueueMessage } from './index';
import type { AppEnv } from './types';

function rawStream(value: string): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

function makeEmail(overrides: Partial<ForwardableEmailMessage> = {}): ForwardableEmailMessage {
  const raw =
    'Message-ID: <msg-1@example.com>\r\nFrom: Ada <ada@example.com>\r\nSubject: Hello\r\n\r\nBody text';
  return {
    from: 'ada@example.com',
    to: 'ki-11111111111141118111111111111111@kiloclaw.ai',
    headers: new Headers(),
    raw: rawStream(raw),
    rawSize: raw.length,
    setReject: vi.fn(),
    forward: vi.fn(),
    reply: vi.fn(),
    ...overrides,
  } as unknown as ForwardableEmailMessage;
}

function makeEnv(overrides: Record<string, unknown> = {}): AppEnv {
  return {
    INBOUND_EMAIL_DOMAIN: 'kiloclaw.ai',
    MAX_EMAIL_RAW_BYTES: '1048576',
    MAX_EMAIL_TEXT_CHARS: '32000',
    ...overrides,
  } as AppEnv;
}

describe('buildQueueMessage', () => {
  it('builds queue messages from Cloudflare Email Routing messages', async () => {
    const queueMessage = await buildQueueMessage(makeEmail(), makeEnv());

    expect(queueMessage?.instanceId).toBe('11111111-1111-4111-8111-111111111111');
    expect(queueMessage?.messageId).toBe('<msg-1@example.com>');
    expect(queueMessage?.from).toBe('ada@example.com');
    expect(queueMessage?.to).toBe('ki-11111111111141118111111111111111@kiloclaw.ai');
    expect(queueMessage?.subject).toBe('Hello');
    expect(queueMessage?.text).toBe('Body text');
    expect(typeof queueMessage?.receivedAt).toBe('string');
  });

  it('falls back to the envelope sender when the raw email has no sender header', async () => {
    const raw = 'Message-ID: <msg-2@example.com>\r\nSubject: Missing sender\r\n\r\nBody text';
    const queueMessage = await buildQueueMessage(
      makeEmail({
        from: 'envelope@example.com',
        raw: rawStream(raw),
        rawSize: raw.length,
      }),
      makeEnv()
    );

    expect(queueMessage?.from).toBe('envelope@example.com');
  });

  it('rejects invalid recipient addresses', async () => {
    const setReject = vi.fn();
    const email = makeEmail({ to: 'hello@kiloclaw.ai', setReject });

    const queueMessage = await buildQueueMessage(email, makeEnv());

    expect(queueMessage).toBeNull();
    expect(setReject).toHaveBeenCalledWith('Address unavailable');
  });

  it('rejects oversized messages before parsing raw content', async () => {
    const setReject = vi.fn();
    const email = makeEmail({ rawSize: 10, setReject });

    const queueMessage = await buildQueueMessage(email, makeEnv({ MAX_EMAIL_RAW_BYTES: '1' }));

    expect(queueMessage).toBeNull();
    expect(setReject).toHaveBeenCalledWith('Message too large');
  });
});
