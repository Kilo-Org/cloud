import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  classifyProcesses,
  isKiloServerProcess,
  parseToolCgroupConfig,
  pidStillMatches,
  readMemTotalBytes,
  readProcessTable,
  startToolCgroup,
  ToolCgroupManager,
  type ToolCgroupConfig,
} from './tool-cgroup';

const MEM_TOTAL_KB = 6333912;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tool-cgroup-test-'));
  tempDirs.push(dir);
  return dir;
}

function makeCgroupRoot(): string {
  const root = makeTempDir();
  writeFileSync(join(root, 'cgroup.subtree_control'), 'cpuset cpu io memory pids');
  return root;
}

type FakeProcess = { pid: number; ppid: number; argv: string[]; cgroup?: string };

function makeProcRoot(processes: FakeProcess[], memTotalKb = MEM_TOTAL_KB): string {
  const root = makeTempDir();
  writeFileSync(join(root, 'meminfo'), `MemTotal:        ${memTotalKb} kB\nMemFree: 1 kB\n`);
  for (const proc of processes) {
    const dir = join(root, String(proc.pid));
    mkdirSync(dir);
    writeFileSync(join(dir, 'stat'), `${proc.pid} (${proc.argv[0] ?? 'x'}) S ${proc.ppid} 1 1 0`);
    writeFileSync(join(dir, 'cmdline'), proc.argv.join('\0') + '\0');
    writeFileSync(join(dir, 'cgroup'), proc.cgroup ?? '0::/cloudchamber_v2/abc_oci');
  }
  return root;
}

/** Wrapper (100) → kilo shim (101) → kilo server (102) → bash (103) → tsc (104); wrapper → git (105). */
const PROCESS_TREE: FakeProcess[] = [
  { pid: 1, ppid: 0, argv: ['sandbox'] },
  { pid: 100, ppid: 1, argv: ['bun', '/usr/local/bin/kilocode-wrapper.js'] },
  { pid: 101, ppid: 100, argv: ['node', '/usr/local/bin/kilo', 'serve', '--hostname=127.0.0.1'] },
  { pid: 102, ppid: 101, argv: ['/usr/local/lib/kilo/.kilo', 'serve', '--hostname=127.0.0.1'] },
  { pid: 103, ppid: 102, argv: ['bash', '-c', 'pnpm --filter web typecheck'] },
  { pid: 104, ppid: 103, argv: ['node', '/repo/node_modules/.bin/tsc', '--noEmit'] },
  { pid: 105, ppid: 100, argv: ['git', 'commit', '-m', 'x'] },
  { pid: 200, ppid: 1, argv: ['bash'] },
];

function makeConfig(overrides: Partial<ToolCgroupConfig>): ToolCgroupConfig {
  return {
    mode: 'enforce',
    reserveBytes: 1536 * 1024 * 1024,
    serverLimitBytes: null,
    cpuWeight: null,
    serverCpuWeight: null,
    sweepIntervalMs: 1000,
    statsIntervalMs: 5 * 60 * 1000,
    oomGroup: true,
    cgroupRoot: makeCgroupRoot(),
    procRoot: makeProcRoot(PROCESS_TREE),
    toolCgroupName: 'kilo-tools',
    serverCgroupName: 'kilo-server',
    selfPid: 100,
    ...overrides,
  };
}

function readCgroupFile(config: ToolCgroupConfig, name: string, file: string): string {
  return readFileSync(join(config.cgroupRoot, name, file), 'utf8');
}

function migratedPids(config: ToolCgroupConfig, name: string): number[] {
  return readCgroupFile(config, name, 'cgroup.procs')
    .split('\n')
    .filter(Boolean)
    .map(line => parseInt(line, 10))
    .sort((a, b) => a - b);
}

