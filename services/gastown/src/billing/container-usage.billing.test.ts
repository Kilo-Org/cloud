import type { ContainerUsageRpcMethods, RecordStartInput } from '@kilocode/container-usage';
import { describe, expect, it, vi } from 'vitest';
import {
  GASTOWN_CONTAINER_SKU,
  getContainerUsageClient,
  isGastownBillingEnabled,
} from './container-usage.billing';

function envFixture(overrides: Partial<Env>): Env {
  return overrides as Env;
}

describe('Gastown billing configuration', () => {
  it('enables billing only for the exact true value', () => {
    expect(isGastownBillingEnabled(envFixture({ GASTOWN_BILLING_ENABLED: 'true' }))).toBe(true);
    expect(isGastownBillingEnabled(envFixture({ GASTOWN_BILLING_ENABLED: 'false' }))).toBe(false);
    expect(isGastownBillingEnabled(envFixture({}))).toBe(false);
  });

  it('uses the production Gastown SKU', () => {
    expect(GASTOWN_CONTAINER_SKU).toBe('gastown-standard-2026-07');
  });

  it('creates a client backed by the WorkerEntrypoint binding', async () => {
    const recordStart = vi.fn(async (_input: RecordStartInput) => ({
      success: true as const,
      ack: { intervalId: 'test', durable: 'pg' as const, dedup: false },
    }));
    const binding = {
      recordStart,
      recordHeartbeat: vi.fn(),
      recordStop: vi.fn(),
    } satisfies ContainerUsageRpcMethods;

    await getContainerUsageClient(envFixture({ CONTAINER_USAGE: binding })).recordStart({
      instanceId: 'container-1',
      sku: GASTOWN_CONTAINER_SKU,
      subject: { type: 'user', id: 'user-1' },
      actor: { type: 'user', id: 'user-1' },
      sessionId: 'town-1',
      metadata: { townId: 'town-1' },
      startEpochMs: 1_000,
    });

    expect(recordStart).toHaveBeenCalledWith(
      expect.objectContaining({
        service: 'gastown',
        sku: 'gastown-standard-2026-07',
        idempotencyKey: 'v1:gastown:container-1:1000:start',
      })
    );
  });

  it('fails closed when the binding is absent', () => {
    expect(() => getContainerUsageClient(envFixture({ ENVIRONMENT: 'development' }))).toThrow(
      'CONTAINER_USAGE binding is required'
    );
  });
});
