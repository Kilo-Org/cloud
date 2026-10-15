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
  it('keeps exception stacks and correlation IDs without customer content', () => {
    const frameUrl = new URL('https://host/file.js?private-query=value');
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
