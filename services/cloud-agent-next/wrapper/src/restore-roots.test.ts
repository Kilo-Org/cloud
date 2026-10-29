import { describe, expect, it } from 'bun:test';
import { rootForPath, routeRestoreDiffs } from './restore-roots';

const roots = ['/workspace/web', '/workspace/api'];

describe('rootForPath', () => {
  it('matches by path segment, so a sibling with the same prefix is outside', () => {
    expect(rootForPath(roots, '/workspace/web/src/a.ts')).toBe('/workspace/web');
    expect(rootForPath(roots, '/workspace/website/src/a.ts')).toBeUndefined();
    expect(rootForPath(roots, '/workspace/web')).toBe('/workspace/web');
  });

  it('prefers the longest root when roots nest', () => {
    expect(
      rootForPath(['/workspace/web', '/workspace/web/vendor'], '/workspace/web/vendor/a.ts')
    ).toBe('/workspace/web/vendor');
  });

  it('treats a trailing slash on a root like the root itself', () => {
    expect(rootForPath(['/workspace/web/'], '/workspace/web/a.ts')).toBe('/workspace/web');
  });
});

describe('routeRestoreDiffs', () => {
  const diff = (file: string) => ({ file, status: 'modified', patch: 'x' });

  it('applies everything at the workspace path when the route has no roots', () => {
    const result = routeRestoreDiffs([diff('/workspace/app/a.ts')], '/workspace/app', undefined);
    expect(result.routed).toEqual([
      { diff: diff('/workspace/app/a.ts'), workspace: '/workspace/app' },
    ]);
    expect(result.outside).toEqual([]);
  });

  it('sends an absolute path to its root and an outside path nowhere', () => {
    const result = routeRestoreDiffs(
      [
        diff('/workspace/web/src/a.ts'),
        diff('/workspace/api/b.ts'),
        diff('/workspace/website/c.ts'),
        diff('/etc/passwd'),
        diff('/workspace/web/../website/d.ts'),
      ],
      '/workspace',
      { directories: roots }
    );
    expect(result.routed.map(({ diff: d, workspace }) => [d.file, workspace])).toEqual([
      ['/workspace/web/src/a.ts', '/workspace/web'],
      ['/workspace/api/b.ts', '/workspace/api'],
    ]);
    expect(result.outside.map(d => d.file)).toEqual([
      '/workspace/website/c.ts',
      '/etc/passwd',
      '/workspace/web/../website/d.ts',
    ]);
  });

  it('resolves a relative file against the Kilo cwd before it picks a root', () => {
    const result = routeRestoreDiffs([diff('web/src/a.ts')], '/workspace', { directories: roots });
    expect(result.routed).toEqual([
      { diff: diff('/workspace/web/src/a.ts'), workspace: '/workspace/web' },
    ]);
  });

  it('leaves the files of a recovered root to its saved snapshot', () => {
    const result = routeRestoreDiffs(
      [diff('/workspace/web/a.ts'), diff('/workspace/api/b.ts')],
      '/workspace',
      { directories: roots, recovered: ['/workspace/web'] }
    );
    expect(result.routed.map(entry => entry.workspace)).toEqual(['/workspace/api']);
    expect(result.recoveredCount).toBe(1);
  });
});
