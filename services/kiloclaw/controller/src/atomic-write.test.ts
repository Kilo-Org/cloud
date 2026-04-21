import { describe, expect, it, vi } from 'vitest';
import { atomicWrite, type AtomicWriteDeps } from './atomic-write.js';

function makeDeps(overrides: Partial<AtomicWriteDeps> = {}): AtomicWriteDeps {
  return {
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
    chmodSync: vi.fn(),
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

  it('does not chmod when mode option is not provided (backwards compatible)', () => {
    const deps = makeDeps();
    atomicWrite('/config/openclaw.json', 'data', deps);

    expect(deps.renameSync).toHaveBeenCalledOnce();
    expect(deps.chmodSync).not.toHaveBeenCalled();
  });

  it('chmods the temp file BEFORE rename when mode option is provided', () => {
    const callOrder: string[] = [];
    const deps = makeDeps({
      writeFileSync: vi.fn(() => {
        callOrder.push('write');
      }),
      chmodSync: vi.fn(() => {
        callOrder.push('chmod');
      }),
      renameSync: vi.fn(() => {
        callOrder.push('rename');
      }),
    });
    atomicWrite('/config/openclaw.json', 'data', deps, { mode: 0o600 });

    // Ordering is part of the atomic-rename contract: chmod the temp file
    // first, then rename commits the already-moded file into place. If the
    // chmod throws, the catch cleans up the temp and the final path is
    // untouched — rather than being left at default-umask after a successful
    // rename but before a chmod that may or may not have fired.
    expect(callOrder).toEqual(['write', 'chmod', 'rename']);

    const tmpPath = (deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(deps.chmodSync).toHaveBeenCalledWith(tmpPath, 0o600);
    expect(deps.renameSync).toHaveBeenCalledWith(tmpPath, '/config/openclaw.json');
  });

  it('cleans up temp file and rethrows when chmod fails (target path untouched)', () => {
    const chmodError = new Error('chmod failed');
    const deps = makeDeps({
      chmodSync: vi.fn().mockImplementation(() => {
        throw chmodError;
      }),
    });

    expect(() => atomicWrite('/config/openclaw.json', 'data', deps, { mode: 0o600 })).toThrow(
      chmodError
    );

    // rename must NOT have happened — target path is untouched
    expect(deps.renameSync).not.toHaveBeenCalled();

    // Temp file cleanup attempted
    const tmpPath = (deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(deps.unlinkSync).toHaveBeenCalledWith(tmpPath);
  });

  it('throws a clear error when mode is requested but chmodSync is not in deps', () => {
    const deps: AtomicWriteDeps = {
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
      unlinkSync: vi.fn(),
      // chmodSync intentionally omitted
    };

    expect(() => atomicWrite('/config/openclaw.json', 'data', deps, { mode: 0o600 })).toThrow(
      'options.mode was specified but deps.chmodSync is not provided'
    );

    // None of the write operations should have run — the guard fires first
    expect(deps.writeFileSync).not.toHaveBeenCalled();
    expect(deps.renameSync).not.toHaveBeenCalled();
  });

  it('allows omitting chmodSync from deps when no mode is requested', () => {
    const deps: AtomicWriteDeps = {
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
      unlinkSync: vi.fn(),
      // chmodSync intentionally omitted — allowed because options.mode is unset
    };

    expect(() => atomicWrite('/config/openclaw.json', 'data', deps)).not.toThrow();
    expect(deps.writeFileSync).toHaveBeenCalledOnce();
    expect(deps.renameSync).toHaveBeenCalledOnce();
  });
});
