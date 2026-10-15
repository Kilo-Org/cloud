import { describe, expect, it } from 'vitest';

import { scrubEvent } from './sentry-scrub';

/**
 * The scrubber keeps word-chain runs only at the app-set identifier paths: the
 * `error.subsystem`, `error.operation`, `trpc.procedure`, `trpc.code`,
 * `auth.cause`, `auth.branch`, `auth.keys` and `turbo_module.method` tags and
 * `extra.componentStack`. These cases pin that exemption to those exact paths:
 * a matching key name nested anywhere else is payload data and a word-chain
 * secret there is redacted.
 */
describe('scrubEvent identifier paths', () => {
  it('keeps the agent-message-render subsystem tag the render boundary reports', () => {
    const event = {
      exception: { values: [{ type: 'Error', value: 'kwf staged render crash' }] },
      tags: { 'error.subsystem': 'agent-message-render', 'error.operation': 'render_part' },
    };

    const result = scrubEvent(event);

    expect(result.tags['error.subsystem']).toBe('agent-message-render');
    expect(result.tags['error.operation']).toBe('render_part');
  });

  it('keeps other long subsystem and operation identifiers in tags', () => {
    const event = {
      tags: { 'error.subsystem': 'agent-attachments', 'error.operation': 'write_logout_tombstone' },
    };

    const result = scrubEvent(event);

    expect(result.tags['error.subsystem']).toBe('agent-attachments');
    expect(result.tags['error.operation']).toBe('write_logout_tombstone');
  });

  it('keeps tRPC procedure and code tags', () => {
    const event = {
      tags: {
        'trpc.procedure': 'user.getMyPushTokens',
        'trpc.code': 'INTERNAL_SERVER_ERROR',
      },
    };

    const result = scrubEvent(event);

    expect(result.tags['trpc.procedure']).toBe('user.getMyPushTokens');
    expect(result.tags['trpc.code']).toBe('INTERNAL_SERVER_ERROR');
  });

  it('keeps long tRPC procedure names, including a batched path', () => {
    const procedure = 'cliSessionsV2.getSessionMessagesPage,user.getNotificationPreferences';
    const event = { tags: { 'trpc.procedure': procedure } };

    const result = scrubEvent(event);

    expect(result.tags['trpc.procedure']).toBe(procedure);
  });

  it('keeps the auth branch tags the sign-out telemetry reports', () => {
    const event = {
      tags: {
        'auth.cause': 'credentials_unreadable',
        'auth.branch': 'refresh_token_unreadable',
        'auth.keys': 'auth-token,auth-refresh-token,auth-token-expires-at',
      },
    };

    const result = scrubEvent(event);

    expect(result.tags['auth.cause']).toBe('credentials_unreadable');
    expect(result.tags['auth.branch']).toBe('refresh_token_unreadable');
    expect(result.tags['auth.keys']).toBe('auth-token,auth-refresh-token,auth-token-expires-at');
  });

  it('keeps the TurboModule method tag the Sentry SDK writes', () => {
    const event = { tags: { 'turbo_module.method': 'initNativeReactNavigationNewFrameTracking' } };

    const result = scrubEvent(event);

    expect(result.tags['turbo_module.method']).toBe('initNativeReactNavigationNewFrameTracking');
  });

  it('redacts a JWT in an identifier tag, a plain tag, and extra', () => {
    const header = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const payload = 'eyJzdWIiOiIxMjM0NTY3ODkwIn0';
    const signature = 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const jwt = `${header}.${payload}.${signature}`;
    const redactedJwt = '[redacted].[redacted].[redacted]';
    const event = {
      tags: { 'trpc.procedure': `user.${jwt}`, 'auth.cause': jwt, note: jwt },
      extra: { body: `token=${jwt}` },
    };

    const result = scrubEvent(event);

    expect(result.tags['trpc.procedure']).toBe(`user.${redactedJwt}`);
    expect(result.tags['auth.cause']).toBe(redactedJwt);
    expect(result.tags.note).toBe(redactedJwt);
    expect(result.extra.body).toBe(`token=${redactedJwt}`);
  });

  it('redacts a word-chain secret in a tag outside the identifier allowlist', () => {
    const event = {
      tags: {
        'auth.route': '/api/my-super-secret-prod-token',
        'trpc.input': 'getMyPushTokensSecretValue',
      },
    };

    const result = scrubEvent(event);

    expect(result.tags['auth.route']).toBe('/api/[redacted]');
    expect(result.tags['trpc.input']).toBe('[redacted]');
  });

  it('keeps the render-crash identifiers while redacting a credential beside them', () => {
    const event = {
      tags: { 'error.subsystem': 'agent-message-render', 'error.operation': 'render_part' },
      extra: {
        componentStack: '\n    at MessageErrorBoundary',
        token: 'my-super-secret-prod-token',
      },
    };

    const result = scrubEvent(event);

    expect(result.tags['error.subsystem']).toBe('agent-message-render');
    expect(result.tags['error.operation']).toBe('render_part');
    expect(result.extra.componentStack).toBe('\n    at MessageErrorBoundary');
    expect(result.extra.token).toBe('[redacted]');
  });

  it('keeps a React component stack in extra', () => {
    const componentStack =
      '\n    at TextPartRenderer\n    at MessageErrorBoundary\n    at PartRenderer';
    const event = { extra: { componentStack } };

    const result = scrubEvent(event);

    expect(result.extra.componentStack).toBe(componentStack);
  });

  it('redacts only the credential-shaped run inside a longer component stack', () => {
    const event = {
      extra: {
        componentStack:
          '\n    at TextPartRenderer (http://127.0.0.1:11781/index.bundle?dev=true&mod=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9)\n    at MessageErrorBoundary',
      },
    };

    const result = scrubEvent(event);
    const scrubbed = result.extra.componentStack;

    expect(scrubbed).toContain('MessageErrorBoundary');
    expect(scrubbed).toContain('[redacted]');
    expect(scrubbed).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
  });

  it('redacts a word-chain secret under any non-identifier key', () => {
    const secret = 'my-super-secret-prod-token';
    const event = {
      exception: { values: [{ type: 'RenderCrash' }] },
      contexts: { RenderCrash: { detail: secret } },
      extra: { token: secret, cause: { authorization: secret } },
    };

    const result = scrubEvent(event);

    expect(result.extra.token).toBe('[redacted]');
    expect(result.extra.cause.authorization).toBe('[redacted]');
    expect(result.contexts.RenderCrash.detail).toBe('[redacted]');
  });

  it('redacts a word-chain secret under a nested componentStack key', () => {
    const event = { extra: { cause: { componentStack: 'my-super-secret-prod-token' } } };

    const result = scrubEvent(event);

    expect(result.extra.cause.componentStack).toBe('[redacted]');
  });

  it('redacts a word-chain secret in an array under a componentStack key', () => {
    const event = { extra: { componentStack: ['my-super-secret-prod-token'] } };

    const result = scrubEvent(event);

    expect(result.extra.componentStack[0]).toBe('[redacted]');
  });

  it('redacts a word-chain secret under a nested identifier tag key', () => {
    const secret = 'my-super-secret-prod-token';
    const event = {
      exception: { values: [{ type: 'RenderCrash' }] },
      tags: {
        cause: { 'error.subsystem': secret, 'error.operation': secret },
      },
    };

    const result = scrubEvent(event);

    expect(result.tags.cause['error.subsystem']).toBe('[redacted]');
    expect(result.tags.cause['error.operation']).toBe('[redacted]');
  });

  it('redacts a word-chain secret under an identifier-named key in an exception context', () => {
    const event = {
      exception: { values: [{ type: 'RenderCrash' }] },
      contexts: { RenderCrash: { componentStack: 'my-super-secret-prod-token' } },
    };

    const result = scrubEvent(event);

    expect(result.contexts.RenderCrash.componentStack).toBe('[redacted]');
  });
});
