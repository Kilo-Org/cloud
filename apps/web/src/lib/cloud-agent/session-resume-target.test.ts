import { sessionResumeHref, sessionResumeRefusal } from './session-resume-target';

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
