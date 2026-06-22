import { expect } from '@playwright/test';
import type { BrowserContext, Locator, Page } from '@playwright/test';

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

const longEvalIdentifier = `kilo${'VeryLongIdentifier'.repeat(16)}`;
const evalFixtureCode = `const ${longEvalIdentifier} = document.documentElement.outerHTML.length; return ${longEvalIdentifier};`;

export const mockKiloApi = async (
  context: BrowserContext,
  options: {
    beforeFirstCompletion?: () => Promise<void>;
    beforeModels?: () => Promise<void>;
    firstCompletionEvents?: unknown[];
    organizations?: { id: string; name: string }[];
    secondCompletionEvents?: unknown[];
    seenChatOrganizationIds?: string[];
    thirdCompletionEvents?: unknown[];
  } = {}
): Promise<void> => {
  let chatCompletionCalls = 0;

  await context.route('https://app.kilo.ai/api/user', route =>
    route.fulfill({
      json: { google_user_email: 'user@kilo.ai' },
      status: 200,
    })
  );
  await context.route('https://app.kilo.ai/api/organizations', route =>
    route.fulfill({
      json: {
        organizations: options.organizations ?? [],
      },
      status: 200,
    })
  );
  await context.route('https://app.kilo.ai/api/gateway/models', async route => {
    if (options.beforeModels !== undefined) {
      await options.beforeModels();
    }

    await route.fulfill({
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
    });
  });
  await context.route('https://app.kilo.ai/api/gateway/v1/chat/completions', async route => {
    chatCompletionCalls += 1;
    options.seenChatOrganizationIds?.push(
      route.request().headers()['x-kilocode-organizationid'] ?? ''
    );

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
      if (options.beforeFirstCompletion !== undefined) {
        await options.beforeFirstCompletion();
      }

      return route.fulfill({
        body: chatCompletionStreamResponse(
          options.firstCompletionEvents ?? [
            { choices: [{ delta: { content: 'I will ' } }] },
            { choices: [{ delta: { content: 'inspect the selected tab.' } }] },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        function: {
                          arguments: JSON.stringify({ code: evalFixtureCode }),
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
          ]
        ),
        contentType: 'text/event-stream',
        status: 200,
      });
    }

    if (chatCompletionCalls === 2 && options.secondCompletionEvents !== undefined) {
      return route.fulfill({
        body: chatCompletionStreamResponse(options.secondCompletionEvents),
        contentType: 'text/event-stream',
        status: 200,
      });
    }

    if (chatCompletionCalls === 3 && options.thirdCompletionEvents !== undefined) {
      return route.fulfill({
        body: chatCompletionStreamResponse(options.thirdCompletionEvents),
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
  messagePaneScrollTop: number;
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
    messagePaneScrollTop: conversation.scrollTop,
  };
};

export const readEvalCodeBlockOverflowState = (): {
  codeBlockClientWidth: number;
  codeBlockOverflowX: string;
  codeBlockScrollWidth: number;
} => {
  const codeLabel = [...document.querySelectorAll('p')].find(
    element => element.textContent === 'Code'
  );
  const codeBlock = codeLabel?.parentElement?.querySelector('pre');

  if (!(codeBlock instanceof HTMLElement)) {
    throw new Error('Eval code block was not found.');
  }

  return {
    codeBlockClientWidth: codeBlock.clientWidth,
    codeBlockOverflowX: getComputedStyle(codeBlock).overflowX,
    codeBlockScrollWidth: codeBlock.scrollWidth,
  };
};

export const expectEvalCodeBlockNoHorizontalOverflow = async (sidePanel: Page): Promise<void> => {
  const codeBlockOverflowState = await sidePanel.evaluate(readEvalCodeBlockOverflowState);

  expect(codeBlockOverflowState.codeBlockScrollWidth).toBeLessThanOrEqual(
    codeBlockOverflowState.codeBlockClientWidth
  );
  expect(codeBlockOverflowState.codeBlockOverflowX).toBe('hidden');
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
