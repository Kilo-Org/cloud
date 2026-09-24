// The connection read is stubbed before the component module is loaded:
// @swc/jest emits the static imports first, so the mock only reaches a module
// that is imported after the stub is registered (see `renderChatGptUsageLink`).
jest.mock('@/lib/ai-gateway/openai-chatgpt/store', () => ({
  getOpenAiChatGptConnection: jest.fn(),
}));

import { describe, expect, it, jest } from '@jest/globals';
import { CHATGPT_USAGE_SETTINGS_URL } from '@/lib/ai-gateway/openai-chatgpt/usage-limit';

const USAGE_LINK_SUMMARY = 'View and manage your ChatGPT usage';

/**
 * Renders the server component for a live or an absent connection and returns
 * the markup, or an empty string when the component renders nothing.
 */
async function renderChatGptUsageLink(hasConnection: boolean): Promise<string> {
  jest.resetModules();
  const [store, link, server] = await Promise.all([
    import('@/lib/ai-gateway/openai-chatgpt/store'),
    import('@/components/chatgpt/ChatGptUsageLink'),
    import('react-dom/server'),
  ]);

  const readConnection = jest.mocked(store.getOpenAiChatGptConnection);
  readConnection.mockResolvedValue(
    hasConnection ? ({ status: 'connected' } as Awaited<ReturnType<typeof readConnection>>) : null
  );

  const element = await link.ChatGptUsageLink({ kiloUserId: 'user-1' });
  return element === null ? '' : server.renderToStaticMarkup(element);
}

describe('ChatGptUsageLink', () => {
  it('shows the summary and the ChatGPT usage settings action for a live connection', async () => {
    const html = await renderChatGptUsageLink(true);

    expect(html).toContain(USAGE_LINK_SUMMARY);
    expect(html).toContain(CHATGPT_USAGE_SETTINGS_URL);
    expect(html).toContain('Manage usage');
  });

  it('renders nothing when the account is not connected', async () => {
    expect(await renderChatGptUsageLink(false)).toBe('');
  });
});
