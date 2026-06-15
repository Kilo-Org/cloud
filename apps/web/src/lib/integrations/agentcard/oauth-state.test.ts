import { createAgentCardOAuthState, verifyAgentCardOAuthState } from './oauth-state';

const CODE_VERIFIER = 'a'.repeat(64);

describe('agentcard oauth state', () => {
  test('round-trips payload and user binding', () => {
    const state = createAgentCardOAuthState(
      {
        owner: { type: 'org', id: '4f17f611-3021-495d-98fd-6eb53de9adf5' },
        instanceId: 'bcab9f2b-968f-43f4-8254-668212e04031',
        clientId: '62e42803-614d-40ea-a60c-e59db970380a',
        codeVerifier: CODE_VERIFIER,
        returnTo: '/claw/settings',
      },
      'user_123'
    );

    expect(verifyAgentCardOAuthState(state)).toEqual({
      owner: { type: 'org', id: '4f17f611-3021-495d-98fd-6eb53de9adf5' },
      instanceId: 'bcab9f2b-968f-43f4-8254-668212e04031',
      clientId: '62e42803-614d-40ea-a60c-e59db970380a',
      codeVerifier: CODE_VERIFIER,
      returnTo: '/claw/settings',
      userId: 'user_123',
    });
  });

  test('rejects tampered state', () => {
    const state = createAgentCardOAuthState(
      {
        owner: { type: 'user', id: 'user_abc' },
        instanceId: 'bcab9f2b-968f-43f4-8254-668212e04031',
        clientId: 'client_1',
        codeVerifier: CODE_VERIFIER,
      },
      'user_abc'
    );

    const tampered = `${state.slice(0, -1)}x`;
    expect(verifyAgentCardOAuthState(tampered)).toBeNull();
  });

  test('rejects non-agentcard signed state payload', () => {
    expect(verifyAgentCardOAuthState('eyJvd25lciI6InVzZXJfMSJ9.signature')).toBeNull();
  });

  test('rejects an unsafe returnTo (open redirect)', () => {
    // Build a payload with a protocol-relative returnTo and confirm the schema
    // refinement rejects it on verify.
    const state = createAgentCardOAuthState(
      {
        owner: { type: 'user', id: 'user_abc' },
        instanceId: 'bcab9f2b-968f-43f4-8254-668212e04031',
        clientId: 'client_1',
        codeVerifier: CODE_VERIFIER,
        // create-time does not validate returnTo; verify-time zod refinement must reject it
        returnTo: '//evil.example.com',
      },
      'user_abc'
    );
    expect(verifyAgentCardOAuthState(state)).toBeNull();
  });
});
