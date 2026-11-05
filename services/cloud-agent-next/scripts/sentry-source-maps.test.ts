import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'jsonc-parser';
import {
  readSentryArtifact,
  runSentryCli,
  sentryUploadConfigured,
  sha256,
  validateSentryArtifacts,
  workerBuildArgs,
} from './sentry-source-maps.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
});

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cloud-agent-sentry-'));
  directories.push(directory);
  return directory;
}

describe('Cloud Agent Sentry build artifacts', () => {
  it('requires only the shared auth token to upload', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(sentryUploadConfigured({})).toBe(false);
    expect(sentryUploadConfigured({ SENTRY_AUTH_TOKEN: '' })).toBe(false);
    expect(sentryUploadConfigured({ SENTRY_AUTH_TOKEN: ' \t ' })).toBe(false);
    expect(log).toHaveBeenLastCalledWith(
      expect.stringContaining('SENTRY_AUTH_TOKEN is not configured')
    );
    expect(sentryUploadConfigured({ SENTRY_AUTH_TOKEN: 'shared-web-token' })).toBe(true);
  });

  it('uploads Worker maps to the fixed Cloud Agent project', async () => {
    const sourceMaps = await import('./sentry-source-maps.js');
    vi.stubEnv('SENTRY_AUTH_TOKEN', 'shared-web-token');
    vi.stubEnv('SENTRY_ORG', 'unrelated-org');
    vi.stubEnv('SENTRY_PROJECT', 'unrelated-project');
    vi.spyOn(sourceMaps, 'validateSentryArtifacts').mockResolvedValue([
      {
        file: 'index.js',
        sha256: 'a'.repeat(64),
        mapSha256: 'b'.repeat(64),
        debugId: '2f361bcc-1d43-4fa2-b8d4-c6db9a131c85',
      },
    ]);
    const cli = vi.spyOn(sourceMaps, 'runSentryCli').mockImplementation(() => {});

    await import('./upload-sentry-source-maps.js');

    const directory = resolve('dist/worker');
    expect(cli).toHaveBeenCalledTimes(1);
    expect(cli).toHaveBeenCalledWith([
      'sourcemaps',
      'upload',
      '--org',
      'kilo-code',
      '--project',
      'kilo-cloud-agent',
      '--strict',
      '--validate',
      '--no-rewrite',
      '--wait-for',
      '120',
      resolve(directory, 'index.js'),
      resolve(directory, 'index.js.map'),
    ]);
  });

  it('uses a dry run with external maps and the actual target environment for the Worker build', () => {
    expect(workerBuildArgs('production')).toEqual([
      'deploy',
      '--dry-run',
      '--outdir',
      'dist/worker',
      '--upload-source-maps',
      '--containers-rollout',
      'none',
    ]);
    expect(workerBuildArgs('staging').slice(-2)).toEqual(['--env', 'staging']);
    expect(workerBuildArgs(undefined)).toEqual(workerBuildArgs('production'));
  });

  it('rejects map IDs without SDK runtime registration', async () => {
    const directory = await fixture();
    await writeFile(join(directory, 'index.js'), 'throw new Error("fixture");');
    await writeFile(
      join(directory, 'index.js.map'),
      JSON.stringify({ debug_id: '2f361bcc-1d43-4fa2-b8d4-c6db9a131c85' })
    );
    await expect(readSentryArtifact(directory, 'index.js')).rejects.toThrow('registration');
  });

  it('validates Worker artifacts and rejects later byte changes', async () => {
    const directory = await fixture();
    const debugId = '2f361bcc-1d43-4fa2-b8d4-c6db9a131c85';
    const code = `globalThis._sentryDebugIds = { "fixture": "${debugId}" };`;
    const map = JSON.stringify({ debug_id: debugId });
    await writeFile(join(directory, 'index.js'), code);
    await writeFile(join(directory, 'index.js.map'), map);
    const artifact = {
      file: 'index.js',
      debugId,
      sha256: sha256(code),
      mapSha256: sha256(map),
    };
    await writeFile(join(directory, 'sentry-artifacts.json'), JSON.stringify([artifact]));
    expect(await validateSentryArtifacts(directory)).toEqual([artifact]);

    await writeFile(join(directory, 'index.js'), `${code}\nvoid 0;`);
    await expect(validateSentryArtifacts(directory)).rejects.toThrow('changed after build');
  });

  it('preserves injected Worker bytes, SQL, and binary runtime modules through Wrangler no-bundle', async () => {
    const directory = await fixture();
    const config = join(directory, 'wrangler.jsonc');
    const workerConfig = parse(await readFile(resolve('wrangler.jsonc'), 'utf8')) as {
      rules: { type: string; globs: string[]; fallthrough?: boolean }[];
    };
    await writeFile(
      config,
      JSON.stringify({
        name: 'cloud-agent-sentry-fixture',
        main: 'index.ts',
        compatibility_date: '2026-06-03',
        compatibility_flags: ['nodejs_compat'],
        rules: workerConfig.rules,
      })
    );
    await writeFile(join(directory, 'migration.sql'), 'SELECT 1;');
    await mkdir(join(directory, 'wrapper/dist'), { recursive: true });
    await writeFile(join(directory, 'wrapper/dist/control-plane-wrapper.js'), 'wrapper-bytes');
    await writeFile(join(directory, 'wrapper/control-plane-supervisor.sh'), 'supervisor-bytes');
    await writeFile(
      join(directory, 'index.ts'),
      'import sql from "./migration.sql"; import wrapper from "./wrapper/dist/control-plane-wrapper.js?binary"; import supervisor from "./wrapper/control-plane-supervisor.sh?binary"; export default { fetch() { return new Response(sql + wrapper.byteLength + supervisor.byteLength); } };'
    );
    const bundleDirectory = join(directory, 'bundle');
    const deployedDirectory = join(directory, 'deployed');
    const wrangler = resolve('node_modules/.bin/wrangler');
    const options = { env: { ...process.env, CLOUDFLARE_SEND_METRICS: 'false' } };
    execFileSync(
      wrangler,
      [
        'deploy',
        '--config',
        config,
        '--dry-run',
        '--upload-source-maps',
        '--outdir',
        bundleDirectory,
      ],
      options
    );
    runSentryCli(['sourcemaps', 'inject', bundleDirectory]);
    const artifact = await readSentryArtifact(bundleDirectory, 'index.js');
    execFileSync(
      wrangler,
      [
        'deploy',
        join(bundleDirectory, 'index.js'),
        '--no-bundle',
        '--config',
        config,
        '--dry-run',
        '--upload-source-maps',
        '--outdir',
        deployedDirectory,
      ],
      options
    );
    expect(sha256(await readFile(join(deployedDirectory, 'index.js')))).toBe(artifact.sha256);
    const sqlModules = (await readdir(bundleDirectory)).filter(file => file.endsWith('.sql'));
    expect(sqlModules).toHaveLength(1);
    for (const file of sqlModules) {
      expect(await readFile(join(deployedDirectory, file), 'utf8')).toBe('SELECT 1;');
    }
    const binaryModules = (await readdir(bundleDirectory)).filter(file =>
      /-control-plane-(?:wrapper\.js|supervisor\.sh)$/.test(file)
    );
    expect(binaryModules).toHaveLength(2);
    for (const file of binaryModules) {
      expect(
        (await readFile(join(deployedDirectory, file))).equals(
          await readFile(join(bundleDirectory, file))
        )
      ).toBe(true);
    }
  }, 180_000);

  it('uploads source maps for every Cloud Agent deploy path', async () => {
    const workflow = await readFile(resolve('../../.github/workflows/deploy-workers.yml'), 'utf8');
    expect(workflow.match(/name: Upload Cloud Agent Sentry source maps/g)).toHaveLength(3);
    expect(
      workflow.match(/SENTRY_AUTH_TOKEN: \$\{\{ secrets\.SENTRY_AUTH_TOKEN \}\}/g)
    ).toHaveLength(3);
    expect(workflow).not.toContain('CLOUD_AGENT_SENTRY_ORG');
    expect(workflow).not.toContain('CLOUD_AGENT_SENTRY_PROJECT');
    expect(workflow.match(/steps\.runtime\.outputs\.command/g)).toHaveLength(10);
    expect(
      workflow.match(/dist\/worker\/index\.js --no-bundle --upload-source-maps/g)
    ).toHaveLength(6);
    expect(workflow.match(/name: Deploy to Cloudflare Workers \(retry\)/g)).toHaveLength(2);
  });
});