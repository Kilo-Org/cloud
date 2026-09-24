import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Template } from 'e2b';
import { z } from 'zod';
import { WRAPPER_VERSION } from '../src/shared/wrapper-version.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIRECTORY = resolve(PACKAGE_ROOT, '.e2b-build');
const TEMPLATE_NAME = 'kilo-cloud-agent';
const E2B_CONNECTION = { apiUrl: 'https://api.e2b.app', domain: 'e2b.app', debug: false };
const artifacts = {
  'control-wrapper.js': 'wrapper/dist/control-wrapper.js',
  'restore-session.js': 'wrapper/dist/restore-session.js',
  bb: 'wrapper/dist/bb',
  'kilo-git-credential': 'scripts/kilo-git-credential',
  Dockerfile: 'e2b/Dockerfile',
} as const;

export function createE2BRuntimeManifest(files: Record<keyof typeof artifacts, Uint8Array>) {
  const hashes = Object.fromEntries(
    Object.entries(files).map(([name, bytes]) => [
      name,
      createHash('sha256').update(bytes).digest('hex'),
    ])
  );
  return {
    version: 1,
    runtimeBuildId: `e2b-${createHash('sha256').update(JSON.stringify(hashes)).digest('hex')}`,
    wrapperVersion: WRAPPER_VERSION,
    wrapperSha256: hashes['control-wrapper.js'],
    bunVersion: '1.3.14',
    kiloVersion: '7.4.20',
    sdkVersion: '2.46.1',
    architecture: 'x86_64',
    cpuCount: 2,
    memoryMB: 4096,
    artifacts: hashes,
  };
}

export function createE2BReleaseManifest(
  runtime: ReturnType<typeof createE2BRuntimeManifest>,
  namespace: string,
  build: unknown
) {
  const name = `${z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
    .parse(namespace)}/${TEMPLATE_NAME}`;
  const parsed = z
    .object({
      templateId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      buildId: z.uuid(),
    })
    .parse(build);
  return {
    ...runtime,
    templateId: parsed.templateId,
    templateReference: `${name}:${parsed.buildId}`,
    buildId: parsed.buildId,
    public: false,
    qualification: 'requires-cross-project-live-smoke',
  };
}

async function prepareTemplate() {
  const files = {
    'control-wrapper.js': await readFile(resolve(PACKAGE_ROOT, artifacts['control-wrapper.js'])),
    'restore-session.js': await readFile(resolve(PACKAGE_ROOT, artifacts['restore-session.js'])),
    bb: await readFile(resolve(PACKAGE_ROOT, artifacts.bb)),
    'kilo-git-credential': await readFile(resolve(PACKAGE_ROOT, artifacts['kilo-git-credential'])),
    Dockerfile: await readFile(resolve(PACKAGE_ROOT, artifacts.Dockerfile)),
  };
  const manifest = createE2BRuntimeManifest(files);
  await mkdir(BUILD_DIRECTORY, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(resolve(BUILD_DIRECTORY, name), bytes);
  }
  await writeFile(
    resolve(BUILD_DIRECTORY, 'runtime-manifest.json'),
    JSON.stringify(manifest, null, 2)
  );
  return manifest;
}

async function publishTemplate() {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.E2B_TEMPLATE_PUBLISH_APPROVED !== 'true'
  ) {
    throw new Error('E2B template publication requires the approved release workflow');
  }
  const apiKey = process.env.E2B_TEMPLATE_PUBLISH_KEY?.trim();
  const namespace = process.env.E2B_TEMPLATE_NAMESPACE?.trim();
  if (!apiKey || !namespace || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(namespace)) {
    throw new Error('E2B template publishing configuration is missing');
  }
  const manifest = await prepareTemplate();
  const template = Template({ fileContextPath: BUILD_DIRECTORY })
    .fromDockerfile(resolve(BUILD_DIRECTORY, 'Dockerfile'))
    .setReadyCmd('test -s /opt/kilo/runtime-manifest.json');
  const build = await Template.build(template, `${namespace}/${TEMPLATE_NAME}`, {
    ...E2B_CONNECTION,
    apiKey,
    cpuCount: manifest.cpuCount,
    memoryMB: manifest.memoryMB,
    requestTimeoutMs: 60_000,
  });
  const release = createE2BReleaseManifest(manifest, namespace, build);
  const releasePath = resolve(BUILD_DIRECTORY, 'release-manifest.json');
  await writeFile(releasePath, JSON.stringify(release, null, 2));
  const response = await fetch(
    `https://api.e2b.app/v2/templates/${encodeURIComponent(release.templateId)}`,
    {
      method: 'PATCH',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ public: true }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    }
  );
  await response.body?.cancel();
  if (!response.ok) throw new Error('E2B template publication failed; retain the release manifest');
  await writeFile(releasePath, JSON.stringify({ ...release, public: true }, null, 2));
}

async function main() {
  const command = process.argv[2];
  if (command === 'prepare') {
    await prepareTemplate();
    console.log('Prepared credential-free E2B template artifacts; no remote resources created.');
  } else if (command === 'publish') {
    await publishTemplate();
    console.log('Published E2B template; cross-project live qualification is still required.');
  } else {
    throw new Error('Expected prepare or publish');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('E2B template operation failed. No template cleanup or retry was attempted.');
    process.exitCode = 1;
  });
}
