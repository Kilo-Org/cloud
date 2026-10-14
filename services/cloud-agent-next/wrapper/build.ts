import { chmod, copyFile, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  CONTROL_PLANE_SUPERVISOR,
  RUNTIME_DISTRIBUTION,
  WRAPPER_BUNDLES,
} from '../src/shared/runtime-distribution.js';
import {
  prepareBunSentryArtifact,
  readSentryArtifact,
  runSentryCli,
  sha256,
} from '../scripts/sentry-source-maps.js';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
  return value;
}

const installDir = argValue('install-dir');
const linkDir = argValue('link-dir');
if (Bun.version !== RUNTIME_DISTRIBUTION.bun) {
  throw new Error(`Wrapper build requires Bun ${RUNTIME_DISTRIBUTION.bun}, got ${Bun.version}`);
}

async function buildBundle(entry: string, outdir: string, naming: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [`./${entry}`],
    outdir,
    naming,
    target: 'bun',
    minify: true,
    sourcemap: 'external',
  });
  if (!result.success) throw new Error(`bun build failed for ${entry}`);
  const bundle = result.outputs.find(output => output.kind === 'entry-point');
  if (!bundle) throw new Error(`bun build produced no bundle for ${entry}`);
  const release = `cloud-agent-wrapper@${sha256(await bundle.text())}`;
  const instrumented = await Bun.build({
    entrypoints: [`./${entry}`],
    outdir,
    naming,
    target: 'bun',
    minify: true,
    sourcemap: 'external',
    banner: `globalThis.SENTRY_RELEASE = { id: ${JSON.stringify(release)} };`,
  });
  if (!instrumented.success) throw new Error(`bun build failed for ${entry}`);
  await prepareBunSentryArtifact(outdir, naming);
  return release;
}

async function linkInstalled(installed: readonly string[]): Promise<void> {
  if (!linkDir) return;
  if (!installDir) throw new Error('--link-dir requires --install-dir');
  await mkdir(linkDir, { recursive: true });
  for (const name of installed) {
    const link = resolve(linkDir, name);
    await rm(link, { force: true });
    await symlink(resolve(installDir, name), link);
  }
}

const artifactDir = resolve('dist/sentry');
const runtimeDir = resolve('dist/runtime');
await rm(artifactDir, { force: true, recursive: true });
await rm(runtimeDir, { force: true, recursive: true });
await mkdir(artifactDir, { recursive: true });
await mkdir(runtimeDir, { recursive: true });
const releases = new Map<string, string>();
for (const bundle of WRAPPER_BUNDLES) {
  releases.set(
    bundle.installName,
    await buildBundle(bundle.entry, artifactDir, bundle.installName)
  );
}
runSentryCli(['sourcemaps', 'inject', artifactDir]);
const artifacts = await Promise.all(
  WRAPPER_BUNDLES.filter(bundle => bundle.installName.endsWith('.js')).map(bundle => {
    const release = releases.get(bundle.installName);
    if (!release) throw new Error(`Missing release for ${bundle.installName}`);
    return readSentryArtifact(artifactDir, bundle.installName, release);
  })
);
await writeFile(resolve(artifactDir, 'sentry-artifacts.json'), JSON.stringify(artifacts, null, 2));
for (const bundle of WRAPPER_BUNDLES) {
  await copyFile(resolve(artifactDir, bundle.installName), resolve(runtimeDir, bundle.installName));
  if (bundle.executable) await chmod(resolve(runtimeDir, bundle.installName), 0o755);
}
await copyFile(
  CONTROL_PLANE_SUPERVISOR.wrapperPath,
  resolve(runtimeDir, CONTROL_PLANE_SUPERVISOR.installName)
);
await chmod(resolve(runtimeDir, CONTROL_PLANE_SUPERVISOR.installName), 0o755);

if (installDir) {
  await mkdir(installDir, { recursive: true });
  const installed: string[] = [];
  for (const bundle of WRAPPER_BUNDLES) {
    await copyFile(
      resolve(runtimeDir, bundle.installName),
      resolve(installDir, bundle.installName)
    );
    if (bundle.executable) await chmod(`${installDir}/${bundle.installName}`, 0o755);
    installed.push(bundle.installName);
  }
  const supervisorTarget = `${installDir}/${CONTROL_PLANE_SUPERVISOR.installName}`;
  await copyFile(CONTROL_PLANE_SUPERVISOR.wrapperPath, supervisorTarget);
  await chmod(supervisorTarget, 0o755);
  installed.push(CONTROL_PLANE_SUPERVISOR.installName);
  await linkInstalled(installed);
  console.log(
    `Installed runtime bundles into ${installDir}: ${installed.join(', ')}${
      linkDir ? ` (linked into ${linkDir})` : ''
    }`
  );
} else {
  if (linkDir) throw new Error('--link-dir requires --install-dir');
  await rm('./dist/kilo-bitbucket-review', { force: true });
  for (const bundle of WRAPPER_BUNDLES) {
    await copyFile(resolve(runtimeDir, bundle.installName), resolve('dist', bundle.distName));
    await copyFile(
      resolve(artifactDir, `${bundle.installName}.map`),
      resolve('dist', `${bundle.distName}.map`)
    );
    if (bundle.executable) await chmod(`./dist/${bundle.distName}`, 0o755);
  }
  console.log(
    `Build complete: ${WRAPPER_BUNDLES.map(bundle => `dist/${bundle.distName}`).join(', ')}`
  );
}
