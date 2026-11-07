import { describe, expect, it } from 'vitest';
import { runtimeProxyOriginProof } from '../../runtime-credential-proxy-origin.js';
import {
  markRuntimeProxyOriginAllocation,
  runtimeProxyOriginAdmitted,
} from './runtime-proxy-origin-gate.js';

const env = { NEXTAUTH_SECRET: 'origin-gate-secret' };

function memoryStorage() {
  const values = new Map<string, unknown>();
  return {
    get: (key: string) => values.get(key),
    put: (key: string, value: unknown) => void values.set(key, value),
    delete: (key: string) => values.delete(key),
  };
}

describe('runtimeProxyOriginAdmitted', () => {
  it('requires this egress proof for an allocation that started with origin proofs', async () => {
    const storage = memoryStorage();
    markRuntimeProxyOriginAllocation(storage, 'alloc-1');
    const proof = await runtimeProxyOriginProof(env, 'egress-1');
    const other = await runtimeProxyOriginProof(env, 'egress-2');
    const admitted = (presented: string | undefined) =>
      runtimeProxyOriginAdmitted({
        storage,
        env,
        allocationId: 'alloc-1',
        outboundId: 'egress-1',
        presented,
      });
    expect(await admitted(proof ?? undefined)).toBe(true);
    expect(await admitted(other ?? undefined)).toBe(false);
    expect(await admitted(undefined)).toBe(false);
    expect(await admitted('')).toBe(false);
  });

  it('exempts allocations without platform egress or from before origin proofs', async () => {
    const storage = memoryStorage();
    const check = (allocationId: string, outboundId: string | null) =>
      runtimeProxyOriginAdmitted({ storage, env, allocationId, outboundId, presented: undefined });
    expect(await check('alloc-1', 'egress-1')).toBe(true);
    markRuntimeProxyOriginAllocation(storage, 'alloc-2');
    expect(await check('alloc-1', 'egress-1')).toBe(true);
    expect(await check('alloc-2', null)).toBe(true);
    expect(await check('alloc-2', 'egress-1')).toBe(false);
    markRuntimeProxyOriginAllocation(storage, null);
    expect(await check('alloc-2', 'egress-1')).toBe(true);
  });

  it('exempts a local development facade, which container egress does not intercept', async () => {
    const storage = memoryStorage();
    markRuntimeProxyOriginAllocation(storage, 'alloc-1');
    const check = (workerUrl: string) =>
      runtimeProxyOriginAdmitted({
        storage,
        env: { ...env, WORKER_URL: workerUrl },
        allocationId: 'alloc-1',
        outboundId: 'egress-1',
        presented: undefined,
      });
    expect(await check('http://host.docker.internal:8794')).toBe(true);
    expect(await check('http://localhost:8794')).toBe(true);
    expect(await check('https://cloud-agent.example.com')).toBe(false);
  });
});
