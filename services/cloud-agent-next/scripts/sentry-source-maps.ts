import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { z } from 'zod';

const require = createRequire(import.meta.url);

export const sentryArtifactSchema = z.object({
  file: z.string().regex(/^[\w.-]+$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mapSha256: z.string().regex(/^[a-f0-9]{64}$/),
  debugId: z.uuid(),
  release: z
    .string()
    .regex(/^cloud-agent-wrapper@[a-f0-9]{64}$/)
    .optional(),
});

export type SentryArtifact = z.infer<typeof sentryArtifactSchema>;

export function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function runSentryCli(args: string[]): void {
  execFileSync(require.resolve('@sentry/cli/bin/sentry-cli'), args, { stdio: 'inherit' });
}

export async function prepareBunSentryArtifact(directory: string, file: string): Promise<void> {
  const codePath = join(directory, file);
  const mapPath = `${codePath}.map`;
  const [code, rawMap] = await Promise.all([readFile(codePath, 'utf8'), readFile(mapPath, 'utf8')]);
  const map = z.looseObject({ debugId: z.string().optional() }).parse(JSON.parse(rawMap));
  // CLI skips Bun's native marker, which does not register an ID with the SDK.
  delete map.debugId;
  await Promise.all([
    writeFile(codePath, code.replace(/^\/\/# debugId=.*\n?/gm, '')),
    writeFile(mapPath, JSON.stringify(map)),
  ]);
}

export async function readSentryArtifact(
  directory: string,
  file: string,
  release?: string
): Promise<SentryArtifact> {
  const [code, mapBytes] = await Promise.all([
    readFile(join(directory, file), 'utf8'),
    readFile(join(directory, `${file}.map`)),
  ]);
  const map = z
    .object({ debug_id: z.uuid().optional(), debugId: z.uuid().optional() })
    .parse(JSON.parse(mapBytes.toString()));
  const debugId = map.debug_id ?? map.debugId;
  if (!debugId || !code.includes('_sentryDebugIds') || !code.includes(debugId)) {
    throw new Error(`Missing Sentry debug-ID registration in ${file}`);
  }
  return {
    file,
    release,
    debugId,
    sha256: sha256(code),
    mapSha256: sha256(mapBytes),
  };
}

export async function validateSentryArtifacts(
  directory: string,
  shippedDirectory = directory
): Promise<SentryArtifact[]> {
  const artifacts = z
    .array(sentryArtifactSchema)
    .min(1)
    .parse(JSON.parse(await readFile(join(directory, 'sentry-artifacts.json'), 'utf8')));
  for (const artifact of artifacts) {
    const actual = await readSentryArtifact(directory, artifact.file, artifact.release);
    if (
      actual.sha256 !== artifact.sha256 ||
      actual.mapSha256 !== artifact.mapSha256 ||
      actual.debugId !== artifact.debugId ||
      sha256(await readFile(join(shippedDirectory, artifact.file))) !== artifact.sha256
    ) {
      throw new Error(`Sentry artifact changed after build: ${artifact.file}`);
    }
  }
  return artifacts;
}

/** The built maps uploaded after a deploy, each with the directory its code ships from. */
const SENTRY_SOURCE_DIRECTORIES = [
  ['wrapper/dist/sentry', 'wrapper/dist/runtime'],
  ['dist/worker', 'dist/worker'],
] as const;

/** The native binary of the lockfile's @sentry/cli; it runs without a package manager. */
export function sentryCliBinary(): string {
  const cli = require('@sentry/cli') as { SentryCli: { getPath(): string } };
  return cli.SentryCli.getPath();
}

/**
 * Validates the built maps under `root` and copies what the upload job needs into `outDir`: each
 * code file and map under a numbered folder, the Sentry CLI binary as `sentry-cli`, and
 * `uploads.json`, one `sentry-cli` argument list per artifact with paths relative to `outDir`.
 * The deploy job runs this without the Sentry token; the upload job, which reads the token from
 * STS, runs only those argument lists (.github/workflows/cloud-agent-sentry-sourcemaps.yml).
 */
export async function stageSentryUploads(
  root: string,
  outDir: string,
  cliBinary: string
): Promise<string[][]> {
  const uploads: string[][] = [];
  for (const [index, [source, shipped]] of SENTRY_SOURCE_DIRECTORIES.entries()) {
    const directory = join(root, source);
    const artifacts = await validateSentryArtifacts(directory, join(root, shipped));
    const folder = String(index);
    await mkdir(join(outDir, folder), { recursive: true });
    for (const artifact of artifacts) {
      const map = `${artifact.file}.map`;
      await copyFile(join(directory, artifact.file), join(outDir, folder, artifact.file));
      await copyFile(join(directory, map), join(outDir, folder, map));
      uploads.push([
        'sourcemaps',
        'upload',
        '--org',
        'kilo-code',
        '--project',
        'kilo-cloud-agent',
        ...(artifact.release ? ['--release', artifact.release] : []),
        '--strict',
        '--validate',
        '--no-rewrite',
        '--wait-for',
        '120',
        `${folder}/${artifact.file}`,
        `${folder}/${map}`,
      ]);
    }
  }
  await copyFile(cliBinary, join(outDir, 'sentry-cli'));
  await chmod(join(outDir, 'sentry-cli'), 0o755);
  await writeFile(join(outDir, 'uploads.json'), JSON.stringify(uploads));
  return uploads;
}

export function workerBuildArgs(environment: string | undefined, config?: string): string[] {
  return [
    'deploy',
    '--dry-run',
    '--outdir',
    'dist/worker',
    '--upload-source-maps',
    '--containers-rollout',
    'none',
    ...(config ? ['--config', config] : []),
    ...(environment && environment !== 'production' ? ['--env', environment] : []),
  ];
}
