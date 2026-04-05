import { describe, it, expect, vi, beforeEach } from 'vitest';
import { backupFile, type BackupFileDeps } from './backup-file';

const ROOT = '/root/.openclaw';

describe('backupFile', () => {
  let deps: BackupFileDeps;

  beforeEach(() => {
    deps = {
      copyFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      readdirSync: vi.fn().mockReturnValue([]),
      unlinkSync: vi.fn(),
    };
  });

  it('creates a timestamped backup in .kilo-backups', () => {
    backupFile('/root/.openclaw/workspace/SOUL.md', ROOT, deps);

    expect(deps.mkdirSync).toHaveBeenCalledWith('/root/.openclaw/.kilo-backups', {
      recursive: true,
    });
    expect(deps.copyFileSync).toHaveBeenCalledOnce();
    const [src, dest] = (deps.copyFileSync as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(src).toBe('/root/.openclaw/workspace/SOUL.md');
    expect(dest).toMatch(/\/root\/\.openclaw\/\.kilo-backups\/workspace__SOUL\.md\.\d+\.bak$/);
  });

  it('sanitizes nested paths with double underscores', () => {
    backupFile('/root/.openclaw/a/b/c.json', ROOT, deps);

    const [, dest] = (deps.copyFileSync as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(dest).toMatch(/\/root\/\.openclaw\/\.kilo-backups\/a__b__c\.json\.\d+\.bak$/);
  });

  it('removes oldest backups when exceeding max count', () => {
    const existingBackups = [
      'workspace__SOUL.md.1740787200000.bak',
      'workspace__SOUL.md.1740873600000.bak',
      'workspace__SOUL.md.1740960000000.bak',
      'workspace__SOUL.md.1741046400000.bak',
      'workspace__SOUL.md.1741132800000.bak',
    ];
    (deps.readdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => [
      ...existingBackups,
      'workspace__SOUL.md.1741219200000.bak', // the one just created
    ]);

    backupFile('/root/.openclaw/workspace/SOUL.md', ROOT, deps);

    expect(deps.unlinkSync).toHaveBeenCalledOnce();
    expect(deps.unlinkSync).toHaveBeenCalledWith(
      '/root/.openclaw/.kilo-backups/workspace__SOUL.md.1740787200000.bak'
    );
  });

  it('does not remove backups when under max count', () => {
    const backups = [
      'workspace__SOUL.md.1740787200000.bak',
      'workspace__SOUL.md.1740873600000.bak',
    ];
    (deps.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(backups);

    backupFile('/root/.openclaw/workspace/SOUL.md', ROOT, deps);

    expect(deps.unlinkSync).not.toHaveBeenCalled();
  });
});
