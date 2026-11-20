/* eslint-disable import/no-nodejs-modules -- the proof driver runs in Node, outside the extension. */
/*
 * Opt-in capture for the extension's signed-out side panel, for `pnpm dev:pixel-diff`.
 *
 * It never compares anything: it writes one deterministic PNG, and the shared root
 * diff command compares two of them. The browser runs a real Chromium with the
 * unpacked build, a fresh throwaway profile, a fixed viewport/DPR/theme/locale, and
 * external network blocked. Nothing is published, signed in, or written inside the
 * build or the repo's normal test outputs.
 *
 * Usage:
 *   pnpm --filter kilo-extension capture:sidepanel-proof -- \
 *     --extension .output/chrome-mv3 --out /tmp/sidepanel.png
 *
 * Optional executable: `EXTENSION_E2E_EXECUTABLE_PATH=/path/to/chrome` (the same
 * variable the extension e2e fixture reads).
 */
import { chromium } from '@playwright/test';
import type { BrowserContext, Page, Route } from '@playwright/test';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

/** One panel size and pixel density for every capture, so two builds align exactly. */
const SIDE_PANEL_PROOF_VIEWPORT = { height: 600, width: 400 } as const;
const SIDE_PANEL_PROOF_DEVICE_SCALE_FACTOR = 2;

/** The signed-out side panel always renders this heading; it is the readiness marker. */
const SIDE_PANEL_SIGNED_OUT_MARKER = 'Sign in to continue';

const READY_TIMEOUT_MS = 30_000;
const SERVICE_WORKER_TIMEOUT_MS = 20_000;
const STABILITY_ATTEMPTS = 20;
const STABILITY_INTERVAL_MS = 100;

/*
 * All external requests must fail locally, identically, on every run: the resolver
 * maps every host to a discard address and Playwright aborts any http(s) request the
 * extension still issues. No key, account, or local stack is required or reachable.
 */
const OFFLINE_LAUNCH_ARGS = [
  '--no-proxy-server',
  '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE localhost',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-sync',
  '--no-default-browser-check',
  '--no-first-run',
  '--disable-search-engine-choice-screen',
] as const;

/** Rendering flags that keep text and color stable between captures of one build. */
const RENDERING_LAUNCH_ARGS = [
  '--disable-lcd-text',
  '--font-render-hinting=none',
  '--force-color-profile=srgb',
  '--hide-scrollbars',
] as const;

const USAGE = `Capture the extension's signed-out side panel to a PNG for the shared pixel diff.

  --extension <dir>  Unpacked Chrome build directory (contains manifest.json).
  --out <file>       PNG file to write.
  --help             Show this message.

Optional environment:
  EXTENSION_E2E_EXECUTABLE_PATH  Chromium/Chrome binary to launch instead of the bundled one.`;

const abortExternalRequest = async (route: Route): Promise<void> => {
  await route.abort('blockedbyclient');
};

const waitForSidePanelReady = async (page: Page): Promise<void> => {
  await page.waitForFunction(() => document.readyState === 'complete', undefined, {
    timeout: READY_TIMEOUT_MS,
  });
  await page.getByText(SIDE_PANEL_SIGNED_OUT_MARKER, { exact: true }).waitFor({
    state: 'visible',
    timeout: READY_TIMEOUT_MS,
  });
  // Bundled fonts are local files; wait until every face is applied before pixels count.
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
};

/*
 * Screenshot until two consecutive frames are byte-identical. The loop is bounded, so
 * a panel that never settles fails loudly instead of writing a torn frame.
 */
const settleScreenshot = async (
  page: Page,
  previous: Buffer | undefined,
  attempt: number
): Promise<Buffer> => {
  if (attempt > STABILITY_ATTEMPTS) {
    throw new Error(
      `Side panel pixels did not stabilize after ${String(STABILITY_ATTEMPTS)} frames.`
    );
  }

  const screenshot = await page.screenshot({ timeout: READY_TIMEOUT_MS, type: 'png' });

  if (previous !== undefined && screenshot.equals(previous)) {
    return screenshot;
  }

  await delay(STABILITY_INTERVAL_MS);

  return settleScreenshot(page, screenshot, attempt + 1);
};

