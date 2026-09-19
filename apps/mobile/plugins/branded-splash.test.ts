import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { compileModsAsync, type ConfigPlugin, type ExportedConfig } from 'expo/config-plugins';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const withBrandedSplash = require('./withBrandedSplash.js') as ConfigPlugin<{
  image: string;
  backgroundColor: string;
  imageWidth: number;
}>;

describe('shared branded splash', () => {
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

    const evaluated = await compileModsAsync(config, {
      projectRoot,
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
    expect(evaluated._internal?.modResults?.android?.colors).toMatchObject({
      resources: { color: [{ $: { name: 'splashscreen_background' }, _: '#FAF74F' }] },
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
