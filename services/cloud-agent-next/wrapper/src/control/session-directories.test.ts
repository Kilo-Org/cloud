import { beforeEach, describe, expect, it } from 'bun:test';
import {
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

  it('does not infer an unknown session or child root from its directory', () => {
    rememberAttachedRoot('root', '/ws');

    rememberChildSession({ childId: 'unknown', directory: '/ws' });
    rememberChildSession({ childId: 'child', parentId: 'unattached-root', directory: '/ws' });

    expect(rootForSession('unknown', '/ws')).toBeUndefined();
    expect(rootForSession('child', '/ws')).toBeUndefined();
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

  it('preserves a root when the requested detach directory does not match', () => {
    rememberAttachedRoot('root', '/ws');

    forgetAttachedRoot('root', '/different');

    expect(rootForSession('root')).toBe('root');
    expect(directoryForSession('root')).toBe('/ws');
  });
});
