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
    ['provider model', 'https://api.kilo.ai/api/openrouter/v1/chat/completions', 'provider_model'],
    [
      'organization models',
      'https://api.kilo.ai/api/organizations/org_1/models',
      'organization_models',
    ],
    ['backend api', 'https://api.kilo.ai/api/users/me', 'backend_api'],
    [
      'session ingest',
      'https://ingest.kilosessions.ai/api/session/kilo-session-1/export',
      'session_ingest',
    ],
    [
      'session ingest upload',
      'https://ingest.kilosessions.ai/api/session/kilo-session-1/ingest',
      'session_ingest',
    ],
  ] as const)('routes %s to the right route class', (_description, requestUrl, routeClass) => {
    expect(classifyKiloCapabilityRequest(requestUrl, targets, kiloSessionId)).toEqual({
      success: true,
      routeClass,
    });
  });

  it('routes a matching session-ingest bootstrap request', () => {
    expect(
      classifyKiloCapabilityRequest(
        'https://ingest.kilosessions.ai/api/session',
        targets,
        kiloSessionId,
        { requestMethod: 'POST', bootstrapKiloSessionId: kiloSessionId }
      )
    ).toEqual({ success: true, routeClass: 'session_ingest' });
  });

  it.each([
    ['another session', 'POST', 'another-kilo-session'],
    ['missing session identity', 'POST', undefined],
    ['wrong method', 'GET', kiloSessionId],
  ] as const)('rejects a session-ingest bootstrap request with %s', (_description, method, id) => {
    expect(
      classifyKiloCapabilityRequest(
        'https://ingest.kilosessions.ai/api/session',
        targets,
        kiloSessionId,
        { requestMethod: method, bootstrapKiloSessionId: id }
      )
    ).toEqual({ success: false, reason: 'upstream_not_allowed' });
  });

  describe('Cloud Agent family proxy', () => {
    const rootSessionId = 'ses_12345678901234567890123456';
    const childSessionId = 'ses_abcdefghijklmnopqrstuvwxyz';

    it('allows canonical child bootstrap for a versioned proxy', () => {
      expect(
        classifyKiloCapabilityRequest(
          'https://ingest.kilosessions.ai/api/session',
          targets,
          rootSessionId,
          {
            requestMethod: 'POST',
            bootstrapKiloSessionId: childSessionId,
            sessionIngestProxyVersion: 1,
          }
        )
      ).toEqual({
        success: true,
        routeClass: 'session_ingest',
        sessionIngestFamilyProxy: true,
      });
    });

    it('allows canonical child ingest for a versioned proxy', () => {
      expect(
        classifyKiloCapabilityRequest(
          `https://ingest.kilosessions.ai/api/session/${childSessionId}/ingest`,
          targets,
          rootSessionId,
          { requestMethod: 'POST', sessionIngestProxyVersion: 1 }
        )
      ).toEqual({
        success: true,
        routeClass: 'session_ingest',
        sessionIngestFamilyProxy: true,
      });
    });

    it.each([
      ['missing proxy version', 'POST', childSessionId, undefined],
      ['wrong bootstrap method', 'GET', childSessionId, 1],
      ['noncanonical child ID', 'POST', 'ses_../../other-session-id', 1],
    ] as const)('rejects child bootstrap with %s', (_description, method, childId, version) => {
      expect(
        classifyKiloCapabilityRequest(
          'https://ingest.kilosessions.ai/api/session',
          targets,
          rootSessionId,
          {
            requestMethod: method,
            bootstrapKiloSessionId: childId,
            sessionIngestProxyVersion: version,
          }
        )
      ).toEqual({ success: false, reason: 'upstream_not_allowed' });
    });

    it.each([
      ['missing proxy version', 'POST', undefined],
      ['wrong method', 'GET', 1],
      ['child export', 'GET', 1],
    ] as const)('rejects child session route with %s', (_description, method, version) => {
      const operation = _description === 'child export' ? 'export' : 'ingest';
      expect(
        classifyKiloCapabilityRequest(
          `https://ingest.kilosessions.ai/api/session/${childSessionId}/${operation}`,
          targets,
          rootSessionId,
          { requestMethod: method, sessionIngestProxyVersion: version }
        )
      ).toEqual({ success: false, reason: 'upstream_not_allowed' });
    });

    it('keeps exact-root export on the legacy route classification', () => {
      expect(
        classifyKiloCapabilityRequest(
          `https://ingest.kilosessions.ai/api/session/${rootSessionId}/export`,
          targets,
          rootSessionId,
          { requestMethod: 'GET', sessionIngestProxyVersion: 1 }
        )
      ).toEqual({ success: true, routeClass: 'session_ingest' });
    });
  });

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

  it('refuses to serve provider routes against the backend when the provider lives elsewhere', () => {
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

  it('fails closed for a non-string request url', () => {
    expect(
      classifyKiloCapabilityRequest(null as unknown as string, targets, kiloSessionId)
    ).toEqual({ success: false, reason: 'invalid_upstream_url' });
  });

  describe('when backend and session ingest share an origin', () => {
    const sharedOriginTargets = {
      backendBaseUrl: 'https://api.kilo.ai',
      providerBaseUrl: 'https://api.kilo.ai/api/openrouter',
      sessionIngestBaseUrl: 'https://api.kilo.ai',
    };
    const prefixedSessionIngestTargets = {
      ...sharedOriginTargets,
      sessionIngestBaseUrl: 'https://api.kilo.ai/ingest',
    };

    it('does not let the backend catch-all shadow another session ingest route', () => {
      expect(
        classifyKiloCapabilityRequest(
          'https://api.kilo.ai/api/session/other-session/export',
          sharedOriginTargets,
          kiloSessionId
        )
      ).toEqual({ success: false, reason: 'upstream_not_allowed' });
    });

    it('still routes the bound session ingest route', () => {
      expect(
        classifyKiloCapabilityRequest(
          `https://api.kilo.ai/api/session/${kiloSessionId}/export`,
          sharedOriginTargets,
          kiloSessionId
        )
      ).toEqual({ success: true, routeClass: 'session_ingest' });
    });

    it('does not let the backend catch-all serve an unbound bootstrap request', () => {
      expect(
        classifyKiloCapabilityRequest(
          'https://api.kilo.ai/api/session',
          sharedOriginTargets,
          kiloSessionId,
          { requestMethod: 'POST' }
        )
      ).toEqual({ success: false, reason: 'upstream_not_allowed' });
    });

    it.each(['export', 'ingest'] as const)(
      'does not let the backend catch-all shadow a prefixed %s route for another session',
      operation => {
        expect(
          classifyKiloCapabilityRequest(
            `https://api.kilo.ai/ingest/api/session/other-session/${operation}`,
            prefixedSessionIngestTargets,
            kiloSessionId
          )
        ).toEqual({ success: false, reason: 'upstream_not_allowed' });
      }
    );
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
