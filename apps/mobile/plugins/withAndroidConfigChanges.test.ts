import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileModsAsync, type ExportedConfig } from 'expo/config-plugins';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const pluginModule = require('./withAndroidConfigChanges.js') as ((
  config: ExportedConfig
) => ExportedConfig) & {
  HANDLED_CONFIG_CHANGES: string[];
  addHandledConfigChanges: (value?: string) => string;
};
const withAndroidConfigChanges = pluginModule;
const { HANDLED_CONFIG_CHANGES, addHandledConfigChanges } = pluginModule;

/** The `android:configChanges` the Expo template writes for MainActivity. */
const TEMPLATE_CONFIG_CHANGES =
  'keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode|smallestScreenSize|assetsPaths';

const temporaryProjects: string[] = [];

afterEach(() => {
  for (const root of temporaryProjects.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeManifest(activityAttributes: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'android-config-changes-'));
  temporaryProjects.push(root);
  const main = path.join(root, 'android/app/src/main');
  mkdirSync(main, { recursive: true });
  const manifestPath = path.join(main, 'AndroidManifest.xml');
  writeFileSync(
    manifestPath,
    `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:name=".MainApplication">
    <activity android:name="${activityAttributes}" />
  </application>
</manifest>
`
  );
  return { root, manifestPath };
}

async function prebuild(root: string): Promise<void> {
  const config = withAndroidConfigChanges({
    name: 'Kilo',
    slug: 'kilo-app',
    _internal: { projectRoot },
  });
  await compileModsAsync(config, { projectRoot: root, platforms: ['android'] });
}

function configChangesOf(manifestPath: string): string | undefined {
  const manifest = readFileSync(manifestPath, 'utf8');
  return /<activity[^>]*android:configChanges="([^"]*)"/.exec(manifest)?.[1];
}

describe('addHandledConfigChanges', () => {
  it('appends the handled changes after the declared ones', () => {
    expect(addHandledConfigChanges(TEMPLATE_CONFIG_CHANGES)).toBe(
      `${TEMPLATE_CONFIG_CHANGES}|${HANDLED_CONFIG_CHANGES.join('|')}`
    );
  });

  it('leaves an already handled change in place instead of duplicating it', () => {
    expect(addHandledConfigChanges(`keyboard|fontScale|density|locale`)).toBe(
      `keyboard|fontScale|density|locale|layoutDirection`
    );
  });

  it('turns a missing value into the handled list', () => {
    expect(addHandledConfigChanges(undefined)).toBe(HANDLED_CONFIG_CHANGES.join('|'));
    expect(addHandledConfigChanges('')).toBe(HANDLED_CONFIG_CHANGES.join('|'));
  });
});

describe('withAndroidConfigChanges', () => {
  it('adds font size, display size, language and direction to MainActivity', async () => {
    const { root, manifestPath } = writeManifest(
      `.MainActivity" android:configChanges="${TEMPLATE_CONFIG_CHANGES}`
    );

    await prebuild(root);

    const configChanges = configChangesOf(manifestPath)?.split('|') ?? [];
    // The template's own entries survive in order.
    expect(configChanges.slice(0, 8)).toEqual(TEMPLATE_CONFIG_CHANGES.split('|'));
    expect(configChanges).toEqual(
      expect.arrayContaining(['fontScale', 'density', 'locale', 'layoutDirection'])
    );
  });

  it('is idempotent across prebuilds', async () => {
    const { root, manifestPath } = writeManifest(
      `.MainActivity" android:configChanges="${TEMPLATE_CONFIG_CHANGES}`
    );

    await prebuild(root);
    const once = configChangesOf(manifestPath);
    await prebuild(root);

    expect(configChangesOf(manifestPath)).toBe(once);
  });

  it('adds an activity that declares no configChanges at all', async () => {
    const { root, manifestPath } = writeManifest('.MainActivity');

    await prebuild(root);

    expect(configChangesOf(manifestPath)).toBe(HANDLED_CONFIG_CHANGES.join('|'));
  });

  it('stays inert when the template names its activity differently', async () => {
    const { root, manifestPath } = writeManifest(
      `.OtherActivity" android:configChanges="${TEMPLATE_CONFIG_CHANGES}`
    );

    await prebuild(root);

    expect(configChangesOf(manifestPath)).toBe(TEMPLATE_CONFIG_CHANGES);
  });

  it('stays a registered plugin in app.config.ts', () => {
    const config = readFileSync(path.join(projectRoot, 'app.config.ts'), 'utf8');
    expect(config).toMatch(/'\.\/plugins\/withAndroidConfigChanges'/);
  });
});
