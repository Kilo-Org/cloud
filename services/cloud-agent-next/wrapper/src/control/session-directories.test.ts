import { beforeEach, describe, expect, it } from 'bun:test';
import {
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
});
