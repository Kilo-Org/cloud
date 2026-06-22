import { expect } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const getToolResultHtmlLength = (body: unknown): string => {
  if (!isRecord(body) || !Array.isArray(body['messages'])) {
    return 'unknown';
  }

  const toolMessage = body['messages'].find(
    (message): message is Record<string, unknown> =>
      isRecord(message) && message['role'] === 'tool' && typeof message['content'] === 'string'
  );

  if (toolMessage === undefined || typeof toolMessage['content'] !== 'string') {
    return 'unknown';
  }

  const toolResult: unknown = JSON.parse(toolMessage['content']);

  if (!isRecord(toolResult) || typeof toolResult['value'] !== 'number') {
    return 'unknown';
  }

  return String(toolResult['value']);
};

export const mockKiloApi = async (context: BrowserContext): Promise<void> => {
  let chatCompletionCalls = 0;

  await context.route('https://app.kilo.ai/api/user', route =>
    route.fulfill({
      json: { google_user_email: 'user@kilo.ai' },
      status: 200,
    })
  );
  await context.route('https://app.kilo.ai/api/gateway/models', route =>
    route.fulfill({
      json: {
        data: [
          {
            id: 'anthropic/claude-sonnet-4',
            name: 'Anthropic: Claude Sonnet 4',
            opencode: { variants: { high: {}, low: {}, medium: {} } },
            preferredIndex: 0,
          },
        ],
      },
      status: 200,
    })
  );
  await context.route('https://app.kilo.ai/api/gateway/v1/chat/completions', route => {
    chatCompletionCalls += 1;

    const body: unknown = route.request().postDataJSON();

    expect(body).toMatchObject({
      model: 'anthropic/claude-sonnet-4',
      tool_choice: 'auto',
      tools: [
        {
          function: {
            name: 'eval',
          },
          type: 'function',
        },
      ],
    });

    if (chatCompletionCalls === 1) {
      return route.fulfill({
        json: {
          choices: [
            {
              message: {
                content: 'I will inspect the selected tab.',
                role: 'assistant',
                tool_calls: [
                  {
                    function: {
                      arguments: '{"code":"return document.documentElement.outerHTML.length;"}',
                      name: 'eval',
                    },
                    id: 'call_eval_1',
                    type: 'function',
                  },
                ],
              },
            },
          ],
        },
        status: 200,
      });
    }

    return route.fulfill({
      json: {
        choices: [
          {
            message: {
              content: `The selected tab HTML length is ${getToolResultHtmlLength(body)}.`,
              role: 'assistant',
            },
          },
        ],
      },
      status: 200,
    });
  });
};
