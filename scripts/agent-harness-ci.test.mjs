import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { load } from 'js-yaml';
import jestConfig from '../apps/web/jest.config.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const web = join(root, 'apps/web');
const run = (command, args, cwd = root, env = process.env) =>
  execFileSync(command, args, { cwd, env, encoding: 'utf8' });
const read = path => readFileSync(join(root, path), 'utf8');
function fixture(t, modules = root) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'harness-ci-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  symlinkSync(join(modules, 'node_modules'), join(directory, 'node_modules'), 'dir');
  const write = (path, content) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  };
  return { directory, write };
}

test('stack-base PRs retain root and mobile checks for portable changes', () => {
  for (const path of ['.github/workflows/ci.yml', '.github/workflows/kilo-app-ci.yml']) {
    const workflow = load(read(path));
    assert.ok(Object.hasOwn(workflow.on, 'pull_request'));
    assert.equal(workflow.on.pull_request?.branches, undefined, path);
    assert.equal(workflow.on.pull_request?.['branches-ignore'], undefined, path);
    assert.deepEqual(workflow.on.push.branches, ['main']);
    if (path.endsWith('kilo-app-ci.yml')) {
      for (const event of ['push', 'pull_request']) {
        assert.ok(
          workflow.on[event].paths.some(pattern =>
            matchesGlob('packages/agent-harness/src/client.ts', pattern)
          )
        );
      }
    } else {
      const steps = Object.values(workflow.jobs).flatMap(job => job.steps ?? []);
      assert.ok(steps.some(step => step.run === 'pnpm run test:agent-harness-ci'));
      const filters = load(steps.find(step => step.id === 'filter').with.filters);
      assert.ok(
        filters.kilocode_backend.some(pattern =>
          matchesGlob('packages/agent-harness/src/client.ts', pattern)
        )
      );
    }
  }
});

test('pnpm discovers both harness workspaces and resolves the portable root', () => {
  const workspaces = JSON.parse(
    run('pnpm', [
      '--filter',
      '@kilocode/agent-harness',
      '--filter',
      '@kilocode/agent-harness-worker',
      'ls',
      '--json',
      '--depth',
      '-1',
    ])
  );
  assert.deepEqual(workspaces.map(workspace => workspace.name).sort(), [
    '@kilocode/agent-harness',
    '@kilocode/agent-harness-worker',
  ]);
  run(
    process.execPath,
    ['--input-type=module', '-e', "await import('@kilocode/agent-harness')"],
    web
  );
});

