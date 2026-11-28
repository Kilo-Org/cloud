import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretsBroker } from '../../src/broker';
import { BundleDO } from '../../src/dos/BundleDO';
import { DenialDO } from '../../src/dos/DenialDO';
import { DeployTokenDO } from '../../src/dos/DeployTokenDO';
import { LeaseDO } from '../../src/dos/LeaseDO';
import { RefresherDO } from '../../src/dos/RefresherDO';
import { SignerDO } from '../../src/dos/SignerDO';
import { TokenSignerDO } from '../../src/dos/TokenSignerDO';
import {
  getBundleStub,
  getDenialStub,
  getDeployTokenStub,
  getLeaseStub,
  getRefresherStub,
  getSignerStub,
  getTokenSignerStub,
} from '../../src/dos/stubs';
import { stubOfflineNetwork } from './manager';
import { config, env } from './test-env';

type RpcTarget = Record<string, (...args: unknown[]) => Promise<unknown>>;

type Surface = {
  /** The class's own prototype; every prototype up to the runtime base class counts. */
  prototype: object;
  /** Every method a caller holding a stub or binding may call. */
  rpc: string[];
  stub: (() => unknown) | null;
  /** Internal methods, with arguments, that a stub must refuse; most once handed out a key. */
  internal: Array<[method: string, args: unknown[]]>;
};

const surfaces: Record<string, Surface> = {
  BundleDO: {
    prototype: BundleDO.prototype,
    rpc: ['alarm', 'getBundle', 'putBundle'],
    stub: () => getBundleStub(env, config, 'o11y'),
    internal: [['bundleKeys', []]],
  },
  RefresherDO: {
    prototype: RefresherDO.prototype,
    rpc: [
      'alarm',
      'buildBundle',
      'ensureStarted',
      'refreshAll',
      'requestWebhookRefresh',
      'webhookSecret',
    ],
    stub: () => getRefresherStub(env, config),
    internal: [
      ['snapshotKey', []],
      ['readManager', []],
      ['storedView', []],
    ],
  },
  SignerDO: {
    prototype: SignerDO.prototype,
    rpc: ['getJwks', 'signManagerToken'],
    stub: () => getSignerStub(env, config),
    internal: [
      ['requireSigning', []],
      ['loadOrCreateKey', []],
    ],
  },
  DenialDO: {
    prototype: DenialDO.prototype,
    rpc: ['alarm', 'record'],
    stub: () => getDenialStub(env, config),
    internal: [['increment', ['2026-11-26T00:00', 'forged', 1_000_000]]],
  },
  LeaseDO: {
    prototype: LeaseDO.prototype,
    rpc: ['alarm', 'create', 'ensureSweeping', 'revoke'],
    stub: () => getLeaseStub(env, config),
    internal: [['revokeOnce', ['another-workloads-lease']]],
  },
  DeployTokenDO: {
    prototype: DeployTokenDO.prototype,
    rpc: ['alarm', 'mint', 'revoke'],
    stub: () => getDeployTokenStub(env, config),
    internal: [['mintingCredential', []]],
  },
  TokenSignerDO: {
    prototype: TokenSignerDO.prototype,
    rpc: ['alarm', 'getJwks', 'mint'],
    stub: () => getTokenSignerStub(env, config, 0),
    internal: [['currentKey', []]],
  },
  // No binding to it in this pool; test/runtime calls its former `mintAuthority` over one.
  SecretsBroker: {
    prototype: SecretsBroker.prototype,
    rpc: ['attestGithubRun', 'getBundle', 'lease', 'mintTokens', 'revokeLease'],
    stub: null,
    internal: [],
  },
};

/** What came back, as a shape only: a test must not print key material. */
function shapeOf(value: unknown): string {
  if (typeof value === 'string') return `string(${value.length})`;
  if (value !== null && typeof value === 'object') {
    return `object{${Object.keys(value).sort().join(',')}}`;
  }
  return typeof value;
}

/**
 * Every property name on the chain from `prototype` up to, not including, the runtime base class
 * (`WorkerEntrypoint` for an entrypoint, else `DurableObject`): a stub can call a method of any
 * class in between, so a base class of ours must not add a public method unnoticed.
 */
function callableNames(prototype: object): string[] {
  const names = new Set<string>();
  let current: object | null = prototype;
  while (current !== DurableObject.prototype && current !== WorkerEntrypoint.prototype) {
    if (current === null) throw new Error('the class extends neither runtime base class');
    for (const name of Object.getOwnPropertyNames(current)) names.add(name);
    current = Object.getPrototypeOf(current) as object | null;
  }
  return [...names].sort();
}

/** Awaited directly: handing the RPC promise to `expect(...).rejects` left an unhandled rejection. */
async function callOverRpc(
  target: RpcTarget,
  method: string,
  args: unknown[]
): Promise<{ refused: string } | { answered: string }> {
  try {
    return { answered: shapeOf(await target[method](...args)) };
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
}

beforeEach(() => {
  stubOfflineNetwork();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RPC surface', () => {
  it.each(Object.entries(surfaces))(
    '%s exposes only its RPC methods; everything else is ECMAScript-private',
    async (_name, surface) => {
      expect(callableNames(surface.prototype)).toEqual(['constructor', ...surface.rpc].sort());
      if (surface.stub === null) return;
      const target = surface.stub() as RpcTarget;
      for (const [method, args] of surface.internal) {
        expect({ method, outcome: await callOverRpc(target, method, args) }).toEqual({
          method,
          outcome: { refused: expect.stringContaining(`does not implement "${method}"`) },
        });
      }
    }
  );
});
