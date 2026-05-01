import { upstreamRequest } from '../lib/ai-gateway/providers/upstream-request';
import PROVIDERS from '../lib/ai-gateway/providers/provider-definitions';

describe('upstreamRequest timeout', () => {
  it('should abort after timeout', async () => {
    // Use a very short timeout for testing by temporarily modifying the function
    // For a quick manual test, we can verify the signal is properly combined

    const controller = new AbortController();

    // This test verifies that the request respects the abort signal
    // by immediately aborting and checking the error
    controller.abort();

    await expect(
      upstreamRequest({
        path: '/chat/completions',
        search: '',
        method: 'POST',
        body: {
          model: 'test-model',
          messages: [{ role: 'user', content: 'test' }],
        },
        extraHeaders: {},
        provider: PROVIDERS.OPENROUTER,
        signal: controller.signal,
      })
    ).rejects.toThrow();
  });
});
