import { describe, expect, it } from 'vitest';

import { CLOUD_AGENT_CONNECTION_ID } from '@/lib/active-sessions-live';
import { captureSessionBaseline, hasNewSession } from './session-detection';

const CLOUD = CLOUD_AGENT_CONNECTION_ID;
const CLI = 'cli-connection-1';

describe('captureSessionBaseline', () => {
  it('collects every session id', () => {
    expect(new Set(captureSessionBaseline([{ id: 'a' }, { id: 'b', connectionId: CLI }]))).toEqual(
      new Set(['a', 'b'])
    );
  });
});

describe('hasNewSession', () => {
  it('returns false for an empty session list', () => {
    expect(hasNewSession({ sessions: [], baselineIds: new Set(), kind: 'cloud' })).toBe(false);
    expect(hasNewSession({ sessions: [], baselineIds: new Set(), kind: 'remote' })).toBe(false);
  });

  it('never counts a session present in the baseline', () => {
    const baselineIds = captureSessionBaseline([{ id: 'old', connectionId: CLOUD }]);

    expect(
      hasNewSession({ sessions: [{ id: 'old', connectionId: CLOUD }], baselineIds, kind: 'cloud' })
    ).toBe(false);
  });

  it('counts a new cloud session only with the cloud sentinel connection id', () => {
    const baselineIds = new Set<string>();

    expect(
      hasNewSession({ sessions: [{ id: 'c', connectionId: CLOUD }], baselineIds, kind: 'cloud' })
    ).toBe(true);
    expect(
      hasNewSession({ sessions: [{ id: 'c', connectionId: CLI }], baselineIds, kind: 'cloud' })
    ).toBe(false);
    expect(hasNewSession({ sessions: [{ id: 'c' }], baselineIds, kind: 'cloud' })).toBe(false);
  });

  it('counts a new remote session only with a real CLI connection id', () => {
    const baselineIds = new Set<string>();

    expect(
      hasNewSession({ sessions: [{ id: 'r', connectionId: CLI }], baselineIds, kind: 'remote' })
    ).toBe(true);
    expect(
      hasNewSession({ sessions: [{ id: 'r', connectionId: CLOUD }], baselineIds, kind: 'remote' })
    ).toBe(false);
    expect(hasNewSession({ sessions: [{ id: 'r' }], baselineIds, kind: 'remote' })).toBe(false);
    expect(
      hasNewSession({ sessions: [{ id: 'r', connectionId: '' }], baselineIds, kind: 'remote' })
    ).toBe(false);
  });

  it('requires a passed connection id to match the remote instance', () => {
    const baselineIds = new Set<string>();
    const sessions = [{ id: 'r', connectionId: CLI }];

    expect(hasNewSession({ sessions, baselineIds, kind: 'remote', connectionId: CLI })).toBe(true);
    expect(hasNewSession({ sessions, baselineIds, kind: 'remote', connectionId: 'other' })).toBe(
      false
    );
  });
});
