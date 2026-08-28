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

  it('falls back to the attached directory for an unknown child', () => {
    rememberAttachedRoot('root', '/ws');

    rememberChildSession({ childId: 'unknown', directory: '/ws' });

    expect(rootForSession('unknown', '/ws')).toBe('root');
  });

  it('records children synchronously', () => {
    rememberAttachedRoot('root', '/ws');

    expect(rememberChildSession({ childId: 'c1', parentId: 'root' })).toBeUndefined();
    expect(rootForSession('c1')).toBe('root');
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

  it('preserves a root when the requested detach directory does not match', () => {
    rememberAttachedRoot('root', '/ws');

    forgetAttachedRoot('root', '/different');

    expect(rootForSession('root')).toBe('root');
    expect(directoryForSession('root')).toBe('/ws');
  });
});
