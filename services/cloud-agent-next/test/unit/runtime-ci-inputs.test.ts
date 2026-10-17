import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  collectRuntimeInputs,
  nativeBaseInputSha256,
  runtimeDependencyInputs,
  verifyNativeBaseRecipe,
} from '../../scripts/runtime-ci-inputs.js';
import { RUNTIME_BASE_ABI } from '../../src/shared/runtime-release.js';
import { nativeBaseChanged } from '../../scripts/runtime-ci-command.js';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let fixture: string;
let serviceRoot: string;
beforeAll(async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-input-test-'));
  serviceRoot = path.join(fixture, 'services/cloud-agent-next');
  await fs.mkdir(path.dirname(serviceRoot), { recursive: true });
  await fs.cp(sourceRoot, serviceRoot, {
    recursive: true,
    filter: async source => {
      const relative = path.relative(sourceRoot, source);
      if (
        relative
          .split(path.sep)
          .some(part => ['node_modules', '.wrangler', 'dist', 'test'].includes(part))
      )
        return false;
      if ((await fs.stat(source)).isDirectory()) return true;
      return (
        !source.endsWith('.test.ts') &&
        (/\.(ts|sh|mjs)$/.test(source) ||
          ['package.json', 'tsconfig.json'].includes(path.basename(source)) ||
          path.basename(source).startsWith('Dockerfile') ||
          path.basename(source) === 'kilo-git-credential')
      );
    },
  });
  await fs.copyFile(
    path.resolve(sourceRoot, '../../pnpm-lock.yaml'),
    path.join(fixture, 'pnpm-lock.yaml')
  );
  await fs.cp(path.resolve(sourceRoot, '../../patches'), path.join(fixture, 'patches'), {
    recursive: true,
  });
}, 30_000);
afterAll(async () => {
  await fs.rm(fixture, { recursive: true, force: true });
});

it('changes the runtime fingerprint, not the native base, for wrapper, supervisor, and helper edits', async () => {
  const baseline = await collectRuntimeInputs(serviceRoot);
  for (const file of [
    'wrapper/src/main.ts',
    'wrapper/control-plane-supervisor.sh',
    'scripts/kilo-git-credential',
  ]) {
    const pathname = path.join(serviceRoot, file);
    const source = await fs.readFile(pathname, 'utf8');
    try {
      await fs.appendFile(
        pathname,
        file.endsWith('.ts') ? '\nexport const runtimeInputFixture = true;\n' : '\ntrue\n'
      );
      const changed = await collectRuntimeInputs(serviceRoot);
      expect(changed.runtimeSha256).not.toBe(baseline.runtimeSha256);
      expect(changed.baseSha256).toBe(baseline.baseSha256);
    } finally {
      await fs.writeFile(pathname, source);
    }
  }
}, 30_000);

it('does not rebuild the runtime when unrelated Worker code changes', async () => {
  const baseline = await collectRuntimeInputs(serviceRoot);
  const pathname = path.join(serviceRoot, 'src/index.ts');
  const source = await fs.readFile(pathname, 'utf8');
  try {
    await fs.appendFile(pathname, '\nexport const unrelatedWorkerFixture = true;\n');
    expect(await collectRuntimeInputs(serviceRoot)).toEqual(baseline);
  } finally {
    await fs.writeFile(pathname, source);
  }
});

it('invalidates runtime evidence when the Bun TypeScript build configuration changes', async () => {
  const baseline = await collectRuntimeInputs(serviceRoot);
  const pathname = path.join(serviceRoot, 'wrapper/tsconfig.json');
  const source = await fs.readFile(pathname, 'utf8');
  try {
    await fs.writeFile(pathname, source.replace('"target": "ESNext"', '"target": "ES2022"'));
    const changed = await collectRuntimeInputs(serviceRoot);
    expect(changed.runtimeSha256).not.toBe(baseline.runtimeSha256);
    expect(changed.baseSha256).toBe(baseline.baseSha256);
  } finally {
    await fs.writeFile(pathname, source);
  }
});

it('invalidates the native base when generic tool instructions or ABI change', async () => {
  const baseline = await collectRuntimeInputs(serviceRoot);
  const paths = ['Dockerfile.containers.runtime-free', 'Dockerfile.containers'].map(file =>
    path.join(serviceRoot, file)
  );
  const sources = await Promise.all(paths.map(file => fs.readFile(file, 'utf8')));
  try {
    await Promise.all(
      paths.map((file, index) => fs.writeFile(file, sources[index].replace('24.9.0', '24.9.1')))
    );
    const changed = await collectRuntimeInputs(serviceRoot);
    expect(changed.baseSha256).not.toBe(baseline.baseSha256);
    expect(changed.runtimeSha256).toBe(baseline.runtimeSha256);
  } finally {
    await Promise.all(paths.map((file, index) => fs.writeFile(file, sources[index])));
  }
  expect(nativeBaseInputSha256(sources[0], 'different-layout-abi')).not.toBe(
    nativeBaseInputSha256(sources[0], RUNTIME_BASE_ABI)
  );
});

