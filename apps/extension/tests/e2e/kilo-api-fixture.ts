/* eslint-disable max-lines */
import { expect } from '@playwright/test';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { z } from 'zod';
const toolMessageSchema = z.object({
  content: z.string(),
  role: z.literal('tool'),
});
const userMessageSchema = z.object({
  content: z.string(),
  role: z.literal('user'),
});
const toolDefinitionSchema = z.object({
  function: z.object({
    name: z.unknown().optional(),
  }),
});
const chatRequestSchema = z.object({
  messages: z.array(z.unknown()).optional(),
  model: z.string().min(1),
  tools: z.array(z.unknown()).optional(),
});
const toolResultSchema = z.object({
  value: z.number(),
});
const getToolResultHtmlLength = (body: unknown): string => {
  const request = chatRequestSchema.safeParse(body);

  if (!request.success || request.data.messages === undefined) {
    return 'unknown';
  }

  const toolMessage = request.data.messages
    .map(message => toolMessageSchema.safeParse(message))
    .find(message => message.success);

  if (toolMessage === undefined || !toolMessage.success) {
    return 'unknown';
  }

  const toolResult = toolResultSchema.safeParse(JSON.parse(toolMessage.data.content));

  return toolResult.success ? String(toolResult.data.value) : 'unknown';
};

// The real gateway always reports a finish_reason; a canned completion
// without one would look like a truncated stream and trigger the turn
// runner's transparent retry. Append the terminal chunk unless the fixture
// pins its own.
const hasFinishReason = (events: unknown[]): boolean =>
  events.some(event => JSON.stringify(event).includes('"finish_reason"'));

