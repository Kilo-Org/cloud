import { describe, it, expect } from 'vitest';
import { resolveSafePath, verifyCanonicalized } from './safe-path';

const ROOT = '/root/.openclaw';

describe('resolveSafePath', () => {
  it('resolves a simple relative path', () => {
    expect(resolveSafePath('openclaw.json', ROOT)).toBe('/root/.openclaw/openclaw.json');
  });

  it('resolves a nested path', () => {
    expect(resolveSafePath('workspace/SOUL.md', ROOT)).toBe('/root/.openclaw/workspace/SOUL.md');
  });

  it('rejects path traversal with ..', () => {
    expect(() => resolveSafePath('../etc/passwd', ROOT)).toThrow();
  });

  it('rejects path traversal with encoded ..', () => {
    expect(() => resolveSafePath('workspace/../../etc/passwd', ROOT)).toThrow();
  });

  it('rejects absolute paths', () => {
    expect(() => resolveSafePath('/etc/passwd', ROOT)).toThrow();
  });

  it('rejects null bytes', () => {
    expect(() => resolveSafePath('workspace/SOUL\0.md', ROOT)).toThrow();
  });

  it('resolves the legacy bootstrap path in workspace', () => {
    expect(resolveSafePath('workspace/BOOTSTRAP.md', ROOT)).toBe(
      '/root/.openclaw/workspace/BOOTSTRAP.md'
    );
  });

  it('allows credentials directory', () => {
    expect(resolveSafePath('credentials/key.json', ROOT)).toBe(
      '/root/.openclaw/credentials/key.json'
    );
  });

  it('allows nested credentials directory', () => {
    expect(resolveSafePath('workspace/credentials/key.json', ROOT)).toBe(
      '/root/.openclaw/workspace/credentials/key.json'
    );
  });

  it('rejects empty path', () => {
    expect(() => resolveSafePath('', ROOT)).toThrow();
  });
});

describe('verifyCanonicalized', () => {
  it('accepts a path inside rootDir', () => {
    expect(() => verifyCanonicalized('/root/.openclaw/workspace/SOUL.md', ROOT)).not.toThrow();
  });

  it('rejects a path that escapes root via symlink resolution', () => {
    expect(() => verifyCanonicalized('/etc/passwd', ROOT)).toThrow(
      'escapes root directory via symlink'
    );
  });

  it('allows a canonicalized path through credentials', () => {
    expect(() => verifyCanonicalized('/root/.openclaw/credentials/key.json', ROOT)).not.toThrow();
  });
});