describe('parseToolCgroupConfig', () => {
  it('defaults to off mode with standard knobs', () => {
    const config = parseToolCgroupConfig({}, () => {});
    expect(config.mode).toBe('off');
    expect(config.reserveBytes).toBe(1536 * 1024 * 1024);
    expect(config.serverLimitBytes).toBeNull();
    expect(config.cpuWeight).toBeNull();
    expect(config.serverCpuWeight).toBeNull();
    expect(config.sweepIntervalMs).toBe(1000);
    expect(config.oomGroup).toBe(true);
  });

  it('honors env overrides', () => {
    const config = parseToolCgroupConfig(
      {
        TOOL_CGROUP_MODE: 'enforce',
        TOOL_CGROUP_RESERVE_MB: '2048',
        TOOL_CGROUP_SERVER_LIMIT_MB: '1280',
        TOOL_CGROUP_SWEEP_INTERVAL_MS: '500',
        TOOL_CGROUP_OOM_GROUP: '0',
        TOOL_CGROUP_CPU_WEIGHT: '50',
        TOOL_CGROUP_SERVER_CPU_WEIGHT: '300',
      },
      () => {}
    );
    expect(config.mode).toBe('enforce');
    expect(config.reserveBytes).toBe(2048 * 1024 * 1024);
    expect(config.serverLimitBytes).toBe(1280 * 1024 * 1024);
    expect(config.sweepIntervalMs).toBe(500);
    expect(config.oomGroup).toBe(false);
    expect(config.cpuWeight).toBe(50);
    expect(config.serverCpuWeight).toBe(300);
  });

  it('treats an unset or zero cpu weight as kernel default', () => {
    expect(parseToolCgroupConfig({}, () => {}).cpuWeight).toBeNull();
    expect(parseToolCgroupConfig({ TOOL_CGROUP_CPU_WEIGHT: '0' }, () => {}).cpuWeight).toBeNull();
  });

  it('rejects out-of-range or invalid cpu weights with a warning', () => {
    const logs: string[] = [];
    const config = parseToolCgroupConfig(
      { TOOL_CGROUP_CPU_WEIGHT: '20000', TOOL_CGROUP_SERVER_CPU_WEIGHT: 'abc' },
      message => logs.push(message)
    );
    expect(config.cpuWeight).toBeNull();
    expect(config.serverCpuWeight).toBeNull();
    expect(logs.length).toBe(2);
  });

  it('treats an unset or zero server limit as observe-only', () => {
    expect(parseToolCgroupConfig({}, () => {}).serverLimitBytes).toBeNull();
    expect(
      parseToolCgroupConfig({ TOOL_CGROUP_SERVER_LIMIT_MB: '0' }, () => {}).serverLimitBytes
    ).toBeNull();
  });

  it('falls back on invalid values and clamps the sweep interval', () => {
    const logs: string[] = [];
    const config = parseToolCgroupConfig(
      {
        TOOL_CGROUP_MODE: 'bogus',
        TOOL_CGROUP_RESERVE_MB: 'abc',
        TOOL_CGROUP_SWEEP_INTERVAL_MS: '1',
      },
      message => logs.push(message)
    );
    expect(config.mode).toBe('off');
    expect(config.reserveBytes).toBe(1536 * 1024 * 1024);
    expect(config.sweepIntervalMs).toBe(200);
    expect(logs.length).toBe(2);
  });
});

describe('readMemTotalBytes', () => {
  it('parses MemTotal from meminfo', () => {
    const procRoot = makeProcRoot([]);
    expect(readMemTotalBytes(procRoot)).toBe(MEM_TOTAL_KB * 1024);
  });

  it('returns undefined when meminfo is missing', () => {
    expect(readMemTotalBytes(makeTempDir())).toBeUndefined();
  });
});

describe('isKiloServerProcess', () => {
  it('matches the kilo serve chain through shims and re-execs', () => {
    expect(isKiloServerProcess(['node', '/usr/local/bin/kilo', 'serve', '--port=0'])).toBe(true);
    expect(isKiloServerProcess(['/usr/local/lib/kilo/.kilo', 'serve'])).toBe(true);
    expect(isKiloServerProcess(['kilo', 'serve'])).toBe(true);
  });

  it('does not match tool commands', () => {
    expect(isKiloServerProcess(['bash', '-c', 'pnpm typecheck'])).toBe(false);
    expect(isKiloServerProcess(['npx', 'serve'])).toBe(false);
    // 'serve' inside a shell string is not a standalone argv token
    expect(isKiloServerProcess(['bash', '-c', 'echo kilo serve'])).toBe(false);
    // 'kilo' beyond the executable/script positions does not qualify
    expect(isKiloServerProcess(['node', 'tool.js', 'build', 'serve', '--dir=/kilo'])).toBe(false);
    // a script merely named after kilo is not the real binary basename
    expect(isKiloServerProcess(['node', '/tmp/my-kilo-tool.js', 'serve'])).toBe(false);
    // 'serve' must immediately follow the binary, not just appear somewhere in argv
    expect(isKiloServerProcess(['/usr/local/bin/kilo', '--flag', 'serve'])).toBe(false);
    expect(isKiloServerProcess([])).toBe(false);
  });
});

