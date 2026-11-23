import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import {
  admitSandboxEgressAtLocator,
  createEgressAdmissionCache,
  type SandboxEgressAdmissionResult,
} from './egress-admission.js';

const NOW = 1_800_000_000_000;

function restricted(expiresAt: number): SandboxEgressAdmissionResult {
  return { ok: true, policy: { allowlist: ['example.com'] }, expiresAt };
}

function harness(maxEntries?: number) {
  let now = NOW;
  const admit = createEgressAdmissionCache({
    now: () => now,
    ...(maxEntries ? { maxEntries } : {}),
  });
  return {
    admit,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('egress admission isolate cache', () => {
  it('serves a repeated token for the same sandbox from the cache', async () => {
    const { admit } = harness();
    const load = vi.fn(async () => restricted(NOW + 600_000));
    expect(await admit('ses-a', 'token-1', load)).toEqual(restricted(NOW + 600_000));
    expect(await admit('ses-a', 'token-1', load)).toEqual(restricted(NOW + 600_000));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keys by the sandbox id and the token', async () => {
    const { admit } = harness();
    const load = vi.fn(async () => restricted(NOW + 600_000));
    await admit('ses-a', 'token-1', load);
    await admit('ses-b', 'token-1', load);
    await admit('ses-a', 'token-2', load);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('keeps an entry for at most 30 seconds', async () => {
    const { admit, advance } = harness();
    const load = vi.fn(async (): Promise<SandboxEgressAdmissionResult> => ({
      ok: true,
      policy: null,
    }));
    await admit('ses-a', 'token-1', load);
    advance(29_999);
    await admit('ses-a', 'token-1', load);
    expect(load).toHaveBeenCalledTimes(1);
    advance(1);
    await admit('ses-a', 'token-1', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('never keeps an entry past the identity expiry', async () => {
    const { admit, advance } = harness();
    const load = vi.fn(async () => restricted(NOW + 5_000));
    await admit('ses-a', 'token-1', load);
    advance(4_999);
    await admit('ses-a', 'token-1', load);
    expect(load).toHaveBeenCalledTimes(1);
    advance(1);
    await admit('ses-a', 'token-1', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not cache a denial', async () => {
    const { admit } = harness();
    const load = vi.fn(async (): Promise<SandboxEgressAdmissionResult> => ({
      ok: false,
      status: 401,
      code: 'invalid_identity',
    }));
    await admit('ses-a', 'token-1', load);
    await admit('ses-a', 'token-1', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('removes the oldest entry when it is full', async () => {
    const { admit } = harness(2);
    const load = vi.fn(async () => restricted(NOW + 600_000));
    await admit('ses-a', 'token-1', load);
    await admit('ses-a', 'token-2', load);
    await admit('ses-a', 'token-3', load);
    expect(load).toHaveBeenCalledTimes(3);
    await admit('ses-a', 'token-3', load);
    await admit('ses-a', 'token-2', load);
    expect(load).toHaveBeenCalledTimes(3);
    await admit('ses-a', 'token-1', load);
    expect(load).toHaveBeenCalledTimes(4);
  });
});

describe('egress admission RPC locator', () => {
  it('calls the control object of the logical sandbox', async () => {
    const admitEgressForward = vi.fn(async () => ({ ok: true as const, policy: null }));
    const getByName = vi.fn(() => ({ admitEgressForward }));
    const namespace = Object.assign({} as Env['SANDBOX_CONTROL'], { getByName });
    await expect(
      admitSandboxEgressAtLocator({ SANDBOX_CONTROL: namespace }, 'ses-a', { oidcToken: 't' })
    ).resolves.toEqual({ ok: true, policy: null });
    expect(getByName).toHaveBeenCalledExactlyOnceWith('ses-a');
    expect(admitEgressForward).toHaveBeenCalledExactlyOnceWith({ oidcToken: 't' });
  });

  it('refuses an unsafe sandbox id without a call', async () => {
    const getByName = vi.fn();
    const namespace = Object.assign({} as Env['SANDBOX_CONTROL'], { getByName });
    await expect(
      admitSandboxEgressAtLocator({ SANDBOX_CONTROL: namespace }, '../x', { oidcToken: 't' })
    ).resolves.toEqual({ ok: false, status: 403, code: 'allocation_unavailable' });
    expect(getByName).not.toHaveBeenCalled();
  });
});
