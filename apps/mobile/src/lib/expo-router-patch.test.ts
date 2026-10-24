import { createConfig, getRouteConfigSorter } from 'expo-router/build/fork/getStateFromPath-forks';
import { describe, expect, it } from 'vitest';

describe('Expo Router provider review routes', () => {
  it.each(['comment-composer', 'conversation-comment', 'review-submit', 'merge', 'file-navigator'])(
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
});
