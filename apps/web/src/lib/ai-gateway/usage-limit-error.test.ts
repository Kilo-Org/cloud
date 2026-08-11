import { APICallError } from 'ai';
import { getKiloUsageLimitErrorMessage } from './usage-limit-error';

function apiCallError(statusCode: number, responseBody: string): APICallError {
  return new APICallError({
    message: 'API call failed',
    url: 'https://app.kilo.ai/api/openrouter/chat/completions',
    requestBodyValues: {},
    statusCode,
    responseBody,
  });
}

describe('getKiloUsageLimitErrorMessage', () => {
  test('returns the message for a Kilo usage-limit response', () => {
    const error = apiCallError(
      402,
      JSON.stringify({
        error_type: 'usage_limit_exceeded',
        error: { message: 'Add credits to continue, or switch to a free model' },
      })
    );

    expect(getKiloUsageLimitErrorMessage(error)).toBe(
      'Add credits to continue, or switch to a free model'
    );
  });

  test('does not classify other 402 responses as Kilo usage-limit errors', () => {
    const error = apiCallError(
      402,
      JSON.stringify({ error: { message: 'Upstream provider balance exhausted' } })
    );

    expect(getKiloUsageLimitErrorMessage(error)).toBeNull();
  });

  test('does not classify a usage-limit response with another status', () => {
    const error = apiCallError(
      503,
      JSON.stringify({
        error_type: 'usage_limit_exceeded',
        error: { message: 'Add credits to continue' },
      })
    );

    expect(getKiloUsageLimitErrorMessage(error)).toBeNull();
  });

  test.each([
    new Error('network failure'),
    apiCallError(402, 'not-json'),
    apiCallError(402, JSON.stringify({ error_type: 'usage_limit_exceeded', error: {} })),
    undefined,
  ])('does not classify malformed or unrelated errors', error => {
    expect(getKiloUsageLimitErrorMessage(error)).toBeNull();
  });
});
