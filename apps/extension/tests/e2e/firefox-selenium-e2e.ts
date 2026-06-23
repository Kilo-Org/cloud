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

const extensionRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '../..');
const firefoxZipPath = resolvePath(extensionRoot, '.output/kilo-extension-0.0.0-firefox.zip');
const waitMs = 15_000;

const chromeWorkflowNames = [
  'conversation automatically continues through another eval request',
  'new conversation keeps the selected target tab',
  'assistant messages render markdown',
  'only the message pane scrolls virtualized overflowing conversation content',
  'settings organization picker sends org context to the gateway',
  'native side panel is outside the page DOM',
  'dangerous mode conversation can eval against a normal tab',
  'safe mode conversation reads the selected tab with safe tools',
  'running conversation can be stopped',
  'target tab list can be refreshed',
  'conversation survives side panel reload',
  'model and thinking controls wait for the model catalog',
  'model catalog failures can be retried',
  'switching credit accounts clears the model while the next catalog loads',
  'stale organization model loads cannot overwrite the current catalog',
  'new conversation aborts a running request',
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

const isFirefoxWebDriver = (driver: WebDriver): driver is FirefoxWebDriver => {
  const candidate: unknown = driver;

  return isRecord(candidate) && typeof candidate['installAddon'] === 'function';
};

const chatCompletionStreamResponse = (events: unknown[]): string =>
  `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;

const defaultEvalCode = 'return document.documentElement.outerHTML.length;';

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

  return body === '' ? undefined : JSON.parse(body);
};

const getToolResultHtmlLength = (body: unknown): string => {
  if (!isRecord(body) || !Array.isArray(body['messages'])) {
    return 'unknown';
  }

  const toolMessage = body['messages'].find(
    (message): message is Record<string, unknown> =>
      isRecord(message) && message['role'] === 'tool' && typeof message['content'] === 'string'
  );

  if (toolMessage === undefined) {
    return 'unknown';
  }

  const toolResult: unknown = JSON.parse(String(toolMessage['content']));

  if (!isRecord(toolResult) || typeof toolResult['value'] !== 'number') {
    return 'unknown';
  }

  return String(toolResult['value']);
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
  await driver.findElement(By.css(`button[aria-label="${label}"]`)).click();
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
    name: 'new conversation keeps the selected target tab',
    run: context =>
      withSession(context.api, {}, async session => {
        await session.openTargetPage('First target tab');
        await session.openTargetPage('Second target tab');
        await openAuthenticatedPanel(session);
        await waitForModel(session.driver);
        await setSelectByText(session.driver, 'Target tab', 'Second target tab');
        assert.match(await getSelectText(session.driver, 'Target tab'), /Second target tab/u);

        await clickButtonByLabel(session.driver, 'New conversation');
        assert.match(await getSelectText(session.driver, 'Target tab'), /Second target tab/u);
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

        for (let index = 0; index < 80; index += 1) {
          await sendMessage(session.driver, `message ${index}`);
        }

        await waitForText(session.driver, 'Pick a target tab first.');

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

        assert.ok(isRecord(scrollState));
        assert.equal(scrollState['documentScrollHeight'], scrollState['documentClientHeight']);
        assert.ok(
          Number(scrollState['messagePaneScrollHeight']) >
            Number(scrollState['messagePaneClientHeight'])
        );
        assert.ok(Number(scrollState['mountedMessageItems']) < 80);
        assert.ok(
          Number(scrollState['messagePaneScrollTop']) +
            Number(scrollState['messagePaneClientHeight']) >=
            Number(scrollState['messagePaneScrollHeight']) - 4
        );
      }),
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
          await clickButtonByLabel(session.driver, 'Settings');
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
    name: 'target tab list can be refreshed',
    run: context =>
      withSession(context.api, {}, async session => {
        await session.openTargetPage();
        await openAuthenticatedPanel(session);
        await waitForTargetTab(session.driver, 'Kilo extension fixture');
        const sidePanelHandle = await session.driver.getWindowHandle();

        await session.openTargetPage('Refreshed target tab');
        await session.driver.switchTo().window(sidePanelHandle);
        await clickButtonByLabel(session.driver, 'Refresh tabs');
        await waitForTargetOption(session.driver, 'Refreshed target tab');
      }),
  },
  {
    name: 'conversation survives side panel reload',
    run: context =>
      withSession(context.api, {}, async session => {
        await openAuthenticatedPanel(session);
        await waitForModel(session.driver);
        await sendMessage(session.driver, 'Remember this after reload');
        await waitForText(session.driver, 'Pick a target tab first.');
        await session.driver.navigate().refresh();
        await waitForText(session.driver, 'Remember this after reload');
        await waitForText(session.driver, 'Pick a target tab first.');
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
            await openAuthenticatedPanel(session);
            await waitForModel(session.driver);
            await session.driver.findElement(By.css('#agent-message')).sendKeys('Inspect this tab');
            assert.equal(await isControlDisabled(session.driver, 'button[type="submit"]'), false);
            await clickButtonByLabel(session.driver, 'Settings');
            await setSelectByValue(session.driver, 'Credit account', 'org-2');
            await orgTwoModelsRequested;
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
            await waitForText(session.driver, 'Could not load models.');
            await clickButtonByText(session.driver, 'Retry models');
            await orgOneModelsRequested;
            await setSelectByValue(session.driver, 'Credit account', 'org-2');
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
    name: 'new conversation aborts a running request',
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
            await submitDangerousPrompt(session, 'Inspect this tab');
            await waitForText(session.driver, 'Stop');
            await clickButtonByLabel(session.driver, 'New conversation');
            await chatAborted;
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
