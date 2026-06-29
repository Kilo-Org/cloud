/* eslint-disable id-length, import/no-nodejs-modules, max-lines, no-await-in-loop, promise/avoid-new, promise/no-callback-in-promise, promise/prefer-await-to-callbacks */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Builder, By, Key } from 'selenium-webdriver';
import type { WebDriver, WebElement } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox';
import { z } from 'zod';

const extensionRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '../..');
const firefoxZipPath = resolvePath(extensionRoot, '.output/kilo-extension-0.0.0-firefox.zip');
const waitMs = 15_000;

const chromeWorkflowNames = [
  'conversation automatically continues through another eval request',
  'new conversation inherits the selected target tab',
  'conversation tabs can run in parallel',
  'conversation tabs persist across side panel reloads',
  'closing a conversation removes only that tab',
  'conversation tab bar scrolls horizontally',
  'assistant messages render markdown',
  'only the message pane scrolls virtualized overflowing conversation content',
  'manual scroll up shows jump to latest without following new messages',
  'scrolling back to bottom reactivates automatic scroll to new messages',
  'settings organization picker sends org context to the gateway',
  'native side panel is outside the page DOM',
  'dangerous mode conversation can eval against a normal tab',
  'safe mode conversation reads the selected tab with safe tools',
  'dangerous mode conversation can use safe read tools',
  'running conversation can be stopped',
  'target tab list updates automatically',
  'closing the selected tab clears the target tab selection',
  'closing the selected tab aborts a running request',
  'conversation survives side panel reload',
  'model and thinking controls wait for the model catalog',
  'model catalog failures can be retried',
  'switching credit accounts clears the model while the next catalog loads',
  'stale organization model loads cannot overwrite the current catalog',
  'new conversation keeps the running request in its original tab',
] as const;

interface ServerHandle {
  readonly close: () => Promise<void>;
  readonly url: string;
}

interface Organization {
  readonly id: string;
  readonly name: string;
}

interface KiloApiOptions {
  readonly beforeFirstCompletion?: () => Promise<void>;
  readonly beforeModels?: (organizationId: string) => Promise<void>;
  readonly firstCompletionEvents?: unknown[];
  readonly modelFailuresBeforeSuccess?: number;
  readonly modelFailuresBeforeSuccessByOrganizationId?: Record<string, number>;
  readonly modelNameByOrganizationId?: Record<string, string>;
  readonly observeFirstChatAbort?: () => void;
  readonly organizations?: Organization[];
  readonly secondCompletionEvents?: unknown[];
  readonly seenChatOrganizationIds?: string[];
  readonly thirdCompletionEvents?: unknown[];
  readonly toolNames?: string[];
}

interface KiloApiHandle extends ServerHandle {
  readonly reset: (options?: KiloApiOptions) => void;
}

interface FirefoxSession {
  readonly close: () => Promise<void>;
  readonly driver: FirefoxWebDriver;
  readonly openSidePanel: () => Promise<void>;
  readonly openTargetPage: (title?: string) => Promise<ServerHandle>;
}

interface ScenarioContext {
  readonly api: KiloApiHandle;
}

type FirefoxWebDriver = WebDriver & {
  readonly installAddon: (path: string, temporary: boolean) => Promise<string>;
};

interface FirefoxScenario {
  readonly name: (typeof chromeWorkflowNames)[number];
  readonly run: (context: ScenarioContext) => Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const toolMessageSchema = z.object({
  content: z.string(),
  role: z.literal('tool'),
});
const toolDefinitionSchema = z.object({
  function: z.object({
    name: z.unknown().optional(),
  }),
});
const chatRequestSchema = z.object({
  messages: z.array(z.unknown()).optional(),
  tools: z.array(z.unknown()).optional(),
});
const toolResultSchema = z.object({
  value: z.number(),
});
const scrollStateSchema = z.object({
  documentClientHeight: z.number(),
  documentScrollHeight: z.number(),
  messagePaneClientHeight: z.number(),
  messagePaneScrollHeight: z.number(),
  messagePaneScrollTop: z.number(),
  mountedMessageItems: z.number(),
});

const isFirefoxWebDriver = (driver: WebDriver): driver is FirefoxWebDriver => {
  const candidate: unknown = driver;

  return isRecord(candidate) && typeof candidate['installAddon'] === 'function';
};

const chatCompletionStreamResponse = (events: unknown[]): string =>
  `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;

const defaultEvalCode = 'return document.documentElement.outerHTML.length;';
const dangerousToolNames = ['get_page_snapshot', 'get_element_details', 'find_in_page', 'eval'];

const defaultFirstCompletionEvents = (): unknown[] => [
  { choices: [{ delta: { content: 'I will inspect Firefox.' } }] },
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              function: {
                arguments: JSON.stringify({ code: defaultEvalCode }),
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
];

const readRequestBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: string[] = [];

  for await (const chunk of request) {
    chunks.push(String(chunk));
  }

  const body = chunks.join('');

  return body === '' ? undefined : chatRequestSchema.parse(JSON.parse(body));
};

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

const getRequestToolNames = (body: unknown): unknown[] => {
  const request = chatRequestSchema.safeParse(body);

  return request.success
    ? (request.data.tools ?? []).map(tool => {
        const parsedTool = toolDefinitionSchema.safeParse(tool);

        return parsedTool.success ? parsedTool.data.function.name : undefined;
      })
    : [];
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

const listen = async (server: Server): Promise<ServerHandle> => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Server did not start on a TCP port.');
  }

  return {
    close: () => closeServer(server),
    url: `http://127.0.0.1:${address.port}`,
  };
};

const writeCorsHeaders = (response: ServerResponse): void => {
  response.setHeader('access-control-allow-headers', '*');
  response.setHeader('access-control-allow-methods', '*');
  response.setHeader('access-control-allow-origin', '*');
};

