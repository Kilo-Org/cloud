import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  recordSharedSandboxFailover,
  resolveSharedSandboxAssignment,
  type SharedSandboxOverrideStore,
} from './shared-sandbox-route.js';

const routeKey = 'usr-000000000000000000000000000000000000000000000000' as const;

function createHangingStore(operation: 'get' | 'put'): SharedSandboxOverrideStore {
  return {
    get: operation === 'get' ? () => new Promise<never>(() => undefined) : async () => null,
    put: operation === 'put' ? () => new Promise<never>(() => undefined) : async () => {},
  };
}

describe('shared sandbox override timeouts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails closed when an override read exceeds five seconds', async () => {
    vi.useFakeTimers();
    const assignment = resolveSharedSandboxAssignment(createHangingStore('get'), routeKey);
    const rejection = expect(assignment).rejects.toThrow(
      'Shared sandbox override KV read timed out after 5000ms'
    );

    await vi.advanceTimersByTimeAsync(5_000);

    await rejection;
  });

  it('retries publication when an override write exceeds five seconds', async () => {
    vi.useFakeTimers();
    const publication = recordSharedSandboxFailover(createHangingStore('put'), routeKey);
    const rejection = expect(publication).rejects.toThrow(
      'Shared sandbox override KV write timed out after 5000ms'
    );

    await vi.advanceTimersByTimeAsync(5_000);

    await rejection;
  });
});
