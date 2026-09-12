/* eslint-disable import/no-nodejs-modules -- verifies the dependency patch and installed router code under Node, never bundled in the app */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createConfig, getRouteConfigSorter } from 'expo-router/build/fork/getStateFromPath-forks';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const patch = readFileSync(
  new URL('../../../../patches/expo-router@57.0.15.patch', import.meta.url),
  'utf8'
);

describe('Expo Router provider review routes', () => {
  it('retains the Android native module', () => {
    const module = readFileSync(
      require.resolve('expo-router/android/src/main/java/expo/modules/router/ExpoRouterModule.kt'),
      'utf8'
    );
    expect(module).toContain('class ExpoRouterModule');
  });

  it.each(['comment-composer', 'review-submit', 'merge', 'file-navigator'])(
    'keeps the static %s suffix ahead of the catch-all index',
    screen => {
      function config(name: string) {
        const pattern = `pr-review/:platform/*identity${name === 'index' ? '' : `/${name}`}`;
        const routeNames = ['pr-review', '[platform]', '[...identity]', name];
        return {
          ...createConfig(name, pattern, routeNames),
          screen: name,
          pattern,
          path: pattern,
          routeNames,
        };
      }
      const index = config('index');
      const sheet = config(screen);
      const sorter = getRouteConfigSorter();
      expect(sorter(index, sheet)).toBeGreaterThan(0);
      expect(sorter(sheet, index)).toBeLessThan(0);
    }
  );

  it('locks every router snapshot to the current patch bytes', () => {
    const hash = createHash('sha256').update(patch).digest('hex');
    const lock = readFileSync(new URL('../../../../pnpm-lock.yaml', import.meta.url), 'utf8');
    expect(lock).toContain(`expo-router@57.0.15: ${hash}`);
    const hashes = [
      ...lock.matchAll(/(?:expo-router(?:@|: )|version: )57\.0\.15\(patch_hash=([a-f0-9]+)\)/g),
    ].map(match => match[1]);
    expect(hashes.length).toBeGreaterThan(0);
    expect(new Set(hashes)).toEqual(new Set([hash]));
  });

  it('keeps the router patch limited to the two JavaScript linking fixes', () => {
    const paths = [...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(match => match[1]);
    expect(paths).toEqual([
      'build/fork/getStateFromPath-forks.js',
      'build/fork/useLinking.native.js',
    ]);
  });

  it('automatically registers the provider index alongside the explicitly configured sheets', () => {
    const directory = new URL('../app/(app)/pr-review/[platform]/[...identity]/', import.meta.url);
    const layout = readFileSync(new URL('_layout.tsx', directory), 'utf8');
    const order = [...layout.matchAll(/<Stack\.Screen name="([^"]+)"/g)].map(match => ({
      name: match[1],
    }));
    const children = readdirSync(directory)
      .filter(file => file.endsWith('.tsx') && file !== '_layout.tsx')
      .map(file => ({ route: file.slice(0, -4) }));
    // Execute the installed router's sorting function, not a duplicate of its
    // registration rules. The comparator is immaterial to route membership.
    const source = readFileSync(require.resolve('expo-router/build/useScreens.js'), 'utf8');
    const start = source.indexOf('function getSortedChildren(');
    const end = source.indexOf('function useSortedScreens(', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const screens = runInNewContext(
      `${source.slice(start, end)}; getSortedChildren(children, order)`,
      {
        children,
        order,
        Route_1: { sortRoutesWithInitial: () => () => 0 },
      }
    ) as { route: { route: string } }[];
    expect(screens.map(screen => screen.route.route)).toEqual([
      'comment-composer',
      'review-submit',
      'merge',
      'file-navigator',
      'index',
    ]);
  });
});
