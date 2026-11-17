import { describe, expect, it } from 'vitest';
import { hasStartupMarker, markedStartupCommand } from './startup-command-marker.js';

describe('startup command marker', () => {
  it('appends the marker as a trailing comment that a listed command matches', () => {
    const marked = markedStartupCommand({ argv: ['/bin/sh', '-c', 'exec main'] }, 'tag:1');
    expect(marked).toEqual({ command: '/bin/sh', args: ['-c', 'exec main\n# tag:1'] });
    expect(hasStartupMarker(marked.args, 'tag:1')).toBe(true);
    expect(hasStartupMarker(marked.args, 'tag:2')).toBe(false);
    expect(hasStartupMarker(['-lc', 'exec supervisor # tag:1'], 'tag:1')).toBe(true);
  });

  it('refuses a command that is not one shell script', () => {
    for (const argv of [[], ['/bin/sh', 'script'], ['/bin/sh', '-c', 'a', 'extra']]) {
      expect(() => markedStartupCommand({ argv }, 'tag')).toThrow('not a shell script');
    }
  });
});
