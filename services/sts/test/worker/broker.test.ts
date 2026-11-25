import type { BundleRequest, BundleResult } from '@kilocode/sts-contracts';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { SecretsBroker } from '../../src/broker';
import { BUNDLE_OBJECT_DEADLINE_MS, BUNDLE_OBJECT_RETRY_AFTER_SECONDS } from '../../src/constants';
import type { BundleDO } from '../../src/dos/BundleDO';
import { getBundleStub } from '../../src/dos/stubs';
import { workloadPolicyHash } from '../../src/policy';
import { stubOfflineNetwork } from './manager';
import { resetBundleObject } from './reset';
import { config, env } from './test-env';

beforeEach(async () => {
  stubOfflineNetwork();
  await resetBundleObject(getBundleStub(env, config, 'o11y'));
});

afterEach(() => {
  vi.useRealTimers();
  stubOfflineNetwork();
  vi.restoreAllMocks();
});

/** Puts a stand-in for the o11y bundle object whose `getBundle` answers with `answer`. */
function standInBundleObject(answer: () => Promise<BundleResult>): void {
  const namespace = env.STS_BUNDLE_DO;
  const get = namespace.get.bind(namespace);
  vi.spyOn(namespace, 'get').mockImplementation(
    id => ({ id: get(id).id, getBundle: answer }) as unknown as DurableObjectStub<BundleDO>
  );
}

const OK_BUNDLE: BundleResult = {
  status: 'ok',
  workload: 'o11y',
  environment: 'development',
  etag: '"etag-for-the-stand-in"',
  stale: false,
  fetchedAt: new Date(0).toISOString(),
  secrets: {},
  missing: [],
};

/** The ExecutionContext a SecretsBroker binding with `props: { caller }` gives the entrypoint. */
function bindingContext(caller: string): ExecutionContext {
  const ctx: Pick<ExecutionContext, 'props' | 'waitUntil' | 'passThroughOnException'> = {
    props: { caller },
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  };
  return ctx as ExecutionContext;
}

describe('SecretsBroker', () => {
  it('answers a plain copy and disposes the bundle object result', async () => {
    await getBundleStub(env, config, 'o11y').putBundle({
      workload: 'o11y',
      secrets: { O11Y_CF_AE_API_TOKEN: { value: 'ae-token', version: 7, id: 'id-ae' } },
      missing: [],
      fetchedAt: new Date().toISOString(),
      policyHash: await workloadPolicyHash('o11y'),
      stale: false,
    });

    // Wraps the real stub so the test sees the real RPC result and its workerd disposer. The bundle
    // object reads `id` through the same namespace to check its own name.
    const disposals: Array<Mock<() => void>> = [];
    const namespace = env.STS_BUNDLE_DO;
    const get = namespace.get.bind(namespace);
    vi.spyOn(namespace, 'get').mockImplementation(id => {
      const real = get(id);
      const wrapper = {
        id: real.id,
        getBundle: async (workload: string, environment: string, request: BundleRequest) => {
          const result = await real.getBundle(workload, environment, request);
          const dispose = vi.fn(result[Symbol.dispose].bind(result));
          Object.defineProperty(result, Symbol.dispose, { value: dispose, enumerable: false });
          disposals.push(dispose);
          return result;
        },
      };
      return wrapper as unknown as DurableObjectStub<BundleDO>;
    });

    const broker = new SecretsBroker(bindingContext('o11y'), env);
    const result = await broker.getBundle({});

    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.secrets.O11Y_CF_AE_API_TOKEN).toEqual({ value: 'ae-token', version: 7 });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Symbol.dispose in result).toBe(false);
    expect(disposals).toHaveLength(1);
    expect(disposals[0]).toHaveBeenCalledTimes(1);
  });

  it('answers unavailable at the deadline when the bundle object never answers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const pending = Promise.withResolvers<BundleResult>();
    standInBundleObject(() => pending.promise);
    vi.useFakeTimers();

    const answer = new SecretsBroker(bindingContext('o11y'), env).getBundle({});
    let settled = false;
    void answer.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(BUNDLE_OBJECT_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await answer).toEqual({
      status: 'unavailable',
      reason: 'internal',
      retryAfterSeconds: BUNDLE_OBJECT_RETRY_AFTER_SECONDS,
    });

    // A result that still arrives while the context lives is disposed.
    const dispose = vi.fn();
    pending.resolve(Object.defineProperty({ ...OK_BUNDLE }, Symbol.dispose, { value: dispose }));
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
  });

  it('clears the deadline timer when the bundle object answers in time', async () => {
    standInBundleObject(async () => OK_BUNDLE);
    vi.useFakeTimers();
    const answer = await new SecretsBroker(bindingContext('o11y'), env).getBundle({});
    expect(answer).toEqual(OK_BUNDLE);
    expect(vi.getTimerCount()).toBe(0);
  });
});