const sendJson = (response: ServerResponse, body: unknown): void => {
  writeCorsHeaders(response);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const sendSse = (response: ServerResponse, events: unknown[]): void => {
  writeCorsHeaders(response);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(chatCompletionStreamResponse(events));
};

const startKiloApiServer = async (): Promise<KiloApiHandle> => {
  let options: KiloApiOptions = {};
  let chatCompletionCalls = 0;
  let modelCalls = 0;
  let modelCallsByOrganizationId = new Map<string, number>();

  const reset = (nextOptions: KiloApiOptions = {}): void => {
    options = nextOptions;
    chatCompletionCalls = 0;
    modelCalls = 0;
    modelCallsByOrganizationId = new Map();
  };

  const server = createServer((request, response) => {
    void (async (): Promise<void> => {
      try {
        writeCorsHeaders(response);

        if (request.method === 'OPTIONS') {
          response.writeHead(204);
          response.end();
          return;
        }

        if (request.url === '/api/user') {
          sendJson(response, { google_user_email: 'user@kilo.ai' });
          return;
        }

        if (request.url === '/api/organizations') {
          sendJson(response, { organizations: options.organizations ?? [] });
          return;
        }

        if (request.url === '/api/gateway/models') {
          modelCalls += 1;

          const organizationId = request.headers['x-kilocode-organizationid'];
          const scopedOrganizationId = typeof organizationId === 'string' ? organizationId : '';
          const organizationModelCalls =
            (modelCallsByOrganizationId.get(scopedOrganizationId) ?? 0) + 1;

          modelCallsByOrganizationId.set(scopedOrganizationId, organizationModelCalls);

          if (options.beforeModels !== undefined) {
            await options.beforeModels(scopedOrganizationId);
          }

          if (
            modelCalls <= (options.modelFailuresBeforeSuccess ?? 0) ||
            organizationModelCalls <=
              (options.modelFailuresBeforeSuccessByOrganizationId?.[scopedOrganizationId] ?? 0)
          ) {
            response.writeHead(500);
            response.end('failed');
            return;
          }

          sendJson(response, {
            data: [
              {
                id: 'anthropic/claude-sonnet-4',
                name:
                  options.modelNameByOrganizationId?.[scopedOrganizationId] ??
                  'Anthropic: Claude Sonnet 4',
                opencode: { variants: { high: {}, low: {}, medium: {} } },
                preferredIndex: 0,
              },
            ],
          });
          return;
        }

        if (request.url === '/api/gateway/v1/chat/completions') {
          chatCompletionCalls += 1;
          const chatCall = chatCompletionCalls;
          const organizationHeader = request.headers['x-kilocode-organizationid'];
          options.seenChatOrganizationIds?.push(
            typeof organizationHeader === 'string' ? organizationHeader : ''
          );

          if (chatCall === 1 && options.observeFirstChatAbort !== undefined) {
            request.once('close', () => {
              if (!response.writableEnded) {
                options.observeFirstChatAbort?.();
              }
            });
          }

          const body = await readRequestBody(request);
          assert.deepEqual(getRequestToolNames(body), options.toolNames ?? dangerousToolNames);

          if (chatCall === 1 && options.beforeFirstCompletion !== undefined) {
            await options.beforeFirstCompletion();
          }

          if (response.writableEnded) {
            return;
          }

          if (chatCall === 1) {
            sendSse(response, options.firstCompletionEvents ?? defaultFirstCompletionEvents());
            return;
          }

          if (chatCall === 2 && options.secondCompletionEvents !== undefined) {
            sendSse(response, options.secondCompletionEvents);
            return;
          }

          if (chatCall === 3 && options.thirdCompletionEvents !== undefined) {
            sendSse(response, options.thirdCompletionEvents);
            return;
          }

          sendSse(response, [
            {
              choices: [
                {
                  delta: {
                    content: `The selected tab HTML length is ${getToolResultHtmlLength(body)}.`,
                  },
                },
              ],
            },
          ]);
          return;
        }

        response.writeHead(404);
        response.end('not found');
      } catch (error) {
        response.writeHead(500);
        response.end(error instanceof Error ? error.message : String(error));
      }
    })();
  });

  const handle = await listen(server);

  return { ...handle, reset };
};

const startTargetPageServer = (title = 'Kilo extension fixture'): Promise<ServerHandle> =>
  listen(
    createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
<html>
  <head><title>${title}</title></head>
  <body><main><h1>${title}</h1><p>Firefox can inspect this page.</p></main></body>
</html>`);
    })
  );

const runCommand = async (
  command: string,
  args: readonly string[],
  env: Record<string, string>
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: extensionRoot,
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? 'no code'}.`));
    });
  });
};

const waitUntil = async (
  driver: WebDriver,
  condition: () => Promise<boolean>,
  message: string
): Promise<void> => {
  await driver.wait(() => condition(), waitMs, message);
};

const getBodyText = (driver: WebDriver): Promise<string> =>
  driver.findElement(By.css('body')).getText();

const waitForText = async (driver: WebDriver, text: string): Promise<void> => {
  await waitUntil(
    driver,
    async () => {
      const bodyText = await getBodyText(driver);

      return bodyText.includes(text);
    },
    `Timed out waiting for text: ${text}`
  );
};

const waitForTextMatch = async (driver: WebDriver, pattern: RegExp): Promise<void> => {
  await waitUntil(
    driver,
    async () => pattern.test(await getBodyText(driver)),
    `Timed out waiting for text pattern: ${pattern.source}`
  );
};

const waitForTextGone = async (driver: WebDriver, text: string): Promise<void> => {
  await waitUntil(
    driver,
    async () => {
      const bodyText = await getBodyText(driver);

      return !bodyText.includes(text);
    },
    `Timed out waiting for text to disappear: ${text}`
  );
};

const acceptAlertWithText = async (driver: WebDriver, text: string): Promise<void> => {
  await driver.wait(
    async () => {
      try {
        const alert = await driver.switchTo().alert();
        const alertText = await alert.getText();

        if (!alertText.includes(text)) {
          return false;
        }

        await alert.accept();
        return true;
      } catch {
        return false;
      }
    },
    waitMs,
    `Timed out waiting for alert text: ${text}`
  );
};

const findManifestUrl = async (driver: WebDriver): Promise<string> => {
  await driver.get('about:debugging#/runtime/this-firefox');
  await waitForText(driver, 'Kilo Extension');

  const bodyText = await getBodyText(driver);
  const manifestMatch = /Manifest URL\s+(moz-extension:\/\/\S+\/manifest\.json)/u.exec(bodyText);

  if (manifestMatch === null || manifestMatch[1] === undefined) {
    throw new Error(`Firefox add-on manifest URL was not found.\n${bodyText}`);
  }

  return manifestMatch[1];
};

const seedFirefoxAuth = async (driver: WebDriver): Promise<void> => {
  const result = await driver.executeAsyncScript((done: (value: unknown) => void) => {
    const browserApi = (
      globalThis as typeof globalThis & {
        browser?: {
          storage?: {
            local?: {
              set: (items: Record<string, unknown>) => Promise<void>;
            };
          };
        };
      }
    ).browser;

    browserApi?.storage?.local
      ?.set({ kiloAuth: { token: 'token-1', userEmail: 'user@kilo.ai' } })
      .then(() => {
        done('ok');
        return null;
      })
      .catch((error: unknown) => {
        done(error instanceof Error ? error.message : String(error));
      });
  });

  assert.equal(result, 'ok');
};

const seedFirefoxConversation = async (driver: WebDriver, events: unknown[]): Promise<void> => {
  const result = await driver.executeAsyncScript(
    (conversationEvents: unknown[], done: (value: unknown) => void) => {
      const browserApi = (
        globalThis as typeof globalThis & {
          browser?: {
            storage?: {
              local?: {
                set: (items: Record<string, unknown>) => Promise<void>;
              };
            };
          };
        }
      ).browser;

      browserApi?.storage?.local
        ?.set({
          kiloAgentConversations: {
            activeConversationId: 'conversation-1',
            conversations: [
              {
                events: conversationEvents,
                id: 'conversation-1',
                title: 'Conversation 1',
              },
            ],
          },
        })
        .then(() => {
          done('ok');
          return null;
        })
        .catch((error: unknown) => {
          done(error instanceof Error ? error.message : String(error));
        });
    },
    events
  );

  assert.equal(result, 'ok');
};

