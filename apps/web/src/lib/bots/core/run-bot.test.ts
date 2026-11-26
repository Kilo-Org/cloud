import { sendProxiedChatCompletion } from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { runBot } from './run-bot';

jest.mock('@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers', () => ({
  sendProxiedChatCompletion: jest.fn(),
}));

afterEach(() => {
  jest.restoreAllMocks();
});

it('keeps generated response text out of logs', async () => {
  const content = 'A synthetic model response.';
  jest.mocked(sendProxiedChatCompletion).mockResolvedValue({
    ok: true,
    data: { choices: [{ message: { content } }] },
  });
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

  const result = await runBot({
    authToken: 'test-token',
    model: 'test-model',
    systemPrompt: 'Respond to the request.',
    userMessage: 'Write a sample response.',
    toolExecutor: jest.fn(),
    requestOptions: { version: '0.0.0', userAgent: 'test' },
  });

  expect(result.response).toBe(content);
  expect(log).toHaveBeenCalledWith('[BotEngine] Final response length:', content.length);
  expect(JSON.stringify(log.mock.calls)).not.toContain(content);
});
