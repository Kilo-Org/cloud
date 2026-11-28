import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { SourceMap, type SourceMapPayload } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'jsonc-parser';
import type { ErrorEvent } from '@sentry/core';
import { RUNTIME_DISTRIBUTION, WRAPPER_BUNDLES } from '../src/shared/runtime-distribution.js';
import { controlBundleEntries } from './publish-runtime.js';
import {
  prepareBunSentryArtifact,
  readSentryArtifact,
  runSentryCli,
  sentryCliBinary,
  sha256,
  stageSentryUploads,
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
  it('keeps built image, Vercel, and published runtime bytes identical to injected artifacts', async () => {
    execFileSync('bun', ['run', 'build.ts'], {
      cwd: resolve('wrapper'),
      timeout: 30_000,
      stdio: 'pipe',
    });
    const published = await controlBundleEntries(resolve('.'));
    for (const bundle of WRAPPER_BUNDLES) {
      const canonical = await readFile(resolve('wrapper/dist/sentry', bundle.installName));
      expect(
        (await readFile(resolve('wrapper/dist/runtime', bundle.installName))).equals(canonical)
      ).toBe(true);
      expect((await readFile(resolve('wrapper/dist', bundle.distName))).equals(canonical)).toBe(
        true
      );
      const map = await readFile(resolve('wrapper/dist/sentry', `${bundle.installName}.map`));
      expect(
        (await readFile(resolve('wrapper/dist', `${bundle.installName}.map`))).equals(map)
      ).toBe(true);
      expect((await readFile(resolve('wrapper/dist', `${bundle.distName}.map`))).equals(map)).toBe(
        true
      );
      const entry = published.find(item => item.path === `usr/local/bin/${bundle.installName}`);
      if (!entry) throw new Error(`Missing published runtime bundle: ${bundle.installName}`);
      expect(Buffer.from(entry.bytes).equals(canonical)).toBe(true);
    }
    expect(
      await validateSentryArtifacts('wrapper/dist/sentry', 'wrapper/dist/runtime')
    ).toHaveLength(WRAPPER_BUNDLES.filter(bundle => bundle.installName.endsWith('.js')).length);
  }, 40_000);

  it('stages Worker and wrapper maps for the fixed Cloud Agent project, with the CLI binary', async () => {
    const root = await fixture();
    const outDir = join(await fixture(), 'stage');
    const release = `cloud-agent-wrapper@${'c'.repeat(64)}`;
    const debugIds = [
      '2f361bcc-1d43-4fa2-b8d4-c6db9a131c85',
      '7d2c4f0e-5b1a-4c3e-9f8d-0a1b2c3d4e5f',
    ];
    const sources: Array<[string, string, string | undefined]> = [
      ['wrapper/dist/sentry', 'wrapper/dist/runtime', release],
      ['dist/worker', 'dist/worker', undefined],
    ];
    for (const [index, [source, shipped, artifactRelease]] of sources.entries()) {
      const debugId = debugIds[index] ?? '';
      const code = `globalThis._sentryDebugIds = { x: "${debugId}" };\n`;
      const map = JSON.stringify({ version: 3, debug_id: debugId });
      for (const directory of new Set([source, shipped])) {
        await mkdir(join(root, directory), { recursive: true });
        await writeFile(join(root, directory, 'index.js'), code);
      }
      await writeFile(join(root, source, 'index.js.map'), map);
      await writeFile(
        join(root, source, 'sentry-artifacts.json'),
        JSON.stringify([
          {
            file: 'index.js',
            sha256: sha256(code),
            mapSha256: sha256(map),
            debugId,
            ...(artifactRelease ? { release: artifactRelease } : {}),
          },
        ])
      );
    }
    const cli = join(root, 'fake-sentry-cli');
    await writeFile(cli, '#!/bin/sh\n');

    const uploads = await stageSentryUploads(root, outDir, cli);

    const fixed = ['sourcemaps', 'upload', '--org', 'kilo-code', '--project', 'kilo-cloud-agent'];
    const flags = ['--strict', '--validate', '--no-rewrite', '--wait-for', '120'];
    expect(uploads).toEqual([
      [...fixed, '--release', release, ...flags, '0/index.js', '0/index.js.map'],
      [...fixed, ...flags, '1/index.js', '1/index.js.map'],
    ]);
    expect(JSON.parse(await readFile(join(outDir, 'uploads.json'), 'utf8'))).toEqual(uploads);
    for (const [folder, source] of [
      ['0', 'wrapper/dist/sentry'],
      ['1', 'dist/worker'],
    ]) {
      for (const file of ['index.js', 'index.js.map']) {
        expect(
          (await readFile(join(outDir, folder, file))).equals(
            await readFile(join(root, source, file))
          )
        ).toBe(true);
      }
    }
    expect((await stat(join(outDir, 'sentry-cli'))).mode & 0o777).toBe(0o755);

    // A map changed after the build is refused.
    await writeFile(join(root, 'dist/worker/index.js.map'), '{}');
    await expect(stageSentryUploads(root, join(outDir, 'again'), cli)).rejects.toThrow();
  });

  it('hands over the native Sentry CLI binary of the lockfile', async () => {
    const binary = sentryCliBinary();
    expect((await stat(binary)).mode & 0o111).not.toBe(0);
    expect(execFileSync(binary, ['--version'], { encoding: 'utf8' })).toMatch(/sentry-cli \d/);
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

  it('preserves injected Worker bytes and SQL through Wrangler no-bundle', async () => {
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
  }, 180_000);

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

  it('keeps the containers image runtime-free and keeps auth tokens out of image definitions', async () => {
    for (const name of ['Dockerfile.containers.runtime-free']) {
      const dockerfile = await readFile(resolve(name), 'utf8');
      expect(dockerfile).not.toContain('COPY wrapper/dist/runtime/');
      expect(dockerfile).not.toContain('bun run build.ts');
      expect(dockerfile).not.toContain('SENTRY_AUTH_TOKEN');
      expect(dockerfile).toContain(`ARG BUN_VERSION="${RUNTIME_DISTRIBUTION.bun}"`);
    }
    const workflow = await readFile(resolve('../../.github/workflows/deploy-workers.yml'), 'utf8');
    // Every deploy job above has an `-sts` twin (`DEPLOY_TOKEN_SOURCE=sts`), so
    // both paths carry the same Cloud Agent wiring and are checked separately.
    const twinMarker = '# The STS twins of the deploy jobs above';
    const twinStart = workflow.indexOf(twinMarker);
    expect(twinStart).toBeGreaterThan(0);
    for (const jobs of [workflow.slice(0, twinStart), workflow.slice(twinStart)]) {
      // The deploy jobs stage the maps without the token; the upload job reads it from STS.
      expect(jobs.match(/name: Stage Cloud Agent Sentry source maps/g)).toHaveLength(3);
      expect(jobs.match(/name: Hand over Cloud Agent Sentry source maps/g)).toHaveLength(3);
      expect(jobs).not.toContain('SENTRY_AUTH_TOKEN');
      expect(jobs).not.toContain('CLOUD_AGENT_SENTRY_ORG');
      expect(jobs).not.toContain('CLOUD_AGENT_SENTRY_PROJECT');
      expect(jobs.match(/steps\.runtime\.outputs\.command/g)).toHaveLength(10);
      expect(jobs.match(/dist\/worker\/index\.js --no-bundle --upload-source-maps/g)).toHaveLength(
        6
      );
      expect(jobs.match(/name: Deploy to Cloudflare Workers \(retry\)/g)).toHaveLength(3);
    }
  });
});
