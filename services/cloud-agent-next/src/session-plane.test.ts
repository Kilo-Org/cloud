import { describe, expect, it, vi } from 'vitest';
import {
  generateSessionId,
  isCodeReviewControlPlaneOwner,
  isCodeReviewSession,
  isControlPlaneOrigin,
  isControlSession,
  isLegacySession,
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

  it('mints workspace_ for control-plane session origins', () => {
    expect(generateSessionId('legacy').startsWith('agent_')).toBe(true);
    expect(generateSessionId('control').startsWith('workspace_')).toBe(true);
    expect(sessionIdSchema.safeParse(generateSessionId('control')).success).toBe(true);

    for (const createdOnPlatform of [
      'cloud-agent-web',
      'slack',
      'github',
      'linear',
      'discord',
      'security-agent',
      'security-remediation',
      'webhook',
      'scheduled',
    ]) {
      expect(sessionPlaneForNewOwner({}, { userId: 'user-1' }, { createdOnPlatform })).toBe(
        'control'
      );
    }
  });

  it.each([
    undefined,
    '',
    'cloud-agent',
    'auto-triage',
    'autofix',
    'app-builder',
    'cli',
    'code-review',
    'other',
    'unknown',
  ] as const)('keeps non-control-plane origin %s on the legacy plane', createdOnPlatform => {
    expect(
      sessionPlaneForNewOwner(
        {},
        { userId: 'user-1' },
        createdOnPlatform === undefined ? undefined : { createdOnPlatform }
      )
    ).toBe('legacy');
  });

  it('treats only the trusted billing origin as a code-review session', () => {
    expect(isCodeReviewSession({ billingOrigin: 'code-review' })).toBe(true);
    expect(isCodeReviewSession({ createdOnPlatform: 'code-review' })).toBe(false);
    expect(
      isCodeReviewSession({ createdOnPlatform: 'code-review', billingOrigin: 'cloud-agent' })
    ).toBe(false);
    expect(isCodeReviewSession({})).toBe(false);
    expect(isCodeReviewSession()).toBe(false);
  });

  it('routes enrolled code-review owners to the control plane through CODE_REVIEW_CONTROL_PLANE_IDS', () => {
    const origin = { createdOnPlatform: 'code-review', billingOrigin: 'code-review' };
    expect(
      sessionPlaneForNewOwner(
        { CODE_REVIEW_CONTROL_PLANE_IDS: 'user-1' },
        { userId: 'user-1' },
        origin
      )
    ).toBe('control');
    expect(
      sessionPlaneForNewOwner(
        { CODE_REVIEW_CONTROL_PLANE_IDS: 'org-1' },
        { userId: 'user-2', orgId: 'org-1' },
        origin
      )
    ).toBe('control');
    expect(
      sessionPlaneForNewOwner({ CODE_REVIEW_CONTROL_PLANE_IDS: '*' }, { userId: 'user-3' }, origin)
    ).toBe('control');
    expect(
      sessionPlaneForNewOwner(
        { CODE_REVIEW_CONTROL_PLANE_IDS: 'other' },
        { userId: 'user-3' },
        origin
      )
    ).toBe('legacy');
    expect(sessionPlaneForNewOwner({}, { userId: 'user-1' }, origin)).toBe('legacy');
  });

  it('keeps the code-review allowlist independent of interactive control-plane routing', () => {
    const codeReview = { createdOnPlatform: 'code-review', billingOrigin: 'code-review' };
    const web = { createdOnPlatform: 'cloud-agent-web' };

    expect(sessionPlaneForNewOwner({}, { userId: 'user-1' }, codeReview)).toBe('legacy');
    expect(
      sessionPlaneForNewOwner({ CODE_REVIEW_CONTROL_PLANE_IDS: '*' }, { userId: 'user-1' }, web)
    ).toBe('control');
  });

  it('does not route a spoofed code-review platform string to the control plane', () => {
    expect(
      sessionPlaneForNewOwner(
        { CODE_REVIEW_CONTROL_PLANE_IDS: '*' },
        { userId: 'user-1' },
        { createdOnPlatform: 'code-review' }
      )
    ).toBe('legacy');
  });

  it('matches CODE_REVIEW_CONTROL_PLANE_IDS owners the same way as other allowlists', () => {
    expect(
      isCodeReviewControlPlaneOwner(
        { CODE_REVIEW_CONTROL_PLANE_IDS: 'user-1, org-1' },
        { userId: 'user-2', orgId: 'org-1' }
      )
    ).toBe(true);
    expect(
      isCodeReviewControlPlaneOwner(
        { CODE_REVIEW_CONTROL_PLANE_IDS: 'user-1' },
        { userId: 'user-2' }
      )
    ).toBe(false);
    expect(isCodeReviewControlPlaneOwner({}, { userId: 'user-1' })).toBe(false);
  });

  it('recognizes only the control-plane session origins', () => {
    expect(isControlPlaneOrigin({ createdOnPlatform: 'cloud-agent-web' })).toBe(true);
    expect(isControlPlaneOrigin({ createdOnPlatform: 'slack' })).toBe(true);
    expect(isControlPlaneOrigin({ createdOnPlatform: 'webhook' })).toBe(true);
    expect(isControlPlaneOrigin({ createdOnPlatform: 'auto-triage' })).toBe(false);
    expect(isControlPlaneOrigin({})).toBe(false);
    expect(isControlPlaneOrigin()).toBe(false);
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
