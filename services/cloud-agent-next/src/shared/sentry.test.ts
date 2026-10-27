import { describe, expect, it } from 'vitest';
import type { ErrorEvent } from '@sentry/core';
import { getSentryConfig, sanitizeSentryEvent } from './sentry.js';

describe('Cloud Agent Sentry configuration', () => {
  it('is disabled without a valid trusted HTTPS DSN', () => {
    for (const dsn of [
      undefined,
      '',
      'not-a-url',
      'http://public@o1.ingest.sentry.io/42',
      'https://o1.ingest.sentry.io/42',
      'https://public:secret@o1.ingest.sentry.io/42',
      'https://public@o1.ingest.sentry.io:444/42',
      'https://public@o1.ingest.sentry.io/42?secret=value',
      'https://public@o1.ingest.sentry.io/42#fragment',
      'https://public@o1.ingest.sentry.io/private/path',
    ]) {
      expect(getSentryConfig({ CLOUD_AGENT_SENTRY_DSN: dsn })).toBeUndefined();
    }
  });

  it('normalizes trusted configuration without accepting extra environment values', () => {
    expect(
      getSentryConfig({
        CLOUD_AGENT_SENTRY_DSN: 'https://public@o1.ingest.sentry.io/42',
        CLOUD_AGENT_SENTRY_ENVIRONMENT: 'staging',
      })
    ).toEqual({ dsn: 'https://public@o1.ingest.sentry.io/42', environment: 'staging' });
    expect(
      getSentryConfig({
        CLOUD_AGENT_SENTRY_DSN: 'https://public@o1.ingest.sentry.io/42',
        CLOUD_AGENT_SENTRY_ENVIRONMENT: 'untrusted text with spaces',
      })?.environment
    ).toBe('production');
  });
});

describe('Cloud Agent Sentry privacy', () => {
  it('keeps safe local paths and valid credential-free absolute frame URLs', () => {
    const filenames = [
      '/usr/local/bin/kilocode-control-plane-wrapper.js',
      './dist/app.js',
      '../src/app.ts',
      'src/@kilo/app.ts',
      'C:/runtime/app.js',
      'node:internal/process/task_queues',
      'https://frames.invalid/app.js',
      'http://frames.invalid:8080/app.js',
      'file:///usr/local/bin/app.js',
      'webpack://runtime/src/app.js',
      'a'.repeat(256),
    ];
    const sanitized = sanitizeSentryEvent({
      type: undefined,
      exception: {
        values: [{ stacktrace: { frames: filenames.map(filename => ({ filename })) } }],
      },
    });
    expect(
      sanitized?.exception?.values?.[0]?.stacktrace?.frames?.map(frame => frame.filename)
    ).toEqual(filenames);
  });

  it('rejects unsafe frame URLs including protocol-relative credentials without retaining userinfo', () => {
    const credentialedUrl = new URL('https://frames.invalid/app.js');
    credentialedUrl.username = 'synthetic-user';
    credentialedUrl.password = 'synthetic-password';
    const usernameOnlyUrl = new URL('https://frames.invalid/app.js');
    usernameOnlyUrl.username = 'synthetic-user';
    const filenames = [
      credentialedUrl.href,
      credentialedUrl.href.replace('://', ':'),
      credentialedUrl.href.replace('://', ':/'),
      credentialedUrl.href.replace('https:', ''),
      usernameOnlyUrl.href,
      usernameOnlyUrl.href.replace('://', ':'),
      usernameOnlyUrl.href.replace('://', ':/'),
      usernameOnlyUrl.href.replace('https:', ''),
      '//frames.invalid/app.js',
      '//frames.invalid',
      'https://',
      '/app.js?token=synthetic-token',
      '/app.js#synthetic-fragment',
      'https://frames.invalid/app.js?token=synthetic-token',
      'https://frames.invalid/app.js#synthetic-fragment',
      '//frames.invalid/app.js?token=synthetic-token',
      '//frames.invalid/app.js#synthetic-fragment',
      'https://synthetic-user%40frames.invalid/app.js',
      'app with spaces.js',
      'a'.repeat(257),
    ];
    const sanitized = sanitizeSentryEvent({
      type: undefined,
      exception: {
        values: [{ stacktrace: { frames: filenames.map(filename => ({ filename })) } }],
      },
    });
    const frames = sanitized?.exception?.values?.[0]?.stacktrace?.frames;
    expect(frames).toHaveLength(filenames.length);
    expect(frames?.every(frame => frame.filename === undefined)).toBe(true);
    expect(JSON.stringify(sanitized).includes('synthetic-')).toBe(false);
  });

  it('keeps exception stacks and correlation IDs without customer content', () => {
    const frameUrl = new URL('https://host/file.js');
    frameUrl.username = 'user';
    frameUrl.password = 'private-password';
    const event: ErrorEvent = {
      type: undefined,
      event_id: 'event-id',
      release: 'worker-version',
      environment: 'test',
      message: 'private-message',
      request: {
        url: 'https://worker.example/stream?ticket=private-ticket',
        data: { prompt: 'private-prompt' },
        headers: { Authorization: 'private-token', Cookie: 'private-cookie' },
      },
      user: { email: 'private-email', ip_address: 'private-ip' },
      extra: { code: 'private-code', env: { API_KEY: 'private-key' } },
      breadcrumbs: [{ message: 'private-log' }],
      tags: { user: 'private-user' },
      contexts: {
        cloud_agent: {
          component: 'worker',
          operation: 'send',
          sessionId: 'workspace_one',
          messageId: 'message_one',
          prompt: 'private-context',
        },
        runtime: { command: 'private-command' },
      },
      exception: {
        values: [
          {
            type: 'TypeError',
            value: 'private-exception-message',
            stacktrace: {
              frames: [
                {
                  filename: '/usr/local/bin/kilocode-wrapper.js',
                  function: 'handleMessage',
                  lineno: 11,
                  colno: 22,
                  in_app: true,
                  pre_context: ['private-code'],
                  context_line: 'private-code',
                  post_context: ['private-code'],
                  vars: { token: 'private-variable' },
                },
                { filename: frameUrl.toString() },
              ],
            },
          },
        ],
      },
    };
    const sanitized = sanitizeSentryEvent(event);
    expect(JSON.stringify(sanitized)).not.toContain('private-');
    expect(sanitized?.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({
      filename: '/usr/local/bin/kilocode-wrapper.js',
      function: 'handleMessage',
      lineno: 11,
      colno: 22,
      in_app: true,
    });
    expect(sanitized?.exception?.values?.[0]?.stacktrace?.frames?.[1]).toEqual({});
    expect(sanitized?.contexts).toEqual({
      cloud_agent: {
        component: 'worker',
        operation: 'send',
        sessionId: 'workspace_one',
        messageId: 'message_one',
      },
    });
    expect(sanitized?.event_id).toBe('event-id');
    expect(sanitized?.release).toBe('worker-version');
    expect(event.exception?.values?.[0]?.value).toBe('private-exception-message');
  });

  it('drops plain log events and normalizes untrusted exception types', () => {
    expect(sanitizeSentryEvent({ type: undefined, message: 'a log' })).toBeNull();
    expect(
      sanitizeSentryEvent({
        type: undefined,
        exception: { values: [{ type: 'private-type', value: 'private-value' }] },
      })?.exception?.values?.[0]?.type
    ).toBe('Error');
  });
});
