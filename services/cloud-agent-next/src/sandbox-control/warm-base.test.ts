import { describe, expect, it } from 'vitest';
import {
  activeWarmBaseId,
  attachRestoredFromBackup,
  readWarmBaseRecord,
  selectStartSnapshot,
  selectWarmBaseWorkspace,
  warmBaseDigest,
  warmBaseHomeForWorkspace,
  warmBasePaths,
  type WarmBaseDigestInput,
} from './warm-base.js';

const HEX64 = /^[0-9a-f]{64}$/;

const base: WarmBaseDigestInput = {
  owner: 'user_1',
  repositoryUrl: 'https://github.com/acme/demo.git',
  wrapperVersion: '1.2.3',
  image: 'registry.example/app@sha256:abc',
  instance: 'standard-3',
};

async function digestOf(overrides: Partial<WarmBaseDigestInput>): Promise<string> {
  return warmBaseDigest({ ...base, ...overrides });
}

describe('warmBaseDigest', () => {
  it('is stable for identical inputs', async () => {
    const first = await warmBaseDigest({ ...base });
    const second = await warmBaseDigest({ ...base });
    expect(first).toMatch(HEX64);
    expect(second).toMatch(HEX64);
    expect(first).toBe(second);
  });

  it.each<[string, Partial<WarmBaseDigestInput>]>([
    ['owner', { owner: 'user_2' }],
    ['repository url', { repositoryUrl: 'https://github.com/acme/other.git' }],
    ['wrapper version', { wrapperVersion: '1.2.4' }],
    ['image', { image: 'registry.example/app@sha256:def' }],
    ['instance', { instance: 'standard-4' }],
  ])('changes when %s changes', async (_label, overrides) => {
    const changed = await digestOf(overrides);
    const baseline = await digestOf({});
    expect(changed).toMatch(HEX64);
    expect(baseline).toMatch(HEX64);
    expect(changed).not.toBe(baseline);
  });
});

describe('attachRestoredFromBackup', () => {
  it('is true only when preparation is needed and a restore is pending', () => {
    expect(attachRestoredFromBackup(true, true)).toBe(true);
    expect(attachRestoredFromBackup(true, false)).toBe(false);
    expect(attachRestoredFromBackup(false, true)).toBe(false);
    expect(attachRestoredFromBackup(false, false)).toBe(false);
  });
});

describe('activeWarmBaseId', () => {
  it('returns no id without a record', () => {
    expect(activeWarmBaseId(null, 1_000)).toBeUndefined();
  });

  it('returns no id once the record has expired', () => {
    expect(activeWarmBaseId({ id: 'snap_1', expiresAt: 1_000 }, 1_000)).toBeUndefined();
    expect(activeWarmBaseId({ id: 'snap_1', expiresAt: 999 }, 1_000)).toBeUndefined();
  });

  it('returns the id before expiry', () => {
    expect(activeWarmBaseId({ id: 'snap_1', expiresAt: 1_001 }, 1_000)).toBe('snap_1');
  });

  it('rejects malformed persisted records', () => {
    expect(readWarmBaseRecord({ id: '', expiresAt: 1 })).toBeNull();
    expect(readWarmBaseRecord({ id: 'snap_1' })).toBeNull();
    expect(readWarmBaseRecord({ id: 'snap_1', expiresAt: 1, extra: true })).toBeNull();
    expect(readWarmBaseRecord('snap_1')).toBeNull();
    expect(readWarmBaseRecord({ id: 'snap_1', expiresAt: 1 })).toEqual({
      id: 'snap_1',
      expiresAt: 1,
    });
  });
});

