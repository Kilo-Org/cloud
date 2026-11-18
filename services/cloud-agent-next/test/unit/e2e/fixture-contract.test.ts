import { mkdtemp, chmod, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  FixtureDescriptor,
  FixtureProviderError,
  ProviderCleanupRequest,
  ProviderPrepareRequest,
  SCHEMA_VERSION,
  assertLoopbackOrigins,
  assertScopedTag,
  assertSafeRunId,
  parseFixtureDescriptor,
  parseProviderRequest,
  readRestrictedJson,
  redactText,
  writeRestrictedJson,
  type Origins,
} from '../../e2e/fixture-contract.js';

const ORIGINS: Origins = {
  web: 'http://localhost:43000',
  cloudAgent: 'http://localhost:43001',
  gateway: 'http://localhost:43002/api/v1',
  fakeLlm: 'http://localhost:43003',
};

function descriptor(): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: 'run-1',
    lane: 'cloud',
    createdAt: '2026-11-02T00:00:00.000Z',
    fakeLlmScope: 'kilo-e2e-run-1',
    origins: ORIGINS,
    credentials: { apiKey: 'secret-key' },
    project: {
      fixture: 'deterministic-git',
      gitUrl: 'https://github.com/octocat/Hello-World.git',
      branch: 'main',
      model: 'kilo/fake-deterministic',
      seed: 'kilo-e2e-run-1',
    },
    resources: {
      profileId: 'profile-1',
      workspaceId: 'worktree_1',
      cloudSessionId: 'workspace_1',
      nativeSessionId: 'ses_1',
    },
    cleanup: { token: 'cleanup-token', ids: [{ kind: 'profile', id: 'profile-1' }] },
    state: { data: '/d', config: '/c', state: '/s', cache: '/k' },
  };
}

describe('fixture descriptor contract', () => {
  it('accepts a v1 descriptor with loopback origins', () => {
    const parsed = parseFixtureDescriptor(descriptor());
    expect(parsed.runId).toBe('run-1');
    expect(parsed.resources.workspaceId).toBe('worktree_1');
  });

  it('rejects a future schema version with an actionable error', () => {
    expect(() => parseFixtureDescriptor({ ...descriptor(), schemaVersion: 2 })).toThrowError(
      /schemaVersion 2 is not supported \(expected 1\)/
    );
  });

  it('rejects a non-loopback descriptor origin', () => {
    expect(() =>
      parseFixtureDescriptor({
        ...descriptor(),
        origins: { ...ORIGINS, web: 'https://api.kilo.ai' },
      })
    ).toThrowError(/origin web=https:\/\/api\.kilo\.ai is not an explicit loopback origin/);
  });

  it('rejects a non-http loopback scheme', () => {
    expect(() => assertLoopbackOrigins({ ...ORIGINS, web: 'ftp://localhost:1' })).toThrowError(
      /not an explicit loopback origin/
    );
  });

  it('reports the failing field for a shape error', () => {
    const value = descriptor();
    value.credentials = {};
    expect(() => parseFixtureDescriptor(value)).toThrowError(
      /fixture descriptor does not match schema v1: credentials\.apiKey/
    );
  });
});

