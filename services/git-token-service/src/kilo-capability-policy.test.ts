import { describe, expect, it } from 'vitest';
import {
  areValidKiloCapabilityTargets,
  classifyKiloCapabilityRequest,
} from './kilo-capability-policy.js';

const targets = {
  backendBaseUrl: 'https://api.kilo.ai',
  providerBaseUrl: 'https://api.kilo.ai',
  sessionIngestBaseUrl: 'https://ingest.kilosessions.ai',
};

describe('classifyKiloCapabilityRequest', () => {
  const kiloSessionId = 'kilo-session-1';

  it.each([
    [
      'provider model',
      'https://api.kilo.ai/api/openrouter/v1/chat/completions',
      'provider_model',
      'provider',
    ],
    [
      'organization models',
      'https://api.kilo.ai/api/organizations/org_1/models',
      'organization_models',
      'provider',
    ],
    ['backend api', 'https://api.kilo.ai/api/users/me', 'backend_api', 'user'],
    [
      'session ingest',
      'https://ingest.kilosessions.ai/api/session/kilo-session-1/export',
      'session_ingest',
      'user',
    ],
  ] as const)(
    'routes %s with the right credential',
    (_description, requestUrl, routeClass, credential) => {
      expect(classifyKiloCapabilityRequest(requestUrl, targets, kiloSessionId)).toEqual({
        success: true,
        routeClass,
        credential,
      });
    }
  );

  it('allows percent-encoded characters in the query string', () => {
    expect(
      classifyKiloCapabilityRequest(
        'https://api.kilo.ai/api/openrouter/v1/chat?redirect=%2Ffoo&ref=a%2Fb',
        targets,
        kiloSessionId
      )
    ).toMatchObject({ success: true, routeClass: 'provider_model' });
  });

  it.each([
    ['encoded slash in path', 'https://api.kilo.ai/api/openrouter%2fsecret'],
    ['encoded traversal in path', 'https://api.kilo.ai/api/openrouter/%2e%2e/secret'],
    ['userinfo', 'https://user@api.kilo.ai/api/users/me'],
    ['disallowed origin', 'https://evil.example.com/api/users/me'],
    ['plain http production host', 'http://api.kilo.ai/api/users/me'],
    ['different session ingest route', 'https://ingest.kilosessions.ai/api/session/other/export'],
    ['unscoped session ingest route', 'https://ingest.kilosessions.ai/sessions/s1/logs'],
  ] as const)('rejects %s', (_description, requestUrl) => {
    expect(classifyKiloCapabilityRequest(requestUrl, targets, kiloSessionId).success).toBe(false);
  });

  it('refuses to serve provider routes with the user credential when the provider lives elsewhere', () => {
    expect(
      classifyKiloCapabilityRequest(
        'https://api.kilo.ai/api/openrouter/v1/chat',
        {
          ...targets,
          providerBaseUrl: 'https://provider.kilo.ai',
        },
        kiloSessionId
      )
    ).toEqual({ success: false, reason: 'upstream_not_allowed' });
  });
});

describe('areValidKiloCapabilityTargets', () => {
  it('accepts well-formed https targets', () => {
    expect(areValidKiloCapabilityTargets(targets)).toBe(true);
  });

  it('rejects a target carrying userinfo', () => {
    expect(
      areValidKiloCapabilityTargets({
        ...targets,
        backendBaseUrl: 'https://user@api.kilo.ai',
      })
    ).toBe(false);
  });
});
