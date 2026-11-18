jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  CODE_INDEXING_ENABLED: false,
}));

import {
  CODE_INDEXING_GONE_MESSAGE,
  codeIndexingGoneResponse,
  isCodeIndexingEnabled,
} from './availability.server';

describe('code indexing availability', () => {
  it('is disabled unless explicitly enabled', () => {
    expect(isCodeIndexingEnabled()).toBe(false);
  });

  it('returns a 410 response with the gone message', async () => {
    const response = codeIndexingGoneResponse();

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      error: 'gone',
      message: CODE_INDEXING_GONE_MESSAGE,
    });
  });
});
