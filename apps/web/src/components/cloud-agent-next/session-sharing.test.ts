import { getSessionSharingDisabledReason } from './session-sharing';

const cloudSession = {
  kiloSessionId: 'ses_synthetic',
  cloudAgentSessionId: 'workspace_synthetic',
  isError: false,
};

describe('session sharing availability', () => {
  it('disables native v2 sharing even if a later refresh fails', () => {
    for (const isError of [false, true]) {
      expect(
        getSessionSharingDisabledReason({
          ...cloudSession,
          history: { source: { version: 'v2' } },
          isError,
        })
      ).toBe('Sharing is not available for Kilo v2 sessions.');
    }
  });

  it('keeps v1 sharing available, including legacy pages without a source field', () => {
    for (const history of [{ source: { version: 'v1' as const } }, {}]) {
      expect(getSessionSharingDisabledReason({ ...cloudSession, history })).toBeUndefined();
    }
  });

  it('waits for the session source before allowing sharing', () => {
    expect(getSessionSharingDisabledReason(cloudSession)).toBe(
      'Checking session sharing availability…'
    );
  });

  it('does not enable sharing when history is missing or unavailable', () => {
    for (const state of [{ history: null }, { isError: true }, { history: {}, isError: true }]) {
      expect(getSessionSharingDisabledReason({ ...cloudSession, ...state })).toContain(
        'could not be checked'
      );
    }
  });

  it('preserves sharing for CLI and retired Cloud Agent sessions', () => {
    for (const cloudAgentSessionId of [undefined, null, 'agent_synthetic']) {
      expect(
        getSessionSharingDisabledReason({ ...cloudSession, cloudAgentSessionId })
      ).toBeUndefined();
    }
  });

  it('disables sharing before the native session ID is available', () => {
    expect(getSessionSharingDisabledReason({ ...cloudSession, kiloSessionId: undefined })).toBe(
      'Session ID not available yet.'
    );
  });
});
