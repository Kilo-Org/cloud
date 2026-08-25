import { describe, expect, it, vi } from 'vitest';
import { WRAPPER_VERSION } from '../src/shared/wrapper-version.js';
import {
  applyDevVarsFallback,
  createAcceptedConfig,
  createRuntimeManifest,
  defaultRuntimeBuildId,
  main,
  parseDevVars,
  parseScanOutput,
  redactSecrets,
  resolveSnapshotInputs,
  truncateOutput,
  validateRuntimeManifest,
} from './vercel-snapshot.js';

describe('Vercel snapshot operator pure logic', () => {
  const manifest = createRuntimeManifest({
    runtimeBuildId: 'cloud-agent-2026-06-10.1',
    wrapperVersion: '2.3.0',
    wrapperBytes: new TextEncoder().encode('wrapper'),
  });

  it('creates a deterministic pinned manifest', () => {
    expect(manifest).toEqual({
      runtimeBuildId: 'cloud-agent-2026-06-10.1',
      wrapperVersion: '2.3.0',
      runtime: 'node24',
      bunVersion: '1.3.14',
      wrapperSha256: 'a622b10ddc23c8c9e9ec39d4833ae9b7b772ef40cb430425cb1689b76ec3490c',
    });
  });

  it('reports manifest fields that do not match', () => {
    expect(validateRuntimeManifest({ ...manifest, runtime: 'node22' }, manifest)).toEqual([
      'runtime mismatch',
    ]);
  });

  it('normalizes scan observations without exposing file contents', () => {
    expect(
      parseScanOutput('repository\t/vercel/sandbox/.git\ncredential-path\t/root/.ssh\n')
    ).toEqual([
      { kind: 'credential-path', path: '/root/.ssh' },
      { kind: 'repository', path: '/vercel/sandbox/.git' },
    ]);
  });

  it('rejects malformed scan output', () => {
    expect(() => parseScanOutput('credential-path\trelative/path\n')).toThrow(
      'invalid scan output'
    );
  });

  it('loads token, team, and project from .dev.vars when the process env is empty', () => {
    const vars = parseDevVars(
      [
        'VERCEL_TOKEN=token-from-file',
        "VERCEL_TEAM_ID='team_from_file'",
        'VERCEL_PROJECT_ID="prj_from_file"',
        '',
      ].join('\n')
    );
    const env: NodeJS.ProcessEnv = {};
    applyDevVarsFallback(env, vars);
    expect(env).toEqual({
      VERCEL_TOKEN: 'token-from-file',
      VERCEL_TEAM_ID: 'team_from_file',
      VERCEL_PROJECT_ID: 'prj_from_file',
    });
  });

  it('defaults wrapper path, wrapper version, and a dated build id', () => {
    const input = resolveSnapshotInputs({});
    expect(input.wrapperPath).toMatch(/wrapper\/dist\/wrapper\.js$/);
    expect(input.controlWrapperPath).toMatch(/wrapper\/dist\/control-wrapper\.js$/);
    expect(input.wrapperVersion).toBe(WRAPPER_VERSION);
    expect(input.runtimeBuildId).toMatch(/^local-\d{8}-\d{6}$/);
    expect(defaultRuntimeBuildId(new Date('2026-08-19T12:34:56.000Z'))).toBe(
      'local-20260819-123456'
    );
  });

  it('does not overwrite an already-exported VERCEL_TOKEN', () => {
    const env: NodeJS.ProcessEnv = { VERCEL_TOKEN: 'exported-token' };
    applyDevVarsFallback(env, parseDevVars('VERCEL_TOKEN=file-token\n'));
    expect(env.VERCEL_TOKEN).toBe('exported-token');
  });

  it('redacts secrets and keeps the tail of long command output', () => {
    expect(redactSecrets('token=abc123 leftover', ['abc123'])).toBe('token=[redacted] leftover');
    expect(truncateOutput('abcdefghij', 4)).toBe('…ghij');
  });

  it('emits only accepted runtime enrollment configuration', () => {
    expect(createAcceptedConfig('snap_123', manifest)).toEqual({
      VERCEL_SANDBOX_SNAPSHOT_ID: 'snap_123',
      VERCEL_SANDBOX_RUNTIME_BUILD_ID: 'cloud-agent-2026-06-10.1',
      VERCEL_SANDBOX_RUNTIME: 'node24',
    });
  });

  it('documents activation ordering and the post-activation rollback constraint', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await main(['help']);

    const output = write.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain('Deploy code with VERCEL_SANDBOX_ORG_IDS empty');
    expect(output).toContain(
      'Disabling enrollment prevents new Vercel selection but does not stop already-pinned sessions'
    );
    expect(output).toContain(
      'Do not roll code back past version-2 tombstone support until live Vercel sessions and version-2 tombstones are drained or remediated'
    );
    write.mockRestore();
  });
});
