import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  CONTROL_PLANE_SUPERVISOR,
  GIT_CREDENTIAL_HELPER,
  RUNTIME_DISTRIBUTION,
  WRAPPER_BUNDLES,
} from '../src/shared/runtime-distribution.js';
import { RUNTIME_BASE_ABI } from '../src/shared/runtime-release.js';
import { PINNED_CLI_VERSION } from './runtime-cli-artifact.js';
import { sha256 } from './publish-runtime.js';

export const NATIVE_RUNTIME_FREE_DOCKERFILE = 'Dockerfile.containers.runtime-free';

export function nativeBaseInputSha256(recipe: string, abi: string) {
  return sha256(new TextEncoder().encode(JSON.stringify({ recipe, abi, platform: 'linux/amd64' })));
}

const dependencySchema = z.object({ version: z.string() }).passthrough();
const importerSchema = z
  .object({
    dependencies: z.record(z.string(), dependencySchema).optional(),
    devDependencies: z.record(z.string(), dependencySchema).optional(),
  })
  .passthrough();
const lockSchema = z.object({
  importers: z.record(z.string(), importerSchema),
  packages: z.record(z.string(), z.unknown()),
  snapshots: z.record(
    z.string(),
    z
      .object({
        dependencies: z.record(z.string(), z.string()).optional(),
        optionalDependencies: z.record(z.string(), z.string()).optional(),
      })
      .passthrough()
  ),
  patchedDependencies: z.record(z.string(), z.unknown()).optional(),
});

