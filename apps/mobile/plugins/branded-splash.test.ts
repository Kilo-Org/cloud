import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileModsAsync, type ConfigPlugin, type ExportedConfig } from 'expo/config-plugins';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const withBrandedSplash = require('./withBrandedSplash.js') as ConfigPlugin<
  { image: string; backgroundColor: string; imageWidth: number } | undefined
>;

const temporaryProjects: string[] = [];

afterEach(() => {
  for (const root of temporaryProjects.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createAndroidProject() {
  const root = mkdtempSync(path.join(tmpdir(), 'branded-splash-'));
  temporaryProjects.push(root);
  const main = path.join(root, 'android/app/src/main');
  const values = path.join(main, 'res/values');
  const java = path.join(main, 'java/com/kilocode/kiloapp');
  mkdirSync(values, { recursive: true });
  mkdirSync(java, { recursive: true });
  writeFileSync(
    path.join(values, 'styles.xml'),
    '<resources><style name="AppTheme" /></resources>'
  );
  writeFileSync(
    path.join(java, 'MainActivity.kt'),
    `package com.kilocode.kiloapp
import android.os.Bundle
class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }
}`
  );
  return {
    root,
    values,
    drawable: path.join(main, 'res/drawable/splashscreen_window_background.xml'),
  };
}

describe('shared branded splash', () => {
  it('does not create a drawable when the splash theme and resources are absent', async () => {
    const { root, values, drawable } = createAndroidProject();
    const config = withBrandedSplash(
      { name: 'Kilo', slug: 'kilo-app', _internal: { projectRoot } },
      undefined
    );

    await compileModsAsync(config, { projectRoot: root, platforms: ['android'] });

    expect(readFileSync(path.join(values, 'styles.xml'), 'utf8')).not.toContain('Theme.App.Launch');
    expect(existsSync(drawable)).toBe(false);
    expect(existsSync(path.dirname(drawable))).toBe(false);
  });

  it('writes the backing drawable after Expo generates the splash theme on a clean prebuild', async () => {
    const { root, values, drawable } = createAndroidProject();
    const compile = () =>
      compileModsAsync(
        withBrandedSplash(
          { name: 'Kilo', slug: 'kilo-app', _internal: { projectRoot } },
          {
            image: path.join(projectRoot, 'assets/images/logo-mark.png'),
            backgroundColor: '#FAF74F',
            imageWidth: 100,
          }
        ),
        { projectRoot: root, platforms: ['android'] }
      );

    await compile();

    const contents = readFileSync(drawable, 'utf8');
    expect(contents).toContain('android:drawable="@color/splashscreen_background"');
    expect(contents).toContain('android:drawable="@drawable/splashscreen_logo"');
    const styles = readFileSync(path.join(values, 'styles.xml'), 'utf8');
    expect(styles).toContain('@drawable/splashscreen_window_background');
    expect(styles).toContain('@style/Theme.App.Launch');
    expect(readFileSync(path.join(values, 'colors.xml'), 'utf8')).toContain('#FAF74F');
    expect(existsSync(path.join(values, '../drawable-mdpi/splashscreen_logo.png'))).toBe(true);

    await compile();

    expect(readFileSync(drawable, 'utf8')).toBe(contents);
    const repeatedStyles = readFileSync(path.join(values, 'styles.xml'), 'utf8');
    expect(repeatedStyles.match(/<style name="Theme.App.Launch"/g)).toHaveLength(1);
    expect(repeatedStyles.match(/@drawable\/splashscreen_window_background/g)).toHaveLength(2);
  });

  it('keeps introspection read-only even when Expo supplies a splash theme', async () => {
    const { root, values, drawable } = createAndroidProject();
    const stylesBefore = readFileSync(path.join(values, 'styles.xml'), 'utf8');
    const config = withBrandedSplash(
      { name: 'Kilo', slug: 'kilo-app', _internal: { projectRoot } },
      { image: './assets/images/logo-mark.png', backgroundColor: '#FAF74F', imageWidth: 100 }
    );

    const evaluated = await compileModsAsync(config, {
      projectRoot: root,
      platforms: ['android'],
      introspect: true,
    });

    expect(evaluated._internal?.modResults?.android?.styles?.resources.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ $: { name: 'Theme.App.Launch', parent: '@style/AppTheme' } }),
      ])
    );
    expect(existsSync(drawable)).toBe(false);
    expect(existsSync(path.dirname(drawable))).toBe(false);
    expect(readFileSync(path.join(values, 'styles.xml'), 'utf8')).toBe(stylesBefore);
  });

  it('generates both native splash surfaces from the same options', async () => {
    const config: ExportedConfig = withBrandedSplash(
      { name: 'Kilo', slug: 'kilo-app', _internal: { projectRoot } },
      { image: './assets/images/logo-mark.png', backgroundColor: '#FAF74F', imageWidth: 100 }
    );

    expect(
      config.mods?.ios?.infoPlist,
      'iOS must receive the same launch implementation'
    ).toBeTypeOf('function');
    expect(config.mods?.android?.styles).toBeTypeOf('function');

    // Introspect against a fresh project root: `compileModsAsync` seeds the
    // Android color/style mods from the resources already on disk, so pointing
    // it at this package's root would read a developer's prebuilt `android/`
    // tree — its `colors.xml` is absent in CI — and merge colors this test does
    // not own into the mod results, making the assertion machine-dependent.
    const { root } = createAndroidProject();
    const evaluated = await compileModsAsync(config, {
      projectRoot: root,
      platforms: ['ios', 'android'],
      introspect: true,
    });
    expect(evaluated.ios?.infoPlist?.UILaunchStoryboardName).toBe('SplashScreen');
    expect(evaluated._internal?.modResults?.ios?.splashScreenStoryboard).toMatchObject({
      document: {
        resources: [
          {
            image: [{ $: { name: 'SplashScreenLogo', width: 100, height: 100 } }],
            namedColor: [
              {
                $: { name: 'SplashScreenBackground' },
                color: [
                  {
                    $: {
                      red: (250 / 255).toPrecision(15),
                      green: (247 / 255).toPrecision(15),
                      blue: (79 / 255).toPrecision(15),
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    // Assert the color this plugin generates, not the host's palette: the
    // compile above inspects the fresh root `createAndroidProject()` created
    // (no prebuilt `colors.xml`), and `arrayContaining` leaves any other
    // entries in `resources.color` unpinned.
    // `introspect` merges into the colors a local prebuild already generated, so
    // assert the plugin's entry instead of the whole array.
    expect(evaluated._internal?.modResults?.android?.colors).toMatchObject({
      resources: {
        color: expect.arrayContaining([{ $: { name: 'splashscreen_background' }, _: '#FAF74F' }]),
      },
    });
    expect(evaluated._internal?.modResults?.android?.styles).toMatchObject({
      resources: {
        style: expect.arrayContaining([
          expect.objectContaining({
            $: { name: 'Theme.App.SplashScreen', parent: 'Theme.SplashScreen' },
            item: expect.arrayContaining([
              {
                $: { name: 'android:windowBackground' },
                _: '@drawable/splashscreen_window_background',
              },
              { $: { name: 'postSplashScreenTheme' }, _: '@style/Theme.App.Launch' },
            ]),
          }),
        ]),
      },
    });
  });
});
