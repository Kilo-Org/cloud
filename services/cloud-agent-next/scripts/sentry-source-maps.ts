import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
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

export function sentryUploadConfigured(env: { SENTRY_AUTH_TOKEN?: string }): boolean {
  if (!env.SENTRY_AUTH_TOKEN?.trim()) {
    console.log(
      'Skipping Cloud Agent Sentry source map upload: SENTRY_AUTH_TOKEN is not configured.'
    );
    return false;
  }
  return true;
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
