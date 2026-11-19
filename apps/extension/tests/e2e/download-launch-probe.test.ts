/* eslint-disable import/no-nodejs-modules, max-lines, promise/avoid-new -- the probe writes an unpacked extension and reads the events its worker recorded */
import { chromium, expect, test } from '@playwright/test';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * It loads a test-only extension and arms the listener inside the extension's
 * own running worker, then starts a real download and asserts the item was
 * recorded. Arming through the worker is what makes the probe deterministic: an
 * MV3 worker is suspended when idle, so a listener registered only by the
 * top-level script is not guaranteed to exist when the download is created.
 * Playwright holds a debugger attachment on the worker, which keeps it running —
 * so `worker.evaluate` both registers the listener and proves the worker is up.
 *
 * The same probe MUST fail under Playwright's `launchPersistentContext`. That
 * launch sends `Browser.setDownloadBehavior` with `allowAndName`, which installs
 * the DevTools download delegate: the file is written under a GUID and the event
 * never reaches an extension. Asserting the negative here makes the harness's
 * premise a test rather than a comment, so a future Playwright change cannot
 * silently turn the download specs into tests of nothing.
 */

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
 * The worker's own script: nothing but the array the probe records into. The
 * listener is added by the test, once the worker is known to be running.
 */
const PROBE_SERVICE_WORKER = 'globalThis.__probeDeterminingItems = [];\n';

/** Writes the probe extension into a fresh directory. */
const writeProbeExtension = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'kilo-download-probe-ext-'));

  await writeFile(join(directory, 'manifest.json'), JSON.stringify(PROBE_MANIFEST));
  await writeFile(join(directory, 'sw.js'), PROBE_SERVICE_WORKER);

  return directory;
};

/** The extension's own worker, once Playwright has attached to it. */
const waitForProbeWorker = async (
  context: BrowserContext,
  extensionId: string
): Promise<Worker> => {
  await expect.poll(() => hasProbeWorker(context, extensionId), { timeout: 20_000 }).toBe(true);

  const worker = context
    .serviceWorkers()
    .find(candidate => new URL(candidate.url()).host === extensionId);

  if (worker === undefined) {
    throw new Error(`the service worker of ${extensionId} disappeared`);
  }

  return worker;
};

const hasProbeWorker = (context: BrowserContext, extensionId: string): boolean =>
  context.serviceWorkers().some(candidate => new URL(candidate.url()).host === extensionId);

/**
 * Registers the listener inside the running worker. The download to be observed
 * is started only after this resolves, so the event router exists before the
 * download does.
 */
const armDownloadProbe = (worker: Worker): Promise<void> =>
  worker.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __probeDeterminingItems?: Record<string, unknown>[];
      chrome?: {
        downloads?: {
          onDeterminingFilename?: {
            addListener: (
              listener: (item: Record<string, unknown>, suggest: () => void) => void
            ) => void;
          };
        };
      };
    };
    const items: Record<string, unknown>[] = [];

    scope.__probeDeterminingItems = items;
    scope.chrome?.downloads?.onDeterminingFilename?.addListener((item, suggest) => {
      items.push({ finalUrl: item['finalUrl'], id: item['id'], url: item['url'] });
      // Answering at once keeps Chrome's own filename, so the file lands as the page named it.
      suggest();
    });
  });

/** The items the armed listener recorded. */
const recordedItems = (worker: Worker): Promise<Record<string, unknown>[]> =>
  worker.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __probeDeterminingItems?: Record<string, unknown>[];
    };

    return scope.__probeDeterminingItems ?? [];
  });

/** Starts the fixture's attachment from a plain page: a download a user's Chrome would create. */
const startDownload = async (context: BrowserContext, fixtureUrl: string): Promise<void> => {
  const page: Page = await context.newPage();

  // A navigation to an attachment never loads a document: the browser answers with a download, so the load error is the download.
  await page.goto(`${fixtureUrl}${DOWNLOAD_PATH}`).catch(() => null);
};

test('the real launch dispatches onDeterminingFilename for a download', async () => {
  test.setTimeout(120_000);
  const probeExtension = await writeProbeExtension();
  const fixture = await startDownloadFixture();
  const launch = await launchRealDownloadBrowser({ extensionPath: probeExtension });

  try {
    const worker = await waitForProbeWorker(launch.context, extensionIdFromPath(probeExtension));

    await armDownloadProbe(worker);
    await startDownload(launch.context, fixture.url);

    await expect
      .poll(() => recordedItems(worker), { timeout: 20_000 })
      .toMatchObject([{ url: expect.stringContaining(DOWNLOAD_PATH) }]);
    // The listener answered suggest() at once, so the file lands under its own name in the profile's folder.
    await expect
      .poll(() => downloadFiles(launch.downloadsPath), { timeout: 20_000 })
      .toHaveLength(1);
    expect(fixture.hits()).toBeGreaterThan(0);
  } finally {
    await launch.close();
    await fixture.close();
    await rm(probeExtension, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
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
    const worker = await waitForProbeWorker(context, extensionIdFromPath(probeExtension));

    // The same arming path as the positive test: only the launch differs, so the assertion is about the launch.
    await armDownloadProbe(worker);
    await startDownload(context, fixture.url);

    // The delegate wrote the file, so the download happened…
    await expect.poll(() => downloadFiles(downloadsPath), { timeout: 20_000 }).toHaveLength(1);
    // …and the event never reached the extension, which is why the download specs cannot run on this launch.
    expect(await recordedItems(worker)).toStrictEqual([]);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    await rm(downloadsPath, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    await rm(probeExtension, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});
