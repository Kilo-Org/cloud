import { describe, expect, it, vi } from 'vitest';
import {
  generateSessionId,
  isControlSession,
  isCodeReviewContainersOwner,
  isPreviewOwner,
  requiredProviderCapability,
  sessionDoName,
  sessionIdFromDoName,
} from './session-identity.js';
import { sessionIdSchema } from './types.js';
import { SESSION_ID_RE } from './shared/protocol.js';
import { getSandboxSessionStub } from './sandbox-session/session-stub.js';
import type { SessionStubEnv } from './sandbox-session/session-stub.js';

const sessionId = 'workspace_12345678-1234-1234-1234-123456789abc';

describe('session identity', () => {
  it('keeps code-review provider enrollment independent of session identity', () => {
    expect(isCodeReviewContainersOwner({}, { userId: 'user' })).toBe(false);
    expect(
      isCodeReviewContainersOwner({ CODE_REVIEW_CONTAINERS_ORG_IDS: 'user' }, { userId: 'user' })
    ).toBe(true);
    expect(
      isCodeReviewContainersOwner(
        { CODE_REVIEW_CONTAINERS_ORG_IDS: 'other, org' },
        { userId: 'user', orgId: 'org' }
      )
    ).toBe(true);
    expect(
      isCodeReviewContainersOwner({ CODE_REVIEW_CONTAINERS_ORG_IDS: '*' }, { userId: 'user' })
    ).toBe(true);
    expect(
      isCodeReviewContainersOwner({ CODE_REVIEW_CONTAINERS_ORG_IDS: 'other' }, { userId: 'user' })
    ).toBe(false);
    expect(isControlSession(generateSessionId())).toBe(true);
  });

  it('generates only workspace IDs accepted by the public and wrapper contracts', () => {
    const generated = generateSessionId();
    expect(generated).toMatch(/^workspace_/);
    expect(isControlSession(generated)).toBe(true);
    expect(sessionIdSchema.parse(generated)).toBe(generated);
    expect(SESSION_ID_RE.test(generated)).toBe(true);
  });

  it.each(['agent', 'agent2', 'sess'])(
    'rejects the retired %s namespace before DO resolution',
    prefix => {
      const retiredId = `${prefix}_12345678-1234-1234-1234-123456789abc`;
      const idFromName = vi.fn();
      const get = vi.fn();
      const env = { SANDBOX_SESSION: { idFromName, get } } as unknown as SessionStubEnv;
      expect(isControlSession(retiredId)).toBe(false);
      expect(sessionIdSchema.safeParse(retiredId).success).toBe(false);
      expect(SESSION_ID_RE.test(retiredId)).toBe(false);
      expect(() => getSandboxSessionStub(env, 'owner', retiredId)).toThrow('Session not found');
      expect(idFromName).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    }
  );

  it('preserves an owner containing colons when naming and reading the Session DO', () => {
    const name = sessionDoName('oauth/google:12345', sessionId);
    expect(name).toBe(`oauth/google:12345:${sessionId}`);
    expect(sessionIdFromDoName(name)).toBe(sessionId);
    expect(sessionIdFromDoName(sessionId)).toBe(sessionId);
  });

  it('keeps review and remediation capabilities independent of session routing', () => {
    expect(requiredProviderCapability({ billingOrigin: 'code-review' })).toBe('review');
    expect(requiredProviderCapability({ createdOnPlatform: 'code-review' })).toBe('review');
    expect(
      requiredProviderCapability({
        createdOnPlatform: 'security-remediation',
        billingOrigin: 'cloud-agent',
      })
    ).toBe('remediation');
    expect(requiredProviderCapability({ createdOnPlatform: 'app-builder' })).toBeUndefined();
    expect(requiredProviderCapability()).toBeUndefined();
  });

  it('keeps preview enrollment as an independent UI setting', () => {
    expect(isPreviewOwner({}, { userId: 'user' })).toBe(false);
    expect(isPreviewOwner({ PREVIEW_ENABLED_IDS: '*' }, { userId: 'user' })).toBe(true);
    expect(
      isPreviewOwner({ PREVIEW_ENABLED_IDS: 'other, org' }, { userId: 'user', orgId: 'org' })
    ).toBe(true);
    expect(isPreviewOwner({ PREVIEW_ENABLED_IDS: 'other' }, { userId: 'user' })).toBe(false);
  });
});
