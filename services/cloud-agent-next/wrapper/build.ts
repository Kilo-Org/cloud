import { chmod, copyFile, mkdir, rm, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';

import { CONTROL_PLANE_SUPERVISOR, WRAPPER_BUNDLES } from '../src/shared/runtime-distribution.js';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
  return value;
}

const installDir = argValue('install-dir');
const linkDir = argValue('link-dir');

async function buildBundle(
  entry: string,
  outdir: string,
  naming: string,
  sourcemap: boolean
): Promise<void> {
  const result = await Bun.build({
    entrypoints: [`./${entry}`],
    outdir,
    naming,
    target: 'bun',
    minify: true,
    ...(sourcemap ? { sourcemap: 'external' as const } : {}),
  });
  if (!result.success) throw new Error(`bun build failed for ${entry}`);
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

if (installDir) {
  await mkdir(installDir, { recursive: true });
  const installed: string[] = [];
  for (const bundle of WRAPPER_BUNDLES) {
    await buildBundle(bundle.entry, installDir, bundle.installName, false);
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
    await buildBundle(bundle.entry, './dist', bundle.distName, bundle.entry === 'src/main.ts');
    if (bundle.executable) await chmod(`./dist/${bundle.distName}`, 0o755);
  }
  console.log(
    `Build complete: ${WRAPPER_BUNDLES.map(bundle => `dist/${bundle.distName}`).join(', ')}`
  );
}
