import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { SourceMap, type SourceMapPayload } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorEvent } from '@sentry/core';
import {
  prepareBunSentryArtifact,
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

  it('uploads Worker and wrapper maps to the fixed Cloud Agent project', async () => {
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

    expect(cli).toHaveBeenCalledTimes(2);
    for (const [index, directory] of ['wrapper/dist/sentry', 'dist/worker'].entries()) {
      expect(cli).toHaveBeenNthCalledWith(index + 1, [
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
    }
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

  it('injects registration into actual Bun output and rejects later byte changes', async () => {
    const directory = await fixture();
    const entry = join(directory, 'index.ts');
    await writeFile(entry, 'export function fixtureCrash() { throw new Error("fixture"); }');
    execFileSync('bun', [
      'build',
      entry,
      '--target=bun',
      '--minify',
      '--sourcemap=external',
      '--outdir',
      directory,
    ]);
    const original = await readFile(join(directory, 'index.js'), 'utf8');
    const originalMap = await readFile(join(directory, 'index.js.map'), 'utf8');
    await prepareBunSentryArtifact(directory, 'index.js');
    runSentryCli(['sourcemaps', 'inject', directory]);
    const artifact = await readSentryArtifact(
      directory,
      'index.js',
      `cloud-agent-wrapper@${sha256(original)}`
    );
    await writeFile(join(directory, 'sentry-artifacts.json'), JSON.stringify([artifact]));
    expect(await validateSentryArtifacts(directory)).toEqual([artifact]);
    const registration = (await readFile(join(directory, 'index.js'), 'utf8'))
      .split('\n')
      .find(line => line.includes('_sentryDebugIds'));
    expect(registration).toContain(artifact.debugId);
    if (!registration) throw new Error('Missing registration');
    const context: { _sentryDebugIds?: Record<string, string> } = {};
    runInNewContext(registration, context);
    expect(Object.values(context._sentryDebugIds ?? {})).toContain(artifact.debugId);
    const shippedDirectory = join(directory, 'runtime');
    await mkdir(shippedDirectory);
    const shippedFile = join(shippedDirectory, 'index.js');
    await copyFile(join(directory, 'index.js'), shippedFile);
    expect(await validateSentryArtifacts(directory, shippedDirectory)).toEqual([artifact]);
    const stackOutput = execFileSync(
      'bun',
      [
        '--eval',
        `const { fixtureCrash } = await import(${JSON.stringify(pathToFileURL(shippedFile).href)}); try { fixtureCrash(); } catch (error) { console.log(JSON.stringify({ stack: error.stack, debugIds: globalThis._sentryDebugIds })); }`,
      ],
      { encoding: 'utf8' }
    );
    const observation: { stack: string; debugIds: Record<string, string> } =
      JSON.parse(stackOutput);
    expect(observation.stack).toContain(shippedFile);
    expect(Object.values(observation.debugIds)).toContain(artifact.debugId);
    expect(Object.keys(observation.debugIds).some(stack => stack.includes(shippedFile))).toBe(true);
    const code = await readFile(join(directory, 'index.js'), 'utf8');
    const position = code.indexOf('"fixture"');
    const preceding = code.slice(0, position).split('\n');
    const entryLocation = new SourceMap(
      JSON.parse(await readFile(join(directory, 'index.js.map'), 'utf8')) as SourceMapPayload
    ).findEntry(preceding.length - 1, preceding.at(-1)?.length ?? 0);
    if (!('originalSource' in entryLocation) || !('originalLine' in entryLocation)) {
      throw new Error('Missing fixture source mapping');
    }
    expect(entryLocation.originalSource).toMatch(/index\.ts$/);
    expect(entryLocation.originalLine).toBe(0);
    await writeFile(join(directory, 'index.js'), original);
    await writeFile(join(directory, 'index.js.map'), originalMap);
    await prepareBunSentryArtifact(directory, 'index.js');
    runSentryCli(['sourcemaps', 'inject', directory]);
    expect(await validateSentryArtifacts(directory)).toEqual([artifact]);
    await writeFile(
      join(directory, 'index.js'),
      `${await readFile(join(directory, 'index.js'), 'utf8')}\nvoid 0;`
    );
    await expect(validateSentryArtifacts(directory)).rejects.toThrow('changed after build');
  });

  it('preserves injected Worker bytes and SQL modules through Wrangler no-bundle', async () => {
    const directory = await fixture();
    const config = join(directory, 'wrangler.jsonc');
    await writeFile(
      config,
      JSON.stringify({
        name: 'cloud-agent-sentry-fixture',
        main: 'index.ts',
        compatibility_date: '2026-06-03',
        compatibility_flags: ['nodejs_compat'],
        rules: [{ type: 'Text', globs: ['**/*.sql'], fallthrough: true }],
      })
    );
    await writeFile(join(directory, 'migration.sql'), 'SELECT 1;');
    await writeFile(
      join(directory, 'index.ts'),
      'import sql from "./migration.sql"; export default { fetch() { return new Response(sql); } };'
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
  }, 30_000);

  it('preserves the injected debug ID and usable frames through the compiled Bun SDK and sanitizer', async () => {
    const directory = await fixture();
    const entry = join(directory, 'index.ts');
    const release = `cloud-agent-wrapper@${sha256('compiled-sentry-sdk-smoke')}`;
    await writeFile(
      entry,
      `
import { createWrapperSentryReporter } from ${JSON.stringify(resolve('wrapper/src/sentry.ts'))};
globalThis.SENTRY_RELEASE = { id: ${JSON.stringify(release)} };
const events = [];
const reporter = await createWrapperSentryReporter({
  env: { CLOUD_AGENT_SENTRY_DSN: 'https://public@o1.ingest.sentry.io/42', CLOUD_AGENT_SENTRY_ENVIRONMENT: 'test' },
  log: () => {},
  transport: () => ({
    send: async envelope => {
      for (const [header, payload] of envelope[1]) {
        if (header.type === 'event') events.push(payload);
      }
      return { statusCode: 200 };
    },
    flush: async () => true,
  }),
});
reporter.capture(new TypeError('private-source-map-message'), { operation: 'startup', allocationId: 'allocation_smoke' });
await reporter.flush();
console.log(JSON.stringify(events));
`
    );
    execFileSync('bun', [
      'build',
      entry,
      '--target=bun',
      '--minify',
      '--sourcemap=external',
      '--outdir',
      directory,
    ]);
    await prepareBunSentryArtifact(directory, 'index.js');
    runSentryCli(['sourcemaps', 'inject', directory]);
    const artifact = await readSentryArtifact(directory, 'index.js', release);
    const shippedDirectory = join(directory, 'runtime');
    await mkdir(shippedDirectory);
    const shippedFile = join(shippedDirectory, 'index.js');
    await copyFile(join(directory, 'index.js'), shippedFile);
    const events: ErrorEvent[] = JSON.parse(
      execFileSync('bun', [shippedFile], { encoding: 'utf8' })
    );
    expect(events).toHaveLength(1);
    const event = events[0];
    if (!event) throw new Error('Missing compiled SDK event');
    expect(event.release).toBe(release);
    expect(event.debug_meta?.images).toContainEqual({
      type: 'sourcemap',
      code_file: shippedFile,
      debug_id: artifact.debugId,
    });
    const frames = event.exception?.values?.[0]?.stacktrace?.frames;
    expect(frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filename: shippedFile,
          lineno: expect.any(Number),
          colno: expect.any(Number),
        }),
      ])
    );
    const frame = frames?.find(frame => frame.filename === shippedFile);
    if (typeof frame?.lineno !== 'number' || typeof frame.colno !== 'number') {
      throw new Error('Missing compiled SDK frame location');
    }
    const location = new SourceMap(
      JSON.parse(await readFile(join(directory, 'index.js.map'), 'utf8')) as SourceMapPayload
    ).findEntry(frame.lineno - 1, frame.colno - 1);
    if (!('originalSource' in location)) throw new Error('Missing compiled SDK source mapping');
    expect(location.originalSource).toMatch(/index\.ts$/);
    for (const frame of frames ?? []) {
      for (const key of ['context_line', 'pre_context', 'post_context', 'vars']) {
        expect(frame).not.toHaveProperty(key);
      }
    }
    expect(JSON.stringify(event)).not.toContain('private-source-map-message');
    expect(event.contexts?.cloud_agent).toEqual({
      component: 'wrapper',
      operation: 'startup',
      allocationId: 'allocation_smoke',
    });
  }, 15_000);

  it('ships prebuilt bytes in every image and keeps auth tokens out of image definitions', async () => {
    for (const name of [
      'Dockerfile',
      'Dockerfile.containers',
      'Dockerfile.dind',
      'Dockerfile.dev',
    ]) {
      const dockerfile = await readFile(resolve(name), 'utf8');
      expect(dockerfile).toContain('COPY wrapper/dist/runtime/');
      expect(dockerfile).not.toContain('bun run build.ts');
      expect(dockerfile).not.toContain('SENTRY_AUTH_TOKEN');
      expect(dockerfile).toContain('ARG BUN_VERSION="1.3.14"');
    }
    const workflow = await readFile(resolve('../../.github/workflows/deploy-workers.yml'), 'utf8');
    expect(workflow.match(/name: Upload Cloud Agent Sentry source maps/g)).toHaveLength(2);
    expect(
      workflow.match(/SENTRY_AUTH_TOKEN: \$\{\{ secrets\.SENTRY_AUTH_TOKEN \}\}/g)
    ).toHaveLength(2);
    expect(workflow).not.toContain('CLOUD_AGENT_SENTRY_ORG');
    expect(workflow).not.toContain('CLOUD_AGENT_SENTRY_PROJECT');
    expect(
      workflow.match(/deploy dist\/worker\/index\.js --no-bundle --upload-source-maps/g)
    ).toHaveLength(4);
    expect(workflow).not.toContain('continue-on-error');
  });
});
