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
  const artifacts = [
    {
      installName: 'kilocode-wrapper.js',
      sha256: 'a622b10ddc23c8c9e9ec39d4833ae9b7b772ef40cb430425cb1689b76ec3490c',
    },
    {
      installName: 'kilo-restore-session.js',
      sha256: '8ade8fb1988ac5066301d3c85f471bce8de4c8e4bb0e4b16efbd959317de7535',
    },
    {
      installName: 'bb',
      sha256: '3b64db95cb55c763391c707108489ae18b4112d783300de38e033b4c98c3deaf',
    },
    {
      installName: 'github-review-publish-mcp',
      sha256: '3efa7d8ec9be90f9c50aaa4c612302c584634e0dfb0fe7cd1d44949a654e251e',
    },
    {
      installName: 'kilocode-control-plane-wrapper.js',
      sha256: '042faca14bb0e2ccbb0d1f7c3617f91df4254711df5d8fb54e66e64e39264908',
    },
    {
      installName: 'kilocode-control-plane-supervisor.sh',
      sha256: '0834c2d60725ac5902257b3b78dd161ad26d1c0290dbf1e47cc14add5b8c8142',
    },
    {
      installName: 'kilo-git-credential',
      sha256: 'b1f4372f436ed78b4eb484c8eceb8805a37592801ee309dac399ac18dc513bd1',
    },
  ];

  const manifest = createRuntimeManifest({
    runtimeBuildId: 'cloud-agent-2026-06-10.1',
    wrapperVersion: '2.3.0',
    wrapperBytes: new TextEncoder().encode('wrapper'),
    controlPlaneWrapperBytes: new TextEncoder().encode('control-plane-wrapper'),
    controlPlaneSupervisorBytes: new TextEncoder().encode('supervisor'),
    artifacts,
  });

  it('creates a deterministic pinned manifest with the full artifact inventory', () => {
    expect(manifest).toEqual({
      runtimeBuildId: 'cloud-agent-2026-06-10.1',
      wrapperVersion: '2.3.0',
      runtime: 'node24',
      bunVersion: '1.3.14',
      wrapperSha256: 'a622b10ddc23c8c9e9ec39d4833ae9b7b772ef40cb430425cb1689b76ec3490c',
      controlPlaneWrapperSha256: '042faca14bb0e2ccbb0d1f7c3617f91df4254711df5d8fb54e66e64e39264908',
      controlPlaneSupervisorSha256:
        '0834c2d60725ac5902257b3b78dd161ad26d1c0290dbf1e47cc14add5b8c8142',
      artifacts,
    });
  });

  it('reports manifest fields that do not match', () => {
    expect(validateRuntimeManifest({ ...manifest, runtime: 'node22' }, manifest)).toEqual([
      'runtime mismatch',
    ]);
  });

  it('reports a missing control-plane hash', () => {
    const withoutControlPlane = { ...manifest } as Record<string, unknown>;
    delete withoutControlPlane.controlPlaneWrapperSha256;
    expect(validateRuntimeManifest(withoutControlPlane, manifest)).toEqual([
      'controlPlaneWrapperSha256 missing',
    ]);
  });

  it('reports a changed control-plane supervisor hash', () => {
    expect(
      validateRuntimeManifest(
        { ...manifest, controlPlaneSupervisorSha256: '0'.repeat(64) },
        manifest
      )
    ).toEqual(['controlPlaneSupervisorSha256 mismatch']);
  });

  it('reports missing and mismatched inventory artifacts', () => {
    const missing = {
      ...manifest,
      artifacts: manifest.artifacts.filter(artifact => artifact.installName !== 'bb'),
    };
    expect(validateRuntimeManifest(missing, manifest)).toEqual(['artifacts.bb missing']);

    const mismatched = {
      ...manifest,
      artifacts: manifest.artifacts.map(artifact =>
        artifact.installName === 'kilo-git-credential'
          ? { ...artifact, sha256: '0'.repeat(64) }
          : artifact
      ),
    };
    expect(validateRuntimeManifest(mismatched, manifest)).toEqual([
      'artifacts.kilo-git-credential mismatch',
    ]);

    expect(validateRuntimeManifest({ ...manifest, artifacts: undefined }, manifest)).toEqual([
      'artifacts missing',
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
    const env: Record<string, string | undefined> = {};
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
    expect(input.controlPlaneWrapperPath).toMatch(/wrapper\/dist\/control-plane-wrapper\.js$/);
    expect(input.controlPlaneSupervisorPath).toMatch(/wrapper\/control-plane-supervisor\.sh$/);
    expect(input.wrapperVersion).toBe(WRAPPER_VERSION);
    expect(input.runtimeBuildId).toMatch(/^local-\d{8}-\d{6}$/);
    expect(defaultRuntimeBuildId(new Date('2026-08-19T12:34:56.000Z'))).toBe(
      'local-20260819-123456'
    );
  });

  it('derives the full artifact inventory from the shared distribution contract', () => {
    const input = resolveSnapshotInputs({});
    expect(input.artifactPaths['kilocode-wrapper.js']).toBe(input.wrapperPath);
    expect(input.artifactPaths['kilocode-control-plane-wrapper.js']).toBe(
      input.controlPlaneWrapperPath
    );
    expect(input.artifactPaths['kilocode-control-plane-supervisor.sh']).toBe(
      input.controlPlaneSupervisorPath
    );
    expect(input.artifactPaths['kilo-restore-session.js']).toMatch(
      /wrapper\/dist\/restore-session\.js$/
    );
    expect(input.artifactPaths['bb']).toMatch(/wrapper\/dist\/bb$/);
    expect(input.artifactPaths['github-review-publish-mcp']).toMatch(
      /wrapper\/dist\/github-review-publish-mcp$/
    );
    expect(input.artifactPaths['kilo-git-credential']).toMatch(/scripts\/kilo-git-credential$/);
  });

  it('moves the whole dist inventory with a --wrapper override', () => {
    const input = resolveSnapshotInputs({ wrapper: '/elsewhere/build/wrapper.js' });
    expect(input.wrapperPath).toBe('/elsewhere/build/wrapper.js');
    expect(input.controlPlaneWrapperPath).toBe('/elsewhere/build/control-plane-wrapper.js');
    expect(input.controlPlaneSupervisorPath).toBe('/elsewhere/control-plane-supervisor.sh');
    expect(input.artifactPaths['kilo-restore-session.js']).toBe(
      '/elsewhere/build/restore-session.js'
    );
    expect(input.artifactPaths['bb']).toBe('/elsewhere/build/bb');
    expect(input.artifactPaths['github-review-publish-mcp']).toBe(
      '/elsewhere/build/github-review-publish-mcp'
    );
    expect(input.artifactPaths['kilo-git-credential']).toMatch(/scripts\/kilo-git-credential$/);
  });

  it('does not overwrite an already-exported VERCEL_TOKEN', () => {
    const env: Record<string, string | undefined> = { VERCEL_TOKEN: 'exported-token' };
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
