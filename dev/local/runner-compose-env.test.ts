import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  composeInterpolatedKeys,
  formatComposeEnvAssignment,
  writeComposeSecretsEnvFile,
} from './runner.ts';

const COMPOSE_FILE = [
  'services:',
  '  grafana:',
  '    environment:',
  '      CF_ACCOUNT_ID: ${CF_ACCOUNT_ID:-e115e769bcdd4c3d66af59d3332cb394}',
  '      CF_AE_TOKEN: ${CF_AE_TOKEN:-}',
  '      GRAFANA_CLICKHOUSE_SECURE: ${GRAFANA_CLICKHOUSE_SECURE:-true}',
  '    ports:',
  "      - '${KILO_GRAFANA_PORT:-4000}:3000'",
].join('\n');

/** Minimal repo layout: dev/docker-compose.yml plus the given .env.local. */
function setupRepo(envLocal?: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'compose-secrets-'));
  mkdirSync(path.join(directory, 'dev'), { recursive: true });
  writeFileSync(path.join(directory, 'dev', 'docker-compose.yml'), COMPOSE_FILE);
  if (envLocal !== undefined) writeFileSync(path.join(directory, '.env.local'), envLocal);
  return directory;
}

void test('composeInterpolatedKeys extracts unique braced variable names', () => {
  const directory = setupRepo('');
  try {
    assert.deepEqual(composeInterpolatedKeys(path.join(directory, 'dev', 'docker-compose.yml')), [
      'CF_ACCOUNT_ID',
      'CF_AE_TOKEN',
      'GRAFANA_CLICKHOUSE_SECURE',
      'KILO_GRAFANA_PORT',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test('formatComposeEnvAssignment leaves simple tokens unquoted', () => {
  assert.equal(formatComposeEnvAssignment('CF_AE_TOKEN', 'abc_123-xyz'), 'CF_AE_TOKEN=abc_123-xyz');
});

void test('formatComposeEnvAssignment escapes quotes for Compose', () => {
  assert.equal(formatComposeEnvAssignment('KEY', 'he said "hi"'), 'KEY="he said \\"hi\\""');
});

void test('writeComposeSecretsEnvFile keeps only Compose-interpolated keys', () => {
  const directory = setupRepo(
    [
      'CF_AE_TOKEN=secret-token',
      'BITBUCKET_CODE_REVIEW_WEBHOOK_SIGNING_KEYS="{"active":"x"}"',
      'GRAFANA_CLICKHOUSE_SECURE=false',
      'UNRELATED=1',
    ].join('\n')
  );
  try {
    const relative = writeComposeSecretsEnvFile(directory);
    assert.equal(relative, path.join('dev', '.env.compose-secrets'));
    const content = readFileSync(path.join(directory, relative!), 'utf8');
    assert.match(content, /^CF_AE_TOKEN=secret-token$/m);
    assert.match(content, /^GRAFANA_CLICKHOUSE_SECURE=false$/m);
    assert.doesNotMatch(content, /BITBUCKET/);
    assert.doesNotMatch(content, /UNRELATED/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test('writeComposeSecretsEnvFile picks up new compose interpolations automatically', () => {
  const directory = setupRepo('NEW_TOKEN=abc\n');
  try {
    writeFileSync(
      path.join(directory, 'dev', 'docker-compose.yml'),
      `${COMPOSE_FILE}\n      NEW_TOKEN: \${NEW_TOKEN:-}\n`
    );
    const relative = writeComposeSecretsEnvFile(directory);
    const content = readFileSync(path.join(directory, relative!), 'utf8');
    assert.match(content, /^NEW_TOKEN=abc$/m);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test('writeComposeSecretsEnvFile writes the secrets file owner-only', () => {
  const directory = setupRepo('CF_AE_TOKEN=secret-token\n');
  try {
    const relative = writeComposeSecretsEnvFile(directory);
    const absolute = path.join(directory, relative!);
    assert.equal(statSync(absolute).mode & 0o777, 0o600);
    // Rewriting an existing file must also tighten previously loose permissions.
    chmodSync(absolute, 0o644);
    writeComposeSecretsEnvFile(directory);
    assert.equal(statSync(absolute).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test('writeComposeSecretsEnvFile removes the stale file when keys disappear', () => {
  const directory = setupRepo('CF_AE_TOKEN=secret-token\n');
  try {
    const relative = writeComposeSecretsEnvFile(directory);
    const absolute = path.join(directory, relative!);
    assert.ok(existsSync(absolute));

    writeFileSync(path.join(directory, '.env.local'), 'OTHER=1\n');
    assert.equal(writeComposeSecretsEnvFile(directory), undefined);
    assert.ok(!existsSync(absolute));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test('writeComposeSecretsEnvFile returns undefined when no keys match', () => {
  const directory = setupRepo('OTHER=1\n');
  try {
    assert.equal(writeComposeSecretsEnvFile(directory), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