const waitForStoredFirefoxConversationText = async (
  driver: WebDriver,
  text: string
): Promise<void> => {
  await waitUntil(
    driver,
    async () => {
      const result = await driver.executeAsyncScript(
        (expectedText: string, done: (value: unknown) => void) => {
          const browserApi = (
            globalThis as typeof globalThis & {
              browser?: {
                storage?: {
                  local?: {
                    get: (keys: string[]) => Promise<Record<string, unknown>>;
                  };
                };
              };
            }
          ).browser;

          browserApi?.storage?.local
            ?.get(['kiloAgentConversation', 'kiloAgentConversations'])
            .then(items => {
              done(
                JSON.stringify({
                  conversations: items['kiloAgentConversations'] ?? null,
                  legacyConversation: items['kiloAgentConversation'] ?? null,
                }).includes(expectedText)
              );
              return null;
            })
            .catch((error: unknown) => {
              done(error instanceof Error ? error.message : String(error));
            });
        },
        text
      );

      return result === true;
    },
    `Timed out waiting for stored conversation text: ${text}`
  );
};

const startFirefoxSession = async (): Promise<FirefoxSession> => {
  const options = new firefox.Options();

  options.addArguments('-headless');
  options.setPreference('extensions.install.requireBuiltInCerts', false);
  options.setPreference('xpinstall.signatures.required', false);

  const sessionDriver = await new Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(options)
    .build();

  const targetServers: ServerHandle[] = [];
  let setupSucceeded = false;

  try {
    if (!isFirefoxWebDriver(sessionDriver)) {
      throw new Error('Firefox WebDriver did not expose installAddon.');
    }

    await sessionDriver.installAddon(firefoxZipPath, true);
    const manifestUrl = await findManifestUrl(sessionDriver);
    const sidePanelUrl = manifestUrl.replace('/manifest.json', '/sidepanel.html');
    setupSucceeded = true;

    return {
      close: async () => {
        try {
          await sessionDriver.quit();
        } finally {
          await Promise.all(targetServers.map(server => server.close()));
        }
      },
      driver: sessionDriver,
      openSidePanel: async () => {
        await sessionDriver.switchTo().newWindow('tab');
        await sessionDriver.get(sidePanelUrl);
      },
      openTargetPage: async (title?: string) => {
        const server = await startTargetPageServer(title);

        targetServers.push(server);
        await sessionDriver.switchTo().newWindow('tab');
        await sessionDriver.get(server.url);

        return server;
      },
    };
  } finally {
    if (!setupSucceeded) {
      await sessionDriver.quit();
    }
  }
};

const withSession = async (
  api: KiloApiHandle,
  options: KiloApiOptions,
  run: (session: FirefoxSession) => Promise<void>
): Promise<void> => {
  api.reset(options);

  const session = await startFirefoxSession();

  try {
    await run(session);
  } finally {
    await session.close();
  }
};

const openAuthenticatedPanel = async (session: FirefoxSession): Promise<void> => {
  await session.openSidePanel();
  await seedFirefoxAuth(session.driver);
  await session.driver.navigate().refresh();
  await waitForText(session.driver, 'Kilo');
};

const setSelectByText = async (
  driver: WebDriver,
  ariaLabel: string,
  text: string
): Promise<void> => {
  const result = await driver.executeScript(
    (label: string, optionText: string) => {
      const select = [...document.querySelectorAll('select')].find(
        element => element.getAttribute('aria-label') === label
      );

      if (!(select instanceof HTMLSelectElement)) {
        return `select ${label} not found`;
      }

      const option = [...select.options].find(element => element.textContent?.includes(optionText));

      if (option === undefined) {
        return `option ${optionText} not found`;
      }

      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));

      return true;
    },
    ariaLabel,
    text
  );

  assert.equal(result, true);
};

const setSelectByValue = async (
  driver: WebDriver,
  ariaLabel: string,
  value: string
): Promise<void> => {
  const result = await driver.executeScript(
    (label: string, nextValue: string) => {
      const select = [...document.querySelectorAll('select')].find(
        element => element.getAttribute('aria-label') === label
      );

      if (!(select instanceof HTMLSelectElement)) {
        return `select ${label} not found`;
      }

      select.value = nextValue;
      select.dispatchEvent(new Event('change', { bubbles: true }));

      return true;
    },
    ariaLabel,
    value
  );

  assert.equal(result, true);
};

const getSelectText = async (driver: WebDriver, ariaLabel: string): Promise<string> => {
  const result = await driver.executeScript((label: string) => {
    const select = [...document.querySelectorAll('select')].find(
      element => element.getAttribute('aria-label') === label
    );

    if (!(select instanceof HTMLSelectElement)) {
      return '';
    }

    return select.selectedOptions[0]?.textContent ?? '';
  }, ariaLabel);

  return String(result);
};

const getSelectOptionsText = async (driver: WebDriver, ariaLabel: string): Promise<string> => {
  const result = await driver.executeScript((label: string) => {
    const select = [...document.querySelectorAll('select')].find(
      element => element.getAttribute('aria-label') === label
    );

    if (!(select instanceof HTMLSelectElement)) {
      return '';
    }

    return [...select.options].map(option => option.textContent ?? '').join('\n');
  }, ariaLabel);

  return String(result);
};

const isControlDisabled = async (driver: WebDriver, selector: string): Promise<boolean> => {
  await waitUntil(
    driver,
    async () => {
      const elements = await driver.findElements(By.css(selector));

      return elements.length > 0;
    },
    `Timed out waiting for control ${selector}`
  );

  const element = await driver.findElement(By.css(selector));

  return !(await element.isEnabled());
};

const clickButtonByText = async (driver: WebDriver, text: string): Promise<void> => {
  await driver
    .findElement(By.xpath(`//button[contains(normalize-space(.), ${JSON.stringify(text)})]`))
    .click();
};

const clickButtonByLabel = async (driver: WebDriver, label: string): Promise<void> => {
  await waitUntil(
    driver,
    async () => {
      const elements = await driver.findElements(By.css(`button[aria-label="${label}"]`));

      return elements.length > 0;
    },
    `Timed out waiting for button label: ${label}`
  );
  await driver.findElement(By.css(`button[aria-label="${label}"]`)).click();
};

const waitForButtonByLabel = async (driver: WebDriver, label: string): Promise<void> => {
  await waitUntil(
    driver,
    async () => {
      const elements = await driver.findElements(By.css(`button[aria-label="${label}"]`));

      return elements.length > 0;
    },
    `Timed out waiting for button label: ${label}`
  );
};

const waitForNoButtonByLabel = async (driver: WebDriver, label: string): Promise<void> => {
  await waitUntil(
    driver,
    async () => {
      const elements = await driver.findElements(By.css(`button[aria-label="${label}"]`));

      return elements.length === 0;
    },
    `Timed out waiting for button label to disappear: ${label}`
  );
};