test('workspace selection uses the PR target/head, pushed range, and local fallback', t => {
  const { directory, write } = fixture(t);
  const git = (...args) =>
    run('git', args, directory, {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    }).trim();
  const commit = () => {
    git('add', '.');
    git('commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  write('.gitignore', 'node_modules\nevent.json\n');
  write('package.json', JSON.stringify({ private: true, packageManager: 'pnpm@11.1.2' }));
  write('pnpm-workspace.yaml', 'packages:\n  - services/*\n  - packages/*\n');
  for (const path of ['scripts/changed-workspaces.sh', 'scripts/changed-dependencies.mjs'])
    write(path, read(path));
  const names = ['lower', 'base-only', '@kilocode/agent-harness-worker', '@kilocode/agent-harness'];
  const dirs = [
    'services/lower',
    'services/base-only',
    'services/agent-harness',
    'packages/agent-harness',
  ];
  dirs.forEach((dir, index) => {
    write(
      `${dir}/package.json`,
      JSON.stringify({ name: names[index], scripts: { test: 'vitest run' } })
    );
    write(`${dir}/src/probe.test.ts`, 'export {};');
  });
  const lock = {
    lockfileVersion: '9.0',
    settings: {},
    importers: Object.fromEntries(['.', ...dirs].map(dir => [dir, {}])),
    packages: { 'leaf@1.0.0': {}, 'leaf@2.0.0': {} },
    snapshots: { 'leaf@1.0.0': {}, 'leaf@2.0.0': {} },
  };
  lock.importers['services/agent-harness'] = { dependencies: { leaf: { version: '1.0.0' } } };
  write('pnpm-lock.yaml', JSON.stringify(lock));
  const main = commit();
  git('update-ref', 'refs/remotes/origin/main', main);
  write('services/lower/src/probe.test.ts', 'export const lower = 1;');
  const stack = commit();
  write('packages/agent-harness/src/probe.test.ts', 'export const feature = 1;');
  lock.importers['services/agent-harness'].dependencies.leaf.version = '2.0.0';
  write('pnpm-lock.yaml', JSON.stringify(lock));
  commit();
  write('services/agent-harness/src/probe.test.ts', 'export const feature = 1;');
  const head = commit();
  git('checkout', '-q', '--detach', stack);
  write('services/base-only/src/probe.test.ts', 'export const base = 1;');
  write('pnpm-lock.yaml', JSON.stringify({ ...lock, settings: { changedOnBase: true } }));
  const base = commit();
  git('checkout', '-q', '--detach', head);
  write('services/base-only/src/probe.test.ts', 'export const base = 1;');
  write('pnpm-lock.yaml', JSON.stringify({ ...lock, settings: { changedOnBase: true } }));
  commit();
  const selected = (event, payload) => {
    write('event.json', JSON.stringify(payload));
    return JSON.parse(
      run('bash', ['scripts/changed-workspaces.sh'], directory, {
        ...process.env,
        GITHUB_EVENT_NAME: event,
        GITHUB_EVENT_PATH: join(directory, 'event.json'),
      })
    )
      .map(workspace => workspace.name)
      .sort();
  };
  const harnesses = ['@kilocode/agent-harness', '@kilocode/agent-harness-worker'];
  assert.deepEqual(
    selected('pull_request', { pull_request: { base: { sha: base }, head: { sha: head } } }),
    harnesses
  );
  git('checkout', '-q', '--detach', head);
  assert.deepEqual(selected('push', { before: stack }), harnesses);
  for (const before of ['0'.repeat(40), 'f'.repeat(40)])
    assert.deepEqual(selected('push', { before }), ['@kilocode/agent-harness-worker']);
  write('services/base-only/src/probe.test.ts', 'export const local = 1;');
  assert.deepEqual(selected('', {}), [...names].sort());
});

test('Vitest declarations preserve Worker byte responses and timingSafeEqual without DOM types', t => {
  const { directory, write } = fixture(t, join(root, 'services/agent-harness'));
  write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        lib: ['ESNext'],
        types: ['node', '@cloudflare/workers-types'],
        strict: true,
        skipLibCheck: true,
        declaration: true,
        emitDeclarationOnly: true,
        noEmitOnError: true,
        outDir: 'declarations',
      },
      files: ['probe.ts'],
    })
  );
  for (const withVitest of [false, true]) {
    write(
      'probe.ts',
      `${withVitest ? "import 'vitest/config';" : ''}
export function byteResponse(bytes: Uint8Array<ArrayBufferLike>) {
  return new Response(bytes);
}
export function safeEqual(left: ArrayBuffer, right: ArrayBuffer) {
  return crypto.subtle.timingSafeEqual(left, right);
}`
    );
    const result = spawnSync(
      process.execPath,
      [
        join(root, 'node_modules/@typescript/native-preview/bin/tsgo.js'),
        '-p',
        directory,
        '--listFiles',
      ],
      { cwd: directory, encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /[/\\]lib\.dom(?:\.iterable)?\.d\.ts/);
    if (withVitest) assert.match(result.stdout, /vitest[/\\]optional-types\.d\.ts/);
    assert.match(
      readFileSync(join(directory, 'declarations/probe.d.ts'), 'utf8'),
      /export declare function safeEqual\(left: ArrayBuffer, right: ArrayBuffer\): boolean;/
    );
  }
});

test('Jest discovers every harness TSX test without expanding unrelated discovery', t => {
  const jest = (...args) =>
    run(
      process.execPath,
      [join(web, 'node_modules/jest/bin/jest.js'), '--runInBand', ...args],
      web
    );
  const expected = globSync('src/components/quick-chat/**/*.test.tsx', { cwd: web })
    .map(path => join(web, path))
    .sort();
  const discovered = JSON.parse(
    jest('--listTests', '--json', '--testPathPatterns', 'src/components/quick-chat/')
  );
  assert.deepEqual(discovered.filter(path => path.endsWith('.test.tsx')).sort(), expected);
  const { directory, write } = fixture(t, web);
  const component = 'src/components/quick-chat/nested/probe.test.tsx';
  const server = 'src/lib/probe.test.ts';
  write(
    component,
    `/** @jest-environment jsdom */
import { render, screen } from '@testing-library/react';
test('renders TSX without a React import', () => {
  render(<button>Ready</button>);
  expect(screen.getByRole('button', { name: 'Ready' }).textContent).toBe('Ready');
});`
  );
  write(
    server,
    "test('keeps server tests in Node', () => expect(typeof window).toBe('undefined')); "
  );
  write(
    'src/components/unrelated/excluded.test.tsx',
    "throw new Error('Unrelated discovery expanded');"
  );
  const config = JSON.stringify({
    ...jestConfig,
    rootDir: directory,
    globalSetup: undefined,
    setupFilesAfterEnv: [],
  });
  assert.deepEqual(
    JSON.parse(jest('--config', config, '--listTests', '--json')).sort(),
    [component, server].map(path => join(directory, path)).sort()
  );
  jest('--config', config, '--runTestsByPath', join(directory, component), join(directory, server));
});
