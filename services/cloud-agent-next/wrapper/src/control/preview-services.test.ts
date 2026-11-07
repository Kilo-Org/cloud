import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PreviewServiceScanTimeoutError, scanPreviewServices } from './preview-services';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

type FakeProcess = {
  pid: number;
  ppid?: number;
  argv: string[];
  cwd?: string;
  socketInodes?: number[];
};

function tcpLine(port: number, inode: number, state = '0A', ipv6 = false): string {
  const encodedPort = port.toString(16).padStart(4, '0').toUpperCase();
  const local = ipv6
    ? `00000000000000000000000000000000:${encodedPort}`
    : `0100007F:${encodedPort}`;
  return `   0: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 1000 0 ${inode} 1 0000000000000000 100 0 0 10 0`;
}

function makeProcRoot(processes: FakeProcess[]): string {
  const root = mkdtempSync(join(tmpdir(), 'preview-services-test-'));
  temporaryDirectories.push(root);
  mkdirSync(join(root, 'net'));
  writeFileSync(join(root, 'net', 'tcp'), '');
  writeFileSync(join(root, 'net', 'tcp6'), '');

  for (const process of processes) {
    const directory = join(root, String(process.pid));
    mkdirSync(directory);
    writeFileSync(
      join(directory, 'stat'),
      `${process.pid} (${process.argv[0] ?? 'x'}) S ${process.ppid ?? 1} 1 1 0`
    );
    writeFileSync(join(directory, 'cmdline'), process.argv.join('\0') + '\0');
    mkdirSync(join(directory, 'fd'));
    for (const [index, inode] of (process.socketInodes ?? []).entries()) {
      symlinkSync(`socket:[${inode}]`, join(directory, 'fd', String(index + 3)));
    }
    if (process.cwd !== undefined) {
      mkdirSync(join(root, 'cwd-targets', process.cwd), { recursive: true });
      symlinkSync(join(root, 'cwd-targets', process.cwd), join(directory, 'cwd'));
    }
  }
  return root;
}

function writeTcp(root: string, tcp: string[], tcp6: string[] = []): void {
  writeFileSync(join(root, 'net', 'tcp'), tcp.join('\n'));
  writeFileSync(join(root, 'net', 'tcp6'), tcp6.join('\n'));
}

