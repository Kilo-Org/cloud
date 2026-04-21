import { GOOGLE_CAPABILITY } from './capabilities';
import { createGoogleOAuthState, verifyGoogleOAuthState } from './oauth-state';

describe('google oauth state', () => {
  test('round-trips payload and user binding', () => {
    const state = createGoogleOAuthState(
      {
        owner: { type: 'org', id: '4f17f611-3021-495d-98fd-6eb53de9adf5' },
        instanceId: 'bcab9f2b-968f-43f4-8254-668212e04031',
        capabilities: [GOOGLE_CAPABILITY.CALENDAR_READ, GOOGLE_CAPABILITY.GMAIL_READ],
      },
      'user_123'
    );

    expect(verifyGoogleOAuthState(state)).toEqual({
      owner: { type: 'org', id: '4f17f611-3021-495d-98fd-6eb53de9adf5' },
      instanceId: 'bcab9f2b-968f-43f4-8254-668212e04031',
      capabilities: [GOOGLE_CAPABILITY.CALENDAR_READ, GOOGLE_CAPABILITY.GMAIL_READ],
      userId: 'user_123',
    });
  });

  test('rejects tampered state', () => {
    const state = createGoogleOAuthState(
      {
        owner: { type: 'user', id: 'user_abc' },
        instanceId: 'bcab9f2b-968f-43f4-8254-668212e04031',
        capabilities: [GOOGLE_CAPABILITY.CALENDAR_READ],
      },
      'user_abc'
    );

    const tampered = `${state.slice(0, -1)}x`;
    expect(verifyGoogleOAuthState(tampered)).toBeNull();
  });

  test('rejects non-google signed state payload', () => {
    // This string is a syntactically valid signed state format but not the google-prefixed payload.
    // We only validate google-specific state envelopes in this module.
    expect(verifyGoogleOAuthState('eyJvd25lciI6InVzZXJfMSJ9.signature')).toBeNull();
  });
});
