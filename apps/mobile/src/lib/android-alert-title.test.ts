/* eslint-disable import/no-nodejs-modules -- Exercises the build-time resource plugin in Node, not the mobile runtime. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ExportedConfig } from 'expo/config-plugins';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const withAndroidManifestFix: (
  config: ExportedConfig
) => ExportedConfig = require('../../plugins/withAndroidManifestFix.js');
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const upstreamLayout = readFileSync(
  join(
    dirname(require.resolve('react-native/package.json')),
    'ReactAndroid/src/main/res/views/alert/layout/alert_title_layout.xml'
  ),
  'utf8'
);

describe('Android native alert title', () => {
  let platformProjectRoot = '';
  let resDir = '';

  beforeEach(() => {
    platformProjectRoot = mkdtempSync(join(tmpdir(), 'kilo-alert-title-'));
    resDir = join(platformProjectRoot, 'app/src/main/res');
  });

  afterEach(() => {
    rmSync(platformProjectRoot, { recursive: true, force: true });
  });

  async function generateResources() {
    const config = withAndroidManifestFix({ name: 'Kilo', slug: 'kilo-app' });
    const resourceMod = config.mods?.android?.dangerous;
    if (!resourceMod) {
      throw new Error('Android resource mod is not registered');
    }
    await resourceMod({
      ...config,
      modResults: {},
      modRawConfig: config,
      modRequest: {
        projectRoot,
        platformProjectRoot,
        platform: 'android',
        modName: 'dangerous',
        introspect: false,
      },
    });
  }

  function effectiveTitleLayout() {
    const override = join(resDir, 'layout/alert_title_layout.xml');
    // Android app resources override the dependency's resource with the same name.
    return existsSync(override) ? readFileSync(override, 'utf8') : upstreamLayout;
  }

  it('aligns Arabic and English titles to the text start, not the device view direction', async () => {
    await generateResources();

    expect(/android:textAlignment="([^"]+)"/.exec(effectiveTitleLayout())?.[1]).toBe('textStart');
  });

  it('preserves the native title class, ID, theme attributes, padding, and sizing', async () => {
    await generateResources();

    expect(readFileSync(join(resDir, 'layout/alert_title_layout.xml'), 'utf8')).toBe(
      upstreamLayout.replace(
        'android:textAlignment="viewStart"',
        'android:textAlignment="textStart"'
      )
    );
    expect(effectiveTitleLayout()).toContain('com.facebook.react.modules.dialog.DialogTitle');
    expect(effectiveTitleLayout()).toContain('android:id="@+id/alert_title"');
    expect(effectiveTitleLayout()).toContain('style="?android:attr/windowTitleStyle"');
  });

  it('is repeatable and retains the existing backup and resource-shrinking resources', async () => {
    await generateResources();
    const first = effectiveTitleLayout();
    await generateResources();

    expect(effectiveTitleLayout()).toBe(first);
    for (const name of ['kilo_backup_rules.xml', 'kilo_data_extraction_rules.xml']) {
      expect(readFileSync(join(resDir, 'xml', name), 'utf8')).toBe(
        readFileSync(join(projectRoot, 'plugins/backup', name), 'utf8')
      );
    }
    expect(readFileSync(join(resDir, 'raw/kilo_shrink_sentinel_unused'), 'utf8')).toBe(
      'resource shrink sentinel'
    );
  });
});
