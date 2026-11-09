import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import type { ArtifactObjectStore } from '../src/sandbox-control/runtime-artifact-keys.js';
import { RUNTIME_BASE_ABI } from '../src/sandbox-control/runtime-release.js';
import { sha256 } from './runtime-publication.js';

export const RUNTIME_BASE_PLATFORM = 'linux/amd64';
const inputLabel = 'io.kilo.runtime-base-input';
const digestReference = z
  .string()
  .regex(/^registry\.cloudflare\.com\/[a-f0-9]{32}\/kilo-runtime-base@sha256:[a-f0-9]{64}$/);
export const runtimeBaseSchema = z
  .object({
    format: z.literal(1),
    inputId: z.string().regex(/^[a-f0-9]{64}$/),
    platform: z.literal(RUNTIME_BASE_PLATFORM),
    abi: z.literal(RUNTIME_BASE_ABI),
    image: digestReference,
  })
  .strict();
export type RuntimeBase = z.infer<typeof runtimeBaseSchema>;

/** The runtime-free recipe currently has no COPY or ADD inputs. */
export async function runtimeBaseInputId(packageRoot: string): Promise<string> {
  const dockerfile = await fs.readFile(
    path.join(packageRoot, 'Dockerfile.containers.runtime-free')
  );
  if (/^\s*(?:COPY|ADD)\s/im.test(dockerfile.toString()))
    throw new Error('Declare and hash base context inputs before adding COPY or ADD');
  return sha256(
    Buffer.from(
      JSON.stringify({
        format: 1,
        platform: RUNTIME_BASE_PLATFORM,
        abi: RUNTIME_BASE_ABI,
        dockerfile: sha256(dockerfile),
        contextFiles: [],
      })
    )
  );
}

export function runRuntimeTool(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 20 * 60_000,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
  });
  // Do not include command arguments or child output in errors.
  if (result.error || result.status !== 0)
    throw new Error(command + ' runtime publication command failed');
  return result.stdout.trim();
}

export function verifyRuntimeBase(base: RuntimeBase, packageRoot: string): void {
  runRuntimeTool('docker', ['pull', '--platform', base.platform, base.image], packageRoot);
  const inspect = z
    .object({
      Os: z.literal('linux'),
      Architecture: z.literal('amd64'),
      Config: z.object({ Labels: z.record(z.string(), z.string()) }),
    })
    .parse(
      JSON.parse(
        runRuntimeTool(
          'docker',
          ['image', 'inspect', '--format', '{{json .}}', base.image],
          packageRoot
        )
      )
    );
  if (inspect.Config.Labels[inputLabel] !== base.inputId)
    throw new Error('Runtime base input identity does not match');
  runRuntimeTool(
    'docker',
    [
      'run',
      '--rm',
      '--platform',
      base.platform,
      '--entrypoint',
      '/bin/sh',
      base.image,
      '-ec',
      'test -x /usr/bin/flock; test -x /usr/local/bin/node; test -x /usr/local/bin/bun; ' +
        'test ! -e /usr/local/bin/kilo; test ! -e /usr/local/bin/kilocode-control-plane; ' +
        'test ! -e /opt/kilo-cloud/kilo-git-credential',
    ],
    packageRoot
  );
}