const switchToDangerousMode = async (driver: WebDriver): Promise<void> => {
  await driver.findElement(By.css('button[aria-label^="Safe mode"]')).click();
  await clickButtonByText(driver, 'Dangerous');
};

const sendMessage = async (driver: WebDriver, text: string): Promise<void> => {
  const input = await driver.findElement(By.css('#agent-message'));

  await input.clear();
  await input.sendKeys(text, Key.ENTER);
};

const getButtonByText = (driver: WebDriver, text: string): Promise<WebElement> =>
  driver.findElement(By.xpath(`//button[normalize-space(.)=${JSON.stringify(text)}]`));

const waitForModel = async (driver: WebDriver, text = 'Claude Sonnet 4'): Promise<void> => {
  await waitUntil(
    driver,
    async () => {
      const selectText = await getSelectText(driver, 'Model');

      return selectText.includes(text);
    },
    `Timed out waiting for model ${text}`
  );
};

const waitForTargetTab = async (driver: WebDriver, text: string): Promise<void> => {
  await waitUntil(
    driver,
    async () => {
      const selectText = await getSelectText(driver, 'Target tab');

      return selectText.includes(text);
    },
    `Timed out waiting for target tab ${text}`
  );
};

const waitForTargetOption = async (driver: WebDriver, text: string): Promise<void> => {
  await waitUntil(
    driver,
    async () => {
      const optionsText = await getSelectOptionsText(driver, 'Target tab');

      return optionsText.includes(text);
    },
    `Timed out waiting for target tab option ${text}`
  );
};

const submitDangerousPrompt = async (
  session: FirefoxSession,
  prompt: string,
  targetTitle = 'Kilo extension fixture'
): Promise<void> => {
  await session.openTargetPage(targetTitle);
  await openAuthenticatedPanel(session);
  await waitForModel(session.driver);
  await waitForTargetTab(session.driver, targetTitle);
  await switchToDangerousMode(session.driver);
  await sendMessage(session.driver, prompt);
};