it('rejects untested SDK pairs and an unsynchronized native base recipe', async () => {
  const pathname = path.join(serviceRoot, 'wrapper/package.json');
  const source = await fs.readFile(pathname, 'utf8');
  try {
    await fs.writeFile(
      pathname,
      source.replace('"@kilocode/sdk": "7.8.1"', '"@kilocode/sdk": "7.8.2"')
    );
    await expect(collectRuntimeInputs(serviceRoot)).rejects.toThrow('CLI and SDK pins disagree');
  } finally {
    await fs.writeFile(pathname, source);
  }
  const candidate = await fs.readFile(
    path.join(serviceRoot, 'Dockerfile.containers.runtime-free'),
    'utf8'
  );
  const baked = await fs.readFile(path.join(serviceRoot, 'Dockerfile.containers'), 'utf8');
  expect(() => verifyNativeBaseRecipe(candidate, baked)).not.toThrow();
  expect(() => verifyNativeBaseRecipe(candidate.replace('24.9.0', '24.9.1'), baked)).toThrow(
    'differs'
  );
});

it('tracks locked production dependency closure but ignores an unrelated app importer', () => {
  const lock = {
    importers: {
      'services/cloud-agent-next/wrapper': { dependencies: { sdk: { version: '1.0.0' } } },
      'services/cloud-agent-next': { dependencies: {} },
      'apps/web': { dependencies: { unrelated: { version: '2.0.0' } } },
    },
    packages: {
      'sdk@1.0.0': { resolution: { integrity: 'sdk-a' } },
      'child@1.0.0': { resolution: { integrity: 'child-a' } },
    },
    snapshots: { 'sdk@1.0.0': { dependencies: { child: '1.0.0' } }, 'child@1.0.0': {} },
  };
  const baseline = runtimeDependencyInputs(lock);
  expect(
    runtimeDependencyInputs({
      ...lock,
      importers: {
        ...lock.importers,
        'apps/web': { dependencies: { other: { version: '3.0.0' } } },
      },
    })
  ).toEqual(baseline);
  expect(
    runtimeDependencyInputs({
      ...lock,
      packages: { ...lock.packages, 'child@1.0.0': { resolution: { integrity: 'child-b' } } },
    })
  ).not.toEqual(baseline);
  expect(() => runtimeDependencyInputs({ ...lock, snapshots: {} })).toThrow('not locked');
});

it('skips an unchanged native recipe across commits and checks changed or missing base inputs', async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-base-range-'));
  try {
    const service = path.join(repository, 'services/cloud-agent-next');
    await fs.mkdir(path.join(service, 'src/shared'), { recursive: true });
    const recipe = await fs.readFile(
      path.join(sourceRoot, 'Dockerfile.containers.runtime-free'),
      'utf8'
    );
    await fs.writeFile(path.join(service, 'Dockerfile.containers.runtime-free'), recipe);
    await fs.writeFile(
      path.join(service, 'src/shared/runtime-release.ts'),
      `export const RUNTIME_BASE_ABI = '${RUNTIME_BASE_ABI}';\n`
    );
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
    git('init', '-b', 'main');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'base fixture'
    );
    const baseline = git('rev-parse', 'HEAD');
    const fingerprint = nativeBaseInputSha256(recipe, RUNTIME_BASE_ABI);
    expect(await nativeBaseChanged(service, baseline, fingerprint)).toBe(false);
    expect(
      await nativeBaseChanged(
        service,
        baseline,
        nativeBaseInputSha256(recipe.replace('24.9.0', '24.9.1'), RUNTIME_BASE_ABI)
      )
    ).toBe(true);
    expect(
      await nativeBaseChanged(service, baseline, nativeBaseInputSha256(recipe, 'new-layout-abi'))
    ).toBe(true);
    expect(await nativeBaseChanged(service, '', fingerprint)).toBe(true);
    expect(await nativeBaseChanged(service, 'a'.repeat(40), fingerprint)).toBe(true);
  } finally {
    await fs.rm(repository, { recursive: true, force: true });
  }
});
