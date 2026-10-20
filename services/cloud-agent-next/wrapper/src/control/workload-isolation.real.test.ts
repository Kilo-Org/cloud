import { describe, expect, it } from 'bun:test';
import {
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createKiloClient } from '@kilocode/sdk/v2/client';
import { CONTROL_PLANE_TIMERS } from '../../../src/shared/control-plane-timers.js';
import { createKiloRuntime } from '../control-plane/kilo-runtime.js';
import { createKiloEventFeed } from '../control-plane/kilo-event-feed.js';
import { kiloClientConfig, type KiloServer } from '../kilo-server-auth.js';
import { createOwnedProcessScope } from './owned-processes.js';
import { closeControlWorkload, initializeControlWorkload } from './workload-cgroup.js';

// Opt in only inside an isolated Linux container with a private, writable cgroup namespace.
// Use a 4 GiB container, no swap, Kilo 7.8.1 and Bun 1.3.14. Never run on a shared host cgroup.
const suite = process.env.KILO_MEMORY_CGROUP_TEST === '1' ? describe : describe.skip;
const MiB = 1024 * 1024;

async function until(check: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Memory isolation condition timed out');
    await Bun.sleep(50);
  }
}

function workload() {
  expect(process.platform).toBe('linux');
  expect(['0::/', '0::/kilo-runtime']).toContain(readFileSync('/proc/self/cgroup', 'utf8').trim());
  expect(Number(readFileSync('/sys/fs/cgroup/memory.max', 'utf8'))).toBe(4096 * MiB);
  const result = initializeControlWorkload({ env: {} });
  expect(result.placement).toBeDefined();
  return result;
}

/** Keep the actual cgroup, but make this scope's migration descriptor reject writes. */
function rejectToolMigration() {
  let replaced = 0;
  for (const entry of readdirSync('/proc/self/fd')) {
    const fd = Number(entry);
    let target: string;
    try {
      target = readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      continue;
    }
    if (!target.endsWith('/tools/cgroup.procs')) continue;
    closeSync(fd);
    expect(openSync(target, constants.O_RDONLY)).toBe(fd);
    replaced++;
  }
  expect(replaced).toBe(1);
}