const scenarios: FirefoxScenario[] = [
  {
    name: 'conversation automatically continues through another eval request',
    run: context =>
      withSession(
        context.api,
        {
          secondCompletionEvents: [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        function: {
                          arguments: JSON.stringify({ code: 'return document.title;' }),
                          name: 'eval',
                        },
                        id: 'call_eval_2',
                        index: 0,
                        type: 'function',
                      },
                    ],
                  },
                },
              ],
            },
          ],
          thirdCompletionEvents: [
            { choices: [{ delta: { content: 'Second round finished and final answer ready.' } }] },
          ],
        },
        async session => {
          await submitDangerousPrompt(session, 'Inspect twice');
          await waitForText(session.driver, 'Second round finished and final answer ready.');

          const bodyText = await getBodyText(session.driver);

          assert.equal((bodyText.match(/eval completed/gu) ?? []).length, 2);
          assert.doesNotMatch(bodyText, /requested another eval/u);
        }
      ),
  },
  {
    name: 'new conversation inherits the selected target tab',
    run: context =>
      withSession(context.api, {}, async session => {
        await session.openTargetPage('First target tab');
        await session.openTargetPage('Second target tab');
        await openAuthenticatedPanel(session);
        await waitForModel(session.driver);
        await setSelectByText(session.driver, 'Target tab', 'Second target tab');
        await waitForTargetTab(session.driver, 'Second target tab');

        await clickButtonByLabel(session.driver, 'New conversation');
        await waitForTargetTab(session.driver, 'Second target tab');
      }),
  },
  {
    name: 'conversation tabs can run in parallel',
    run: context => {
      const { promise: pendingFirstCompletion, resolve: releaseFirstCompletion } =
        Promise.withResolvers<void>();

      return withSession(
        context.api,
        {
          beforeFirstCompletion: () => pendingFirstCompletion,
          firstCompletionEvents: [{ choices: [{ delta: { content: 'First tab finished.' } }] }],
          secondCompletionEvents: [{ choices: [{ delta: { content: 'Second tab finished.' } }] }],
          toolNames: ['get_page_snapshot', 'get_element_details', 'find_in_page'],
        },
        async session => {
          try {
            await session.openTargetPage();
            await openAuthenticatedPanel(session);
            await waitForModel(session.driver);
            await waitForTargetTab(session.driver, 'Kilo extension fixture');
            await sendMessage(session.driver, 'First request');
            await waitForText(session.driver, 'Stop');

            await clickButtonByLabel(session.driver, 'New conversation');
            await sendMessage(session.driver, 'Second request');
            await waitForText(session.driver, 'Second tab finished.');

            await clickButtonByText(session.driver, 'First request');
            await waitForText(session.driver, 'Stop');
            releaseFirstCompletion();
            await waitForText(session.driver, 'First tab finished.');

            await clickButtonByText(session.driver, 'Second request');
            await waitForText(session.driver, 'Second tab finished.');
          } finally {
            releaseFirstCompletion();
          }
        }
      );
    },
  },
  {
    name: 'conversation tabs persist across side panel reloads',
    run: context =>
      withSession(
        context.api,
        {
          firstCompletionEvents: [{ choices: [{ delta: { content: 'First persisted reply.' } }] }],
          secondCompletionEvents: [
            { choices: [{ delta: { content: 'Second persisted reply.' } }] },
          ],
          toolNames: ['get_page_snapshot', 'get_element_details', 'find_in_page'],
        },
        async session => {
          await session.openTargetPage();
          await openAuthenticatedPanel(session);
          await waitForModel(session.driver);
          await waitForTargetTab(session.driver, 'Kilo extension fixture');

          await sendMessage(session.driver, 'First persisted');
          await waitForText(session.driver, 'First persisted reply.');
          await clickButtonByLabel(session.driver, 'New conversation');
          await sendMessage(session.driver, 'Second persisted');
          await waitForText(session.driver, 'Second persisted reply.');
          await waitForStoredFirefoxConversationText(session.driver, 'Second persisted reply.');

          await session.driver.navigate().refresh();
          await waitForText(session.driver, 'Second persisted reply.');
          await clickButtonByText(session.driver, 'First persisted');
          await waitForText(session.driver, 'First persisted reply.');
        }
      ),
  },
  {
    name: 'closing a conversation removes only that tab',
    run: context =>
      withSession(
        context.api,
        {
          firstCompletionEvents: [{ choices: [{ delta: { content: 'Keep this reply.' } }] }],
          secondCompletionEvents: [{ choices: [{ delta: { content: 'Close this reply.' } }] }],
          toolNames: ['get_page_snapshot', 'get_element_details', 'find_in_page'],
        },
        async session => {
          await session.openTargetPage();
          await openAuthenticatedPanel(session);
          await waitForModel(session.driver);
          await waitForTargetTab(session.driver, 'Kilo extension fixture');

          await sendMessage(session.driver, 'Keep this');
          await waitForText(session.driver, 'Keep this reply.');
          await clickButtonByLabel(session.driver, 'New conversation');
          await sendMessage(session.driver, 'Close this');
          await waitForText(session.driver, 'Close this reply.');

          await clickButtonByLabel(session.driver, 'Close Close this');
          await acceptAlertWithText(session.driver, 'Close this conversation tab?');
          await waitForTextGone(session.driver, 'Close this reply.');
          await waitForText(session.driver, 'Keep this reply.');

          await clickButtonByLabel(session.driver, 'History');
          await clickButtonByLabel(session.driver, 'Open Close this');
          await waitForText(session.driver, 'Close this reply.');
        }
      ),
  },
  {
    name: 'conversation tab bar scrolls horizontally',
    run: context =>
      withSession(context.api, {}, async session => {
        await session.openTargetPage();
        await openAuthenticatedPanel(session);
        await waitForModel(session.driver);
        await session.driver.manage().window().setRect({ height: 520, width: 320, x: 0, y: 0 });

        for (let index = 0; index < 14; index += 1) {
          await clickButtonByLabel(session.driver, 'New conversation');
        }

        const tabBarState = await session.driver.executeScript(() => {
          const tabBar = document.querySelector('[aria-label="Conversation tabs"]');

          if (!(tabBar instanceof HTMLElement)) {
            throw new Error('Conversation tab bar was not found.');
          }

          return {
            clientWidth: tabBar.clientWidth,
            overflowX: getComputedStyle(tabBar).overflowX,
            scrollWidth: tabBar.scrollWidth,
          };
        });
        const parsedTabBarState = z
          .object({
            clientWidth: z.number(),
            overflowX: z.string(),
            scrollWidth: z.number(),
          })
          .parse(tabBarState);

        assert.equal(parsedTabBarState.overflowX, 'auto');
        assert.ok(parsedTabBarState.scrollWidth > parsedTabBarState.clientWidth);
      }),
  },
  {
    name: 'assistant messages render markdown',
    run: context =>
      withSession(
        context.api,
        {
          firstCompletionEvents: [
            {
              choices: [
                {
                  delta: {
                    content:
                      '### Markdown title\n\nThis has **bold text** and [a link](https://kilo.ai).\n\n- first item',
                  },
                },
              ],
            },
          ],
        },
        async session => {
          await submitDangerousPrompt(session, 'Show markdown');
          await session.driver.findElement(By.xpath('//h3[normalize-space(.)="Markdown title"]'));
          await session.driver.findElement(By.xpath('//strong[normalize-space(.)="bold text"]'));

          const linkHref = await session.driver
            .findElement(By.xpath('//a[normalize-space(.)="a link"]'))
            .getAttribute('href');

          assert.equal(linkHref, 'https://kilo.ai/');
          await session.driver.findElement(
            By.xpath('//li[contains(normalize-space(.), "first item")]')
          );
        }
      ),
  },
  {
    name: 'only the message pane scrolls virtualized overflowing conversation content',
    run: context =>
      withSession(context.api, {}, async session => {
        await openAuthenticatedPanel(session);
        await waitForModel(session.driver);
        await session.driver.manage().window().setRect({ height: 420, width: 360, x: 0, y: 0 });
        await seedFirefoxConversation(
          session.driver,
          Array.from({ length: 80 }, (_value, index) => ({
            id: `overflow-${index}`,
            role: 'assistant',
            text: `Overflow content ${index}`,
            type: 'message',
          }))
        );
        await session.driver.navigate().refresh();
        await waitForText(session.driver, 'Overflow content 79');

        const scrollState = await session.driver.executeScript(() => {
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
            mountedMessageItems: document.querySelectorAll(
              'section[aria-label="Agent conversation"] [data-index]'
            ).length,
          };
        });

        const parsedScrollState = scrollStateSchema.parse(scrollState);

        assert.equal(
          parsedScrollState.documentScrollHeight,
          parsedScrollState.documentClientHeight
        );
        assert.ok(
          parsedScrollState.messagePaneScrollHeight > parsedScrollState.messagePaneClientHeight
        );
        assert.ok(parsedScrollState.mountedMessageItems < 80);
        assert.ok(
          parsedScrollState.messagePaneScrollTop + parsedScrollState.messagePaneClientHeight >=
            parsedScrollState.messagePaneScrollHeight - 4
        );
      }),
  },
  {
    name: 'manual scroll up shows jump to latest without following new messages',
    run: context => {
      const { promise: pendingFirstCompletion, resolve: releaseFirstCompletion } =
        Promise.withResolvers<void>();

      return withSession(
        context.api,
        {
          beforeFirstCompletion: () => pendingFirstCompletion,
          firstCompletionEvents: [
            { choices: [{ delta: { content: 'Delayed Firefox reply arrived.' } }] },
          ],
          toolNames: ['get_page_snapshot', 'get_element_details', 'find_in_page'],
        },
        async session => {
          try {
            await session.openTargetPage();
            await openAuthenticatedPanel(session);
            await waitForModel(session.driver);
            await session.driver.manage().window().setRect({ height: 420, width: 360, x: 0, y: 0 });
            await seedFirefoxConversation(
              session.driver,
              Array.from({ length: 80 }, (_value, index) => ({
                id: `manual-scroll-${index}`,
                role: 'assistant',
                text: `Manual scroll content ${index}`,
                type: 'message',
              }))
            );
            await session.driver.navigate().refresh();
            await waitForText(session.driver, 'Manual scroll content 79');

            await sendMessage(session.driver, 'Wait before replying');
            await waitForText(session.driver, 'Stop');
            await new Promise(resolve => {
              setTimeout(resolve, 100);
            });

            const scrolledUpState = await session.driver.executeScript(() => {
              const conversation = document.querySelector('[aria-label="Agent conversation"]');

              if (!(conversation instanceof HTMLElement)) {
                throw new Error('Agent conversation pane was not found.');
              }

              conversation.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -2400 }));
              conversation.scrollTop = 0;
              conversation.dispatchEvent(new Event('scroll', { bubbles: true }));

              return {
                messagePaneClientHeight: conversation.clientHeight,
                messagePaneScrollHeight: conversation.scrollHeight,
                messagePaneScrollTop: conversation.scrollTop,
              };
            });

            const parsedScrolledUpState = scrollStateSchema
              .omit({
                documentClientHeight: true,
                documentScrollHeight: true,
                mountedMessageItems: true,
              })
              .parse(scrolledUpState);
            await waitForButtonByLabel(session.driver, 'Jump to latest');

            releaseFirstCompletion();
            await waitForStoredFirefoxConversationText(
              session.driver,
              'Delayed Firefox reply arrived.'
            );

            const finalScrollState = await session.driver.executeScript(() => {
              const conversation = document.querySelector('[aria-label="Agent conversation"]');

              if (!(conversation instanceof HTMLElement)) {
                throw new Error('Agent conversation pane was not found.');
              }

              return {
                messagePaneClientHeight: conversation.clientHeight,
                messagePaneScrollHeight: conversation.scrollHeight,
                messagePaneScrollTop: conversation.scrollTop,
              };
            });

            const parsedFinalScrollState = scrollStateSchema
              .omit({
                documentClientHeight: true,
                documentScrollHeight: true,
                mountedMessageItems: true,
              })
              .parse(finalScrollState);

            assert.ok(
              parsedFinalScrollState.messagePaneScrollTop <=
                parsedScrolledUpState.messagePaneScrollTop + 4
            );
            assert.ok(
              parsedFinalScrollState.messagePaneScrollTop +
                parsedFinalScrollState.messagePaneClientHeight <
                parsedFinalScrollState.messagePaneScrollHeight - 16
            );

            await clickButtonByLabel(session.driver, 'Jump to latest');
            await waitForText(session.driver, 'Delayed Firefox reply arrived.');
            await waitForNoButtonByLabel(session.driver, 'Jump to latest');

            const jumpedScrollState = await session.driver.executeScript(() => {
              const conversation = document.querySelector('[aria-label="Agent conversation"]');

              if (!(conversation instanceof HTMLElement)) {
                throw new Error('Agent conversation pane was not found.');
              }

              return {
                messagePaneClientHeight: conversation.clientHeight,
                messagePaneScrollHeight: conversation.scrollHeight,
                messagePaneScrollTop: conversation.scrollTop,
              };
            });
            const parsedJumpedScrollState = scrollStateSchema
              .omit({
                documentClientHeight: true,
                documentScrollHeight: true,
                mountedMessageItems: true,
              })
              .parse(jumpedScrollState);

            assert.ok(
              parsedJumpedScrollState.messagePaneScrollTop +
                parsedJumpedScrollState.messagePaneClientHeight >=
                parsedJumpedScrollState.messagePaneScrollHeight - 16
            );
          } finally {
            releaseFirstCompletion();
          }
        }
      );
    },
  },
  {
    name: 'scrolling back to bottom reactivates automatic scroll to new messages',
    run: context => {
      const { promise: pendingFirstCompletion, resolve: releaseFirstCompletion } =
        Promise.withResolvers<void>();

      return withSession(
        context.api,
        {
          beforeFirstCompletion: () => pendingFirstCompletion,
          firstCompletionEvents: [
            { choices: [{ delta: { content: 'First delayed Firefox reply.' } }] },
          ],
          secondCompletionEvents: [
            { choices: [{ delta: { content: 'Second Firefox reply after bottom.' } }] },
          ],
          toolNames: ['get_page_snapshot', 'get_element_details', 'find_in_page'],
        },
        async session => {
          try {
            await session.openTargetPage();
            await openAuthenticatedPanel(session);
            await waitForModel(session.driver);
            await session.driver.manage().window().setRect({ height: 420, width: 360, x: 0, y: 0 });
            await seedFirefoxConversation(
              session.driver,
              Array.from({ length: 80 }, (_value, index) => ({
                id: `bottom-reactivation-${index}`,
                role: 'assistant',
                text: `Bottom reactivation content ${index}`,
                type: 'message',
              }))
            );
            await session.driver.navigate().refresh();
            await waitForText(session.driver, 'Bottom reactivation content 79');

            await sendMessage(session.driver, 'Wait before first reply');
            await waitForText(session.driver, 'Stop');
            await new Promise(resolve => {
              setTimeout(resolve, 100);
            });

            await session.driver.executeScript(() => {
              const conversation = document.querySelector('[aria-label="Agent conversation"]');

              if (!(conversation instanceof HTMLElement)) {
                throw new Error('Agent conversation pane was not found.');
              }

              conversation.scrollTop = 0;
              conversation.dispatchEvent(new Event('scroll', { bubbles: true }));
            });
            await waitForButtonByLabel(session.driver, 'Jump to latest');

            releaseFirstCompletion();
            await waitForStoredFirefoxConversationText(
              session.driver,
              'First delayed Firefox reply.'
            );

            await session.driver.executeScript(() => {
              const conversation = document.querySelector('[aria-label="Agent conversation"]');

              if (!(conversation instanceof HTMLElement)) {
                throw new Error('Agent conversation pane was not found.');
              }

              conversation.scrollTop = conversation.scrollHeight;
              conversation.dispatchEvent(new Event('scroll', { bubbles: true }));
            });
            await waitForNoButtonByLabel(session.driver, 'Jump to latest');

            await sendMessage(session.driver, 'Reply after bottom');
            await waitForText(session.driver, 'Second Firefox reply after bottom.');

            const finalScrollState = await session.driver.executeScript(() => {
              const conversation = document.querySelector('[aria-label="Agent conversation"]');

              if (!(conversation instanceof HTMLElement)) {
                throw new Error('Agent conversation pane was not found.');
              }

              return {
                messagePaneClientHeight: conversation.clientHeight,
                messagePaneScrollHeight: conversation.scrollHeight,
                messagePaneScrollTop: conversation.scrollTop,
              };
            });
            const parsedFinalScrollState = scrollStateSchema
              .omit({
                documentClientHeight: true,
                documentScrollHeight: true,
                mountedMessageItems: true,
              })
              .parse(finalScrollState);

            assert.ok(
              parsedFinalScrollState.messagePaneScrollTop +
                parsedFinalScrollState.messagePaneClientHeight >=
                parsedFinalScrollState.messagePaneScrollHeight - 16
            );
          } finally {
            releaseFirstCompletion();
          }
        }
      );
    },
  },
  {
    name: 'settings organization picker sends org context to the gateway',
    run: context => {
      const seenChatOrganizationIds: string[] = [];

      return withSession(
        context.api,
        {
          organizations: [{ id: 'org-1', name: 'Acme' }],
          seenChatOrganizationIds,
        },
        async session => {
          await session.openTargetPage();
          await openAuthenticatedPanel(session);
          await waitForModel(session.driver);
          await waitForTargetTab(session.driver, 'Kilo extension fixture');
          await clickButtonByLabel(session.driver, 'Settings');
          await setSelectByValue(session.driver, 'Credit account', 'org-1');
          await clickButtonByLabel(session.driver, 'Close settings');
          await switchToDangerousMode(session.driver);
          await sendMessage(session.driver, 'Inspect this tab');
          await waitForTextMatch(session.driver, /The selected tab HTML length is [0-9]+\./u);
          assert.ok(seenChatOrganizationIds.includes('org-1'));
        }
      );
    },
  },
  {
    name: 'native side panel is outside the page DOM',
    run: context =>
      withSession(context.api, {}, async session => {
        await session.openTargetPage();

        const hasSidebar = await session.driver.executeScript(
          () => document.querySelector('kilo-sidebar') !== null
        );

        assert.equal(hasSidebar, false);
        await session.openSidePanel();
        await waitForText(session.driver, 'Sign in');
        await waitForTextGone(session.driver, 'No actions yet');
      }),
  },
  {
    name: 'dangerous mode conversation can eval against a normal tab',
    run: context =>
      withSession(context.api, {}, async session => {
        await submitDangerousPrompt(session, 'Inspect this tab and tell me the HTML length');
        await waitForText(session.driver, 'eval completed');
        await waitForTextMatch(session.driver, /The selected tab HTML length is [0-9]+\./u);
        await clickButtonByLabel(session.driver, 'New conversation');
        await waitForTextGone(session.driver, 'eval completed');
        await waitForText(session.driver, 'Pick a tab and ask Kilo to inspect it.');
      }),
  },
  {
    name: 'safe mode conversation reads the selected tab with safe tools',
    run: context =>
      withSession(
        context.api,
        {
          firstCompletionEvents: [
            { choices: [{ delta: { content: 'I will read the page.' } }] },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        function: {
                          arguments: JSON.stringify({}),
                          name: 'get_page_snapshot',
                        },
                        id: 'call_snapshot_1',
                        index: 0,
                        type: 'function',
                      },
                    ],
                  },
                },
              ],
            },
          ],
          secondCompletionEvents: [
            { choices: [{ delta: { content: 'The page is the Kilo extension fixture.' } }] },
          ],
          toolNames: ['get_page_snapshot', 'get_element_details', 'find_in_page'],
        },
        async session => {
          await session.openTargetPage();
          await openAuthenticatedPanel(session);
          await waitForModel(session.driver);
          await waitForTargetTab(session.driver, 'Kilo extension fixture');
          await sendMessage(session.driver, 'What is on this page?');
          await waitForText(session.driver, 'get_page_snapshot completed');
          await waitForText(session.driver, 'The page is the Kilo extension fixture.');
        }
      ),
  },
  {
    name: 'dangerous mode conversation can use safe read tools',
    run: context =>
      withSession(
        context.api,
        {
          firstCompletionEvents: [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        function: {
                          arguments: JSON.stringify({}),
                          name: 'get_page_snapshot',
                        },
                        id: 'call_snapshot_1',
                        index: 0,
                        type: 'function',
                      },
                    ],
                  },
                },
              ],
            },
          ],
          secondCompletionEvents: [
            { choices: [{ delta: { content: 'Dangerous mode read the page safely first.' } }] },
          ],
        },
        async session => {
          await session.openTargetPage();
          await openAuthenticatedPanel(session);
          await waitForModel(session.driver);
          await waitForTargetTab(session.driver, 'Kilo extension fixture');
          await switchToDangerousMode(session.driver);
          await sendMessage(session.driver, 'Read this page safely first');
          await waitForText(session.driver, 'get_page_snapshot completed');
          await waitForText(session.driver, 'Dangerous mode read the page safely first.');
        }
      ),
  },
  {
    name: 'running conversation can be stopped',
    run: context => {
      const { promise: pendingCompletion, resolve: releaseCompletion } =
        Promise.withResolvers<void>();

      return withSession(
        context.api,
        { beforeFirstCompletion: () => pendingCompletion },
        async session => {
          try {
            await submitDangerousPrompt(session, 'Inspect this tab');
            await waitForText(session.driver, 'Stop');
            assert.equal(
              await isControlDisabled(session.driver, 'select[aria-label="Target tab"]'),
              true
            );

            await clickButtonByText(session.driver, 'Stop');
            await waitForText(session.driver, 'Stopped.');
            await getButtonByText(session.driver, 'Send message');
            assert.equal(
              await isControlDisabled(session.driver, 'select[aria-label="Target tab"]'),
              false
            );
          } finally {
            releaseCompletion();
          }
        }
      );
    },
  },
  {
    name: 'target tab list updates automatically',
    run: context =>
      withSession(context.api, {}, async session => {
        await session.openTargetPage();
        await openAuthenticatedPanel(session);
        await waitForTargetTab(session.driver, 'Kilo extension fixture');
        const sidePanelHandle = await session.driver.getWindowHandle();

        await session.openTargetPage('Refreshed target tab');
        await session.driver.switchTo().window(sidePanelHandle);
        await waitForTargetOption(session.driver, 'Refreshed target tab');
      }),
  },
  {
    name: 'closing the selected tab clears the target tab selection',
    run: context =>
      withSession(context.api, {}, async session => {
        await session.openTargetPage();
        const targetPageHandle = await session.driver.getWindowHandle();

        await openAuthenticatedPanel(session);
        await waitForTargetTab(session.driver, 'Kilo extension fixture');
        const sidePanelHandle = await session.driver.getWindowHandle();

        await session.driver.switchTo().window(targetPageHandle);
        await session.driver.close();
        await session.driver.switchTo().window(sidePanelHandle);
        await waitForTargetTab(session.driver, 'No tab selected');
        await session.driver
          .findElement(By.css('#agent-message'))
          .sendKeys('Inspect the closed tab');
        assert.equal(await isControlDisabled(session.driver, 'button[type="submit"]'), true);
      }),
  },
  {
    name: 'closing the selected tab aborts a running request',
    run: context => {
      const { promise: pendingCompletion, resolve: releaseCompletion } =
        Promise.withResolvers<void>();
      const { promise: chatAborted, resolve: markChatAborted } = Promise.withResolvers<void>();

      return withSession(
        context.api,
        {
          beforeFirstCompletion: () => pendingCompletion,
          observeFirstChatAbort: markChatAborted,
        },
        async session => {
          try {
            await session.openTargetPage();
            const targetPageHandle = await session.driver.getWindowHandle();

            await openAuthenticatedPanel(session);
            await waitForTargetTab(session.driver, 'Kilo extension fixture');
            const sidePanelHandle = await session.driver.getWindowHandle();

            await switchToDangerousMode(session.driver);
            await sendMessage(session.driver, 'Inspect this tab');
            await waitForText(session.driver, 'Stop');
            await session.driver.switchTo().window(targetPageHandle);
            await session.driver.close();
            await session.driver.switchTo().window(sidePanelHandle);
            await waitForTargetTab(session.driver, 'No tab selected');
            await chatAborted;
          } finally {
            releaseCompletion();
          }
        }
      );
    },
  },
  {
    name: 'conversation survives side panel reload',
    run: context =>
      withSession(context.api, {}, async session => {
        await session.openTargetPage();
        await openAuthenticatedPanel(session);
        await waitForModel(session.driver);
        await switchToDangerousMode(session.driver);
        await sendMessage(session.driver, 'Remember this after reload');
        await waitForText(session.driver, 'Remember this after reload');
        await waitForStoredFirefoxConversationText(session.driver, 'Remember this after reload');
        await session.driver.navigate().refresh();
        await waitForText(session.driver, 'Remember this after reload');
      }),
  },
  {
    name: 'model and thinking controls wait for the model catalog',
    run: context => {
      const { promise: pendingModels, resolve: releaseModels } = Promise.withResolvers<void>();

      return withSession(context.api, { beforeModels: () => pendingModels }, async session => {
        try {
          await session.openSidePanel();
          await seedFirefoxAuth(session.driver);
          await session.driver.navigate().refresh();
          assert.equal(await isControlDisabled(session.driver, 'select[aria-label="Model"]'), true);
          assert.match(await getSelectText(session.driver, 'Model'), /Loading models/u);
          assert.equal(
            await isControlDisabled(session.driver, 'select[aria-label="Thinking effort"]'),
            true
          );
          await session.driver.findElement(By.css('#agent-message')).sendKeys('Inspect this tab');
          assert.equal(await isControlDisabled(session.driver, 'button[type="submit"]'), true);

          releaseModels();
          await waitForModel(session.driver);
          assert.equal(
            await isControlDisabled(session.driver, 'select[aria-label="Model"]'),
            false
          );
          assert.equal(
            await isControlDisabled(session.driver, 'select[aria-label="Thinking effort"]'),
            false
          );
        } finally {
          releaseModels();
        }
      });
    },
  },
  {
    name: 'model catalog failures can be retried',
    run: context =>
      withSession(context.api, { modelFailuresBeforeSuccess: 1 }, async session => {
        await openAuthenticatedPanel(session);
        await waitForText(session.driver, 'Could not load models.');
        assert.equal(await isControlDisabled(session.driver, 'select[aria-label="Model"]'), true);
        await clickButtonByText(session.driver, 'Retry models');
        await waitForModel(session.driver);
        assert.equal(await isControlDisabled(session.driver, 'select[aria-label="Model"]'), false);
      }),
  },
  {
    name: 'switching credit accounts clears the model while the next catalog loads',
    run: context => {
      const { promise: pendingOrgTwoModels, resolve: releaseOrgTwoModels } =
        Promise.withResolvers<void>();
      const { promise: orgTwoModelsRequested, resolve: markOrgTwoModelsRequested } =
        Promise.withResolvers<void>();

      return withSession(
        context.api,
        {
          beforeModels: organizationId => {
            if (organizationId === 'org-2') {
              markOrgTwoModelsRequested();
              return pendingOrgTwoModels;
            }

            return Promise.resolve();
          },
          modelNameByOrganizationId: { 'org-2': 'Provider: Org Two Model' },
          organizations: [{ id: 'org-2', name: 'Beta' }],
        },
        async session => {
          try {
            await session.openTargetPage();
            await openAuthenticatedPanel(session);
            await waitForModel(session.driver);
            await session.driver.findElement(By.css('#agent-message')).sendKeys('Inspect this tab');
            assert.equal(await isControlDisabled(session.driver, 'button[type="submit"]'), false);
            await clickButtonByLabel(session.driver, 'Settings');
            await setSelectByValue(session.driver, 'Credit account', 'org-2');
            await orgTwoModelsRequested;
            await clickButtonByLabel(session.driver, 'Close settings');
            assert.equal(
              await isControlDisabled(session.driver, 'select[aria-label="Model"]'),
              true
            );
            assert.match(await getSelectText(session.driver, 'Model'), /Loading models/u);
            assert.equal(await isControlDisabled(session.driver, 'button[type="submit"]'), true);
            releaseOrgTwoModels();
            await waitForModel(session.driver, 'Org Two Model');
          } finally {
            releaseOrgTwoModels();
          }
        }
      );
    },
  },
  {
    name: 'stale organization model loads cannot overwrite the current catalog',
    run: context => {
      const { promise: pendingOrgOneModels, resolve: releaseOrgOneModels } =
        Promise.withResolvers<void>();
      const { promise: orgOneModelsRequested, resolve: markOrgOneModelsRequested } =
        Promise.withResolvers<void>();
      let orgOneCalls = 0;

      return withSession(
        context.api,
        {
          beforeModels: organizationId => {
            if (organizationId === 'org-1') {
              orgOneCalls += 1;

              if (orgOneCalls === 2) {
                markOrgOneModelsRequested();
                return pendingOrgOneModels;
              }
            }

            return Promise.resolve();
          },
          modelFailuresBeforeSuccessByOrganizationId: { 'org-1': 1 },
          modelNameByOrganizationId: {
            'org-1': 'Provider: Org One Model',
            'org-2': 'Provider: Org Two Model',
          },
          organizations: [
            { id: 'org-1', name: 'Acme' },
            { id: 'org-2', name: 'Beta' },
          ],
        },
        async session => {
          try {
            await openAuthenticatedPanel(session);
            await clickButtonByLabel(session.driver, 'Settings');
            await setSelectByValue(session.driver, 'Credit account', 'org-1');
            await clickButtonByLabel(session.driver, 'Close settings');
            await waitForText(session.driver, 'Could not load models.');
            await clickButtonByText(session.driver, 'Retry models');
            await orgOneModelsRequested;
            await clickButtonByLabel(session.driver, 'Settings');
            await setSelectByValue(session.driver, 'Credit account', 'org-2');
            await clickButtonByLabel(session.driver, 'Close settings');
            await waitForModel(session.driver, 'Org Two Model');
            releaseOrgOneModels();
            await new Promise(resolve => {
              setTimeout(resolve, 250);
            });
            assert.match(await getSelectText(session.driver, 'Model'), /Org Two Model/u);
          } finally {
            releaseOrgOneModels();
          }
        }
      );
    },
  },
  {
    name: 'new conversation keeps the running request in its original tab',
    run: context => {
      const { promise: pendingCompletion, resolve: releaseCompletion } =
        Promise.withResolvers<void>();

      return withSession(
        context.api,
        {
          beforeFirstCompletion: () => pendingCompletion,
          firstCompletionEvents: [{ choices: [{ delta: { content: 'Original tab completed.' } }] }],
          toolNames: ['get_page_snapshot', 'get_element_details', 'find_in_page'],
        },
        async session => {
          try {
            await session.openTargetPage();
            await openAuthenticatedPanel(session);
            await waitForModel(session.driver);
            await waitForTargetTab(session.driver, 'Kilo extension fixture');
            await sendMessage(session.driver, 'Original tab');
            await waitForText(session.driver, 'Stop');
            await clickButtonByLabel(session.driver, 'New conversation');
            await waitForText(session.driver, 'Pick a tab and ask Kilo to inspect it.');
            await clickButtonByText(session.driver, 'Original tab');
            await waitForText(session.driver, 'Stop');
            releaseCompletion();
            await waitForText(session.driver, 'Original tab completed.');
          } finally {
            releaseCompletion();
          }
        }
      );
    },
  },
];

assert.deepStrictEqual(
  scenarios.map(scenario => scenario.name),
  chromeWorkflowNames
);

const main = async (): Promise<void> => {
  const api = await startKiloApiServer();

  try {
    await runCommand('pnpm', ['run', 'zip:firefox'], {
      VITE_KILO_API_BASE_URL: api.url,
    });

    for (const scenario of scenarios) {
      process.stdout.write(`Firefox e2e: ${scenario.name} ... `);
      await scenario.run({ api });
      process.stdout.write('passed\n');
    }

    console.log(`Firefox e2e passed ${scenarios.length}/${chromeWorkflowNames.length} workflows.`);
  } finally {
    await api.close();
  }
};

await main();
