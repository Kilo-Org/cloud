/* eslint-disable import/no-nodejs-modules, max-lines, promise/avoid-new -- the harness spawns the browser binary, writes its profile and polls its port file */
import { chromium } from '@playwright/test';
import type { Browser, BrowserContext } from '@playwright/test';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyExtensionWithGrantedPermissions } from './extension-context-fixture';
import {
  applyPosthogE2eBrowserWorkarounds,
  EXTENSION_E2E_LAUNCH_ARGS,
  EXTENSION_E2E_USER_AGENT,
  installPosthogStub,
} from './posthog-fixture';
import type { NormalizedPosthogEvent } from './posthog-fixture';

/*
 * A launch that leaves Chrome's own download pipeline alone.
 *
 * Playwright's `launchPersistentContext` sends `Browser.setDownloadBehavior`
 * with `allowAndName` for the context, which installs the DevTools download
 * delegate: the download is written under a GUID and
 * `chrome.downloads.onDeterminingFilename` never reaches an extension. Any
 * non-`default` behaviour does the same, so a spec that measures the guard
 * cannot run under Playwright's own launch.
 *
 * This launch starts the browser as a child process instead, points the
 * download directory at a real folder through the profile's `Default/
 * Preferences`, and attaches Playwright over CDP with `noDefaults` so it does
 * not install its own download behaviour. The extension then sees the same
 * event a user's Chrome dispatches.
 *
 * The browser is started headed: extension loading and the download manager are
 * the states this harness measures, and CI runs the suite under xvfb.
 */

/** Where Chrome writes the debugging port it was asked for with `--remote-debugging-port=0`. */
const DEVTOOLS_PORT_FILE = 'DevToolsActivePort';
/** How long a launch may take before the harness gives up, in milliseconds. */
const LAUNCH_TIMEOUT_MS = 60_000;
/** How long the worker may take to appear before the id is derived from the extension's path instead. */
const EXTENSION_WORKER_TIMEOUT_MS = 15_000;

const delay = (milliseconds: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();

  setTimeout(resolve, milliseconds);

  return promise;
};

/**
 * The extension's id. Chrome derives an unpacked extension's id from the
 * absolute path it is loaded from, so this is exact — and taking the first
 * worker instead would pick up any other extension the profile happens to
 * carry, which is how the probe page loaded the wrong extension once.
 */
export const extensionIdFromPath = (extensionDir: string): string => {
  const digest = createHash('sha256').update(extensionDir).digest('hex').slice(0, 32);

  return digest
    .split('')
    .map(nibble => 'abcdefghijklmnop'[Number.parseInt(nibble, 16)])
    .join('');
};

/** The profile preferences that make Chrome download into our folder without a prompt. */
const writePreferences = async (userDataDir: string, downloadsPath: string): Promise<void> => {
  const defaultProfile = join(userDataDir, 'Default');

  await mkdir(defaultProfile, { recursive: true });
  await writeFile(
    join(defaultProfile, 'Preferences'),
    JSON.stringify({
      download: {
        default_directory: downloadsPath,
        directory_upgrade: true,
        prompt_for_download: false,
      },
      profile: { exit_type: 'Normal', exited_cleanly: true },
    })
  );
};

/**
 * Polls `read` until it answers something other than null. Every wait in this
 * harness is a condition on the outside world — a file the browser writes, a
 * worker it starts — so the loop is the one place a delay is legitimate.
 */
const pollUntil = async <Value>(
  read: () => Promise<Value | null>,
  { intervalMs, timeoutMs }: { readonly intervalMs: number; readonly timeoutMs: number }
): Promise<Value | null> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- each attempt reads the state the browser just changed
    const value = await read();

    if (value !== null) {
      return value;
    }

    // eslint-disable-next-line no-await-in-loop -- the interval between two reads, not a wait for the answer
    await delay(intervalMs);
  }

  return null;
};

/** The endpoint once the browser has written its port, or a failure that carries what the browser said. */
const waitForEndpoint = async (
  userDataDir: string,
  child: ChildProcess,
  stderr: () => string
): Promise<string> => {
  const portFile = join(userDataDir, DEVTOOLS_PORT_FILE);
  const endpoint = await pollUntil(
    async () => {
      if (child.exitCode !== null) {
        throw new Error(`Chrome exited before it reported a port:\n${stderr()}`);
      }

      if (!existsSync(portFile)) {
        return null;
      }

      const contents = await readFile(portFile, 'utf8');
      const [port] = contents.split('\n');
      const trimmed = port?.trim() ?? '';

      return /^\d+$/u.test(trimmed) ? `http://127.0.0.1:${trimmed}` : null;
    },
    { intervalMs: 50, timeoutMs: LAUNCH_TIMEOUT_MS }
  );

  if (endpoint === null) {
    throw new Error(
      `Chrome did not report a debugging port in ${LAUNCH_TIMEOUT_MS} ms:\n${stderr()}`
    );
  }

  return endpoint;
};

/**
 * The extension's id, from the path Chrome loads it by. The extension's worker
 * is awaited first so the background page is alive before a spec drives it, but
 * the id itself does not come from the worker: a profile can carry other
 * extensions' workers, and the first one is not necessarily this extension.
 */
const waitForExtensionId = async (
  context: BrowserContext,
  extensionDir: string
): Promise<string> => {
  await pollUntil(
    () =>
      Promise.resolve(
        context
          .serviceWorkers()
          .some(candidate => candidate.url().startsWith('chrome-extension://'))
          ? true
          : null
      ),
    { intervalMs: 100, timeoutMs: EXTENSION_WORKER_TIMEOUT_MS }
  );

  return extensionIdFromPath(extensionDir);
};