export async function ensureRuntimeBase(
  store: ArtifactObjectStore,
  packageRoot: string,
  accountId: string
): Promise<RuntimeBase> {
  z.string()
    .regex(/^[a-f0-9]{32}$/)
    .parse(accountId);
  const inputId = await runtimeBaseInputId(packageRoot);
  const key = 'runtime-artifacts/v1/bases/' + inputId + '.json';
  const parseStoredBase = (stored: Uint8Array) => {
    const base = runtimeBaseSchema.parse(JSON.parse(new TextDecoder().decode(stored)));
    if (
      base.inputId !== inputId ||
      !base.image.startsWith('registry.cloudflare.com/' + accountId + '/')
    )
      throw new Error('Cached runtime base does not match this publication target');
    return base;
  };
  const stored = await store.getBytes(key);
  if (stored !== null) {
    const base = parseStoredBase(stored);
    verifyRuntimeBase(base, packageRoot);
    return base;
  }
  const tag = 'kilo-runtime-base:' + inputId;
  runRuntimeTool(
    'docker',
    [
      'build',
      '--platform',
      RUNTIME_BASE_PLATFORM,
      '--file',
      'Dockerfile.containers.runtime-free',
      '--label',
      inputLabel + '=' + inputId,
      '--tag',
      tag,
      '.',
    ],
    packageRoot
  );
  runRuntimeTool('pnpm', ['exec', 'wrangler', 'containers', 'push', tag], packageRoot);
  const tagged = 'registry.cloudflare.com/' + accountId + '/' + tag;
  const digests = z
    .array(z.string())
    .parse(
      JSON.parse(
        runRuntimeTool(
          'docker',
          ['image', 'inspect', '--format', '{{json .RepoDigests}}', tagged],
          packageRoot
        )
      )
    );
  const image = digests.find(
    value =>
      digestReference.safeParse(value).success &&
      value.startsWith('registry.cloudflare.com/' + accountId + '/')
  );
  if (!image) throw new Error('Published runtime base has no immutable registry digest');
  const base = runtimeBaseSchema.parse({
    format: 1,
    inputId,
    platform: RUNTIME_BASE_PLATFORM,
    abi: RUNTIME_BASE_ABI,
    image,
  });
  verifyRuntimeBase(base, packageRoot);
  await store.putIfAbsent(key, Buffer.from(JSON.stringify(base)), 'application/json');
  const retained = await store.getBytes(key);
  if (retained === null) throw new Error('Published runtime base is missing');
  // Concurrent source SHAs can build different digests from the same base inputs.
  // Keep the first verified digest and verify it before this publisher uses it.
  const winner = parseStoredBase(retained);
  if (winner.image !== base.image) verifyRuntimeBase(winner, packageRoot);
  return winner;
}

async function linkRuntimeDockerPlugins(sourceDirectory: string, directory: string): Promise<void> {
  const plugins = path.join(sourceDirectory, 'cli-plugins');
  try {
    if (!(await fs.stat(plugins)).isDirectory()) return;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  // Keep Buildx discoverable without copying config.json, auths, proxies or credential helpers.
  await fs.symlink(plugins, path.join(directory, 'cli-plugins'), 'dir');
}

/** Keep temporary registry credentials out of the user's Docker configuration. */
export async function withRuntimeRegistry<T>(
  packageRoot: string,
  run: () => Promise<T>
): Promise<T> {
  const previous = process.env.DOCKER_CONFIG;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kilo-runtime-registry-'));
  process.env.DOCKER_CONFIG = directory;
  try {
    await linkRuntimeDockerPlugins(
      previous ? path.resolve(packageRoot, previous) : path.join(os.homedir(), '.docker'),
      directory
    );
    const credentials = z
      .object({ username: z.string().min(1), password: z.string().min(1) })
      .parse(
        JSON.parse(
          runRuntimeTool(
            'pnpm',
            ['exec', 'wrangler', 'containers', 'registries', 'credentials', '--pull', '--json'],
            packageRoot
          )
        )
      );
    const login = spawnSync(
      'docker',
      ['login', 'registry.cloudflare.com', '--username', credentials.username, '--password-stdin'],
      {
        input: credentials.password,
        encoding: 'utf8',
        cwd: packageRoot,
        timeout: 30_000,
        killSignal: 'SIGKILL',
      }
    );
    if (login.error || login.status !== 0)
      throw new Error('Runtime registry authentication failed');
    return await run();
  } finally {
    if (previous === undefined) delete process.env.DOCKER_CONFIG;
    else process.env.DOCKER_CONFIG = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
}