describe('warmBasePaths', () => {
  const digest = 'a'.repeat(64);

  it('omits the session id and is stable per digest', () => {
    const paths = warmBasePaths(digest);
    expect(paths).toEqual({
      workspace: `/workspace/warm/${digest}`,
      home: `/tmp/kilo-worktrees/warm/${digest}`,
    });
    expect(paths.workspace).not.toContain('workspace_1');
    expect(warmBasePaths(digest)).toEqual(paths);
    expect(warmBasePaths('b'.repeat(64))).not.toEqual(paths);
  });

  it('derives the stable home only from a warm workspace path', () => {
    expect(warmBaseHomeForWorkspace(warmBasePaths(digest).workspace)).toBe(
      warmBasePaths(digest).home
    );
    expect(warmBaseHomeForWorkspace('/workspace/user_1/sessions/workspace_1')).toBeUndefined();
    expect(warmBaseHomeForWorkspace('/workspace/warm/not-a-digest')).toBeUndefined();
    expect(warmBaseHomeForWorkspace(undefined)).toBeUndefined();
  });
});

describe('selectStartSnapshot', () => {
  it('prefers the session slot, then the warm id, then the image', () => {
    expect(selectStartSnapshot('slot_1', 'warm_1')).toBe('slot_1');
    expect(selectStartSnapshot(null, 'warm_1')).toBe('warm_1');
    expect(selectStartSnapshot(undefined, undefined)).toBeUndefined();
  });
});

describe('selectWarmBaseWorkspace', () => {
  const expected = `/workspace/warm/${'a'.repeat(64)}`;
  const legacy = '/workspace/user_1/sessions/workspace_1';

  it('refuses warm and pins the legacy directory when preparation history exists', () => {
    expect(
      selectWarmBaseWorkspace({
        currentPath: undefined,
        sessionSlot: null,
        hasPreparationHistory: true,
        legacyDirectory: legacy,
        expectedWorkspace: expected,
      })
    ).toEqual({ eligible: false, continuation: false, directory: legacy });
  });

  it('continues at a matching persisted warm path regardless of preparation history', () => {
    expect(
      selectWarmBaseWorkspace({
        currentPath: expected,
        sessionSlot: null,
        hasPreparationHistory: true,
        legacyDirectory: legacy,
        expectedWorkspace: expected,
      })
    ).toEqual({ eligible: true, continuation: true, directory: expected });
    expect(
      selectWarmBaseWorkspace({
        currentPath: expected,
        sessionSlot: null,
        hasPreparationHistory: false,
        legacyDirectory: legacy,
        expectedWorkspace: expected,
      })
    ).toEqual({ eligible: true, continuation: true, directory: expected });
  });

  it('preserves a diverging resolved path and refuses warm', () => {
    expect(
      selectWarmBaseWorkspace({
        currentPath: '/workspace/other',
        sessionSlot: null,
        hasPreparationHistory: false,
        legacyDirectory: legacy,
        expectedWorkspace: expected,
      })
    ).toEqual({ eligible: false, continuation: false, directory: '/workspace/other' });
  });

  it('refuses warm for a matching warm path while a session snapshot exists', () => {
    expect(
      selectWarmBaseWorkspace({
        currentPath: expected,
        sessionSlot: 'snap_1',
        hasPreparationHistory: false,
        legacyDirectory: legacy,
        expectedWorkspace: expected,
      })
    ).toEqual({ eligible: false, continuation: false, directory: expected });
  });

  it('refuses warm while a session snapshot exists', () => {
    expect(
      selectWarmBaseWorkspace({
        currentPath: undefined,
        sessionSlot: 'snap_1',
        hasPreparationHistory: false,
        legacyDirectory: legacy,
        expectedWorkspace: expected,
      })
    ).toEqual({ eligible: false, continuation: false, directory: legacy });
  });

  it('adopts the stable path only for a first, unprepared preparation', () => {
    expect(
      selectWarmBaseWorkspace({
        currentPath: undefined,
        sessionSlot: null,
        hasPreparationHistory: false,
        legacyDirectory: legacy,
        expectedWorkspace: expected,
      })
    ).toEqual({ eligible: true, continuation: false, directory: expected });
  });
});
