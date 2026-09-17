import { isValidCallbackPath } from '@/lib/getSignInCallbackUrl';
import { webPathToAppPath } from '@kilocode/app-shared/universal-links';
import {
  SESSION_RESUME_REFUSAL_HREF,
  sessionResumeHref,
  sessionResumeNeedsSignIn,
  sessionResumeRefusal,
  sessionResumeSignInPath,
} from '@/lib/cloud-agent/session-resume-target';

describe('SESSION_RESUME_REFUSAL_HREF', () => {
  it('sends a refused reader to the sessions list, not a dead end', () => {
    expect(SESSION_RESUME_REFUSAL_HREF).toBe('/cloud/sessions');
    // The destination is a claimed route: the table the app's universal links
    // compile from resolves it, so the refusal's control cannot point at a path
    // the router does not serve.
    expect(webPathToAppPath(SESSION_RESUME_REFUSAL_HREF)).toBe('/(app)/(tabs)/(2_agents)');
  });
});

describe('sessionResumeRefusal', () => {
  it('refuses a removed session as Not found', () => {
    expect(sessionResumeRefusal('NOT_FOUND')).toEqual({
      heading: 'Not found',
      message: 'This item may have been removed or is no longer available.',
    });
  });

  it('refuses an inaccessible session as Access denied', () => {
    expect(sessionResumeRefusal('UNAUTHORIZED')).toEqual({
      heading: 'Access denied',
      message: "You don't have permission to view this.",
    });
    expect(sessionResumeRefusal('FORBIDDEN')).toEqual({
      heading: 'Access denied',
      message: "You don't have permission to view this.",
    });
  });

  it('is not a refusal for a code the gate should retry', () => {
    expect(sessionResumeRefusal('INTERNAL_SERVER_ERROR')).toBeNull();
    expect(sessionResumeRefusal('TIMEOUT')).toBeNull();
    expect(sessionResumeRefusal(undefined)).toBeNull();
    expect(sessionResumeRefusal(null)).toBeNull();
  });
});

describe('sessionResumeNeedsSignIn', () => {
  it('treats a context auth failure as recoverable sign-in, not a denial', () => {
    expect(sessionResumeNeedsSignIn({ data: { authRequired: true } })).toBe(true);
  });

  it('does not treat a session-access denial as sign-in', () => {
    // A procedure-level UNAUTHORIZED (another account's session, lost org
    // membership) has no `authRequired`: it is the permanent denial the gate
    // renders, and signing in again would not change it.
    expect(sessionResumeNeedsSignIn({ data: { code: 'UNAUTHORIZED' } })).toBe(false);
    expect(sessionResumeNeedsSignIn({ data: { authRequired: false } })).toBe(false);
  });

  it('is false for a missing error', () => {
    expect(sessionResumeNeedsSignIn(null)).toBe(false);
    expect(sessionResumeNeedsSignIn(undefined)).toBe(false);
    expect(sessionResumeNeedsSignIn({})).toBe(false);
  });
});

describe('sessionResumeHref', () => {
  it('targets the organization chat for an organization session', () => {
    expect(
      sessionResumeHref({ session_id: 'ses_123', organization_id: 'org_456' }, 'msg_789')
    ).toBe('/organizations/org_456/cloud/chat?sessionId=ses_123&at=msg_789');
  });

  it('targets the personal chat for a personal session', () => {
    expect(sessionResumeHref({ session_id: 'ses_123', organization_id: null }, 'msg_789')).toBe(
      '/cloud/chat?sessionId=ses_123&at=msg_789'
    );
    expect(sessionResumeHref({ session_id: 'ses_123' }, 'msg_789')).toBe(
      '/cloud/chat?sessionId=ses_123&at=msg_789'
    );
  });

  it('preserves the anchor when present and omits it when absent', () => {
    expect(sessionResumeHref({ session_id: 'ses_123' }, 'msg_789')).toContain('at=msg_789');
    expect(sessionResumeHref({ session_id: 'ses_123' }, null)).toBe(
      '/cloud/chat?sessionId=ses_123'
    );
    expect(sessionResumeHref({ session_id: 'ses_123' }, undefined)).toBe(
      '/cloud/chat?sessionId=ses_123'
    );
    expect(sessionResumeHref({ session_id: 'ses_123' }, '')).toBe('/cloud/chat?sessionId=ses_123');
  });

  it('encodes the session id and the anchor', () => {
    expect(sessionResumeHref({ session_id: 'ses 1', organization_id: 'org/1' }, 'msg 9')).toBe(
      '/organizations/org%2F1/cloud/chat?sessionId=ses%201&at=msg%209'
    );
  });
});

/** The `callbackPath` the sign-in URL carries, decoded the way the app reads it. */
function decodedCallbackPath(signInPath: string): string {
  return (
    new URLSearchParams(signInPath.slice(signInPath.indexOf('?') + 1)).get('callbackPath') ?? ''
  );
}

describe('sessionResumeSignInPath', () => {
  it('sends the session path as the callbackPath when there is no anchor', () => {
    expect(sessionResumeSignInPath('ses_1', null)).toBe(
      '/users/sign_in?callbackPath=%2Fcloud%2Fsessions%2Fses_1'
    );
    expect(sessionResumeSignInPath('ses_1', undefined)).toBe(
      '/users/sign_in?callbackPath=%2Fcloud%2Fsessions%2Fses_1'
    );
  });

  it('carries the anchor inside the same callbackPath, encoded once', () => {
    const signInPath = sessionResumeSignInPath('ses_1', 'msg_2');
    expect(decodedCallbackPath(signInPath)).toBe('/cloud/sessions/ses_1?at=msg_2');
    expect(signInPath).toBe('/users/sign_in?callbackPath=%2Fcloud%2Fsessions%2Fses_1%3Fat%3Dmsg_2');
    expect(signInPath).not.toContain('%25');
  });

  it('adds no at for an empty-string anchor', () => {
    const signInPath = sessionResumeSignInPath('ses_1', '');
    expect(decodedCallbackPath(signInPath)).toBe('/cloud/sessions/ses_1');
    expect(signInPath).not.toContain('at=');
  });

  it('stays inside the callback-path family sign-in accepts', () => {
    for (const anchor of [null, undefined, '', 'msg_2']) {
      const decoded = decodedCallbackPath(sessionResumeSignInPath('ses_1', anchor));
      expect(isValidCallbackPath(decoded)).toBe(true);
    }
  });
});
