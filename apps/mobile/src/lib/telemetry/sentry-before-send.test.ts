import { describe, expect, it } from 'vitest';

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
});
