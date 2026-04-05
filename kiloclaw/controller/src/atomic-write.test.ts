import { describe, expect, it, vi } from 'vitest';
import { atomicWrite, type AtomicWriteDeps } from './atomic-write.js';

function makeDeps(overrides: Partial<AtomicWriteDeps> = {}): AtomicWriteDeps {
  return {
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
    ...overrides,
  };
}

describe('atomicWrite', () => {
  it('writes to a temp file then renames into place', () => {
    const deps = makeDeps();
    atomicWrite('/config/openclaw.json', '{"ok":true}', deps);

    expect(deps.writeFileSync).toHaveBeenCalledOnce();
    expect(deps.renameSync).toHaveBeenCalledOnce();

    // The temp file should be in the same directory with a .kilotmp suffix
    const tmpPath = (deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(tmpPath).toMatch(/^\/config\/\.openclaw\.json\.kilotmp\.[0-9a-f]+$/);
    expect((deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('{"ok":true}');

    // Rename should move the temp file to the final path
    expect(deps.renameSync).toHaveBeenCalledWith(tmpPath, '/config/openclaw.json');

    // No cleanup needed on success
    expect(deps.unlinkSync).not.toHaveBeenCalled();
  });

  it('does not call rename when write fails, and cleans up temp file', () => {
    const writeError = new Error('disk full');
    const deps = makeDeps({
      writeFileSync: vi.fn().mockImplementation(() => {
        throw writeError;
      }),
    });

    expect(() => atomicWrite('/config/openclaw.json', 'data', deps)).toThrow(writeError);

    expect(deps.renameSync).not.toHaveBeenCalled();
    expect(deps.unlinkSync).toHaveBeenCalledOnce();
  });

  it('unlinks temp file and rethrows when rename fails', () => {
    const renameError = new Error('rename failed');
    const deps = makeDeps({
      renameSync: vi.fn().mockImplementation(() => {
        throw renameError;
      }),
    });

    expect(() => atomicWrite('/config/openclaw.json', 'data', deps)).toThrow(renameError);

    // Write succeeded, so temp file was created — should be cleaned up
    const tmpPath = (deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(deps.unlinkSync).toHaveBeenCalledWith(tmpPath);
  });

  it('rethrows the original error when cleanup also fails', () => {
    const renameError = new Error('rename failed');
    const unlinkError = new Error('unlink failed');
    const deps = makeDeps({
      renameSync: vi.fn().mockImplementation(() => {
        throw renameError;
      }),
      unlinkSync: vi.fn().mockImplementation(() => {
        throw unlinkError;
      }),
    });

    // Should throw the original rename error, not the unlink error
    expect(() => atomicWrite('/config/openclaw.json', 'data', deps)).toThrow(renameError);
  });
});
