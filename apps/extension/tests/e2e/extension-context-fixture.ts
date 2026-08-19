/* eslint-disable import/no-nodejs-modules, max-lines, promise/avoid-new, promise/prefer-await-to-callbacks */
import { chromium, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { access, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import {
  applyPosthogE2eBrowserWorkarounds,
  EXTENSION_E2E_LAUNCH_ARGS,
  EXTENSION_E2E_USER_AGENT,
  installPosthogStub,
} from './posthog-fixture';
import type { NormalizedPosthogEvent } from './posthog-fixture';

export const extensionPath = resolvePath(import.meta.dirname, '../../.output/chrome-mv3');

export const startFixtureServer = async ({
  bodyHtml,
  pathHtml,
  title = 'Kilo extension fixture',
}: {
  bodyHtml?: string;
  pathHtml?: Record<string, string>;
  title?: string;
} = {}): Promise<{ close: () => Promise<void>; url: string }> => {
  const fallbackHtml = `<!doctype html>
<html>
  <head><title>${title}</title></head>
  <body>
    <main>
      <h1>${title}</h1>
      ${bodyHtml ?? '<p>This page exists so content scripts run in a normal HTTP tab.</p>'}
    </main>
  </body>
</html>`;
  const server = createServer((request, response) => {
    const requestPath = (request.url ?? '/').split('?')[0] ?? '/';
    const html = pathHtml?.[requestPath] ?? fallbackHtml;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
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
        // Force-close idle and active connections so server.close does NOT
        // Wait for the browser keep-alive connection to drain. Without this
        // The teardown hangs for ~55 s until the test times out.
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
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
  /** `/flags` and `/decide/` URLs that hit the stub (must stay empty with flags disabled). */
  posthogFlagsOrDecideHits: string[];
  /** Capture-class PostHog events (normalized). Additive; existing callers ignore it. */
  posthogRequests: NormalizedPosthogEvent[];
  userDataDir: string;
}> => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kilo-extension-e2e-'));
  await access(join(extensionPath, 'manifest.json'));
  const isHeaded = process.env['EXTENSION_E2E_HEADED'] === '1';

  const context = await chromium.launchPersistentContext(userDataDir, {
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      ...EXTENSION_E2E_LAUNCH_ARGS,
    ],
    channel: process.env['EXTENSION_E2E_CHANNEL'] === 'chrome' ? 'chrome' : 'chromium',
    headless: !isHeaded,
    ignoreDefaultArgs: ['--enable-automation'],
    userAgent: EXTENSION_E2E_USER_AGENT,
  });

  await applyPosthogE2eBrowserWorkarounds(context);
  const posthogRecorder = await installPosthogStub(context);

  const [existingServiceWorker] = context.serviceWorkers();
  const serviceWorker = existingServiceWorker ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(serviceWorker.url()).host;

  return {
    context,
    extensionId,
    posthogFlagsOrDecideHits: posthogRecorder.flagsOrDecideHits,
    posthogRequests: posthogRecorder.events,
    userDataDir,
  };
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

export const setExtensionSyncStorage = async (
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
                sync?: {
                  set: (items: Record<string, unknown>, callback: () => void) => void;
                };
              };
            };
          }
        ).chrome;

        const runtime = chromeApi?.runtime;
        const storage = chromeApi?.storage?.sync;

        if (runtime === undefined || storage === undefined) {
          reject(new Error('Extension sync storage is unavailable.'));
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

export const readExtensionSyncStorage = (page: Page, key: string): Promise<unknown> =>
  page.evaluate(
    storageKey =>
      new Promise<unknown>((resolve, reject) => {
        const chromeApi = (
          globalThis as typeof globalThis & {
            chrome?: {
              runtime?: { lastError?: { message?: string } };
              storage?: {
                sync?: {
                  get: (keys: string[], callback: (items: Record<string, unknown>) => void) => void;
                };
              };
            };
          }
        ).chrome;

        const runtime = chromeApi?.runtime;
        const storage = chromeApi?.storage?.sync;

        if (runtime === undefined || storage === undefined) {
          reject(new Error('Extension sync storage is unavailable.'));
          return;
        }

        storage.get([storageKey], items => {
          const message = runtime.lastError?.message;

          if (message !== undefined && message !== '') {
            reject(new Error(message));
            return;
          }

          resolve(items[storageKey]);
        });
      }),
    key
  );

export const readExtensionLocalStorage = (page: Page, key: string): Promise<unknown> =>
  page.evaluate(
    storageKey =>
      new Promise<unknown>((resolve, reject) => {
        const chromeApi = (
          globalThis as typeof globalThis & {
            chrome?: {
              runtime?: { lastError?: { message?: string } };
              storage?: {
                local?: {
                  get: (keys: string[], callback: (items: Record<string, unknown>) => void) => void;
                };
              };
            };
          }
        ).chrome;

        const runtime = chromeApi?.runtime;
        const storage = chromeApi?.storage?.local;

        if (runtime === undefined || storage === undefined) {
          reject(new Error('Extension local storage is unavailable.'));
          return;
        }

        storage.get([storageKey], items => {
          const message = runtime.lastError?.message;

          if (message !== undefined && message !== '') {
            reject(new Error(message));
            return;
          }

          resolve(items[storageKey]);
        });
      }),
    key
  );

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
