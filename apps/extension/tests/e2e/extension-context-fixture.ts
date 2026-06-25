/* eslint-disable import/no-nodejs-modules, promise/avoid-new, promise/prefer-await-to-callbacks */
import { chromium, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { access, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

export const extensionPath = resolvePath(import.meta.dirname, '../../.output/chrome-mv3');

export const startFixtureServer = async ({
  title = 'Kilo extension fixture',
}: {
  title?: string;
} = {}): Promise<{ close: () => Promise<void>; url: string }> => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`
      <!doctype html>
      <html>
        <head><title>${title}</title></head>
        <body>
          <main>
            <h1>${title}</h1>
            <p>This page exists so content scripts run in a normal HTTP tab.</p>
          </main>
        </body>
      </html>
    `);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Fixture server did not start on a TCP port.');
  }

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
    url: `http://127.0.0.1:${address.port}`,
  };
};

export const launchExtensionContext = async (): Promise<{
  context: BrowserContext;
  extensionId: string;
  userDataDir: string;
}> => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kilo-extension-e2e-'));
  await access(join(extensionPath, 'manifest.json'));
  const isHeaded = process.env['EXTENSION_E2E_HEADED'] === '1';

  const context = await chromium.launchPersistentContext(userDataDir, {
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    channel: 'chromium',
    headless: !isHeaded,
  });

  const [existingServiceWorker] = context.serviceWorkers();
  const serviceWorker = existingServiceWorker ?? (await context.waitForEvent('serviceworker'));

  const extensionId = new URL(serviceWorker.url()).host;

  return { context, extensionId, userDataDir };
};

export const setExtensionStorage = async (
  page: Page,
  items: Record<string, unknown>
): Promise<void> => {
  await page.evaluate(
    storageItems =>
      new Promise<void>((resolve, reject) => {
        const chromeApi = (
          globalThis as typeof globalThis & {
            chrome?: {
              runtime?: { lastError?: { message?: string } };
              storage?: {
                local?: {
                  set: (items: Record<string, unknown>, callback: () => void) => void;
                };
              };
            };
          }
        ).chrome;

        const runtime = chromeApi?.runtime;
        const storage = chromeApi?.storage?.local;

        if (runtime === undefined || storage === undefined) {
          reject(new Error('Extension runtime storage is unavailable.'));
          return;
        }

        storage.set(storageItems, () => {
          const message = runtime.lastError?.message;

          if (message !== undefined && message !== '') {
            reject(new Error(message));
            return;
          }

          resolve();
        });
      }),
    items
  );
};

export const seedExtensionAuth = (page: Page): Promise<void> =>
  setExtensionStorage(page, { kiloAuth: { token: 'token-1', userEmail: 'user@kilo.ai' } });

export const waitForStoredConversationText = async (page: Page, text: string): Promise<void> => {
  await expect
    .poll(
      () =>
        page.evaluate(
          expectedText =>
            new Promise<boolean>((resolve, reject) => {
              const chromeApi = (
                globalThis as typeof globalThis & {
                  chrome?: {
                    runtime?: { lastError?: { message?: string } };
                    storage?: {
                      local?: {
                        get: (
                          keys: string[],
                          callback: (items: Record<string, unknown>) => void
                        ) => void;
                      };
                    };
                  };
                }
              ).chrome;

              const runtime = chromeApi?.runtime;
              const storage = chromeApi?.storage?.local;

              if (runtime === undefined || storage === undefined) {
                reject(new Error('Extension runtime storage is unavailable.'));
                return;
              }

              storage.get(['kiloAgentConversation', 'kiloAgentConversations'], items => {
                const message = runtime.lastError?.message;

                if (message !== undefined && message !== '') {
                  reject(new Error(message));
                  return;
                }

                resolve(
                  JSON.stringify({
                    conversations: items['kiloAgentConversations'] ?? null,
                    legacyConversation: items['kiloAgentConversation'] ?? null,
                  }).includes(expectedText)
                );
              });
            }),
          text
        ),
      { timeout: 5000 }
    )
    .toBe(true);
};

export const holdConversationScrolledUp = (
  page: Page,
  frames: number
): Promise<{ everRecapturedToBottom: boolean }> =>
  page.evaluate(
    frameCount =>
      new Promise<{ everRecapturedToBottom: boolean }>(resolve => {
        const pane = document.querySelector('[aria-label="Agent conversation"]');

        if (!(pane instanceof HTMLElement)) {
          throw new Error('Agent conversation pane was not found.');
        }

        let remainingFrames = frameCount;
        let hasForcedTop = false;
        let everRecapturedToBottom = false;
        const dragToTop = (): void => {
          // Before re-forcing the top, look at where the previous frame left us. If anything scrolled us back to the bottom after we had already dragged up, the reply stole focus during the window this helper is holding open.
          if (hasForcedTop && pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 16) {
            everRecapturedToBottom = true;
          }

          pane.scrollTop = 0;
          hasForcedTop = true;
          remainingFrames -= 1;

          if (remainingFrames > 0) {
            requestAnimationFrame(dragToTop);
            return;
          }

          resolve({ everRecapturedToBottom });
        };

        requestAnimationFrame(dragToTop);
      }),
    frames
  );