describe('readProcessTable / classifyProcesses', () => {
  it('reads pid, ppid and argv from /proc', async () => {
    const table = await readProcessTable(makeProcRoot(PROCESS_TREE));
    expect(table.size).toBe(PROCESS_TREE.length);
    expect(table.get(103)).toEqual({
      pid: 103,
      ppid: 102,
      argv: ['bash', '-c', 'pnpm --filter web typecheck'],
    });
  });

  it('classifies descendants of the wrapper into tool work vs. the kilo-server chain', async () => {
    const table = await readProcessTable(makeProcRoot(PROCESS_TREE));
    const { toolPids, serverPids } = classifyProcesses(table, 100);
    expect(toolPids.sort((a, b) => a - b)).toEqual([103, 104, 105]);
    expect(serverPids.sort((a, b) => a - b)).toEqual([101, 102]);
  });

  it('pidStillMatches accepts an unchanged process and rejects reuse, exec and exit', async () => {
    const procRoot = makeProcRoot([{ pid: 42, ppid: 7, argv: ['git', 'status'] }]);
    const snapshot = { pid: 42, ppid: 7, argv: ['git', 'status'] };
    expect(await pidStillMatches(procRoot, snapshot)).toBe(true);
    // pid reused by a child of a different parent
    writeFileSync(join(procRoot, '42', 'stat'), '42 (git) S 9 1 1 0');
    expect(await pidStillMatches(procRoot, snapshot)).toBe(false);
    // exec()ed into a different command since the snapshot
    writeFileSync(join(procRoot, '42', 'stat'), '42 (git) S 7 1 1 0');
    writeFileSync(join(procRoot, '42', 'cmdline'), 'node\0tsc\0');
    expect(await pidStillMatches(procRoot, snapshot)).toBe(false);
    // exited
    rmSync(join(procRoot, '42'), { recursive: true, force: true });
    expect(await pidStillMatches(procRoot, snapshot)).toBe(false);
  });

  it('handles a comm containing spaces and parens', async () => {
    const procRoot = makeTempDir();
    const dir = join(procRoot, '42');
    mkdirSync(dir);
    writeFileSync(join(dir, 'stat'), '42 (weird (name) x) S 7 1 1 0');
    writeFileSync(join(dir, 'cmdline'), 'weird\0');
    const table = await readProcessTable(procRoot);
    expect(table.get(42)?.ppid).toBe(7);
  });
});

