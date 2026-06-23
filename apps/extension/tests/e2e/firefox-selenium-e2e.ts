/* eslint-disable import/no-nodejs-modules, max-lines, promise/avoid-new, promise/no-callback-in-promise, promise/prefer-await-to-callbacks */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Builder, By, Key, until } from 'selenium-webdriver';
import type { WebDriver } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox';

const extensionRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '../..');
const firefoxZipPath = resolvePath(extensionRoot, '.output/kilo-extension-0.0.0-firefox.zip');

interface ServerHandle {
  readonly close: () => Promise<void>;
  readonly url: string;
}

type FirefoxWebDriver = WebDriver & {
  readonly installAddon: (path: string, temporary: boolean) => Promise<string>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFirefoxWebDriver = (driver: WebDriver): driver is FirefoxWebDriver => {
  const candidate: unknown = driver;

  return isRecord(candidate) && typeof candidate['installAddon'] === 'function';
};

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

const readRequestBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: string[] = [];

  for await (const chunk of request) {
    chunks.push(String(chunk));
  }

  const body = chunks.join('');

  return body === '' ? undefined : JSON.parse(body);
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

const startKiloApiServer = (): Promise<ServerHandle> => {
  let chatCompletionCalls = 0;

  return listen(
    createServer((request, response) => {
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
            sendJson(response, { organizations: [] });
            return;
          }

          if (request.url === '/api/gateway/models') {
            sendJson(response, {
              data: [
                {
                  id: 'anthropic/claude-sonnet-4',
                  name: 'Anthropic: Claude Sonnet 4',
                  opencode: { variants: { high: {}, low: {}, medium: {} } },
                  preferredIndex: 0,
                },
              ],
            });
            return;
          }

          if (request.url === '/api/gateway/v1/chat/completions') {
            chatCompletionCalls += 1;
            const body = await readRequestBody(request);

            if (chatCompletionCalls === 1) {
              sendSse(response, [
                { choices: [{ delta: { content: 'I will inspect Firefox.' } }] },
                {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            function: {
                              arguments: JSON.stringify({
                                code: 'return document.documentElement.outerHTML.length;',
                              }),
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
              ]);
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
    })
  );
};

const startTargetPageServer = (): Promise<ServerHandle> =>
  listen(
    createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
<html>
  <head><title>Firefox target tab</title></head>
  <body><main><h1>Firefox target tab</h1><p>Firefox can inspect this page.</p></main></body>
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

const waitForText = async (driver: WebDriver, text: string): Promise<void> => {
  await driver.wait(
    until.elementLocated(By.xpath(`//*[contains(normalize-space(.), ${JSON.stringify(text)})]`)),
    15_000
  );
};

const findManifestUrl = async (driver: WebDriver): Promise<string> => {
  await driver.get('about:debugging#/runtime/this-firefox');
  await waitForText(driver, 'Kilo Extension');

  const bodyText = await driver.findElement(By.css('body')).getText();
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

const main = async (): Promise<void> => {
  const api = await startKiloApiServer();
  let target: ServerHandle | undefined = undefined;
  let driver: FirefoxWebDriver | undefined = undefined;

  try {
    await runCommand('pnpm', ['run', 'zip:firefox'], {
      VITE_KILO_API_BASE_URL: api.url,
    });

    target = await startTargetPageServer();

    const options = new firefox.Options();
    options.addArguments('-headless');
    options.setPreference('extensions.install.requireBuiltInCerts', false);
    options.setPreference('xpinstall.signatures.required', false);

    const sessionDriver = await new Builder()
      .forBrowser('firefox')
      .setFirefoxOptions(options)
      .build();

    if (!isFirefoxWebDriver(sessionDriver)) {
      throw new Error('Firefox WebDriver did not expose installAddon.');
    }

    driver = sessionDriver;

    await sessionDriver.installAddon(firefoxZipPath, true);
    const manifestUrl = await findManifestUrl(sessionDriver);

    await sessionDriver.switchTo().newWindow('tab');
    await sessionDriver.get(target.url);

    await sessionDriver.switchTo().newWindow('tab');
    await sessionDriver.get(manifestUrl.replace('/manifest.json', '/sidepanel.html'));
    await seedFirefoxAuth(sessionDriver);
    await sessionDriver.navigate().refresh();

    await waitForText(sessionDriver, 'Claude Sonnet 4');
    await waitForText(sessionDriver, 'Firefox target tab');

    await sessionDriver.findElement(By.css('button[aria-label^="Safe mode"]')).click();
    await sessionDriver.findElement(By.xpath("//button[.//span[text()='Dangerous']]")).click();
    await sessionDriver
      .findElement(By.css('#agent-message'))
      .sendKeys('Inspect this tab', Key.ENTER);

    await waitForText(sessionDriver, 'I will inspect Firefox.');
    await waitForText(sessionDriver, 'eval completed');
    await waitForText(sessionDriver, 'The selected tab HTML length is');

    const bodyText = await sessionDriver.findElement(By.css('body')).getText();

    assert.match(bodyText, /The selected tab HTML length is \d+\./u);
    assert.doesNotMatch(bodyText, /The selected tab HTML length is undefined\./u);

    console.log('Firefox e2e passed.');
  } finally {
    if (driver !== undefined) {
      await driver.quit();
    }

    if (target !== undefined) {
      await target.close();
    }

    await api.close();
  }
};

await main();