suite('Linux workload memory isolation', () => {
  it('repairs inherited OOM protection even after a tool has entered its memory group', async () => {
    const control = workload();
    const scope = createOwnedProcessScope(control.placement);
    const root = mkdtempSync(path.join(tmpdir(), 'workload-member-'));
    try {
      const script = path.join(root, 'tool.js');
      const pidfile = path.join(root, 'pid');
      writeFileSync(
        script,
        `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(pidfile)}, String(process.pid)); setInterval(() => {}, 1000);`
      );
      const parent = scope.spawn(
        'bun',
        ['-e', `Bun.spawn(['bun', ${JSON.stringify(script)}]); setInterval(() => {}, 1000)`],
        { env: process.env }
      );
      parent.stdout.resume();
      parent.stderr.resume();
      let pid: string | undefined;
      await until(() => {
        try {
          pid = readFileSync(pidfile, 'utf8');
          return readFileSync(`/proc/${pid}/cgroup`, 'utf8').includes('/tools');
        } catch {
          return false;
        }
      });
      // A child that inherits protection from a tool before its previous adjustment succeeded
      // can already be a tools-group member. Membership must not skip protection repair.
      writeFileSync(`/proc/${pid}/oom_score_adj`, '-1000');
      await until(() => readFileSync(`/proc/${pid}/oom_score_adj`, 'utf8').trim() === '0');
      expect(parent.exitCode).toBeNull();
    } finally {
      expect(await scope.stop(Date.now() + 5000)).toBe(true);
      closeControlWorkload(control);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  for (const migration of ['available', 'failed'] as const) {
    it(`keeps real Kilo usable after concurrent oversized shells with migration ${migration}`, async () => {
      expect(Bun.spawnSync(['kilo', '--version']).stdout.toString().trim()).toBe('7.8.1');
      const control = workload();
      const root = mkdtempSync(path.join(tmpdir(), 'kilo-memory-'));
      const restarts: string[] = [];
      let server: KiloServer | undefined;
      const runtime = createKiloRuntime({
        directory: root,
        workload: control,
        timers: CONTROL_PLANE_TIMERS,
        pidfileDirectory: path.join(root, 'pids'),
        log: () => undefined,
        onRestart: info => restarts.push(info.reason),
        openFeed(source, callbacks) {
          server = source.server;
          return createKiloEventFeed({ source, ...callbacks, log: () => undefined });
        },
        env: {
          PATH: process.env.PATH ?? '',
          HOME: root,
          XDG_CONFIG_HOME: path.join(root, 'config'),
          XDG_DATA_HOME: path.join(root, 'data'),
          XDG_CACHE_HOME: path.join(root, 'cache'),
          XDG_STATE_HOME: path.join(root, 'state'),
          KILO_CONFIG_CONTENT: JSON.stringify({
            model: 'contract/fake',
            share: 'disabled',
            permission: { '*': 'allow' },
            provider: {
              contract: {
                npm: '@ai-sdk/openai-compatible',
                options: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'local-test' },
                models: { fake: { name: 'Fake' } },
              },
            },
          }),
        },
      });
      try {
        const native = await runtime.ensure();
        if (!server) throw new Error('Native server not observed');
        const client = createKiloClient(kiloClientConfig(server, root));
        const parent = await client.session.create({ directory: root }, { throwOnError: true });
        const parentID = parent.data.id;
        const children = await Promise.all(
          [0, 1].map(() =>
            client.session.create({ directory: root, parentID }, { throwOnError: true })
          )
        );
        if (migration === 'failed') rejectToolMigration();
        const ordinary = await Promise.all(
          children.map(child =>
            client.session.shell(
              {
                sessionID: child.data.id,
                directory: root,
                agent: 'build',
                command:
                  "bun -e 'const held = Buffer.alloc(128 * 1024 * 1024, 1); console.log(held.length)'",
              },
              { throwOnError: true, signal: AbortSignal.timeout(15_000) }
            )
          )
        );
        for (const result of ordinary) {
          expect(
            result.data.parts.some(
              part =>
                part.type === 'tool' &&
                part.state.status === 'completed' &&
                part.state.output.includes('134217728')
            )
          ).toBe(true);
        }
        const allocation = path.join(root, 'allocate.js');
        writeFileSync(
          allocation,
          `await Bun.sleep(1500); const held = Buffer.alloc(1800 * 1024 * 1024, 1); await Bun.sleep(3000); console.log(held.length);`
        );
        const runner = path.join(root, 'allocate.sh');
        // The native shell endpoint records output, but no exit code. Capture the actual
        // allocator status in a script, outside the endpoint's command interpolation.
        writeFileSync(
          runner,
          `bun ${allocation}\nresult=$?\nprintf '\\nallocation_exit=%s\\n' "$result"\n`
        );
        const results = await Promise.all(
          children.map(child =>
            client.session.shell(
              {
                sessionID: child.data.id,
                directory: root,
                agent: 'build',
                command: `bash ${runner}`,
              },
              { throwOnError: true, signal: AbortSignal.timeout(30_000) }
            )
          )
        );
        const outputs = results.flatMap(result =>
          result.data.parts.flatMap(part =>
            part.type === 'tool' && part.state.status === 'completed' ? [part.state.output] : []
          )
        );
        expect(outputs).toHaveLength(2);
        expect(outputs).toEqual(
          expect.arrayContaining([expect.stringContaining('allocation_exit=137')])
        );
        for (const child of children) {
          const persisted = await client.session.messages(
            { sessionID: child.data.id, directory: root },
            { throwOnError: true }
          );
          expect(
            persisted.data.some(message =>
              message.parts.some(part => part.type === 'tool' && part.state.status === 'running')
            )
          ).toBe(false);
        }
        const health = await client.global.health({
          signal: AbortSignal.timeout(5000),
          throwOnError: true,
        });
        expect(health.data.healthy).toBe(true);
        const followup = await client.session.shell(
          {
            sessionID: parentID,
            directory: root,
            agent: 'build',
            command: 'printf memory-recovered',
          },
          { throwOnError: true, signal: AbortSignal.timeout(5000) }
        );
        expect(JSON.stringify(followup.data)).toContain('memory-recovered');
        expect(restarts).toEqual([]);
        expect(runtime.client).toBe(native);
      } finally {
        await runtime.shutdown();
        closeControlWorkload(control);
        rmSync(root, { recursive: true, force: true });
      }
    }, 90_000);
  }
});
