import { expect } from '@playwright/test';
import type { BrowserContext, Locator } from '@playwright/test';

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

const chatCompletionStreamResponse = (events: unknown[]): string =>
  `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;

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
      stream: true,
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
        body: chatCompletionStreamResponse([
          { choices: [{ delta: { content: 'I will ' } }] },
          { choices: [{ delta: { content: 'inspect the selected tab.' } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      function: {
                        arguments: '{"code":"return document.documentElement.outerHTML.length;"}',
                        name: 'eval',
                      },
                      id: 'call_eval_1',
                      index: 0,
                      type: 'function',
                    },
                  ],
                },
              },
            ],
          },
        ]),
        contentType: 'text/event-stream',
        status: 200,
      });
    }

    return route.fulfill({
      body: chatCompletionStreamResponse([
        {
          choices: [
            {
              delta: {
                content: `The selected tab HTML length is ${getToolResultHtmlLength(body)}.`,
              },
            },
          ],
        },
      ]),
      contentType: 'text/event-stream',
      status: 200,
    });
  });
};

export const readSidePanelScrollState = (): {
  documentClientHeight: number;
  documentScrollHeight: number;
  messagePaneClientHeight: number;
  messagePaneScrollHeight: number;
  renderedConversationItems: number;
} => {
  const conversation = document.querySelector('[aria-label="Agent conversation"]');

  if (!(conversation instanceof HTMLElement)) {
    throw new Error('Agent conversation pane was not found.');
  }

  return {
    documentClientHeight: document.documentElement.clientHeight,
    documentScrollHeight: document.documentElement.scrollHeight,
    messagePaneClientHeight: conversation.clientHeight,
    messagePaneScrollHeight: conversation.scrollHeight,
    renderedConversationItems: conversation.querySelectorAll(':scope > div > *').length,
  };
};

export const sendOverflowMessages = async (messageInput: Locator, count: number): Promise<void> => {
  await Array.from({ length: count }).reduce<Promise<void>>(
    async (previousMessage, _value, index) => {
      await previousMessage;
      await messageInput.fill(`Overflow content ${index}`);
      await messageInput.press('Enter');
    },
    Promise.resolve()
  );
};