describe('provider request contract', () => {
  it('parses a prepare request and a cleanup request', () => {
    const prepare = parseProviderRequest({
      schemaVersion: SCHEMA_VERSION,
      operation: 'prepare',
      runId: 'run-1',
      lane: 'local',
      fakeLlmScope: 'kilo-e2e-run-1',
      descriptorPath: '/tmp/descriptor.json',
      projectDir: '/tmp/project',
      state: { data: '/d', config: '/c', state: '/s', cache: '/k' },
    });
    expect(prepare.operation).toBe('prepare');
    const cleanup = ProviderCleanupRequest.parse({
      schemaVersion: SCHEMA_VERSION,
      operation: 'cleanup',
      runId: 'run-1',
      descriptorPath: '/tmp/descriptor.json',
      descriptorPresent: false,
    });
    expect(cleanup.descriptorPresent).toBe(false);
    expect(ProviderPrepareRequest.safeParse({ ...prepare, operation: 'cleanup' }).success).toBe(
      false
    );
  });

  it('accepts an optional scenario id and rejects an unknown one', () => {
    const request = {
      schemaVersion: SCHEMA_VERSION,
      operation: 'prepare',
      runId: 'run-1',
      lane: 'local',
      scenarioId: 'prompt.stream',
      fakeLlmScope: 'kilo-e2e-run-1',
      descriptorPath: '/tmp/descriptor.json',
      projectDir: '/tmp/project',
      state: { data: '/d', config: '/c', state: '/s', cache: '/k' },
    };
    expect(ProviderPrepareRequest.parse(request).scenarioId).toBe('prompt.stream');
    expect(
      ProviderPrepareRequest.safeParse({ ...request, scenarioId: 'unknown.scenario' }).success
    ).toBe(false);
    const { scenarioId, ...withoutScenario } = request;
    expect(scenarioId).toBe('prompt.stream');
    expect(ProviderPrepareRequest.parse(withoutScenario).scenarioId).toBeUndefined();
  });

  it('rejects a request with an unsupported version', () => {
    expect(() =>
      parseProviderRequest({
        schemaVersion: 3,
        operation: 'cleanup',
        runId: 'run-1',
        descriptorPath: '/tmp/x',
        descriptorPresent: true,
      })
    ).toThrowError(/schemaVersion 3 is not supported/);
  });
});

describe('restricted documents', () => {
  it('writes and reads a mode-0600 document', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fixture-contract-'));
    const file = path.join(dir, 'nested', 'descriptor.json');
    const value = FixtureDescriptor.parse(descriptor());
    await writeRestrictedJson(file, value);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    const read = await readRestrictedJson(file, FixtureDescriptor, 'fixture descriptor');
    expect(read).toEqual(value);
    expect(await readFile(file, 'utf8')).toContain('"runId": "run-1"');
  });

  it('does not tighten a pre-existing parent directory', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fixture-contract-'));
    await chmod(dir, 0o755);
    const file = path.join(dir, 'descriptor.json');
    await writeRestrictedJson(file, descriptor());
    expect((await stat(dir)).mode & 0o777).toBe(0o755);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('refuses a group-readable descriptor', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fixture-contract-'));
    const file = path.join(dir, 'descriptor.json');
    await writeRestrictedJson(file, descriptor());
    await chmod(file, 0o644);
    await expect(
      readRestrictedJson(file, FixtureDescriptor, 'fixture descriptor')
    ).rejects.toThrowError(/accessible to other users/);
  });
});

describe('scope and redaction', () => {
  it('allows only run-scoped fake-LLM tags', () => {
    expect(() => assertScopedTag('kilo-e2e-run-1', 'kilo-e2e-run-1')).not.toThrow();
    expect(() => assertScopedTag('kilo-e2e-run-1', 'kilo-e2e-run-1-gate')).not.toThrow();
    expect(() => assertScopedTag('kilo-e2e-run-1', 'kilo-e2e-run-2-gate')).toThrowError(
      /not scoped to this run/
    );
    expect(() => assertScopedTag('kilo-e2e-run-1', 'bad tag')).toThrowError(/not a valid tag/);
  });

  it('redacts known secrets, bearer headers, and JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature';
    const text = redactText(`key=secret Bearer abc.def ${jwt}`, ['secret']);
    expect(text).toBe('key=[redacted] Bearer [redacted] [redacted-jwt]');
  });

  it('rejects run ids that cannot prefix a fake-LLM scope token', () => {
    expect(() => assertSafeRunId('run-1')).not.toThrow();
    expect(() => assertSafeRunId('run.1')).toThrowError(/1-55 characters/);
    expect(() => assertSafeRunId('a'.repeat(56))).toThrowError(/1-55 characters/);
  });

  it('keeps fixture errors typed', () => {
    const error = new FixtureProviderError('ownership', 'nope');
    expect(error.code).toBe('ownership');
    expect(error).toBeInstanceOf(Error);
  });
});
