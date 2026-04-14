import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverInboundEmail } from './consumer';
import type { AppEnv, InboundEmailQueueMessage } from './types';

const message: InboundEmailQueueMessage = {
  instanceId: '11111111-1111-4111-8111-111111111111',
  messageId: '<msg-1@example.com>',
  from: 'sender@example.com',
  to: 'ki-11111111111141118111111111111111@kiloclaw.ai',
  subject: 'Hello',
  text: 'Body',
  receivedAt: '2026-04-13T12:00:00.000Z',
};

function makeEnv(response: Response): { env: AppEnv; fetchMock: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn().mockResolvedValue(response);
  const env = {
    INTERNAL_API_SECRET: { get: vi.fn().mockResolvedValue('internal-secret') },
    KILOCLAW: { fetch: fetchMock },
  } as unknown as AppEnv;
  return { env, fetchMock };
}

describe('deliverInboundEmail', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('posts queue messages to the KiloClaw platform endpoint', async () => {
    const { env, fetchMock } = makeEnv(new Response('ok', { status: 202 }));

    await deliverInboundEmail(message, env);

    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0][0] as Request;
    expect(request.url).toBe('https://kiloclaw/api/platform/inbound-email');
    expect(request.headers.get('x-internal-api-key')).toBe('internal-secret');
    expect(await request.json()).toEqual(message);
  });

  it('does not retry permanent failures', async () => {
    const { env } = makeEnv(new Response('not found', { status: 404 }));

    await expect(deliverInboundEmail(message, env)).resolves.toBeUndefined();
  });

  it('throws on transient failures so the queue retries', async () => {
    const { env } = makeEnv(new Response('unavailable', { status: 503 }));

    await expect(deliverInboundEmail(message, env)).rejects.toThrow(
      'Inbound email delivery failed with status 503'
    );
  });
});