describe('preview service discovery scanner', () => {
  it('lists tcp and tcp6 listeners, dedupes by port and derives safe names', async () => {
    const root = makeProcRoot([
      {
        pid: 100,
        argv: ['node', '/usr/local/bin/kilo', 'serve', '--port=0'],
        socketInodes: [10],
      },
      {
        pid: 200,
        argv: ['node', '/workspace/web/node_modules/.bin/next', 'dev'],
        cwd: 'web-app',
        socketInodes: [11],
      },
      {
        pid: 201,
        argv: ['node', '/workspace/web/node_modules/.bin/vite', '--port=3002'],
        cwd: 'frontend',
        socketInodes: [12],
      },
      {
        pid: 202,
        argv: ['custom-server', '--port=3003'],
        socketInodes: [13],
      },
    ]);
    writeTcp(
      root,
      [
        tcpLine(3000, 10),
        tcpLine(3001, 11),
        tcpLine(3002, 12),
        tcpLine(3003, 13),
        tcpLine(3004, 14),
        tcpLine(3010, 15, '01'),
        tcpLine(80, 16),
      ],
      [tcpLine(3002, 12, '0A', true)]
    );

    const services = await scanPreviewServices({ procRoot: root });
    expect(services).toEqual([
      { port: 3001, name: 'Next.js', description: 'in web-app' },
      { port: 3002, name: 'Vite', description: 'in frontend' },
      { port: 3003, name: 'HTTP server' },
    ]);
  });

  it('omits proxy and control listeners that no sandbox process owns', async () => {
    const root = makeProcRoot([]);
    writeTcp(root, [tcpLine(39001, 17), tcpLine(41209, 18)]);

    const services = await scanPreviewServices({ procRoot: root });
    expect(services).toEqual([]);
  });

  it('ignores inherited object properties in framework and executable labels', async () => {
    const root = makeProcRoot([
      { pid: 200, argv: ['node', '/workspace/constructor'], socketInodes: [20] },
      { pid: 201, argv: ['/usr/bin/constructor'], socketInodes: [21] },
      { pid: 202, argv: ['node', 'constructor', 'vite'], socketInodes: [22] },
    ]);
    writeTcp(root, [tcpLine(4000, 20), tcpLine(4001, 21), tcpLine(4002, 22)]);

    expect(await scanPreviewServices({ procRoot: root })).toEqual([
      { port: 4000, name: 'Node.js' },
      { port: 4001, name: 'HTTP server' },
      { port: 4002, name: 'Vite' },
    ]);
  });

  it('never returns raw argv, environment-like flags or full paths', async () => {
    const root = makeProcRoot([
      {
        pid: 200,
        argv: ['node', '/workspace/private/server.js', '--api-key', 'supersecret'],
        cwd: 'private-app',
        socketInodes: [20],
      },
    ]);
    writeTcp(root, [tcpLine(4000, 20)]);

    const result = await scanPreviewServices({ procRoot: root });
    const serialized = JSON.stringify(result);
    expect(result).toEqual([{ port: 4000, name: 'Node.js', description: 'in private-app' }]);
    expect(serialized).not.toContain('/workspace');
    expect(serialized).not.toContain('supersecret');
    expect(serialized).not.toContain('--api-key');
  });

  it('excludes caller-owned control ports', async () => {
    const root = makeProcRoot([
      { pid: 200, argv: ['node', 'vite'], socketInodes: [21] },
      { pid: 201, argv: ['node', 'next'], socketInodes: [22] },
    ]);
    writeTcp(root, [tcpLine(3000, 21), tcpLine(3001, 22)]);

    const services = await scanPreviewServices({ procRoot: root, excludedPorts: [3000] });
    expect(services).toEqual([{ port: 3001, name: 'Next.js' }]);
  });

  it('returns an empty list when nothing is listening', async () => {
    const root = makeProcRoot([]);
    const services = await scanPreviewServices({ procRoot: root });
    expect(services).toEqual([]);
  });

  it('bounds the returned service count', async () => {
    const processes = Array.from({ length: 4 }, (_, index) => ({
      pid: 200 + index,
      argv: ['node', 'next'],
      socketInodes: [30 + index],
    }));
    const root = makeProcRoot(processes);
    writeTcp(
      root,
      processes.map((process, index) => tcpLine(5000 + index, process.socketInodes[0]))
    );

    const services = await scanPreviewServices({ procRoot: root, maxServices: 2 });
    expect(services).toHaveLength(2);
  });

  it('checks the deadline while walking file descriptors', async () => {
    const root = makeProcRoot([{ pid: 200, argv: ['node', 'next'] }]);
    const fdDirectory = join(root, '200', 'fd');
    for (let index = 0; index < 60; index += 1) {
      symlinkSync('/dev/null', join(fdDirectory, `extra-${index}`));
    }
    writeTcp(root, [tcpLine(5000, 999)]);
    let calls = 0;
    const now = (): number => {
      calls += 1;
      return calls < 30 ? 0 : 2_000;
    };

    const error = await scanPreviewServices({ procRoot: root, now, deadlineMs: 1_000 }).then(
      () => undefined,
      reason => reason
    );
    expect(error).toBeInstanceOf(PreviewServiceScanTimeoutError);
  });

  it('removes the deadline abort listener when the scan finishes', async () => {
    const root = makeProcRoot([{ pid: 200, argv: ['node', 'next'], socketInodes: [40] }]);
    writeTcp(root, [tcpLine(5000, 40)]);
    let added = 0;
    let removed = 0;
    const signal = {
      aborted: false,
      addEventListener: () => {
        added += 1;
      },
      removeEventListener: () => {
        removed += 1;
      },
    } as unknown as AbortSignal;

    await scanPreviewServices({ procRoot: root, signal });

    expect(added).toBe(1);
    expect(removed).toBe(1);
  });

  it('throws when neither TCP listener table is readable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'preview-services-test-'));
    temporaryDirectories.push(root);
    const error = await scanPreviewServices({ procRoot: root }).then(
      () => undefined,
      reason => reason
    );
    expect(error).toBeInstanceOf(Error);
  });

  it('throws a timeout instead of pretending nothing is listening', async () => {
    const root = makeProcRoot([]);
    const error = await scanPreviewServices({ procRoot: root, deadlineMs: 0 }).then(
      () => undefined,
      reason => reason
    );
    expect(error).toBeInstanceOf(PreviewServiceScanTimeoutError);
  });
});
