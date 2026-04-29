import { isSlackMissingScopeError, isSlackWebApiPlatformError } from './helpers';

describe('Slack bot helpers', () => {
  it('identifies Slack missing_scope platform errors with a needed scope', () => {
    const error = {
      code: 'slack_webapi_platform_error',
      data: {
        ok: false,
        error: 'missing_scope',
        needed: 'assistant:write',
        provided: 'chat:write',
        response_metadata: {
          scopes: ['chat:write'],
          acceptedScopes: ['assistant:write'],
        },
      },
    };

    expect(isSlackMissingScopeError(error)).toBe(true);
  });

  it('keeps non-scope Slack platform errors out of the missing-scope path', () => {
    const error = {
      code: 'slack_webapi_platform_error',
      data: {
        ok: false,
        error: 'channel_not_found',
      },
    };

    expect(isSlackWebApiPlatformError(error)).toBe(true);
    expect(isSlackMissingScopeError(error)).toBe(false);
  });

  it('requires missing_scope errors to include a string needed value', () => {
    const error = {
      code: 'slack_webapi_platform_error',
      data: {
        ok: false,
        error: 'missing_scope',
      },
    };

    expect(isSlackMissingScopeError(error)).toBe(false);
  });
});
