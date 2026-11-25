import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebhookGate } from '../../src/infisical/webhook';
import { signWebhook, webhookBody } from './webhook';

const SECRET = 'webhook-secret-from-the-refresher';

function gate(options?: { secret?: () => string; failLoads?: () => boolean }) {
  let clock = Date.now();
  let loads = 0;
  const instance = new WebhookGate({
    loadSecret: async () => {
      loads += 1;
      if (options?.failLoads?.()) throw new Error('refresher unavailable');
      return options?.secret?.() ?? SECRET;
    },
    projectId: 'test-project-id',
    environmentSlug: 'development',
    now: () => clock,
  });
  return {
    verify: (body: string, signature: string | null) => instance.verify(body, signature),
    loads: () => loads,
    advance: (ms: number) => {
      clock += ms;
    },
    body: () => webhookBody({ timestamp: clock }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('webhook gate', () => {
  it('lets a forged flood cost no refresher call after the first load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const subject = gate();
    const body = subject.body();
    expect(await subject.verify(body, await signWebhook(SECRET, body))).toEqual({
      status: 'refresh',
    });
    expect(subject.loads()).toBe(1);

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const forged = subject.body();
      expect(await subject.verify(forged, await signWebhook(`guess-${attempt}`, forged))).toEqual({
        status: 'rejected',
        reason: 'bad_signature',
      });
    }
    expect(subject.loads()).toBe(1);
  });

  it('reloads the secret at most once a minute after a failed signature', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let current = SECRET;
    const subject = gate({ secret: () => current });
    const first = subject.body();
    await subject.verify(first, await signWebhook(SECRET, first));

    current = 'a-new-secret';
    const renewed = subject.body();
    const signature = await signWebhook(current, renewed);
    expect((await subject.verify(renewed, signature)).status).toBe('rejected');
    expect(subject.loads()).toBe(1);

    subject.advance(61_000);
    const later = subject.body();
    expect(await subject.verify(later, await signWebhook(current, later))).toEqual({
      status: 'refresh',
    });
    expect(subject.loads()).toBe(2);
    const forged = subject.body();
    await subject.verify(forged, await signWebhook('guess', forged));
    expect(subject.loads()).toBe(2);
  });

  it('shares one load between concurrent first requests and retries a failed load a minute later', async () => {
    let failing = true;
    const subject = gate({ failLoads: () => failing });
    const body = subject.body();
    const signature = await signWebhook(SECRET, body);
    const results = await Promise.allSettled([
      subject.verify(body, signature),
      subject.verify(body, signature),
      subject.verify(body, signature),
    ]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(subject.loads()).toBe(1);
    await expect(subject.verify(body, signature)).rejects.toThrow('refresher unavailable');
    expect(subject.loads()).toBe(1);

    failing = false;
    subject.advance(61_000);
    const later = subject.body();
    expect((await subject.verify(later, await signWebhook(SECRET, later))).status).toBe('refresh');
    expect(subject.loads()).toBe(2);
  });

  it('refuses a missing signature and a stale timestamp, and ignores another environment', async () => {
    const subject = gate();
    const body = subject.body();
    expect(await subject.verify(body, null)).toEqual({ status: 'rejected', reason: 'malformed' });

    const old = webhookBody({ timestamp: Date.now() - 6 * 60 * 1000 });
    expect(await subject.verify(old, await signWebhook(SECRET, old))).toEqual({
      status: 'rejected',
      reason: 'stale',
    });

    const staging = webhookBody({ timestamp: Date.now(), environment: 'staging' });
    expect(await subject.verify(staging, await signWebhook(SECRET, staging))).toEqual({
      status: 'ignored',
      reason: 'other_scope',
    });
    expect(subject.loads()).toBe(1);
  });
});
