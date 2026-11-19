/* eslint-disable import/no-nodejs-modules, promise/avoid-new, vitest/no-conditional-in-test -- the probe writes an unpacked extension, reads events the browser recorded, and asserts both branches */
import { chromium, expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { DOWNLOAD_PATH, startDownloadFixture } from './download-fixture';
import {
  downloadFiles,
  extensionIdFromPath,
  launchRealDownloadBrowser,
} from './real-download-launch';

/*
 * The guard's primitive is `chrome.downloads.onDeterminingFilename`, and this
 * probe proves the harness dispatches it at all.
 *
 * It loads a test-only extension that does nothing but listen: one manifest, one
 * service worker, and a listener that records each item into
 * `chrome.storage.session` and then calls `suggest()` at once, so the download
 * proceeds under its own name. The probe starts a real download and asserts the
 * record exists.
 *
 * The same probe MUST fail under Playwright's `launchPersistentContext`. That
 * launch sends `Browser.setDownloadBehavior` with `allowAndName`, which installs
 * the DevTools download delegate: the file is written under a GUID and the event
 * never reaches an extension. Asserting the negative here makes the harness's
 * premise a test rather than a comment, so a future Playwright change cannot
 * silently turn the download specs into tests of nothing.
 */

/** The storage key the probe extension records items under. */
const PROBE_STORAGE_KEY = 'determiningFilenameItems';

const PROBE_MANIFEST = {
  action: { default_title: 'Download event probe' },
  background: { service_worker: 'sw.js' },
  description: 'Records chrome.downloads.onDeterminingFilename items for the e2e harness.',
  manifest_version: 3,
  name: 'Download event probe',
  permissions: ['downloads', 'storage'],
  version: '1.0.0',
};

/**
 * The listener records the item and answers at once, so the download proceeds
 * under its own name. `onConnect` is what holds the worker open: an MV3 worker
 * is suspended when idle, and Chrome creates the download's event router only
 * when a listener exists at that moment. A connected port keeps it alive
 * between the page's load and the download.
 */
const PROBE_SERVICE_WORKER = `
chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'probe') {
    port.postMessage({ registered: true });
  }
});
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  chrome.storage.session.set({
    ${PROBE_STORAGE_KEY}: { finalUrl: item.finalUrl, id: item.id, url: item.url },
  });
  suggest();
});
`;

const PROBE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Probe</title></head>
<body><p>Probe extension page.</p></body></html>`;

/** Writes the probe extension into a fresh directory. */
const writeProbeExtension = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'kilo-download-probe-ext-'));

  await writeFile(join(directory, 'manifest.json'), JSON.stringify(PROBE_MANIFEST));
  await writeFile(join(directory, 'sw.js'), PROBE_SERVICE_WORKER);
  await writeFile(join(directory, 'probe.html'), PROBE_PAGE);

  return directory;
};

/** The recorded item, read from the probe's own page: null means the event never fired. */
const recordedItem = (page: Page): Promise<Record<string, unknown> | null> =>
  page.evaluate(
    storageKey =>
      new Promise<Record<string, unknown> | null>((resolve, reject) => {
        const chromeApi = (
          globalThis as typeof globalThis & {
            chrome?: {
              runtime?: { lastError?: { message?: string } };
              storage?: {
                session?: {
                  get: (keys: string[], callback: (items: Record<string, unknown>) => void) => void;
                };
              };
            };
          }
        ).chrome;
        const storage = chromeApi?.storage?.session;

        if (chromeApi === undefined || storage === undefined) {
          reject(new Error('chrome.storage.session is unavailable in the probe page.'));
          return;
        }

        storage.get([storageKey], items => {
          const message = chromeApi.runtime?.lastError?.message;

          if (message !== undefined && message !== '') {
            reject(new Error(message));
            return;
          }

          const value = items[storageKey];

          if (typeof value !== 'object' || value === null) {
            resolve(null);
            return;
          }

          resolve(z.record(z.string(), z.unknown()).parse(value));
        });
      }),
    PROBE_STORAGE_KEY
  );

test('the real launch dispatches onDeterminingFilename for a download', async () => {
  test.setTimeout(120_000);
  const probeExtension = await writeProbeExtension();
  const fixture = await startDownloadFixture();
  const launch = await launchRealDownloadBrowser({ extensionPath: probeExtension });

  try {
    const probePage = await launch.context.newPage();

    await probePage.goto(`chrome-extension://${launch.extensionId}/probe.html`);

    // The worker registers the listener at top level and is suspended when idle, so the page holds a
    // port open across the download. The port answers only once the top-level script ran, which is the
    // moment the listener exists: the wake and the registration are the same event.
    await probePage.evaluate(
      () =>
        new Promise<void>(resolve => {
          const port = chrome.runtime.connect({ name: 'probe' });

          port.onMessage.addListener(() => {
            resolve();
          });
        })
    );

    const page = await launch.context.newPage();

    // A navigation to an attachment never loads a document: the browser answers with a download, so the load error is the download.
    await page.goto(`${fixture.url}${DOWNLOAD_PATH}`).catch(() => null);

    await expect
      .poll(() => recordedItem(probePage), { timeout: 20_000 })
      .toMatchObject({ url: expect.stringContaining(DOWNLOAD_PATH) });
    // The listener answered suggest() at once, so the file lands under its own name.
    await expect
      .poll(() => downloadFiles(launch.downloadsPath), { timeout: 20_000 })
      .toHaveLength(1);
    expect(fixture.hits()).toBeGreaterThan(0);
  } finally {
    await launch.close();
    await fixture.close();
    await rm(probeExtension, { force: true, recursive: true });
  }
});

test('Playwright launchPersistentContext never dispatches onDeterminingFilename', async () => {
  test.setTimeout(120_000);
  const probeExtension = await writeProbeExtension();
  const userDataDir = await mkdtemp(join(tmpdir(), 'kilo-download-probe-playwright-'));
  const downloadsPath = await mkdtemp(join(tmpdir(), 'kilo-download-probe-files-'));
  const fixture = await startDownloadFixture();
  const context = await chromium.launchPersistentContext(userDataDir, {
    args: [`--disable-extensions-except=${probeExtension}`, `--load-extension=${probeExtension}`],
    downloadsPath,
    headless: false,
  });

  try {
    // The probe extension's own path fixes its id, so no worker scan is needed to open its page.
    const probePage = await context.newPage();

    await probePage.goto(`chrome-extension://${extensionIdFromPath(probeExtension)}/probe.html`);

    const page = await context.newPage();

    await page.goto(`${fixture.url}${DOWNLOAD_PATH}`).catch(() => null);

    // The delegate wrote the file, so the download happened…
    await expect.poll(() => downloadFiles(downloadsPath), { timeout: 20_000 }).toHaveLength(1);
    // …and the event never reached the extension, which is why the download specs cannot run on this launch.
    expect(await recordedItem(probePage)).toBeNull();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
    await rm(downloadsPath, { force: true, recursive: true });
    await rm(probeExtension, { force: true, recursive: true });
  }
});