const pngSize = (png: Buffer): { height: number; width: number } => {
  const IHDR_OFFSET = 16;

  if (png.length < 24 || png.toString('latin1', 1, 4) !== 'PNG') {
    throw new Error('Playwright did not return a complete PNG buffer.');
  }

  return { height: png.readUInt32BE(IHDR_OFFSET + 4), width: png.readUInt32BE(IHDR_OFFSET) };
};

const parseCli = (argv: readonly string[]): { extension: string; out: string } | undefined => {
  const parsed = parseArgs({
    allowPositionals: false,
    args: [...argv],
    options: {
      extension: { type: 'string' },
      help: { default: false, type: 'boolean' },
      out: { type: 'string' },
    },
    strict: true,
  });

  if (parsed.values.help) {
    console.log(USAGE);
    return undefined;
  }

  const { extension, out } = parsed.values;

  if (extension === undefined || extension === '') {
    throw new Error(`--extension is required.\n\n${USAGE}`);
  }

  if (out === undefined || out === '') {
    throw new Error(`--out is required.\n\n${USAGE}`);
  }

  return { extension: resolve(extension), out: resolve(out) };
};

const capture = async (extensionPath: string, outPath: string): Promise<void> => {
  try {
    await access(join(extensionPath, 'manifest.json'));
  } catch {
    throw new Error(
      `--extension must be an unpacked Chrome build with a manifest.json: ${extensionPath}`
    );
  }

  const profileDir = await mkdtemp(join(tmpdir(), 'kilo-sidepanel-proof-'));
  const executablePath = process.env['EXTENSION_E2E_EXECUTABLE_PATH'];
  let context: BrowserContext | undefined;

  try {
    context = await chromium.launchPersistentContext(profileDir, {
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        ...OFFLINE_LAUNCH_ARGS,
        ...RENDERING_LAUNCH_ARGS,
      ],
      /*
       * The extension ships one dark surface set today, but the emulation is pinned
       * anyway: a future light variant keyed on prefers-color-scheme must not leak
       * into a pair and turn a theme swap into pixel noise.
       */
      colorScheme: 'dark',
      deviceScaleFactor: SIDE_PANEL_PROOF_DEVICE_SCALE_FACTOR,
      ...(executablePath === undefined || executablePath === '' ? {} : { executablePath }),
      headless: true,
      ignoreDefaultArgs: ['--enable-automation'],
      locale: 'en-US',
      reducedMotion: 'reduce',
      serviceWorkers: 'allow',
      timezoneId: 'UTC',
      viewport: SIDE_PANEL_PROOF_VIEWPORT,
    });

    await context.route(/^https?:\/\//u, abortExternalRequest);
    // Belt and braces: no request may wait on a socket, even one a worker opens.
    await context.setOffline(true);

    const [existingServiceWorker] = context.serviceWorkers();
    const serviceWorker =
      existingServiceWorker ??
      (await context.waitForEvent('serviceworker', { timeout: SERVICE_WORKER_TIMEOUT_MS }));
    const extensionId = new URL(serviceWorker.url()).host;

    // A new tab, not the worker's own document: a fresh side panel page in a fresh profile.
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`, {
      waitUntil: 'domcontentloaded',
    });
    await waitForSidePanelReady(page);

    const screenshot = await settleScreenshot(page, undefined, 1);
    const size = pngSize(screenshot);
    const expected = {
      height: SIDE_PANEL_PROOF_VIEWPORT.height * SIDE_PANEL_PROOF_DEVICE_SCALE_FACTOR,
      width: SIDE_PANEL_PROOF_VIEWPORT.width * SIDE_PANEL_PROOF_DEVICE_SCALE_FACTOR,
    };

    if (size.width !== expected.width || size.height !== expected.height) {
      throw new Error(
        `Screenshot is ${String(size.width)}x${String(size.height)}, expected ${String(expected.width)}x${String(expected.height)}.`
      );
    }

    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, screenshot, { flag: 'wx' });

    console.log(
      JSON.stringify(
        {
          deviceScaleFactor: SIDE_PANEL_PROOF_DEVICE_SCALE_FACTOR,
          extensionId,
          extensionPath,
          out: outPath,
          viewport: SIDE_PANEL_PROOF_VIEWPORT,
        },
        undefined,
        2
      )
    );
  } finally {
    try {
      await context?.close();
    } finally {
      await rm(profileDir, { force: true, recursive: true });
    }
  }
};

try {
  const cli = parseCli(process.argv.slice(2));

  if (cli !== undefined) {
    await capture(cli.extension, cli.out);
  }
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
