import { describe, expect, it } from 'vitest';

import { ProtectedDataUnavailableError } from '@/lib/protected-data';

import { E2eInjectedFaultError } from './e2e-fault';
import { beforeSendScrubbedEvent } from './sentry-before-send';

describe('beforeSendScrubbedEvent', () => {
  it('drops a harness-injected E2E fault instead of filing a product issue', () => {
    const error = new E2eInjectedFaultError(
      'E2E secure-store fault window is open: read of gateway-transcription-model rejected'
    );
    const event = { exception: { values: [{ type: 'Error', value: error.message }] } };

    expect(beforeSendScrubbedEvent(event, { originalException: error })).toBeNull();
  });

  it('drops the fault even when the error reached the hint as a plain error carrying the marker', () => {
    const error = Object.assign(new Error('read rejected'), { name: 'E2eInjectedFaultError' });

    expect(beforeSendScrubbedEvent({ event_id: 'abc' }, { originalException: error })).toBeNull();
  });

  it('drops a keychain call skipped on a locked device', () => {
    const error = new ProtectedDataUnavailableError();

    expect(beforeSendScrubbedEvent({ event_id: 'abc' }, { originalException: error })).toBeNull();
  });

  it('keeps a real error and still scrubs it', () => {
    const error = new Error('keychain unavailable');
    const event = {
      request: { url: 'https://api.example.com/trpc/getUser?input=%7B%22id%22%3A%221%22%7D' },
      extra: { token: 'Bearer abcdefghijklmnopqrstuvwxyz012345' },
    };

    const result = beforeSendScrubbedEvent(event, { originalException: error });

    expect(result).not.toBeNull();
    expect(result?.request.url).toBe('https://api.example.com/trpc/getUser');
    expect(result?.extra.token).toBe('[redacted]');
  });

  it('keeps and scrubs the event when no hint is supplied', () => {
    const event = { request: { url: 'https://api.example.com/page?q=1' } };

    const result = beforeSendScrubbedEvent(event);

    expect(result?.request.url).toBe('https://api.example.com/page');
  });

  describe('App Attest diagnostic', () => {
    /**
     * What the SDK hands `beforeSend` for the App Attest message once it has
     * applied the scope: the app's identity, global tags, breadcrumbs, the
     * network reporter's context and the token POST's own request data.
     */
    function sdkPreparedEvent() {
      return {
        event_id: 'event-1',
        timestamp: 1_700_000_000,
        platform: 'javascript',
        level: 'error',
        release: '1.0.16 (823)',
        dist: '823',
        environment: 'production',
        sdk: { name: 'sentry.javascript.react-native', version: '8.34.0' },
        message: 'App Attest failure',
        tags: {
          'app_attest.step': 'attestKey',
          'app_attest.error_domain': 'DCErrorDomain',
          'app_attest.error_code': 4,
          'app.auth_state': 'signed_in',
          'app.telemetry_mode': 'mandatory',
        },
        user: { id: 'user-1', email: 'person@example.com', ip_address: '203.0.113.9' },
        request: {
          url: 'https://api.kilo.ai/api/auth/native/token',
          headers: { authorization: 'Bearer token-value' },
          data: { admission: { challenge: 'challenge-value', keyId: 'key-value' } },
        },
        breadcrumbs: [{ category: 'http', message: 'POST admission-challenge' }],
        contexts: {
          device: { model: 'iPhone16,1', name: 'iPhone' },
          app: { app_version: '1.0.16', build: '823' },
        },
        extra: { keyId: 'key-value' },
        exception: { values: [{ type: 'Error', value: 'Server unavailable' }] },
      };
    }

    it('projects the SDK-prepared event to its allowlisted fields', () => {
      const result = beforeSendScrubbedEvent(sdkPreparedEvent());

      expect(result).toEqual({
        event_id: 'event-1',
        timestamp: 1_700_000_000,
        platform: 'javascript',
        level: 'error',
        release: '1.0.16 (823)',
        dist: '823',
        environment: 'production',
        sdk: { name: 'sentry.javascript.react-native', version: '8.34.0' },
        message: 'App Attest failure',
        tags: {
          'app_attest.step': 'attestKey',
          'app_attest.error_domain': 'DCErrorDomain',
          'app_attest.error_code': 4,
        },
      });
    });

    it('cannot forward SDK context, identity, breadcrumbs or request data', () => {
      const result = beforeSendScrubbedEvent(sdkPreparedEvent());
      const text = JSON.stringify(result);

      for (const forbidden of [
        'person@example.com',
        'user-1',
        '203.0.113.9',
        'token-value',
        'challenge-value',
        'key-value',
        'iPhone16,1',
        'admission-challenge',
        'signed_in',
        'Server unavailable',
      ]) {
        expect(text).not.toContain(forbidden);
      }
    });

    it('drops the event when its tags are not a producer shape', () => {
      const event = {
        message: 'App Attest failure',
        tags: { 'app_attest.step': 'generateKey', 'app_attest.error_domain': 'DCErrorDomain' },
      };

      expect(beforeSendScrubbedEvent(event)).toBeNull();
    });

    it('projects by the fixed message, not by its tag set', () => {
      // The scope adds tags of its own. A tag-set discriminator would miss the
      // diagnostic here and let the general scrub keep `user` and `contexts`.
      const event = {
        ...sdkPreparedEvent(),
        tags: { 'app_attest.step': 'attestKey', 'app.auth_state': 'signed_in' },
      };

      const result = beforeSendScrubbedEvent(event);

      expect(result).not.toBeNull();
      expect(result).not.toHaveProperty('user');
      expect(result).not.toHaveProperty('contexts');
      expect(result?.tags).toEqual({ 'app_attest.step': 'attestKey' });
    });

    it('leaves an unrelated error event on the ordinary scrub path', () => {
      const event = {
        message: 'Something else',
        tags: { 'app_attest.step': 'generateKey' },
        extra: { token: 'Bearer abcdefghijklmnopqrstuvwxyz012345' },
      };

      const result = beforeSendScrubbedEvent(event);

      expect(result?.extra.token).toBe('[redacted]');
    });
  });
});
