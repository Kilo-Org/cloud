import { describe, expect, it } from 'vitest';
import {
  clearRuntimeLaunchIntent,
  readRuntimeLaunchIntent,
  rotateRuntimeLaunchNonce,
  runtimeLaunchSelectionFor,
  writeRuntimeLaunchIntent,
  type RuntimeLaunchIntent,
  type RuntimeLaunchIntentStorage,
} from './runtime-launch-intent.js';
import { resolveRuntimeLaunchSelection } from '../../sandbox-control/runtime-launch.js';

/**
 * The durable launch intent: one versioned fixed-key record written with the
 * allocation transaction, retained across reconstruction, rejected when present
 * but malformed or mismatched, and reconciled baked when missing (legacy).
 */

const ALLOC = 'alloc-1';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const DESCRIPTOR = JSON.stringify({
  format: 1,
  bootstrap: 1,
  platform: { os: 'linux', arch: 'x64', libc: 'glibc', cpu: 'baseline' },
  abi: 'kilo-runtime-base-v1',
  cliVersion: '1.0.0',
  cliExecutable: 'kilo',
  wrapperSdkVersion: '1.0.0',
  protocol: 'v1',
  artifacts: [
    { role: 'cli', sha256: SHA_A, transferBytes: 10, expandedBytes: 4, fileCount: 1 },
    { role: 'control', sha256: SHA_B, transferBytes: 10, expandedBytes: 4, fileCount: 1 },
  ],
  caps: { maxTransferBytes: 100, maxExpandedBytes: 100, maxFileCount: 10 },
  inventory: [
    ['cli', 'kilo', 0o755, 4, SHA_A],
    ['control', 'x/y', 0o644, 4, SHA_B],
  ],
});
const ORIGIN = 'https://runtime.example.com';

function fakeStorage(): RuntimeLaunchIntentStorage & { readonly raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>();
  return {
    raw,
    get: key => raw.get(key),
    put: (key, value) => {
      raw.set(key, value);
    },
    delete: key => raw.delete(key),
  };
}

function releaseIntent(launchId = 'launch-0001'): RuntimeLaunchIntent {
  return {
    version: 1,
    allocationId: ALLOC,
    launchId,
    selection: {
      kind: 'release',
      descriptor: DESCRIPTOR,
      artifactOrigin: ORIGIN,
      bootstrapContract: 1,
    },
  };
}

describe('resolveRuntimeLaunchSelection', () => {
  it('selects a release only for a valid descriptor and trusted HTTPS origin', () => {
    expect(
      resolveRuntimeLaunchSelection({ descriptor: DESCRIPTOR, artifactOrigin: ORIGIN })
    ).toEqual({
      kind: 'release',
      descriptor: DESCRIPTOR,
      artifactOrigin: ORIGIN,
      bootstrapContract: 1,
    });
  });

  it('stays baked only without any explicit configuration', () => {
    expect(
      resolveRuntimeLaunchSelection({ descriptor: undefined, artifactOrigin: undefined })
    ).toEqual({ kind: 'baked' });
  });

  it('fails closed on incomplete or invalid explicit configuration', () => {
    expect(() =>
      resolveRuntimeLaunchSelection({ descriptor: DESCRIPTOR, artifactOrigin: undefined })
    ).toThrow();
    expect(() =>
      resolveRuntimeLaunchSelection({ descriptor: DESCRIPTOR, artifactOrigin: 'http://insecure' })
    ).toThrow();
    expect(() =>
      resolveRuntimeLaunchSelection({ descriptor: undefined, artifactOrigin: ORIGIN })
    ).toThrow();
    expect(() =>
      resolveRuntimeLaunchSelection({ descriptor: '{"format":1}', artifactOrigin: ORIGIN })
    ).toThrow();
  });
});

describe('runtime launch intent record', () => {
  it('treats a missing record as legacy and reconciles baked', () => {
    const storage = fakeStorage();
    expect(readRuntimeLaunchIntent(storage, ALLOC)).toEqual({ kind: 'legacy' });
    expect(runtimeLaunchSelectionFor(storage, ALLOC)).toEqual({ kind: 'baked' });
  });

  it('round-trips a written intent and retains it for the same identity', () => {
    const storage = fakeStorage();
    writeRuntimeLaunchIntent(storage, releaseIntent());
    expect(readRuntimeLaunchIntent(storage, ALLOC)).toEqual({
      kind: 'intent',
      intent: releaseIntent(),
    });
    expect(runtimeLaunchSelectionFor(storage, ALLOC)).toMatchObject({ kind: 'release' });
  });

  it('fails closed on a present but mismatched or malformed record', () => {
    const storage = fakeStorage();
    writeRuntimeLaunchIntent(storage, releaseIntent());
    expect(readRuntimeLaunchIntent(storage, 'other-alloc')).toEqual({ kind: 'malformed' });
    expect(() => runtimeLaunchSelectionFor(storage, 'other-alloc')).toThrow();

    storage.put('runtime_launch', { version: 1, allocationId: ALLOC });
    expect(readRuntimeLaunchIntent(storage, ALLOC)).toEqual({ kind: 'malformed' });
    expect(() => runtimeLaunchSelectionFor(storage, ALLOC)).toThrow();
  });

  it('clears the record when the allocation identity clears', () => {
    const storage = fakeStorage();
    writeRuntimeLaunchIntent(storage, releaseIntent());
    clearRuntimeLaunchIntent(storage);
    expect(readRuntimeLaunchIntent(storage, null)).toEqual({ kind: 'legacy' });
    expect(storage.raw.size).toBe(0);
  });

  it('rotates only the expected nonce, retaining the selection', () => {
    const storage = fakeStorage();
    writeRuntimeLaunchIntent(storage, releaseIntent());
    const rotated = rotateRuntimeLaunchNonce(storage, ALLOC, 'launch-0001', 'launch-0002');
    expect(rotated.launchId).toBe('launch-0002');
    expect(rotated.selection).toEqual(releaseIntent().selection);
    expect(readRuntimeLaunchIntent(storage, ALLOC)).toMatchObject({
      kind: 'intent',
      intent: { launchId: 'launch-0002', selection: { kind: 'release' } },
    });
  });

  it('refuses to rotate unless the expected previous nonce matches', () => {
    const storage = fakeStorage();
    expect(() => rotateRuntimeLaunchNonce(storage, ALLOC, 'launch-0001', 'launch-0002')).toThrow();

    writeRuntimeLaunchIntent(storage, releaseIntent());
    expect(() =>
      rotateRuntimeLaunchNonce(storage, 'other', 'launch-0001', 'launch-0002')
    ).toThrow();
    // A stale expected nonce must not overwrite the current one.
    expect(() => rotateRuntimeLaunchNonce(storage, ALLOC, 'launch-9999', 'launch-0003')).toThrow();
    expect(readRuntimeLaunchIntent(storage, ALLOC)).toMatchObject({
      kind: 'intent',
      intent: { launchId: 'launch-0001' },
    });
  });
});
