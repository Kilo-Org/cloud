import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixtureRuntime } from '../test/runtime-installer/fixtures.js';
import { RUNTIME_BASE_ABI } from '../src/sandbox-control/runtime-release.js';
import { CONTROL_PLANE_PROTOCOL_VERSION } from '../src/shared/control-plane-protocol.js';
import { RUNTIME_BASE_PLATFORM, type RuntimeBase } from './runtime-base.js';
import { runCompatibilityProcess, verifyRuntimeCompatibility } from './runtime-compatibility.js';

it('a rejected descriptor closes verification servers and lets the caller exit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-compatibility-process-'));
  const previous = process.env.PATH;
  try {
    const bin = path.join(root, 'bin');
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'docker'), '#!' + process.execPath + '\nprocess.exit(0);\n', {
      mode: 0o755,
    });
    const script = [
      "import {fixtureRuntime} from './test/runtime-installer/fixtures.ts';",
      "import {verifyRuntimeCompatibility} from './scripts/runtime-compatibility.ts';",
      "import {CONTROL_PLANE_PROTOCOL_VERSION} from './src/shared/control-plane-protocol.ts';",
      "const packaged=await fixtureRuntime();packaged.descriptor.protocol=String(CONTROL_PLANE_PROTOCOL_VERSION);packaged.descriptor.cliVersion='x'.repeat(65);",
      "try{await verifyRuntimeCompatibility({platform:'linux/amd64',image:'fixture'},packaged,process.cwd());process.exitCode=2;}",
      "catch{console.log('descriptor rejected');}",
    ].join('\n');
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        cwd: process.cwd(),
        env: { ...process.env, PATH: bin + path.delimiter + previous },
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
      }
    );
    expect(result.stdout).toContain('descriptor rejected');
    expect(result.status).toBe(0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  // Exceed the child bound so a slow tsx start reports the child result.
}, 40_000);

it('the watchdog settles when a Docker client ignores SIGTERM', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-client-bound-'));
  const previous = process.env.PATH;
  try {
    await fs.writeFile(
      path.join(root, 'docker'),
      '#!' +
        process.execPath +
        '\nprocess.on("SIGTERM",()=>{});setTimeout(()=>process.exit(0),5000);\n',
      { mode: 0o755 }
    );
    process.env.PATH = root + path.delimiter + previous;
    const start = Date.now();
    expect(await runCompatibilityProcess(['run'], root, start + 500)).toBeNull();
    expect(Date.now() - start).toBeLessThan(3000);
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}, 10000);

it('only the launch credential can report a startup failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-compatibility-report-'));
  const previous = process.env.PATH;
  const statuses = path.join(root, 'statuses.json');
  try {
    // The fake client reports without and then with the launch credential.
    const client = [
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "if (args[0] !== 'run') process.exit(0);",
      "const value = name => args.find(arg => arg.startsWith(name + '=')).slice(name.length + 1);",
      "const origin = 'http://127.0.0.1:' + new URL(value('SANDBOX_CONTROL_URL')).port;",
      "const report = headers => fetch(origin + '/startup-failure', { method: 'POST', headers }).then(response => response.status);",
      "const credential = { Authorization: 'Bearer ' + value('SANDBOX_CONTROL_CREDENTIAL') };",
      '(async () => fs.writeFileSync(' +
        JSON.stringify(statuses) +
        ', JSON.stringify([await report({}), await report(credential)])))();',
    ].join('\n');
    await fs.writeFile(path.join(root, 'docker'), '#!' + process.execPath + '\n' + client + '\n', {
      mode: 0o755,
    });
    process.env.PATH = root + path.delimiter + previous;
    const packaged = await fixtureRuntime();
    packaged.descriptor.protocol = String(CONTROL_PLANE_PROTOCOL_VERSION);
    const base: RuntimeBase = {
      format: 1,
      inputId: 'a'.repeat(64),
      platform: RUNTIME_BASE_PLATFORM,
      abi: RUNTIME_BASE_ABI,
      image:
        'registry.cloudflare.com/' + 'b'.repeat(32) + '/kilo-runtime-base@sha256:' + 'c'.repeat(64),
    };
    await expect(verifyRuntimeCompatibility(base, packaged, root)).rejects.toThrow('incompatible');
    expect(JSON.parse(await fs.readFile(statuses, 'utf8'))).toEqual([401, 204]);
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);
