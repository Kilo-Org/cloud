import { describe, expect, it } from 'vitest';
import {
  getSandboxAllocationRequest,
  type SandboxSelectionCapabilities,
} from '@kilocode/worker-utils/sandbox-allocation';
import type { Env } from '../types.js';
import { relayChatForBrowserPrepare } from './browser-relay-capability.js';

const owner = { userId: 'synthetic-user', orgId: '11111111-1111-4111-8111-111111111111' };
const env = {
  RUNTIME_KILO2_ORG_IDS: '*',
  RUNTIME_RELEASE_DESCRIPTOR_KILO2: 'synthetic-release',
} as Env;
const capabilities: SandboxSelectionCapabilities = {
  enabled: true,
  defaultDestination: getSandboxAllocationRequest('cloudflare-containers-standard-3'),
  options: [{ allocation: getSandboxAllocationRequest('vercel-small') }],
};

describe('browser prepare relay capability', () => {
  it('uses the unchanged origin-only startup owner for personal and organization candidates', () => {
    expect(relayChatForBrowserPrepare(env, owner, capabilities, { status: 'none' })).toBe(true);
    expect(
      relayChatForBrowserPrepare(env, { userId: owner.userId }, capabilities, { status: 'none' })
    ).toBe(true);
    expect(
      relayChatForBrowserPrepare(
        { ...env, RUNTIME_KILO2_ORG_IDS: owner.orgId },
        { userId: owner.userId },
        capabilities,
        { status: 'none' }
      )
    ).toBe(false);
  });
  it.each(['unknown', 'conflict', 'requested-not-found'])(
    'rejects unresolved environment %s',
    status => {
      expect(relayChatForBrowserPrepare(env, owner, capabilities, { status })).toBe(false);
    }
  );
  it.each(['unknown-allocation', 'cloudflare-shared', 'isolated-standard'])(
    'does not omit incompatible environment pin %s',
    sandboxAllocation => {
      expect(
        relayChatForBrowserPrepare(env, owner, capabilities, { status: 'match', sandboxAllocation })
      ).toBe(false);
    }
  );
  it('includes environment pins, saved defaults, explicit choices and disabled-picker defaults', () => {
    expect(
      relayChatForBrowserPrepare(env, owner, capabilities, {
        status: 'match',
        sandboxAllocation: 'vercel-small',
      })
    ).toBe(true);
    const incompatible = { ...env, RUNTIME_STARTUP_MODE: 'preinstalled' } as Env;
    expect(relayChatForBrowserPrepare(incompatible, owner, capabilities, { status: 'none' })).toBe(
      false
    );
    expect(
      relayChatForBrowserPrepare(
        incompatible,
        owner,
        { enabled: false, options: [], defaultDestination: capabilities.defaultDestination },
        { status: 'none' }
      )
    ).toBe(false);
  });
  it.each([
    { RUNTIME_KILO2_ORG_IDS: '' },
    { RUNTIME_RELEASE_DESCRIPTOR_KILO2: '' },
    { RUNTIME_INTERACTIVE_ORG_IDS: '*' },
  ])('fails closed for unavailable runtime configuration %j', overrides => {
    expect(
      relayChatForBrowserPrepare({ ...env, ...overrides }, owner, capabilities, { status: 'none' })
    ).toBe(false);
  });
});
