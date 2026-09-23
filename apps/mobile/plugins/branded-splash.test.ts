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
    // Compile and introspect against the throwaway project root the sibling
    // cases use: `compileModsAsync` seeds the Android color/style mods from the
    // resources already on disk, so compiling against this package's root would
    // fold a developer's generated, gitignored `android/` tree into the result —
    // its `colors.xml` is absent in CI — and merge colors this test does not own
    // into the mod results, making the exact assertion below machine-dependent.
    const { root } = createAndroidProject();
    const config: ExportedConfig = withBrandedSplash(
      { name: 'Kilo', slug: 'kilo-app', _internal: { projectRoot } },
      {
        image: path.join(projectRoot, 'assets/images/logo-mark.png'),
        backgroundColor: '#FAF74F',
        imageWidth: 100,
      }
    );

    expect(
      config.mods?.ios?.infoPlist,
      'iOS must receive the same launch implementation'
    ).toBeTypeOf('function');
    expect(config.mods?.android?.styles).toBeTypeOf('function');

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
<<<<<<< HEAD
    // `compileModsAsync` with `introspect: true` runs the Android colors mod
    // against `projectRoot`, so on a worktree with a generated or prebuilt
    // `android/` tree the introspected list also carries that project's other
    // colors — notification and dialog colors from the app's other plugins
    // (adaptive-icon, notification, app background), and whatever a local
    // prebuild already wrote. Assert the splash color this plugin owns is
    // present among them, by containment, rather than that it is the only entry
    // or that the array has an exact length, the same way the styles assertion
    // below tolerates extra prebuilt styles (and not the whole array, so a
    // prebuild's iconBackground, colorPrimary, … cannot fail the case).
=======
    // Introspection runs against the real project root, so `withAndroidColors`
    // also reads whatever the project's own prebuild has already written to
    // `android/app/src/main/res/values/colors.xml` (that directory is
    // gitignored, so CI sees only the splash color while a worktree with a
    // prebuild sees the app's colors too). The plugin's contract is that its
    // own color is present, not that it is the only one.
    // The shared app config carries the other `colors.xml` entries (icon and
    // notification colors, the app background) through the same mod chain, so
    // assert this plugin's surface is present rather than the array length.
    // compileModsAsync introspects the project's existing android resources, so
    // the colors array also carries the project's other theme colors. Assert the
    // splash color this plugin owns instead of the array's exact contents.
    // Introspection reads the project's own native resources, so the colors
    // modResults carry whatever the worktree's generated `android/` project
    // declares next to the splash color: notification and dialog colors come
    // from the app's other plugins (adaptive-icon, notification, app
    // background), and `introspect` merges into the colors a local prebuild
    // already generated, so a worktree with a prebuilt `android/` directory
    // carries that file's extra entries too. Assert the splash color the plugin
    // owns is present among them rather than the only one, by containment, the
    // same way the styles assertion below pins its theme: not the whole array
    // and not its exact length, so a prebuild's other colors (iconBackground,
    // colorPrimary, …) surviving here cannot fail the case.
>>>>>>> origin/main
    expect(evaluated._internal?.modResults?.android?.colors).toMatchObject({
      resources: {
        color: expect.arrayContaining([
          expect.objectContaining({ $: { name: 'splashscreen_background' }, _: '#FAF74F' }),
        ]),
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