/** The files a download folder holds, ignoring the dot-prefixed temp file an in-flight download writes. */
export const downloadFiles = async (downloadsPath: string): Promise<string[]> => {
  const names = await readdir(downloadsPath);

  return names
    .filter(name => !name.startsWith('.'))
    .toSorted((left, right) => left.localeCompare(right));
};

/**
 * The dot-prefixed files in the folder: Chrome's in-flight write is
 * `.org.chromium.Chromium.XXXXXX` (or `.com.google.Chrome.XXXXXX`) and is gone
 * once the item is cancelled, so a refusal that leaves one behind left bytes.
 */
export const tempDownloadFiles = async (downloadsPath: string): Promise<string[]> => {
  const names = await readdir(downloadsPath);

  return names
    .filter(name => name.startsWith('.'))
    .toSorted((left, right) => left.localeCompare(right));
};

/** The text of a downloaded file, read from the folder Chrome really wrote into. */
export const readDownloadedFile = (downloadsPath: string, filename: string): Promise<string> =>
  readFile(join(downloadsPath, filename), 'utf8');

export interface RealDownloadBrowser {
  readonly browser: Browser;
  /** Chrome's one context: the profile the launch created. */
  readonly context: BrowserContext;
  /**
   * The real folder Chrome downloads into, as its profile names it. Every
   * assertion about a file that did or did not land is a read of this folder.
   */
  readonly downloadsPath: string;
  readonly extensionId: string;
  /** Capture-class PostHog events, from the stub this launch installs. */
  readonly posthogRequests: NormalizedPosthogEvent[];
  /** Stops the browser, waits for it to exit, and removes the profile and the downloads folder. */
  readonly close: () => Promise<void>;
}

/**
 * Launches Chrome with the built extension and a real download folder.
 *
 * `extensionPath` loads a different unpacked extension instead of a copy of the
 * build, which is how the harness probe loads its own listener. `grantPermissions`
 * promotes those optional permissions to required in a copy of the build, the
 * same way the Playwright launch does, because automation cannot answer the
 * permission prompt.
 */
export const launchRealDownloadBrowser = async (
  options: {
    /** A folder the spec owns; the launch creates one when it is omitted, and removes it on close either way. */
    readonly downloadsPath?: string;
    /** An unpacked extension to load instead of the build under test. */
    readonly extensionPath?: string;
    /** Chrome switches a spec needs, appended to the harness's own. */
    readonly extraLaunchArgs?: readonly string[];
    /** Optional permissions Chrome cannot be asked for by automation, granted at load time in a copy of the build. */
    readonly grantPermissions?: readonly string[];
  } = {}
): Promise<RealDownloadBrowser> => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kilo-real-download-profile-'));
  const downloadsPath = options.downloadsPath ?? (await mkdtemp(join(tmpdir(), 'kilo-downloads-')));
  const extensionDir =
    options.extensionPath ??
    (await copyExtensionWithGrantedPermissions(options.grantPermissions ?? ['downloads']));

  await writePreferences(userDataDir, downloadsPath);

  const executablePath = process.env['EXTENSION_E2E_EXECUTABLE_PATH'] ?? chromium.executablePath();
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    // Playwright launches Chromium with `chromiumSandbox: false`. Without the same switch this
    // Launch refuses to start on hosts whose kernel disables unprivileged user namespaces —
    // Every Ubuntu 23.10+ runner and this VM included. The profile is throwaway, holding no data.
    '--no-sandbox',
    `--user-agent=${EXTENSION_E2E_USER_AGENT}`,
    ...EXTENSION_E2E_LAUNCH_ARGS,
    ...(options.extraLaunchArgs ?? []),
  ];

  const child = spawn(executablePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', chunk => {
    stderr = `${stderr}${String(chunk)}`.slice(-4000);
  });

  const removeDirs = async (): Promise<void> => {
    // Chrome's zygote and renderer children can outlive the browser's exit by a moment and keep writing
    // inside the profile, so a plain rm loses an ENOTEMPTY race. Retry until the tree is finally quiet.
    await rm(userDataDir, { force: true, maxRetries: 20, recursive: true, retryDelay: 100 });
    await rm(downloadsPath, { force: true, maxRetries: 20, recursive: true, retryDelay: 100 });
  };

  const endpoint = await waitForEndpoint(userDataDir, child, () => stderr).catch(async error => {
    child.kill('SIGKILL');
    await removeDirs();

    throw error;
  });

  const browser = await chromium
    .connectOverCDP(endpoint, { isLocal: true, noDefaults: true })
    .catch(async error => {
      child.kill('SIGKILL');
      await removeDirs();

      throw error;
    });

  const [context] = browser.contexts();

  if (context === undefined) {
    child.kill('SIGKILL');
    await removeDirs();

    throw new Error('the browser reported no default context');
  }

  await applyPosthogE2eBrowserWorkarounds(context);
  const posthogRecorder = await installPosthogStub(context);
  const extensionId = await waitForExtensionId(context, extensionDir);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }

    closed = true;
    await browser.close().catch(() => null);

    if (child.exitCode === null && child.signalCode === null) {
      const exited = Promise.withResolvers<void>();

      child.once('exit', () => {
        exited.resolve();
      });
      child.kill('SIGKILL');
      await exited.promise;
    }

    await removeDirs();
  };

  return {
    browser,
    close,
    context,
    downloadsPath,
    extensionId,
    posthogRequests: posthogRecorder.events,
  };
};