const chatCompletionStreamResponse = (events: unknown[]): string => {
  const terminal = hasFinishReason(events)
    ? []
    : [{ choices: [{ delta: {}, finish_reason: 'stop' }] }];
  return `${[...events, ...terminal].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
};

const longEvalIdentifier = `kilo${'VeryLongIdentifier'.repeat(16)}`;
const evalFixtureCode = `const ${longEvalIdentifier} = document.documentElement.outerHTML.length; return ${longEvalIdentifier};`;
const chatCompletionsPath = '/api/gateway/v1/chat/completions';
export const workflowToolNames = [
  'search_workflows',
  'get_workflow',
  'save_workflow',
  'save_memory',
];
export const safeToolNames = [
  'get_page_snapshot',
  'get_element_details',
  'find_in_page',
  'search_memories',
  'get_memory',
  ...workflowToolNames,
];
export const dangerousToolNames = [
  'get_page_snapshot',
  'get_element_details',
  'find_in_page',
  'search_memories',
  'get_memory',
  'eval',
  ...workflowToolNames,
  'run_workflow',
  'delete_workflow',
];
interface MockGatewayModel {
  readonly contextLength?: number;
  readonly hasUserByokAvailable?: boolean;
  readonly id: string;
  readonly isFree?: boolean;
  readonly mayTrainOnYourPrompts?: boolean;
  readonly name: string;
  readonly preferredIndex?: number;
  readonly variants?: Record<string, unknown>;
}

const favoriteMutationBodySchema = z.object({
  model: z.string().min(1),
});

type ChatAbortObserverWindow = typeof globalThis & {
  __kiloChatCompletionAborted?: boolean;
};

const defaultModelPreferencesMutationBody = {
  result: { data: { success: true } },
};

export const mockKiloApi = async (
  context: BrowserContext,
  options: {
    beforeFirstCompletion?: () => Promise<void>;
    beforeModels?: (organizationId: string) => Promise<void>;
    afterModels?: (organizationId: string) => void;
    firstCompletionEvents?: unknown[];
    modelInputModalities?: string[];
    modelFailuresBeforeSuccessByOrganizationId?: Record<string, number>;
    models?: MockGatewayModel[];
    modelNameByOrganizationId?: Record<string, string>;
    modelFailuresBeforeSuccess?: number;
    modelPreferencesFavorites?: string[];
    modelPreferencesGetFailuresBeforeSuccess?: number;
    modelPreferencesGetStatus?: number;
    modelPreferencesMutationFailuresBeforeSuccess?: number;
    modelPreferencesMutationStatus?: number;
    organizations?: { id: string; name: string }[];
    secondCompletionEvents?: unknown[];
    seenChatBodies?: unknown[];
    seenModelPreferencesGetUrls?: string[];
    toolNames?: string[];
    toolNamesByCall?: string[][];
    seenChatOrganizationIds?: string[];
    thirdCompletionEvents?: unknown[];
  } = {}
): Promise<void> => {
  let chatCompletionCalls = 0;
  let modelCalls = 0;
  const modelCallsByOrganizationId = new Map<string, number>();
  const favorites = [...(options.modelPreferencesFavorites ?? [])];
  let modelPreferencesGetFailuresRemaining = options.modelPreferencesGetFailuresBeforeSuccess ?? 0;
  let modelPreferencesMutationFailuresRemaining =
    options.modelPreferencesMutationFailuresBeforeSuccess ?? 0;

  await context.route('https://app.kilo.ai/api/user', route =>
    route.fulfill({
      json: { google_user_email: 'user@kilo.ai' },
      status: 200,
    })
  );
  await context.route('https://app.kilo.ai/api/organizations', route =>
    route.fulfill({ json: { organizations: options.organizations ?? [] }, status: 200 })
  );
  await context.route(
    url =>
      url.origin === 'https://app.kilo.ai' &&
      url.pathname.startsWith('/api/trpc/modelPreferences.'),
    async route => {
      const requestUrl = route.request().url();
      let pathname = '';

      try {
        ({ pathname } = new URL(requestUrl));
      } catch {
        await route.fulfill({ status: 404 });
        return;
      }

      if (pathname.endsWith('/modelPreferences.get')) {
        options.seenModelPreferencesGetUrls?.push(requestUrl);

        if (options.modelPreferencesGetStatus !== undefined) {
          await route.fulfill({ status: options.modelPreferencesGetStatus });
          return;
        }

        if (modelPreferencesGetFailuresRemaining > 0) {
          modelPreferencesGetFailuresRemaining -= 1;
          await route.fulfill({ status: 500 });
          return;
        }

        await route.fulfill({
          json: {
            result: {
              data: {
                favorites: [...favorites],
                lastSelected: null,
              },
            },
          },
          status: 200,
        });
        return;
      }

      if (
        pathname.endsWith('/modelPreferences.addFavorite') ||
        pathname.endsWith('/modelPreferences.removeFavorite')
      ) {
        if (options.modelPreferencesMutationStatus !== undefined) {
          await route.fulfill({ status: options.modelPreferencesMutationStatus });
          return;
        }

        if (modelPreferencesMutationFailuresRemaining > 0) {
          modelPreferencesMutationFailuresRemaining -= 1;
          await route.fulfill({ status: 500 });
          return;
        }

        let postData: unknown = null;

        try {
          postData = route.request().postDataJSON();
        } catch {
          postData = null;
        }

        const parsedBody = favoriteMutationBodySchema.safeParse(postData);

        if (parsedBody.success) {
          const modelId = parsedBody.data.model;
          const isAdd = pathname.endsWith('/modelPreferences.addFavorite');
          const favoriteIndex = favorites.indexOf(modelId);

          if (isAdd && favoriteIndex === -1) {
            favorites.push(modelId);
          }

          if (!isAdd && favoriteIndex !== -1) {
            favorites.splice(favoriteIndex, 1);
          }
        }

        await route.fulfill({
          json: defaultModelPreferencesMutationBody,
          status: 200,
        });
        return;
      }

      await route.fulfill({ status: 404 });
    }
  );
  await context.route('https://app.kilo.ai/api/gateway/models', async route => {
    modelCalls += 1;
    const organizationId = route.request().headers()['x-kilocode-organizationid'] ?? '';
    const organizationModelCalls = (modelCallsByOrganizationId.get(organizationId) ?? 0) + 1;
    modelCallsByOrganizationId.set(organizationId, organizationModelCalls);

    if (options.beforeModels !== undefined) {
      await options.beforeModels(organizationId);
    }

    if (
      modelCalls <= (options.modelFailuresBeforeSuccess ?? 0) ||
      organizationModelCalls <=
        (options.modelFailuresBeforeSuccessByOrganizationId?.[organizationId] ?? 0)
    ) {
      await route.fulfill({ status: 500 });
      options.afterModels?.(organizationId);
      return;
    }

    const models = options.models ?? [
      {
        id: 'anthropic/claude-sonnet-4',
        name: options.modelNameByOrganizationId?.[organizationId] ?? 'Anthropic: Claude Sonnet 4',
        variants: { high: {}, low: {}, medium: {} },
      },
    ];

    const data = models.map((model, index) => {
      const {
        contextLength,
        hasUserByokAvailable,
        id,
        isFree,
        mayTrainOnYourPrompts,
        name,
        preferredIndex: explicitPreferredIndex,
        variants,
      } = model;
      let preferredIndex = explicitPreferredIndex;

      if (preferredIndex === undefined && index === 0) {
        preferredIndex = 0;
      }

      const item = {
        id,
        name,
        opencode: { variants: variants ?? { high: {}, low: {}, medium: {} } },
        ...(contextLength === undefined ? {} : { context_length: contextLength }),
        ...(hasUserByokAvailable === undefined ? {} : { hasUserByokAvailable }),
        ...(isFree === undefined ? {} : { isFree }),
        ...(mayTrainOnYourPrompts === undefined ? {} : { mayTrainOnYourPrompts }),
        ...(preferredIndex === undefined ? {} : { preferredIndex }),
      };

      return Object.assign(
        item,
        options.modelInputModalities === undefined
          ? {}
          : { architecture: { input_modalities: options.modelInputModalities } }
      );
    });

    await route.fulfill({
      json: {
        data,
      },
      status: 200,
    });
    options.afterModels?.(organizationId);
  });
  await context.route('https://app.kilo.ai/api/gateway/v1/chat/completions', async route => {
    chatCompletionCalls += 1;
    options.seenChatOrganizationIds?.push(
      route.request().headers()['x-kilocode-organizationid'] ?? ''
    );

    const body: unknown = route.request().postDataJSON();
    options.seenChatBodies?.push(body);
    const parsedBody = chatRequestSchema.safeParse(body);
    const messages = parsedBody.success ? (parsedBody.data.messages ?? []) : [];
    const expectedModelIds = options.models?.map(model => model.id) ?? [
      'anthropic/claude-sonnet-4',
    ];

    const toolNames =
      options.toolNamesByCall?.[chatCompletionCalls - 1] ?? options.toolNames ?? safeToolNames;

    // Summarization calls use tool_choice: 'none' (tools: []); skip normal-turn assertions for them.
    const isSummarizationCall =
      parsedBody.success &&
      Array.isArray(parsedBody.data.tools) &&
      parsedBody.data.tools.length === 0;

    if (isSummarizationCall) {
      // Summarization calls skip normal-turn assertions (tool_choice: 'none', tools: [])
    } else {
      expect(body).toMatchObject({ stream: true, tool_choice: 'auto' });
      expect(parsedBody.success ? expectedModelIds.includes(parsedBody.data.model) : false).toBe(
        true
      );
      expect(
        parsedBody.success && parsedBody.data.tools !== undefined
          ? parsedBody.data.tools.map(tool => {
              const parsedTool = toolDefinitionSchema.safeParse(tool);

              return parsedTool.success ? parsedTool.data.function.name : undefined;
            })
          : []
      ).toStrictEqual(toolNames);
      const userMessages = messages
        .map(message => userMessageSchema.safeParse(message))
        .filter(message => message.success)
        .map(message => message.data);
      expect(userMessages.at(-1)?.content).toEqual(expect.stringContaining('<system_environment>'));
      expect(userMessages.at(-1)?.content).toEqual(expect.stringContaining('Current time:'));
      expect(userMessages.at(-1)?.content).toEqual(expect.stringContaining('Timezone:'));
    }

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

export const installChatCompletionAbortObserver = async (sidePanel: Page): Promise<void> => {
  await sidePanel.evaluate(chatPath => {
    const originalFetch = globalThis.fetch.bind(globalThis);
    const state = globalThis as ChatAbortObserverWindow;

    state.__kiloChatCompletionAborted = false;
    globalThis.fetch = ((input, init) => {
      let requestUrl = '';

      if (input instanceof Request) {
        requestUrl = input.url;
      } else if (input instanceof URL) {
        requestUrl = input.href;
      } else {
        requestUrl = input;
      }

      if (requestUrl.endsWith(chatPath)) {
        init?.signal?.addEventListener(
          'abort',
          () => {
            state.__kiloChatCompletionAborted = true;
          },
          { once: true }
        );
      }

      return originalFetch(input, init);
    }) as typeof globalThis.fetch;
  }, chatCompletionsPath);
};

export const wasChatCompletionAborted = (sidePanel: Page): Promise<boolean> =>
  sidePanel.evaluate(() => {
    const state = globalThis as ChatAbortObserverWindow;

    return state.__kiloChatCompletionAborted === true;
  });

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
