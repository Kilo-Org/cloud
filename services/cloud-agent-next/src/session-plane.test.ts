import { describe, expect, it } from 'vitest';
import {
  generateSessionId,
  isControlPlaneOwner,
  isControlPlaneSessionOrigin,
  isWorktreeOwner,
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

  it('mints workspace_ for enrolled Code Reviewer runs', () => {
    const codeReview = { createdOnPlatform: 'code-review' };
    expect(
      sessionPlaneForNewOwner({ CONTROL_PLANE_IDS: 'user-1' }, { userId: 'user-1' }, codeReview)
    ).toBe('control');
    expect(
      sessionPlaneForNewOwner(
        { CONTROL_PLANE_IDS: 'org-1' },
        { userId: 'user-2', orgId: 'org-1' },
        codeReview
      )
    ).toBe('control');
    expect(sessionPlaneForNewOwner({}, { userId: 'user-1' }, codeReview)).toBe('legacy');
    expect(
      sessionPlaneForNewOwner({ CONTROL_PLANE_IDS: 'other' }, { userId: 'user-1' }, codeReview)
    ).toBe('legacy');
  });

  it.each([undefined, '', 'cloud-agent', 'slack', 'scheduled', 'webhook'] as const)(
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

  it('admits cloud-agent-web and code-review as control-plane origins', () => {
    expect(isControlPlaneSessionOrigin({ createdOnPlatform: 'cloud-agent-web' })).toBe(true);
    expect(isControlPlaneSessionOrigin({ createdOnPlatform: 'code-review' })).toBe(true);
    expect(isControlPlaneSessionOrigin({ createdOnPlatform: 'slack' })).toBe(false);
    expect(isControlPlaneSessionOrigin({})).toBe(false);
    expect(isControlPlaneSessionOrigin()).toBe(false);
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
