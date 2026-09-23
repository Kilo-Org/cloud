import { describe, expect, it } from 'vitest';

import { FINGERPRINT_MESSAGE_LIMIT, scrubEvent } from './sentry-scrub';

// An event shape as the SDK builds it for one captured exception: the
// exception class and message plus the capture options the sink passes.
type FallbackEvent = {
  message?: string;
  fingerprint?: string[];
  exception: { values: { type?: string; value?: string }[] };
};

function unhandledError(value: string): FallbackEvent {
  return { exception: { values: [{ type: 'Error', value }] } };
}

describe('scrubEvent fingerprint fallback', () => {
  it('keys an un-fingerprinted event on its class and message, not the worktree path', () => {
    const first = scrubEvent(
      unhandledError(
        'Error: fetch failed at /home/ci/worktrees/a1/apps/mobile/node_modules/expo-modules-core/build/ExpoFetch.ts:12:3'
      )
    );
    const second = scrubEvent(
      unhandledError(
        'Error: fetch failed at /home/ci/worktrees/b2/apps/mobile/node_modules/expo-modules-core/build/ExpoFetch.ts:12:3'
      )
    );

    expect(first.fingerprint).toEqual(second.fingerprint);
    expect(first.fingerprint).toEqual(['Error', 'Error: fetch failed at <path>']);
  });

  it('keys an unhandled native failure on host and port', () => {
    const first = scrubEvent(
      unhandledError(
        'Error: fetch failed: java.net.ConnectException: Failed to connect to /127.0.0.1:10416'
      )
    );
    const second = scrubEvent(
      unhandledError(
        'Error: fetch failed: java.net.ConnectException: Failed to connect to /10.0.2.2:8080'
      )
    );

    expect(first.fingerprint).toEqual(second.fingerprint);
    expect(first.fingerprint).toEqual([
      'Error',
      'Error: fetch failed: java.net.ConnectException: Failed to connect to <host>',
    ]);
  });

  it('strips a URL origin to a placeholder', () => {
    const event = unhandledError('Upload to https://api.example.com:8443/api/attachments failed');

    expect(scrubEvent(event).fingerprint).toEqual(['Error', 'Upload to <host><path> failed']);
  });

  it('keeps an app-set fingerprint', () => {
    const event: FallbackEvent = {
      fingerprint: ['network-error', 'fetch', '/v1/latency', 'http.401'],
      exception: { values: [{ type: 'NetworkError', value: 'POST /v1/latency -> 401' }] },
    };

    expect(scrubEvent(event).fingerprint).toEqual([
      'network-error',
      'fetch',
      '/v1/latency',
      'http.401',
    ]);
  });

  it('strips a query string and token-shaped runs from the fallback message', () => {
    const event = unhandledError(
      'GET /v1/latency?input=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 failed'
    );

    const fingerprint = scrubEvent(event).fingerprint ?? [];

    expect(fingerprint).toEqual(['Error', 'GET <path> failed']);
    expect(fingerprint.join(' ')).not.toContain('input=');
    expect(fingerprint.join(' ')).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
  });

  it('leaves an event with no exception unfingerprinted', () => {
    const event: FallbackEvent = {
      message: 'a message-only event',
      exception: { values: [] },
    };

    expect(scrubEvent(event).fingerprint).toBeUndefined();
  });

  it('bounds the work on a pathologically long message', () => {
    // `beforeSend` runs on the JS thread and an exception message is unbounded.
    // A 200k-character word run is exactly the input that made the old
    // unanchored host:port pattern quadratic, so the fallback must read only a
    // bounded prefix of it.
    const event = unhandledError('x '.repeat(100_000));

    const [type, message] = scrubEvent(event).fingerprint ?? [];

    expect(type).toBe('Error');
    expect((message ?? '').length).toBeLessThanOrEqual(FINGERPRINT_MESSAGE_LIMIT);
  });

  it('normalizes a volatile value that sits inside the bounded prefix', () => {
    const event = unhandledError(`${'detail '.repeat(60)}Failed to connect to /10.0.2.2:8080`);

    const [type, message] = scrubEvent(event).fingerprint ?? [];

    expect(type).toBe('Error');
    expect(message).toContain('<host>');
    expect(message ?? '').not.toContain('10.0.2.2');
    expect(message ?? '').not.toContain('8080');
  });
});
