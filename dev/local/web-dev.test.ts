import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../..');

async function startFixture(env: NodeJS.ProcessEnv = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'web-dev-test-'));
  const stub = `#!${process.execPath}
    const {spawn} = require('node:child_process');
    const path = require('node:path');
    const name = path.basename(process.cwd());
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
    console.log(JSON.stringify({name, pid: process.pid, worker: worker.pid,
      args: process.argv.slice(2), port: process.env.PORT, gatewayPort: process.env.AI_GATEWAY_PORT}));
    if (process.env.FAIL_APP === name) setTimeout(() => process.exit(23), 300);
    setInterval(() => {}, 1000);
  `;
  for (const command of ['bash', 'next']) {
    fs.writeFileSync(path.join(bin, command), stub, { mode: 0o755 });
  }
  const child = spawn(
    process.execPath,
    [path.join(repoRoot, 'scripts/web-dev.mjs'), '--turbopack'],
    {
      cwd: path.join(repoRoot, 'apps/web'),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PORT: '5500',
        AI_GATEWAY_PORT: '5510',
        KILO_AI_GATEWAY_MANAGED: '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const exited = once(child, 'exit');
  let output = '';
  let errors = '';
  child.stdout.on('data', data => (output += String(data)));
  child.stderr.on('data', data => (errors += String(data)));
  const apps = () =>
    output
      .split('\n')
      .slice(0, -1)
      .filter(Boolean)
      .map(line => JSON.parse(line));

  return {
    child,
    exited,
    apps,
    errors: () => errors,
    async ready(count: number) {
      const deadline = Date.now() + 5000;
      while (apps().length < count && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(apps().length, count, errors);
    },
    cleanup() {
      child.kill('SIGKILL');
      for (const app of apps()) {
        try {
          process.kill(-app.pid, 'SIGKILL');
        } catch (error) {
          assert.ok(error instanceof Error && 'code' in error && error.code === 'ESRCH');
        }
      }
      fs.rmSync(bin, { recursive: true, force: true });
    },
  };
}

function assertStopped(pid: number) {
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

void test('web dev starts both apps with matching ports and cleans up their workers on Ctrl-C', async t => {
  const fixture = await startFixture();
  t.after(() => fixture.cleanup());
  await fixture.ready(2);
  const web = fixture.apps().find(app => app.name === 'web');
  const gateway = fixture.apps().find(app => app.name === 'ai-gateway');
  assert.ok(web);
  assert.ok(gateway);
  assert.equal(web.gatewayPort, gateway.gatewayPort);
  assert.equal(web.gatewayPort, '5510');
  assert.deepEqual(web.args, ['dev', '-H', '0.0.0.0', '-p', '5500', '--turbopack']);
  fixture.child.kill('SIGINT');
  assert.equal((await fixture.exited)[0], 130);
  for (const app of fixture.apps()) {
    assertStopped(app.pid);
    assertStopped(app.worker);
  }
});

for (const app of ['ai-gateway', 'web']) {
  void test(`web dev stops the other app when ${app} fails`, async t => {
    const fixture = await startFixture({ FAIL_APP: app });
    t.after(() => fixture.cleanup());
    await fixture.ready(2);
    assert.equal((await fixture.exited)[0], 23);
    assert.match(fixture.errors(), new RegExp(`${app} exited`));
    for (const server of fixture.apps()) {
      assertStopped(server.pid);
      assertStopped(server.worker);
    }
  });
}

void test('managed web dev does not start or stop a separately owned gateway', async t => {
  const fixture = await startFixture({ KILO_AI_GATEWAY_MANAGED: '1', AI_GATEWAY_PORT: '5620' });
  t.after(() => fixture.cleanup());
  await fixture.ready(1);
  assert.equal(fixture.apps()[0].name, 'web');
  assert.equal(fixture.apps()[0].gatewayPort, '5620');
  fixture.child.kill('SIGTERM');
  assert.equal((await fixture.exited)[0], 143);
  assertStopped(fixture.apps()[0].pid);
  assertStopped(fixture.apps()[0].worker);
});
