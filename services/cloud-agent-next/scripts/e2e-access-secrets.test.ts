// Runs test/e2e/deploy/upload-access-secrets.sh (README "Closed CI path", step
// 12) with a stand-in wrangler that records each call's argv and stdin.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(
  new URL('../test/e2e/deploy/upload-access-secrets.sh', import.meta.url)
);
const CLIENT_ID = 'client-id-value.access';
const CLIENT_SECRET = 'client=secret value';
const VALUES = `E2E_ACCESS_CLIENT_ID=${CLIENT_ID}\nE2E_ACCESS_CLIENT_SECRET=${CLIENT_SECRET}\n`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], stdin = '') {
  const dir = mkdtempSync(join(tmpdir(), 'access-upload-'));
  dirs.push(dir);
  const wrangler = join(dir, 'wrangler');
  writeFileSync(
    wrangler,
    `#!/usr/bin/env bash
n=$(ls "${dir}" | grep -c '^call-' || true)
printf '%s\\n' "$@" > "${dir}/call-$n.argv"
printf '%s' "\${WRANGLER_WRITE_LOGS-unset}" > "${dir}/call-$n.env"
cat > "${dir}/call-$n.stdin"
`
  );
  chmodSync(wrangler, 0o755);
  // The script itself must turn Wrangler's log files off, whatever the caller has.
  const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_BIN: wrangler };
  delete env.WRANGLER_WRITE_LOGS;
  const result = spawnSync('bash', [script, ...args.map(a => a.replace('$DIR', dir))], {
    encoding: 'utf8',
    input: stdin,
    env,
  });
  const calls = readdirSync(dir)
    .filter(name => name.endsWith('.argv'))
    .sort()
    .map(name => ({
      argv: readFileSync(join(dir, name), 'utf8').trim().split('\n'),
      stdin: readFileSync(join(dir, name.replace('.argv', '.stdin')), 'utf8'),
      writeLogs: readFileSync(join(dir, name.replace('.argv', '.env')), 'utf8'),
    }));
  return { ...result, dir, calls, output: result.stdout + result.stderr };
}

describe('upload-access-secrets.sh', () => {
  it('puts both secrets from stdin, each value only on wrangler stdin', () => {
    const result = run(['cloud-agent-e2e-test', '-'], VALUES);
    expect(result.status, result.output).toBe(0);
    expect(result.calls).toEqual([
      {
        argv: ['secret', 'put', 'E2E_ACCESS_CLIENT_ID', '--name', 'cloud-agent-e2e-test'],
        stdin: CLIENT_ID,
        writeLogs: 'false',
      },
      {
        argv: ['secret', 'put', 'E2E_ACCESS_CLIENT_SECRET', '--name', 'cloud-agent-e2e-test'],
        stdin: CLIENT_SECRET,
        writeLogs: 'false',
      },
    ]);
    expect(result.output).not.toContain(CLIENT_ID);
    expect(result.output).not.toContain(CLIENT_SECRET);
  });

  it('reads a 0600 file and refuses any other mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'access-values-'));
    dirs.push(dir);
    const file = join(dir, 'values');
    writeFileSync(file, VALUES);
    chmodSync(file, 0o644);
    const loose = run(['cloud-agent-e2e-test', file]);
    expect(loose.status).toBe(1);
    expect(loose.output).toContain('mode 644, expected 600');
    expect(loose.calls).toEqual([]);
    chmodSync(file, 0o600);
    const strict = run(['cloud-agent-e2e-test', file]);
    expect(strict.status, strict.output).toBe(0);
    expect(strict.calls).toHaveLength(2);
    for (const call of strict.calls) expect(call.writeLogs).toBe('false');
  });

  it('refuses another script, another name, a duplicate or a missing value before any call', () => {
    for (const [args, stdin, message] of [
      [['cloud-agent-next', '-'], VALUES, "refusing script 'cloud-agent-next'"],
      [['fake-llm', '-'], VALUES, "refusing script 'fake-llm'"],
      [
        ['cloud-agent-e2e-test', '-'],
        `${VALUES}INTERNAL_API_SECRET=x\n`,
        "refusing secret name 'INTERNAL_API_SECRET'",
      ],
      [
        ['cloud-agent-e2e-test', '-'],
        `${VALUES}E2E_ACCESS_CLIENT_ID=again\n`,
        'E2E_ACCESS_CLIENT_ID is given twice',
      ],
      [
        ['cloud-agent-e2e-test', '-'],
        `E2E_ACCESS_CLIENT_ID=${CLIENT_ID}\n`,
        'E2E_ACCESS_CLIENT_SECRET is missing',
      ],
      [
        ['cloud-agent-e2e-test', '-'],
        VALUES.replaceAll('\n', '\r\n'),
        'refusing a line with a carriage return',
      ],
      [['cloud-agent-e2e-test'], VALUES, 'usage:'],
    ] as const) {
      const result = run([...args], stdin);
      expect(result.status, message).toBe(1);
      expect(result.output, message).toContain(message);
      expect(result.calls, message).toEqual([]);
      expect(result.output).not.toContain(CLIENT_SECRET);
    }
  });
});
