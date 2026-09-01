import { beforeEach, describe, expect, it } from 'bun:test';
import {
  directoriesForRoot,
  directoryForSession,
  forgetAttachedRoot,
  rememberAttachedRoot,
  rememberChildSession,
  resetSessionDirectoryState,
  rootForSession,
} from './session-directories';

describe('session directory root mappings', () => {
  beforeEach(() => {
    resetSessionDirectoryState();
  });

  it('maps an attached root by session and directory', () => {
    rememberAttachedRoot('root', '/ws');

    expect(rootForSession('root')).toBe('root');
    expect(rootForSession(undefined, '/ws')).toBe('root');
  });

  it('maps a child to its attached parent root', () => {
    rememberAttachedRoot('root', '/ws');

    rememberChildSession({ childId: 'c1', parentId: 'root', directory: '/ws' });

    expect(rootForSession('c1')).toBe('root');
  });

  it('maps nested children through the cached parent root', () => {
    rememberAttachedRoot('root', '/ws');
    rememberChildSession({ childId: 'c1', parentId: 'root', directory: '/ws' });

    rememberChildSession({ childId: 'c2', parentId: 'c1', directory: '/ws' });

    expect(rootForSession('c2')).toBe('root');
  });

  it('leaves an unknown child unmapped without a parent or directory', () => {
    rememberChildSession({ childId: 'unknown' });

    expect(rootForSession('unknown')).toBeUndefined();
  });

  it('fails closed for named sessions without known lineage even in a unique directory', () => {
    rememberAttachedRoot('root', '/ws');

    rememberChildSession({ childId: 'unknown', directory: '/ws' });
    rememberChildSession({ childId: 'child', parentId: 'unattached-root', directory: '/ws' });

    expect(rootForSession('unknown', '/ws')).toBeUndefined();
    expect(rootForSession('child', '/ws')).toBeUndefined();
    expect(rootForSession('', '/ws')).toBeUndefined();
    expect(rootForSession(undefined, '/ws')).toBe('root');
    expect(directoryForSession('unknown')).toBeUndefined();
    expect(directoryForSession('child')).toBeUndefined();
  });

  it('records children synchronously', () => {
    rememberAttachedRoot('root', '/ws');

    expect(rememberChildSession({ childId: 'c1', parentId: 'root' })).toBeUndefined();
    expect(rootForSession('c1')).toBe('root');
    expect(directoryForSession('c1')).toBe('/ws');
  });

  it('forgets only the detached root and its child sessions', () => {
    rememberAttachedRoot('first', '/first');
    rememberChildSession({ childId: 'first-child', parentId: 'first', directory: '/first' });
    rememberAttachedRoot('second', '/second');
    rememberChildSession({ childId: 'second-child', parentId: 'second', directory: '/second' });

    forgetAttachedRoot('first', '/first');

    expect(rootForSession('first')).toBeUndefined();
    expect(rootForSession('first-child')).toBeUndefined();
    expect(rootForSession(undefined, '/first')).toBeUndefined();
    expect(directoryForSession('first')).toBeUndefined();
    expect(directoryForSession('first-child')).toBeUndefined();
    expect(rootForSession('second')).toBe('second');
    expect(rootForSession('second-child')).toBe('second');
    expect(directoryForSession('second-child')).toBe('/second');
  });

  it('keeps multiple roots and nested children independent in the same worktree', () => {
    rememberAttachedRoot('first', '/ws');
    rememberChildSession({ childId: 'first-child', parentId: 'first' });
    rememberAttachedRoot('second', '/ws');
    rememberChildSession({ childId: 'second-child', parentId: 'second' });
    rememberChildSession({ childId: 'first-grandchild', parentId: 'first-child' });
    rememberAttachedRoot('first', '/ws');

    expect(rootForSession('first', '/ws')).toBe('first');
    expect(rootForSession('second', '/ws')).toBe('second');
    expect(rootForSession('first-grandchild', '/ws')).toBe('first');
    expect(directoryForSession('first-grandchild')).toBe('/ws');
    expect(rootForSession('first-child')).toBe('first');
    expect(rootForSession('second-child')).toBe('second');
    expect(directoriesForRoot('first', '/ws')).toEqual(['/ws']);
    expect(directoriesForRoot('second', '/ws')).toEqual(['/ws']);
    expect(rootForSession(undefined, '/ws')).toBeUndefined();

    forgetAttachedRoot('second', '/ws');
    expect(rootForSession(undefined, '/ws')).toBe('first');
    expect(rootForSession('second', '/ws')).toBeUndefined();
    expect(rootForSession('second-child', '/ws')).toBeUndefined();
    expect(rootForSession('first-grandchild')).toBe('first');
    expect(directoryForSession('first-grandchild')).toBe('/ws');

    forgetAttachedRoot('first', '/ws');
    expect(rootForSession(undefined, '/ws')).toBeUndefined();
  });

  it('does not reparent an attached root or a known child to a sibling root', () => {
    rememberAttachedRoot('first', '/ws');
    rememberAttachedRoot('second', '/ws');
    rememberChildSession({ childId: 'child', parentId: 'first' });

    rememberChildSession({ childId: 'first', directory: '/ws' });
    rememberChildSession({ childId: 'first', parentId: 'second', directory: '/ws' });
    rememberChildSession({ childId: 'child', parentId: 'second', directory: '/ws' });

    expect(rootForSession('first')).toBe('first');
    expect(rootForSession('child')).toBe('first');
  });

  it('rejects late children and nested descendants after their parent root detached', () => {
    rememberAttachedRoot('first', '/ws');
    rememberAttachedRoot('second', '/ws');
    rememberChildSession({ childId: 'child', parentId: 'second' });
    forgetAttachedRoot('second');

    rememberChildSession({ childId: 'late-child', parentId: 'second', directory: '/ws' });
    rememberChildSession({ childId: 'late-grandchild', parentId: 'child', directory: '/ws' });

    for (const id of ['second', 'child', 'late-child', 'late-grandchild']) {
      expect(rootForSession(id, '/ws')).toBeUndefined();
      expect(directoryForSession(id)).toBeUndefined();
    }
    expect(rootForSession(undefined, '/ws')).toBe('first');
  });

  it('restores exact lineage after reattaching a previously detached root', () => {
    rememberAttachedRoot('first', '/ws');
    rememberAttachedRoot('second', '/ws');
    rememberChildSession({ childId: 'child', parentId: 'second' });
    forgetAttachedRoot('second');

    rememberAttachedRoot('second', '/ws');
    expect(rootForSession('child', '/ws')).toBeUndefined();
    rememberChildSession({ childId: 'child', parentId: 'second' });

    expect(rootForSession('second', '/ws')).toBe('second');
    expect(rootForSession('child', '/ws')).toBe('second');
    expect(rootForSession(undefined, '/ws')).toBeUndefined();
  });

  it('retains known-lineage descendants in other directories without polling sibling roots', () => {
    rememberAttachedRoot('root', '/ws');
    rememberAttachedRoot('sibling', '/other');
    rememberChildSession({ childId: 'child', parentId: 'root', directory: '/child-worktree' });
    rememberChildSession({ childId: 'nested', parentId: 'child' });
    rememberChildSession({ childId: 'spoof', parentId: 'root', directory: '/other' });

    expect(rootForSession('child', '/child-worktree')).toBe('root');
    expect(rootForSession('nested', '/child-worktree')).toBe('root');
    expect(directoryForSession('nested')).toBe('/child-worktree');
    expect(rootForSession('child', '/other')).toBeUndefined();
    expect(rootForSession('root', '/other')).toBeUndefined();
    expect(rootForSession('spoof')).toBeUndefined();
    expect(directoryForSession('spoof')).toBeUndefined();
    expect(directoriesForRoot('root', '/ws')).toEqual(['/ws', '/child-worktree']);
    expect(directoriesForRoot('sibling', '/other')).toEqual(['/other']);

    forgetAttachedRoot('root');
    expect(rootForSession('nested', '/child-worktree')).toBeUndefined();
    expect(directoryForSession('child')).toBeUndefined();
    expect(directoryForSession('nested')).toBeUndefined();
    expect(rootForSession('sibling', '/other')).toBe('sibling');
  });

  it('excludes existing descendants when their external directory gains an independent root', () => {
    rememberAttachedRoot('root_a', '/a');
    rememberChildSession({ childId: 'child_a', parentId: 'root_a', directory: '/child-dir' });
    rememberChildSession({ childId: 'nested_a', parentId: 'child_a' });
    rememberChildSession({ childId: 'external_a', parentId: 'root_a', directory: '/external' });
    expect(rootForSession('child_a')).toBe('root_a');
    expect(directoriesForRoot('root_a', '/a')).toEqual(['/a', '/child-dir', '/external']);

    rememberAttachedRoot('root_b', '/child-dir');

    for (const sessionId of ['child_a', 'nested_a']) {
      expect(rootForSession(sessionId)).toBeUndefined();
      expect(rootForSession(sessionId, '/child-dir')).toBeUndefined();
      expect(directoryForSession(sessionId)).toBe('/child-dir');
    }
    expect(rootForSession('external_a')).toBe('root_a');
    expect(rootForSession('root_b')).toBe('root_b');
    expect(directoriesForRoot('root_a', '/a')).toEqual(['/a', '/external']);
    expect(directoriesForRoot('root_b', '/child-dir')).toEqual(['/child-dir']);
    expect(directoriesForRoot('unattached', '/child-dir')).toEqual([]);

    rememberChildSession({ childId: 'late', parentId: 'child_a', directory: '/another-external' });
    expect(rootForSession('late')).toBeUndefined();
    expect(directoryForSession('late')).toBeUndefined();

    forgetAttachedRoot('root_b');
    expect(rootForSession('child_a')).toBe('root_a');
    expect(rootForSession('nested_a')).toBe('root_a');
    expect(directoriesForRoot('root_a', '/a')).toEqual(['/a', '/child-dir', '/external']);
  });

  it('removes stale directory fallback when an attached root moves', () => {
    rememberAttachedRoot('root', '/old');
    rememberAttachedRoot('root', '/new');

    expect(rootForSession(undefined, '/old')).toBeUndefined();
    expect(rootForSession('root', '/old')).toBeUndefined();
    expect(rootForSession(undefined, '/new')).toBe('root');
    expect(directoryForSession('root')).toBe('/new');
  });

  it('preserves a root when the requested detach directory does not match', () => {
    rememberAttachedRoot('root', '/ws');

    forgetAttachedRoot('root', '/different');

    expect(rootForSession('root')).toBe('root');
    expect(directoryForSession('root')).toBe('/ws');
  });
});
