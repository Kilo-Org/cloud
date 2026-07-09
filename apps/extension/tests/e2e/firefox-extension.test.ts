/* eslint-disable import/no-nodejs-modules */
import { expect, firefox, test } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const extensionId = 'browser-agent@kilo.ai';
const firefoxExtensionPath = resolvePath(import.meta.dirname, '../../.output/firefox-mv3');

interface InstalledFirefoxAddon {
  readonly manifestURL: string;
  readonly warnings: string[];
}

interface RemoteFirefox {
  readonly disconnect: () => void;
  readonly getInstalledAddon: (addonId: string) => Promise<InstalledFirefoxAddon>;
  readonly installTemporaryAddon: (addonPath: string, openDevTools: boolean) => Promise<unknown>;
}

interface WebExtFirefoxRemote {
  readonly connectWithMaxRetries: (options: {
    readonly maxRetries: number;
    readonly port: number;
    readonly retryInterval: number;
  }) => Promise<RemoteFirefox>;
  readonly findFreeTcpPort: () => Promise<number>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const firefoxManifestSchema = z.record(z.string(), z.unknown());

const isWebExtFirefoxRemote = (value: unknown): value is WebExtFirefoxRemote =>
  isRecord(value) &&
  typeof value['connectWithMaxRetries'] === 'function' &&
  typeof value['findFreeTcpPort'] === 'function';

const loadWebExtFirefoxRemote = async (): Promise<WebExtFirefoxRemote> => {
  const require = createRequire(import.meta.url);
  const webExtDirectory = dirname(require.resolve('web-ext'));
  const remoteModuleUrl = pathToFileURL(join(webExtDirectory, 'lib/firefox/remote.js')).href;
  const remoteModule: unknown = await import(remoteModuleUrl);

  if (!isWebExtFirefoxRemote(remoteModule)) {
    throw new TypeError('web-ext Firefox remote module has an unexpected shape.');
  }

  return remoteModule;
};

const readFirefoxManifest = async (): Promise<Record<string, unknown>> => {
  const manifest = firefoxManifestSchema.safeParse(
    JSON.parse(await readFile(join(firefoxExtensionPath, 'manifest.json'), 'utf8'))
  );

  if (!manifest.success) {
    throw new TypeError('Firefox manifest was not an object.');
  }

  return manifest.data;
};

test('firefox build installs as a running add-on without invalid manifest warnings', async () => {
  const manifest = await readFirefoxManifest();
  const {
    host_permissions: hostPermissions,
    permissions,
    side_panel: sidePanel,
    sidebar_action: sidebarAction,
  } = manifest;

  expect(permissions).toContain('storage');
  expect(permissions).toContain('scripting');
  expect(permissions).toContain('tabs');
  expect(permissions).not.toContain('debugger');
  expect(hostPermissions).toContain('<all_urls>');
  expect(sidebarAction).toMatchObject({ default_panel: 'sidepanel.html' });
  expect(sidePanel).toBeUndefined();

  const { connectWithMaxRetries, findFreeTcpPort } = await loadWebExtFirefoxRemote();
  const port = await findFreeTcpPort();
  const userDataDir = await mkdtemp(join(tmpdir(), 'kilo-extension-firefox-e2e-'));
  let context: BrowserContext | null = null;
  let remote: RemoteFirefox | null = null;

  try {
    context = await firefox.launchPersistentContext(userDataDir, {
      args: ['-start-debugger-server', String(port)],
      firefoxUserPrefs: {
        'devtools.debugger.prompt-connection': false,
        'devtools.debugger.remote-enabled': true,
        'xpinstall.signatures.required': false,
      },
      headless: true,
    });
    remote = await connectWithMaxRetries({ maxRetries: 100, port, retryInterval: 120 });
    await remote.installTemporaryAddon(firefoxExtensionPath, false);
    const addon = await remote.getInstalledAddon(extensionId);

    expect(addon.manifestURL).toMatch(/^moz-extension:\/\/.+\/manifest\.json$/u);
    expect(addon.warnings).toStrictEqual([]);
  } finally {
    remote?.disconnect();
    await context?.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
