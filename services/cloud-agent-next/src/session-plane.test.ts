import { describe, expect, it, vi } from 'vitest';
import {
  generateSessionId,
  isControlPlaneOwner,
  isControlSession,
  isInteractiveWebSession,
  isLegacySession,
  isWorktreeOwner,
  sessionDoName,
  sessionFor,
  sessionIdFromDoName,
  sessionPlaneForNewOwner,
  sessionPlaneFromId,
  sessionSupportsTerminal,
} from './session-plane.js';
import { PROVIDER_CAPABILITIES, sessionHasTerminal } from './agent-sandbox/capabilities.js';
import { SESSION_ID_RE } from './shared/protocol.js';
import { sessionIdSchema } from './types.js';

describe('session plane identity', () => {
  it('classifies workspace_ as control and everything else as legacy', () => {
    expect(sessionPlaneFromId('workspace_12345678-1234-1234-1234-123456789abc')).toBe('control');
    expect(sessionPlaneFromId('agent_12345678-1234-1234-1234-123456789abc')).toBe('legacy');
    expect(sessionPlaneFromId('agent2_12345678-1234-1234-1234-123456789abc')).toBe('legacy');
  });

  it('exposes thin plane predicates over sessionPlaneFromId', () => {
    const control = 'workspace_12345678-1234-1234-1234-123456789abc';
    const legacy = 'agent_12345678-1234-1234-1234-123456789abc';

    expect(isControlSession(control)).toBe(true);
    expect(isControlSession(legacy)).toBe(false);
    expect(isLegacySession(legacy)).toBe(true);
    expect(isLegacySession(control)).toBe(false);
    // A non-`workspace_` id is legacy even when it is not a valid `agent_` id.
    expect(isLegacySession('agent2_12345678-1234-1234-1234-123456789abc')).toBe(true);
    expect(isControlSession('agent2_12345678-1234-1234-1234-123456789abc')).toBe(false);
  });

  it('accepts agent_ and workspace_ session IDs and rejects agent2_', () => {
    expect(SESSION_ID_RE.test('agent_12345678-1234-1234-1234-123456789abc')).toBe(true);
    expect(SESSION_ID_RE.test('workspace_12345678-1234-1234-1234-123456789abc')).toBe(true);
    expect(SESSION_ID_RE.test('agent2_12345678-1234-1234-1234-123456789abc')).toBe(false);
    expect(SESSION_ID_RE.test('Workspace_12345678-1234-1234-1234-123456789abc')).toBe(false);
    expect(
      sessionIdSchema.safeParse('workspace_12345678-1234-1234-1234-123456789abc').success
    ).toBe(true);
    expect(sessionIdSchema.safeParse('agent2_12345678-1234-1234-1234-123456789abc').success).toBe(
      false
    );
  });

  it('names a Session DO as ownerId:sessionId and recovers the bare session id', () => {
    const sessionId = 'workspace_12345678-1234-1234-1234-123456789abc';
    expect(sessionDoName('user-1', sessionId)).toBe(`user-1:${sessionId}`);
    expect(sessionIdFromDoName(`user-1:${sessionId}`)).toBe(sessionId);
    // `ownerId` may contain colons, so the split is on the last one.
    expect(sessionIdFromDoName(`oauth/google:12345:${sessionId}`)).toBe(sessionId);
    expect(sessionIdFromDoName(sessionId)).toBe(sessionId);
  });

  it('mints workspace_ only for allowlisted interactive web sessions', () => {
    const web = { createdOnPlatform: 'cloud-agent-web' };
    expect(generateSessionId('legacy').startsWith('agent_')).toBe(true);
    expect(generateSessionId('control').startsWith('workspace_')).toBe(true);
    expect(sessionIdSchema.safeParse(generateSessionId('control')).success).toBe(true);
    expect(
      sessionPlaneForNewOwner({ CONTROL_PLANE_IDS: 'user-1' }, { userId: 'user-1' }, web)
    ).toBe('control');
    expect(
      sessionPlaneForNewOwner(
        { CONTROL_PLANE_IDS: 'org-1' },
        { userId: 'user-2', orgId: 'org-1' },
        web
      )
    ).toBe('control');
    expect(sessionPlaneForNewOwner({ CONTROL_PLANE_IDS: '*' }, { userId: 'user-3' }, web)).toBe(
      'control'
    );
    expect(sessionPlaneForNewOwner({}, { userId: 'user-1', orgId: 'org-1' }, web)).toBe('legacy');
    expect(isControlPlaneOwner({ CONTROL_PLANE_IDS: 'user-1' }, { userId: 'user-2' })).toBe(false);
  });

  it.each([undefined, '', 'cloud-agent', 'slack', 'scheduled', 'code-review', 'webhook'] as const)(
    'keeps enrolled owners on agent_ for non-interactive origin %s',
    createdOnPlatform => {
      expect(
        sessionPlaneForNewOwner(
          { CONTROL_PLANE_IDS: '*' },
          { userId: 'user-1' },
          createdOnPlatform === undefined ? undefined : { createdOnPlatform }
        )
      ).toBe('legacy');
    }
  );

  it('treats only cloud-agent-web as an interactive web session', () => {
    expect(isInteractiveWebSession({ createdOnPlatform: 'cloud-agent-web' })).toBe(true);
    expect(isInteractiveWebSession({ createdOnPlatform: 'slack' })).toBe(false);
    expect(isInteractiveWebSession({})).toBe(false);
    expect(isInteractiveWebSession()).toBe(false);
  });

  it.each([
    [undefined, { userId: 'user-1' }, false],
    ['', { userId: 'user-1' }, false],
    [' , ', { userId: 'user-1' }, false],
    ['user-1', { userId: 'user-1' }, true],
    ['user-1', { userId: 'user-2' }, false],
    ['org-1', { userId: 'user-2', orgId: 'org-1' }, true],
    ['org-1', { userId: 'user-2' }, false],
    [' other, org-1, ', { userId: 'user-2', orgId: 'org-1' }, true],
    ['*', { userId: 'user-3' }, true],
    [' oauth/google:1234 ', { userId: 'oauth/google:1234' }, true],
  ] as const)(
    'matches WORKTREE_CREATION_ENABLED_IDS=%s against %j as %s',
    (ids, owner, expected) => {
      expect(isWorktreeOwner({ WORKTREE_CREATION_ENABLED_IDS: ids }, owner)).toBe(expected);
    }
  );

  it('keeps worktree enrollment independent of control-plane routing', () => {
    const owner = { userId: 'user-1' };
    const web = { createdOnPlatform: 'cloud-agent-web' };
    const controlOnly = { CONTROL_PLANE_IDS: '*', WORKTREE_CREATION_ENABLED_IDS: '' };
    const worktreeOnly = { CONTROL_PLANE_IDS: '', WORKTREE_CREATION_ENABLED_IDS: '*' };

    expect(sessionPlaneForNewOwner(controlOnly, owner, web)).toBe('control');
    expect(isWorktreeOwner(controlOnly, owner)).toBe(false);
    expect(sessionPlaneForNewOwner(worktreeOnly, owner, web)).toBe('legacy');
    expect(isWorktreeOwner(worktreeOnly, owner)).toBe(true);
  });

  it('supports control-plane terminals independently of legacy provider capabilities', () => {
    const legacySessionId = 'agent_12345678-1234-1234-1234-123456789abc';
    const controlSessionId = 'workspace_12345678-1234-1234-1234-123456789abc';

    expect(sessionSupportsTerminal(legacySessionId)).toBe(true);
    expect(sessionSupportsTerminal(controlSessionId)).toBe(true);
    expect(sessionHasTerminal(controlSessionId, 'cloudflare')).toBe(true);
    expect(sessionHasTerminal(controlSessionId, 'vercel')).toBe(true);
    expect(sessionHasTerminal(legacySessionId, 'cloudflare')).toBe(true);
    expect(sessionHasTerminal(legacySessionId, 'vercel')).toBe(false);
    expect(PROVIDER_CAPABILITIES.vercel.terminal).toBe(false);
  });
});

describe('sessionFor', () => {
  const controlSessionId = 'workspace_12345678-1234-1234-1234-123456789abc';
  const legacySessionId = 'agent_12345678-1234-1234-1234-123456789abc';

  it('routes a control session to the control branch and a legacy session to the legacy branch', () => {
    const control = vi.fn(() => 'control');
    const legacy = vi.fn(() => 'legacy');

    expect(sessionFor(controlSessionId, control, legacy)).toBe('control');
    expect(sessionFor(legacySessionId, control, legacy)).toBe('legacy');
    expect(control).toHaveBeenCalledTimes(1);
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it('resolves a factory that builds a fresh stub on every call, which withDORetry relies on', () => {
    const control = vi.fn(() => ({ stub: 'control' }));
    const legacy = vi.fn(() => ({ stub: 'legacy' }));
    const getStub = sessionFor(
      controlSessionId,
      () => control,
      () => legacy
    );

    const first = getStub();
    const second = getStub();

    expect(control).toHaveBeenCalledTimes(2);
    expect(legacy).not.toHaveBeenCalled();
    expect(first).not.toBe(second);
  });
});