describe('ToolCgroupManager.setup', () => {
  it('enforce mode caps the tool slice at MemTotal minus the reserve', () => {
    const config = makeConfig({});
    expect(new ToolCgroupManager(config, () => {}).setup()).toBe(true);
    expect(readCgroupFile(config, 'kilo-tools', 'memory.max')).toBe(
      String(MEM_TOTAL_KB * 1024 - config.reserveBytes)
    );
    expect(readCgroupFile(config, 'kilo-tools', 'memory.oom.group')).toBe('1');
    expect(readCgroupFile(config, 'kilo-tools', 'memory.swap.max')).toBe('0');
  });

  it('observe mode leaves the tool slice uncapped', () => {
    const config = makeConfig({ mode: 'observe' });
    const manager = new ToolCgroupManager(config, () => {});
    expect(manager.setup()).toBe(true);
    expect(readCgroupFile(config, 'kilo-tools', 'memory.max')).toBe('max');
    expect(readCgroupFile(config, 'kilo-tools', 'memory.swap.max')).toBe('max');
    expect(manager.health().memoryMaxBytes).toBeNull();
  });

  it('falls back to observe when the computed tool cap is too small', () => {
    const logs: string[] = [];
    const config = makeConfig({ procRoot: makeProcRoot(PROCESS_TREE, 1024 * 1024) });
    const manager = new ToolCgroupManager(config, message => logs.push(message));
    expect(manager.setup()).toBe(true);
    expect(readCgroupFile(config, 'kilo-tools', 'memory.max')).toBe('max');
    expect(manager.health().mode).toBe('observe');
    expect(logs.some(line => line.includes('tool_cgroup_cap_unavailable'))).toBe(true);
  });

  describe('cpu weight', () => {
    it('writes configured weights to both slices', () => {
      const config = makeConfig({ cpuWeight: 50, serverCpuWeight: 300 });
      const manager = new ToolCgroupManager(config, () => {});
      expect(manager.setup()).toBe(true);
      expect(readCgroupFile(config, 'kilo-tools', 'cpu.weight')).toBe('50');
      expect(readCgroupFile(config, 'kilo-server', 'cpu.weight')).toBe('300');
      expect(manager.health().cpuWeight).toBe(50);
      expect(manager.health().server.cpuWeight).toBe(300);
    });

    it('writes the kernel default when unset, neutralizing a stale weight', () => {
      const config = makeConfig({});
      mkdirSync(join(config.cgroupRoot, 'kilo-tools'), { recursive: true });
      writeFileSync(join(config.cgroupRoot, 'kilo-tools', 'cpu.weight'), '25');
      const manager = new ToolCgroupManager(config, () => {});
      expect(manager.setup()).toBe(true);
      expect(readCgroupFile(config, 'kilo-tools', 'cpu.weight')).toBe('100');
      expect(readCgroupFile(config, 'kilo-server', 'cpu.weight')).toBe('100');
      expect(manager.health().cpuWeight).toBeNull();
    });

    it('applies weights in observe mode too', () => {
      const config = makeConfig({ mode: 'observe', cpuWeight: 50 });
      expect(new ToolCgroupManager(config, () => {}).setup()).toBe(true);
      expect(readCgroupFile(config, 'kilo-tools', 'cpu.weight')).toBe('50');
    });

    it('enables missing controllers by token, not substring', () => {
      // `cpuset` present but `cpu` absent must still enable +cpu.
      const config = makeConfig({});
      writeFileSync(join(config.cgroupRoot, 'cgroup.subtree_control'), 'cpuset io pids');
      expect(new ToolCgroupManager(config, () => {}).setup()).toBe(true);
      expect(readFileSync(join(config.cgroupRoot, 'cgroup.subtree_control'), 'utf8')).toBe(
        '+memory +cpu'
      );
    });

    it('leaves subtree_control untouched when both controllers are enabled', () => {
      const config = makeConfig({});
      expect(new ToolCgroupManager(config, () => {}).setup()).toBe(true);
      expect(readFileSync(join(config.cgroupRoot, 'cgroup.subtree_control'), 'utf8')).toBe(
        'cpuset cpu io memory pids'
      );
    });
  });

  it('is idempotent when the cgroups already exist', () => {
    const config = makeConfig({});
    expect(new ToolCgroupManager(config, () => {}).setup()).toBe(true);
    expect(new ToolCgroupManager(config, () => {}).setup()).toBe(true);
  });

  it('fails cleanly when the cgroup root is not writable', () => {
    const logs: string[] = [];
    const config = makeConfig({ cgroupRoot: join(makeTempDir(), 'missing') });
    expect(new ToolCgroupManager(config, message => logs.push(message)).setup()).toBe(false);
    expect(logs.some(line => line.includes('tool_cgroup_setup_failed'))).toBe(true);
  });

  describe('server slice', () => {
    it('stays uncapped and oom.group=0 when TOOL_CGROUP_SERVER_LIMIT_MB is unset', () => {
      const config = makeConfig({});
      const manager = new ToolCgroupManager(config, () => {});
      expect(manager.setup()).toBe(true);
      expect(readCgroupFile(config, 'kilo-server', 'memory.max')).toBe('max');
      expect(readCgroupFile(config, 'kilo-server', 'memory.oom.group')).toBe('0');
      expect(manager.health().server.memoryMaxBytes).toBeNull();
    });

    it('enforces the configured limit with oom.group=0 regardless of TOOL_CGROUP_OOM_GROUP', () => {
      const serverLimitBytes = 256 * 1024 * 1024;
      const config = makeConfig({ serverLimitBytes, oomGroup: true });
      const manager = new ToolCgroupManager(config, () => {});
      expect(manager.setup()).toBe(true);
      expect(readCgroupFile(config, 'kilo-server', 'memory.max')).toBe(String(serverLimitBytes));
      expect(readCgroupFile(config, 'kilo-server', 'memory.oom.group')).toBe('0');
      expect(manager.health().server.memoryMaxBytes).toBe(serverLimitBytes);
    });

    it('warns at startup when the server budget does not fit under the tool reserve', () => {
      const logs: string[] = [];
      const config = makeConfig({
        reserveBytes: 1024 * 1024 * 1024,
        serverLimitBytes: 900 * 1024 * 1024,
      });
      new ToolCgroupManager(config, message => logs.push(message)).setup();
      expect(logs.some(line => line.includes('tool_cgroup_budget_warning'))).toBe(true);
    });

    it('does not warn when the server budget fits under the tool reserve', () => {
      const logs: string[] = [];
      const config = makeConfig({
        reserveBytes: 2048 * 1024 * 1024,
        serverLimitBytes: 1280 * 1024 * 1024,
      });
      new ToolCgroupManager(config, message => logs.push(message)).setup();
      expect(logs.some(line => line.includes('tool_cgroup_budget_warning'))).toBe(false);
    });

    it('does not warn when the server slice is observe-only', () => {
      const logs: string[] = [];
      const config = makeConfig({ reserveBytes: 1024, serverLimitBytes: null });
      new ToolCgroupManager(config, message => logs.push(message)).setup();
      expect(logs.some(line => line.includes('tool_cgroup_budget_warning'))).toBe(false);
    });
  });
});

