import { describe, expect, it } from 'vitest';
import { getContainerUsageService, isGastownBillingEnabled } from './container-usage.billing';
import type { ContainerUsageService } from './container-usage.billing';

function envFixture(overrides: Partial<Env>): Env {
  return overrides as Env;
}

describe('Gastown billing configuration', () => {
  it('enables billing only for the exact true value', () => {
    expect(isGastownBillingEnabled(envFixture({ GASTOWN_BILLING_ENABLED: 'true' }))).toBe(true);
    expect(isGastownBillingEnabled(envFixture({ GASTOWN_BILLING_ENABLED: 'false' }))).toBe(false);
    expect(isGastownBillingEnabled(envFixture({}))).toBe(false);
  });

  it('uses the no-charge development stub when the binding is absent', async () => {
    const service = getContainerUsageService(envFixture({ ENVIRONMENT: 'development' }));
    const authorization = await service.authorizeStart({
      context: {
        service: 'gastown',
        instanceId: 'container-1',
        sku: 'cloudflare-container-standard-4',
        subject: { type: 'user', id: 'user-1' },
        actor: { type: 'user', id: 'user-1' },
        sessionId: 'town-1',
        metadata: { townId: 'town-1' },
      },
      idempotencyKey: 'authorize-1',
      observedAt: 1_000,
    });

    expect(authorization).toMatchObject({ verdict: 'allow', minimumRequired: 1 });
  });

  it('prefers the configured WorkerEntrypoint binding', () => {
    const binding = {
      authorizeStart: async () => ({
        verdict: 'deny' as const,
        remaining: 0,
        minimumRequired: 1,
      }),
      recordStart: async () => ({ intervalId: 'test', durable: 'pg' as const, dedup: false }),
      recordHeartbeat: async () => ({
        intervalId: 'test',
        durable: 'pg' as const,
        dedup: false,
        budget: { verdict: 'continue' as const },
      }),
      recordStop: async () => ({ intervalId: 'test', durable: 'pg' as const, dedup: false }),
    } satisfies ContainerUsageService;

    expect(getContainerUsageService(envFixture({ CONTAINER_USAGE: binding }))).toBe(binding);
  });

  it('fails closed in production when the binding is absent', () => {
    expect(() => getContainerUsageService(envFixture({ ENVIRONMENT: 'production' }))).toThrow(
      'CONTAINER_USAGE binding is required'
    );
  });
});
