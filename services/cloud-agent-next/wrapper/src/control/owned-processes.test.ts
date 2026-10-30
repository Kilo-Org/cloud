import { describe, expect, it } from 'vitest';
import {
  isKernelThread,
  PF_KTHREAD,
  processIdentity,
  scanProcessIdentities,
  type ProcessScan,
} from './owned-processes';

function stat(pid: number, comm: string, flags: number, startedAt: number): string {
  const kernelThread = (flags & PF_KTHREAD) !== 0;
  const parent = kernelThread ? 2 : 1;
  const group = kernelThread ? 0 : pid;
  return `${pid} (${comm}) S ${parent} ${group} 0 0 -1 ${flags} 0 0 0 0 0 0 0 0 0 -20 0 1 ${startedAt} 0 0`;
}

function gone(code: 'ENOENT' | 'ESRCH'): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function scan(files: Map<string, string>, names: string[]): ProcessScan {
  return {
    procRoot: '/proc',
    readdir: async () => names,
    readFile: async file => {
      const value = files.get(file);
      if (value === undefined) throw gone('ENOENT');
      return value;
    },
  };
}

describe('process stat identity', () => {
  it('recognises the PF_KTHREAD flag from a /proc stat fixture', () => {
    const kernel = processIdentity(2, stat(2, 'kworker/0:1', PF_KTHREAD, 4_001));
    const user = processIdentity(3, stat(3, 'node', 0, 4_002));

    expect(kernel.flags & PF_KTHREAD).toBe(PF_KTHREAD);
    expect(isKernelThread(kernel)).toBe(true);
    expect(isKernelThread(user)).toBe(false);
  });

  it('rejects a malformed flags field instead of guessing', () => {
    expect(() => processIdentity(4, stat(4, 'node', Number.NaN, 4_003))).toThrow(
      'Process identity unavailable'
    );
  });
});

describe('process identity scan', () => {
  it('excludes kernel threads and skips processes that definitely disappeared', async () => {
    const files = new Map([
      ['/proc/1/stat', stat(1, 'init', 0, 1_001)],
      ['/proc/2/stat', stat(2, 'kworker/0:1', PF_KTHREAD, 1_002)],
      ['/proc/3/stat', stat(3, 'node', 0, 1_003)],
    ]);

    const identities = await scanProcessIdentities(
      scan(files, ['1', '2', '3', '4', 'self', 'thread-self'])
    );

    expect(identities.map(identity => identity.pid)).toEqual([1, 3]);
  });

  it('fails the scan when a stat read is denied', async () => {
    const input: ProcessScan = {
      procRoot: '/proc',
      readdir: async () => ['1'],
      readFile: async () => {
        const error = new Error('read denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      },
    };

    await expect(scanProcessIdentities(input)).rejects.toThrow('read denied');
  });

  it('skips ESRCH as a definite process disappearance', async () => {
    const identities = await scanProcessIdentities({
      procRoot: '/proc',
      readdir: async () => ['1'],
      readFile: async () => {
        throw gone('ESRCH');
      },
    });

    expect(identities).toEqual([]);
  });

  it('fails the scan when a present process has a malformed stat', async () => {
    await expect(
      scanProcessIdentities({
        procRoot: '/proc',
        readdir: async () => ['1'],
        readFile: async () => '1 (node) malformed',
      })
    ).rejects.toThrow('Process identity unavailable');
  });
});