describe('ToolCgroupManager.sweep', () => {
  it('migrates tool pids into kilo-tools and the server chain into kilo-server', async () => {
    const config = makeConfig({});
    const manager = new ToolCgroupManager(config, () => {});
    manager.setup();
    await manager.sweep();
    expect(migratedPids(config, 'kilo-tools')).toEqual([103, 104, 105]);
    expect(migratedPids(config, 'kilo-server')).toEqual([101, 102]);
    expect(manager.health().migratedTotal).toBe(3);
    expect(manager.health().server.migratedTotal).toBe(2);
  });

  it('skips pids already in their target cgroup', async () => {
    const config = makeConfig({});
    const manager = new ToolCgroupManager(config, () => {});
    manager.setup();
    // Pre-seed cgroup.procs the way a real cgroupfs would report existing members.
    writeFileSync(join(config.cgroupRoot, 'kilo-tools', 'cgroup.procs'), '103\n');
    writeFileSync(join(config.cgroupRoot, 'kilo-server', 'cgroup.procs'), '102\n');
    await manager.sweep();
    expect(migratedPids(config, 'kilo-tools')).toEqual([103, 104, 105]);
    expect(migratedPids(config, 'kilo-server')).toEqual([101, 102]);
    expect(manager.health().migratedTotal).toBe(2);
    expect(manager.health().server.migratedTotal).toBe(1);
  });

  it('logs a migration failure once per error code instead of swallowing it', async () => {
    const logs: string[] = [];
    const config = makeConfig({});
    const manager = new ToolCgroupManager(config, message => logs.push(message));
    manager.setup();
    // Break the tool slice's cgroup.procs deterministically (append hits EISDIR),
    // standing in for a persistent failure like EACCES or a read-only remount.
    mkdirSync(join(config.cgroupRoot, 'kilo-tools', 'cgroup.procs'));

    await manager.sweep();
    expect(logs.filter(line => line.includes('tool_cgroup_migrate_failed')).length).toBe(1);
    expect(manager.health().migratedTotal).toBe(0);
    // The healthy server slice keeps migrating.
    expect(manager.health().server.migratedTotal).toBe(2);

    // Repeated sweeps with the same persistent failure do not spam the log.
    await manager.sweep();
    expect(logs.filter(line => line.includes('tool_cgroup_migrate_failed')).length).toBe(1);
  });

  it('logs tool_cgroup_oom_kill when the tool slice records an OOM kill', async () => {
    const logs: string[] = [];
    const config = makeConfig({});
    const manager = new ToolCgroupManager(config, message => logs.push(message));
    const eventsPath = join(config.cgroupRoot, 'kilo-tools', 'memory.events');
    mkdirSync(join(config.cgroupRoot, 'kilo-tools'), { recursive: true });
    writeFileSync(eventsPath, 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n');
    manager.setup();

    await manager.sweep();
    expect(logs.some(line => line.includes('tool_cgroup_oom_kill'))).toBe(false);

    writeFileSync(eventsPath, 'low 0\nhigh 0\nmax 37\noom 1\noom_kill 2\noom_group_kill 1\n');
    await manager.sweep();
    expect(logs.some(line => line.includes('tool_cgroup_oom_kill'))).toBe(true);
    expect(manager.health().oomKills).toBe(2);
    expect(manager.health().oomGroupKills).toBe(1);
    expect(manager.health().lastOomAt).not.toBeNull();

    // No repeated logging while the counters stay flat.
    logs.splice(0);
    await manager.sweep();
    expect(logs.some(line => line.includes('tool_cgroup_oom_kill'))).toBe(false);
  });

  it('logs tool_cgroup_server_oom_kill when the server slice records an OOM kill', async () => {
    const logs: string[] = [];
    const config = makeConfig({ serverLimitBytes: 256 * 1024 * 1024 });
    const manager = new ToolCgroupManager(config, message => logs.push(message));
    const eventsPath = join(config.cgroupRoot, 'kilo-server', 'memory.events');
    mkdirSync(join(config.cgroupRoot, 'kilo-server'), { recursive: true });
    writeFileSync(eventsPath, 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n');
    manager.setup();

    writeFileSync(eventsPath, 'low 0\nhigh 0\nmax 12\noom 1\noom_kill 1\noom_group_kill 0\n');
    await manager.sweep();
    expect(logs.some(line => line.includes('tool_cgroup_server_oom_kill'))).toBe(true);
    expect(
      logs.some(line => line.includes('tool_cgroup_oom_kill') && !line.includes('server'))
    ).toBe(false);
    expect(manager.health().server.oomKills).toBe(1);
  });

  it('accounts for OOM kills recorded by a previous wrapper generation', () => {
    const config = makeConfig({});
    mkdirSync(join(config.cgroupRoot, 'kilo-tools'), { recursive: true });
    writeFileSync(
      join(config.cgroupRoot, 'kilo-tools', 'memory.events'),
      'low 0\nhigh 0\nmax 5\noom 1\noom_kill 3\noom_group_kill 2\n'
    );
    const manager = new ToolCgroupManager(config, () => {});
    manager.setup();
    expect(manager.health().oomKills).toBe(0);
    expect(manager.health().oomGroupKills).toBe(0);
  });
});

describe('ToolCgroupManager.health', () => {
  it('reports the documented shape including the server section', () => {
    const config = makeConfig({ serverLimitBytes: 256 * 1024 * 1024, serverCpuWeight: 300 });
    const manager = new ToolCgroupManager(config, () => {});
    manager.setup();
    expect(manager.health()).toEqual({
      mode: 'enforce',
      memoryMaxBytes: MEM_TOTAL_KB * 1024 - config.reserveBytes,
      memoryCurrentBytes: null,
      memoryPeakBytes: null,
      cpuWeight: null,
      cpuUsageMicros: null,
      oomKills: 0,
      oomGroupKills: 0,
      migratedTotal: 0,
      lastOomAt: null,
      server: {
        memoryMaxBytes: 256 * 1024 * 1024,
        memoryCurrentBytes: null,
        memoryPeakBytes: null,
        cpuWeight: 300,
        cpuUsageMicros: null,
        oomKills: 0,
        migratedTotal: 0,
      },
    });
  });

  it('reports cpu usage from cpu.stat when present', () => {
    const config = makeConfig({});
    const manager = new ToolCgroupManager(config, () => {});
    manager.setup();
    writeFileSync(
      join(config.cgroupRoot, 'kilo-tools', 'cpu.stat'),
      'usage_usec 123456\nuser_usec 100000\nsystem_usec 23456\n'
    );
    expect(manager.health().cpuUsageMicros).toBe(123456);
    expect(manager.health().server.cpuUsageMicros).toBeNull();
  });
});

describe('rollback hygiene (mode=off)', () => {
  it('resets a stale numeric memory.max on both cgroups to max', () => {
    const cgroupRoot = makeCgroupRoot();
    for (const name of ['kilo-tools', 'kilo-server']) {
      mkdirSync(join(cgroupRoot, name));
      writeFileSync(join(cgroupRoot, name, 'memory.max'), '4294967296');
    }
    const logs: string[] = [];
    const result = startToolCgroup({ TOOL_CGROUP_MODE: 'off' }, message => logs.push(message), {
      cgroupRoot,
    });
    expect(result).toBeNull();
    expect(readFileSync(join(cgroupRoot, 'kilo-tools', 'memory.max'), 'utf8')).toBe('max');
    expect(readFileSync(join(cgroupRoot, 'kilo-server', 'memory.max'), 'utf8')).toBe('max');
    expect(logs.filter(line => line.includes('tool_cgroup_stale_cap_reset')).length).toBe(2);
  });

  it('resets a stale cpu.weight to the kernel default', () => {
    const cgroupRoot = makeCgroupRoot();
    mkdirSync(join(cgroupRoot, 'kilo-tools'));
    writeFileSync(join(cgroupRoot, 'kilo-tools', 'cpu.weight'), '25');
    const logs: string[] = [];
    startToolCgroup({ TOOL_CGROUP_MODE: 'off' }, message => logs.push(message), { cgroupRoot });
    expect(readFileSync(join(cgroupRoot, 'kilo-tools', 'cpu.weight'), 'utf8')).toBe('100');
    expect(logs.filter(line => line.includes('tool_cgroup_stale_cap_reset')).length).toBe(1);
  });

  it('is a no-op when no cgroup dirs exist', () => {
    const cgroupRoot = makeTempDir();
    expect(() =>
      startToolCgroup({ TOOL_CGROUP_MODE: 'off' }, () => {}, { cgroupRoot })
    ).not.toThrow();
  });

  it('does not rewrite an already-uncapped cgroup', () => {
    const cgroupRoot = makeCgroupRoot();
    mkdirSync(join(cgroupRoot, 'kilo-tools'));
    writeFileSync(join(cgroupRoot, 'kilo-tools', 'memory.max'), 'max');
    const logs: string[] = [];
    startToolCgroup({ TOOL_CGROUP_MODE: 'off' }, message => logs.push(message), { cgroupRoot });
    expect(logs.some(line => line.includes('tool_cgroup_stale_cap_reset'))).toBe(false);
  });
});

describe('startToolCgroup', () => {
  it('returns null when mode is off', () => {
    expect(startToolCgroup({ TOOL_CGROUP_MODE: 'off' }, () => {})).toBeNull();
  });

  it('returns null when the cgroup fs is unavailable', () => {
    const result = startToolCgroup({ TOOL_CGROUP_MODE: 'observe' }, () => {}, {
      cgroupRoot: join(makeTempDir(), 'missing'),
    });
    expect(result).toBeNull();
  });

  it('configures both slices and starts the sweeper against working roots', () => {
    const config = makeConfig({});
    const manager = startToolCgroup({ TOOL_CGROUP_MODE: 'enforce' }, () => {}, {
      cgroupRoot: config.cgroupRoot,
      procRoot: config.procRoot,
      selfPid: 100,
    });
    expect(manager).not.toBeNull();
    manager!.stop();
    expect(manager!.health().mode).toBe('enforce');
    expect(readCgroupFile(config, 'kilo-tools', 'memory.max')).toBe(
      String(MEM_TOTAL_KB * 1024 - config.reserveBytes)
    );
  });
});
