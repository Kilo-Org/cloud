import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const setup = readFileSync(new URL('./cloud-agent-setup.sh', import.meta.url), 'utf8');
const cleanup = setup.slice(
  setup.indexOf('  if [[ -z ${DOCKER_HOST:-}'),
  setup.indexOf('  if [[ -n ${DOCKER_HOST:-} ]] || [[ -S /var/run/docker.sock ]]')
);

for (const [name, host, pid, running, mounted, removed] of [
  ['removes restored local socket and PID file', '', true, false, false, true],
  ['preserves a supplied socket without a PID file', '', false, false, false, false],
  ['preserves a mounted socket despite a stale PID file', '', true, false, true, false],
  ['preserves files when DOCKER_HOST is set', 'tcp://docker:2375', true, false, false, false],
  ['preserves files while dockerd is running', '', true, true, false, false],
]) {
  test(name, t => {
    const dir = mkdtempSync(join(tmpdir(), 'kilo-docker-cleanup-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const socket = join(dir, 'docker.sock');
    const pidFile = join(dir, 'docker.pid');
    writeFileSync(socket, '');
    if (pid) writeFileSync(pidFile, '123');
    const result = spawnSync('bash', ['-eu'], {
      input: `
root=()
pgrep() { return ${running ? 0 : 1}; }
mountpoint() { return ${mounted ? 0 : 1}; }
${cleanup.replaceAll('/var/run/', `${dir}/`)}
`,
      env: { ...process.env, DOCKER_HOST: host },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(socket), !removed);
    assert.equal(existsSync(pidFile), pid && !removed);
  });
}

test('pnpm loads repo defaults without attempting Docker recovery', t => {
  const dir = mkdtempSync(join(tmpdir(), 'kilo-pnpm-wrapper-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envFile = join(dir, 'env');
  writeFileSync(envFile, 'export KILO_WRAPPER_TEST=loaded\n');
  const wrapper = setup.match(/cat <<'SH'\n([\s\S]*?)\nSH/)[1];
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = spawnSync(
      'bash',
      [
        '-eu',
        '-c',
        `
repo=$PWD
env_file=$1
shift
docker() { exit 91; }
flock() { exit 92; }
${wrapper.replace('real_pnpm=$(< /usr/local/lib/kilo-cloud-agent/real-pnpm)', 'real_pnpm=/usr/bin/env')}
`,
        '_',
        envFile,
      ],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^KILO_WRAPPER_TEST=loaded$/m);
    assert.equal(result.stderr, '');
  }
});
