import { it, expect, vi } from 'vitest';
import type * as RuntimeReleaseModule from '../src/sandbox-control/runtime-release.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localDirectoryArtifactStore } from './publish-runtime.js';
import { ensureRuntimeBase, runtimeBaseInputId, withRuntimeRegistry } from './runtime-base.js';

it('publication builds once across wrapper, CLI and Worker changes, then rebuilds for base changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-base-matrix-'));
  const saved = {
    PATH: process.env.PATH,
    RUNTIME_TEST_BASE_INPUT: process.env.RUNTIME_TEST_BASE_INPUT,
    RUNTIME_TEST_TOOL_TRACE: process.env.RUNTIME_TEST_TOOL_TRACE,
  };
  try {
    const bin = path.join(root, 'bin');
    await fs.mkdir(bin);
    const trace = path.join(root, 'trace.jsonl');
    const account = 'c'.repeat(32);
    const tool =
      '#!' +
      process.execPath +
      '\n' +
      "const fs=require('node:fs');const args=process.argv.slice(2);" +
      "fs.appendFileSync(process.env.RUNTIME_TEST_TOOL_TRACE,JSON.stringify({tool:require('node:path').basename(process.argv[1]),args})+'\\n');" +
      "if(args[0]==='image'&&args[1]==='inspect'){" +
      "if(args.includes('{{json .RepoDigests}}'))console.log(JSON.stringify(['registry.cloudflare.com/" +
      account +
      "/kilo-runtime-base@sha256:'+process.env.RUNTIME_TEST_BASE_INPUT]));" +
      "else console.log(JSON.stringify({Os:'linux',Architecture:'amd64',Config:{Labels:{'io.kilo.runtime-base-input':process.env.RUNTIME_TEST_BASE_INPUT}}}));}";
    for (const command of ['docker', 'pnpm'])
      await fs.writeFile(path.join(bin, command), tool, { mode: 0o755 });
    process.env.PATH = bin + path.delimiter + saved.PATH;
    process.env.RUNTIME_TEST_TOOL_TRACE = trace;
    const recipe = path.join(root, 'Dockerfile.containers.runtime-free');
    await fs.writeFile(recipe, 'FROM debian:trixie-slim\nRUN true\n');
    const store = localDirectoryArtifactStore(path.join(root, 'objects'));
    const publish = async () => {
      process.env.RUNTIME_TEST_BASE_INPUT = await runtimeBaseInputId(root);
      return ensureRuntimeBase(store, root, account);
    };
    const initial = await publish();
    for (const changed of ['wrapper.ts', 'kilo-cli-version.ts', 'worker.ts']) {
      await fs.writeFile(path.join(root, changed), 'changed');
      expect(await publish()).toEqual(initial);
    }
    await fs.appendFile(recipe, 'RUN echo base-update\n');
    const changed = await publish();
    expect(changed.inputId).not.toBe(initial.inputId);
    expect(changed.image).not.toBe(initial.image);
    const calls = (await fs.readFile(trace, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(calls.filter(call => call.tool === 'docker' && call.args[0] === 'build')).toHaveLength(
      2
    );
    expect(calls.filter(call => call.tool === 'pnpm' && call.args.includes('push'))).toHaveLength(
      2
    );
    expect(calls.filter(call => call.tool === 'docker' && call.args[0] === 'pull')).toHaveLength(5);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const withPlugins of [true, false])
  it(`isolates registry credentials and cleans up with local plugins ${withPlugins ? 'present' : 'absent'}`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-registry-isolation-'));
    const saved = { PATH: process.env.PATH, DOCKER_CONFIG: process.env.DOCKER_CONFIG };
    const original = path.join(root, 'original');
    const originalConfig = JSON.stringify({
      auths: { 'unrelated.example': { auth: 'original-credential-sentinel' } },
    });
    let isolated: string | undefined;
    try {
      const bin = path.join(root, 'bin');
      await fs.mkdir(bin);
      await fs.mkdir(original);
      await fs.writeFile(path.join(original, 'config.json'), originalConfig);
      if (withPlugins) {
        await fs.mkdir(path.join(original, 'cli-plugins'));
        await fs.writeFile(path.join(original, 'cli-plugins/docker-buildx'), 'plugin-sentinel');
      }
      await fs.writeFile(
        path.join(bin, 'pnpm'),
        '#!' +
          process.execPath +
          '\nconsole.log(JSON.stringify({username:"temporary-user",password:"temporary-password"}));',
        { mode: 0o755 }
      );
      await fs.writeFile(
        path.join(bin, 'docker'),
        '#!' +
          process.execPath +
          '\nconst fs=require("node:fs");fs.writeFileSync(require("node:path").join(process.env.DOCKER_CONFIG,"config.json"),JSON.stringify({auths:{"registry.cloudflare.com":{auth:fs.readFileSync(0,"utf8")}}}));',
        { mode: 0o755 }
      );
      process.env.PATH = bin + path.delimiter + saved.PATH;
      process.env.DOCKER_CONFIG = original;
      const run = () =>
        withRuntimeRegistry(root, async () => {
          const directory = process.env.DOCKER_CONFIG;
          if (!directory) throw new Error('Missing isolated Docker configuration');
          isolated = directory;
          expect(isolated).not.toBe(original);
          const config = await fs.readFile(path.join(directory, 'config.json'), 'utf8');
          expect(config).toContain('temporary-password');
          expect(config).not.toContain('original-credential-sentinel');
          if (withPlugins) {
            expect(
              await fs.readFile(path.join(directory, 'cli-plugins/docker-buildx'), 'utf8')
            ).toBe('plugin-sentinel');
            throw new Error('callback failure');
          }
          return 'complete';
        });
      if (withPlugins) await expect(run()).rejects.toThrow('callback failure');
      else await expect(run()).resolves.toBe('complete');
      expect(process.env.DOCKER_CONFIG).toBe(original);
      expect(await fs.readFile(path.join(original, 'config.json'), 'utf8')).toBe(originalConfig);
      if (!isolated) throw new Error('The registry callback did not run');
      await expect(fs.stat(isolated)).rejects.toHaveProperty('code', 'ENOENT');
      if (withPlugins)
        expect(await fs.readFile(path.join(original, 'cli-plugins/docker-buildx'), 'utf8')).toBe(
          'plugin-sentinel'
        );
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

it('changes the base identity when only the runtime ABI changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-base-abi-'));
  try {
    await fs.writeFile(
      path.join(root, 'Dockerfile.containers.runtime-free'),
      'FROM debian:trixie-slim\n'
    );
    const initial = await runtimeBaseInputId(root);
    vi.resetModules();
    vi.doMock('../src/sandbox-control/runtime-release.js', async importOriginal => ({
      ...(await importOriginal<typeof RuntimeReleaseModule>()),
      RUNTIME_BASE_ABI: 'fixture-next-abi',
    }));
    const changed = await import('./runtime-base.js');
    expect(await changed.runtimeBaseInputId(root)).not.toBe(initial);
  } finally {
    vi.doUnmock('../src/sandbox-control/runtime-release.js');
    vi.resetModules();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('concurrent publishers retain and verify the first base digest for identical inputs', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-base-race-')));
  const previousPath = process.env.PATH;
  try {
    const bin = path.join(root, 'bin');
    await fs.mkdir(bin);
    const account = 'c'.repeat(32);
    const prefix = 'registry.cloudflare.com/' + account + '/kilo-runtime-base@sha256:';
    const tool =
      '#!' +
      process.execPath +
      '\n' +
      "const fs=require('node:fs');const args=process.argv.slice(2);" +
      "fs.appendFileSync('../trace.jsonl',JSON.stringify({cwd:process.cwd(),args})+'\\n');" +
      "if(args[0]==='image'&&args[1]==='inspect'){" +
      "if(args.includes('{{json .RepoDigests}}'))console.log(JSON.stringify(['" +
      prefix +
      "'+fs.readFileSync('candidate','utf8')]));" +
      "else console.log(JSON.stringify({Os:'linux',Architecture:'amd64',Config:{Labels:{'io.kilo.runtime-base-input':fs.readFileSync('input','utf8')}}}));}";
    for (const command of ['docker', 'pnpm'])
      await fs.writeFile(path.join(bin, command), tool, { mode: 0o755 });
    process.env.PATH = bin + path.delimiter + previousPath;
    const roots = [path.join(root, 'first'), path.join(root, 'second')];
    for (let i = 0; i < roots.length; i++) {
      await fs.mkdir(roots[i]);
      await fs.writeFile(
        path.join(roots[i], 'Dockerfile.containers.runtime-free'),
        'FROM debian:trixie-slim\n'
      );
      await fs.writeFile(path.join(roots[i], 'input'), await runtimeBaseInputId(roots[i]));
      await fs.writeFile(path.join(roots[i], 'candidate'), String(i + 1).repeat(64));
    }
    const objects = new Map<string, Uint8Array>();
    let reads = 0;
    let release = () => {};
    const bothRead = new Promise<void>(resolve => {
      release = resolve;
    });
    const store = {
      async putIfAbsent(key: string, bytes: Uint8Array) {
        if (objects.has(key)) return false;
        objects.set(key, new Uint8Array(bytes));
        return true;
      },
      async getBytes(key: string) {
        const bytes = objects.get(key) ?? null;
        if (++reads <= 2) {
          if (reads === 2) release();
          await bothRead;
        }
        return bytes;
      },
    };
    const [first, second] = await Promise.all(
      roots.map(directory => ensureRuntimeBase(store, directory, account))
    );
    expect(second).toEqual(first);
    expect(JSON.parse(new TextDecoder().decode(objects.values().next().value))).toEqual(first);
    const calls = (await fs.readFile(path.join(root, 'trace.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(calls.filter(call => call.args[0] === 'build')).toHaveLength(2);
    for (const directory of roots)
      expect(
        calls.some(
          call =>
            call.cwd === directory && call.args[0] === 'pull' && call.args.includes(first.image)
        )
      ).toBe(true);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});