export function runtimeDependencyInputs(value: unknown) {
  const lock = lockSchema.parse(value);
  const selected: Record<string, unknown> = {};
  const visitImporter = (name: string) => {
    const key = `importer:${name}`;
    if (selected[key]) return;
    const importer = lock.importers[name];
    if (!importer) throw new Error(`runtime dependency importer is missing: ${name}`);
    selected[key] = importer.dependencies ?? {};
    for (const [dependency, data] of Object.entries(importer.dependencies ?? {})) {
      visit(dependency, data.version, name);
    }
  };
  const visit = (name: string, version: string, importer: string) => {
    if (version.startsWith('link:')) {
      visitImporter(path.posix.normalize(path.posix.join(importer, version.slice(5))));
      return;
    }
    const key = `${name}@${version}`;
    if (selected[key]) return;
    const snapshot = lock.snapshots[key];
    const packageKey = key.replace(/\(.*$/, '');
    if (!snapshot || !lock.packages[packageKey])
      throw new Error(`runtime dependency is not locked: ${key}`);
    selected[key] = { snapshot, package: lock.packages[packageKey] };
    for (const [dependency, resolved] of Object.entries({
      ...snapshot.dependencies,
      ...snapshot.optionalDependencies,
    })) {
      visit(dependency, resolved, importer);
    }
  };
  visitImporter('services/cloud-agent-next/wrapper');
  visitImporter('services/cloud-agent-next');
  return {
    entries: Object.entries(selected).sort(([left], [right]) => left.localeCompare(right)),
    patches: lock.patchedDependencies,
  };
}

function instructions(source: string) {
  return source
    .split('\n')
    .filter(line => line.trim() && !line.trimStart().startsWith('#'))
    .map(line => line.trim())
    .join('\n');
}

export function verifyNativeBaseRecipe(candidate: string, baked: string): void {
  const generic = baked.split('COPY scripts/kilo-git-credential')[0];
  const entrypoint = baked.slice(baked.indexOf("RUN printf '%s\\n'"));
  if (
    !generic ||
    !baked.includes('COPY scripts/kilo-git-credential') ||
    !entrypoint.startsWith('RUN printf')
  ) {
    throw new Error('native base recipe boundary changed; review the runtime-free recipe');
  }
  const expected = `${generic}\nRUN npm install -g pnpm@\${PNPM_VERSION}\n${entrypoint}`;
  const normalize = (source: string) =>
    instructions(source).replace(/^ARG (BUILD_DATE|VCS_REF|KILOCODE_CLI_VERSION)=.*\n/gm, '');
  if (normalize(candidate) !== normalize(expected))
    throw new Error('native runtime-free recipe differs from the generic native toolchain');
  if (
    /^COPY (?!.*--from=)|@kilocode\/cli|wrapper|supervisor|kilo-git-credential/m.test(candidate)
  ) {
    throw new Error('native runtime-free recipe contains runtime inputs');
  }
  if (!candidate.includes(`ARG NODE_VERSION="${RUNTIME_DISTRIBUTION.nodeMajor}.`))
    throw new Error('native base NODE_VERSION does not match the shared toolchain');
  for (const [name, version] of Object.entries({
    BUN_VERSION: RUNTIME_DISTRIBUTION.bun,
    PNPM_VERSION: RUNTIME_DISTRIBUTION.pnpm,
    GLAB_VERSION: RUNTIME_DISTRIBUTION.glab,
    GH_VERSION: RUNTIME_DISTRIBUTION.gh,
  })) {
    if (!candidate.includes(`ARG ${name}="${version}"`))
      throw new Error(`native base ${name} is not pinned to the shared toolchain`);
  }
}

export async function collectRuntimeInputs(serviceRoot: string) {
  const repositoryRoot = path.resolve(serviceRoot, '../..');
  const files = new Map<string, string>();
  const configPath = path.join(serviceRoot, 'wrapper/tsconfig.json');
  const configSource = await fs.readFile(configPath, 'utf8');
  files.set(path.relative(repositoryRoot, configPath).split(path.sep).join('/'), configSource);
  const config = ts.parseConfigFileTextToJson(configPath, configSource);
  if (config.error) throw new Error('wrapper TypeScript configuration cannot be parsed');
  const parsedConfig = ts.parseJsonConfigFileContent(
    config.config,
    {
      ...ts.sys,
      readFile(file) {
        const relative = path.relative(repositoryRoot, file).split(path.sep).join('/');
        if (relative.startsWith('../'))
          throw new Error('wrapper build configuration escapes the repository');
        const source = ts.sys.readFile(file);
        if (source !== undefined) files.set(relative, source);
        return source;
      },
    },
    path.dirname(configPath)
  );
  if (parsedConfig.errors.length)
    throw new Error('wrapper TypeScript configuration cannot be parsed');
  const visitSource = async (file: string): Promise<void> => {
    const relative = path.relative(repositoryRoot, file).split(path.sep).join('/');
    if (files.has(relative) || relative.split('/').includes('node_modules')) return;
    if (relative.startsWith('../')) throw new Error('runtime source escapes the repository');
    const source = await fs.readFile(file, 'utf8');
    files.set(relative, source);
    if (!/\.[cm]?[jt]s$/.test(file)) return;
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      const resolved = ts.resolveModuleName(
        imported.fileName,
        file,
        parsedConfig.options,
        ts.sys
      ).resolvedModule;
      if (resolved) {
        const resolvedPath = await fs.realpath(resolved.resolvedFileName);
        const dependencyPath = path.relative(repositoryRoot, resolvedPath);
        if (
          !dependencyPath.startsWith('../') &&
          !dependencyPath.split(path.sep).includes('node_modules')
        )
          await visitSource(resolvedPath);
      } else if (imported.fileName.startsWith('.'))
        throw new Error(`runtime source import cannot be resolved: ${relative}`);
    }
  };
  for (const file of [
    ...WRAPPER_BUNDLES.map(bundle => `wrapper/${bundle.entry}`),
    'wrapper/build.ts',
    'wrapper/tsconfig.json',
    `wrapper/${CONTROL_PLANE_SUPERVISOR.wrapperPath}`,
    GIT_CREDENTIAL_HELPER.packagePath,
    'scripts/publish-runtime.ts',
    'scripts/runtime-cli-artifact.ts',
    'scripts/runtime-ci-release.ts',
    'scripts/runtime-ci-command.ts',
    'scripts/runtime-ci-inputs.ts',
  ])
    await visitSource(path.join(serviceRoot, file));
  const wrapper = z
    .object({ dependencies: z.object({ '@kilocode/sdk': z.string() }) })
    .parse(JSON.parse(await fs.readFile(path.join(serviceRoot, 'wrapper/package.json'), 'utf8')));
  const worker = z
    .object({ devDependencies: z.object({ '@kilocode/sdk': z.string() }) })
    .parse(JSON.parse(await fs.readFile(path.join(serviceRoot, 'package.json'), 'utf8')));
  if (
    wrapper.dependencies['@kilocode/sdk'] !== PINNED_CLI_VERSION ||
    worker.devDependencies['@kilocode/sdk'] !== PINNED_CLI_VERSION
  ) {
    throw new Error('CLI and SDK pins disagree; select a tested runtime pair');
  }
  const dependencyInputs = runtimeDependencyInputs(
    parseYaml(await fs.readFile(path.join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8'))
  );
  const patches = await fs.readdir(path.join(repositoryRoot, 'patches'));
  for (const patch of patches.sort())
    await visitSource(path.join(repositoryRoot, 'patches', patch));
  const recipe = await fs.readFile(path.join(serviceRoot, NATIVE_RUNTIME_FREE_DOCKERFILE), 'utf8');
  verifyNativeBaseRecipe(
    recipe,
    await fs.readFile(path.join(serviceRoot, 'Dockerfile.containers'), 'utf8')
  );
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  return {
    runtimeSha256: sha256(
      encode({
        sources: [...files].sort(([left], [right]) => left.localeCompare(right)),
        dependencies: dependencyInputs,
        bun: RUNTIME_DISTRIBUTION.bun,
      })
    ),
    baseSha256: nativeBaseInputSha256(recipe, RUNTIME_BASE_ABI),
    cliVersion: PINNED_CLI_VERSION,
    wrapperSdkVersion: wrapper.dependencies['@kilocode/sdk'],
  };
}

export type RuntimeInputs = Awaited<ReturnType<typeof collectRuntimeInputs>>;
