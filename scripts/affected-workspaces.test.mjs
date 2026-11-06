import assert from 'node:assert/strict';
import test from 'node:test';

import { isModuleSpecifier, isNeutral, selectAffected } from './affected-workspaces.mjs';

const workspace = (name, dir, dependencies = {}) => ({ name, dir, manifest: { dependencies } });
const items = [
  workspace('@kilocode/db', 'packages/db'),
  workspace('@kilocode/trpc', 'packages/trpc', { '@kilocode/db': 'workspace:*' }),
  workspace('web', 'apps/web', { '@kilocode/db': 'workspace:*' }),
  workspace('kilo-app', 'apps/mobile', { '@kilocode/trpc': 'workspace:*' }),
  workspace('agent', 'services/agent'),
  workspace('agent-wrapper', 'services/agent/wrapper'),
  workspace('leaf', 'services/leaf'),
];
const references = [
  ['packages/trpc/src/index.ts', 'apps/web/src/routers/root-router'],
  ['apps/web/src/lib/preview.ts', 'services/agent/src/shared/preview'],
  ['services/leaf/vitest.config.ts', 'tools/shared'],
];
const select = (changedFiles, dependencyDirs = []) =>
  selectAffected({ items, changedFiles, dependencyDirs, references });
const noTests = { test_only_dirs: [], test_only_packages: [], test_only_files: [] };

test('a leaf change selects only the leaf', () => {
  assert.deepEqual(select(['services/leaf/src/index.ts']), {
    full: false,
    reasons: [],
    full_checks: [],
    dirs: ['services/leaf'],
    packages: ['leaf'],
    ...noTests,
  });
});

test('a web .env change selects ai-gateway, which builds with those files', () => {
  const result = selectAffected({
    items: [...items, workspace('ai-gateway', 'apps/ai-gateway')],
    changedFiles: ['apps/web/.env.test'],
    dependencyDirs: [],
    references: [],
  });
  assert.ok(result.packages.includes('ai-gateway'));
});

test('a change reaches workspace dependents and relative-import readers', () => {
  assert.deepEqual(select(['packages/db/src/schema.ts']).packages, [
    '@kilocode/db',
    '@kilocode/trpc',
    'kilo-app',
    'web',
  ]);
  assert.deepEqual(select(['services/agent/src/shared/preview.ts']).packages, [
    '@kilocode/trpc',
    'agent',
    'kilo-app',
    'web',
  ]);
});

test('a nested workspace change selects the workspace around it', () => {
  assert.deepEqual(select(['services/agent/wrapper/src/main.ts']).packages.slice(0, 2), [
    '@kilocode/trpc',
    'agent',
  ]);
});

test('documentation and unchecked root paths select nothing', () => {
  for (const file of [
    'README.md',
    'services/leaf/README.md',
    'docs/a.ts',
    '.github/workflows/deploy.yml',
    'dev/a.ts',
  ]) {
    assert.deepEqual(select([file]).dirs, [], file);
  }
});

test('a root path read by a workspace selects its reader', () => {
  assert.deepEqual(select(['tools/shared/setup.ts']).packages, ['leaf']);
  assert.deepEqual(select(['scripts/web-env/plan.ts']).packages, [
    '@kilocode/trpc',
    'kilo-app',
    'web',
  ]);
});

test('an unattributable or global change selects everything', () => {
  for (const file of [
    'package.json',
    'tsconfig.base.json',
    'unknown/file.ts',
    '.github/workflows/ci.yml',
    'scripts/affected-workspaces.mjs',
    '.github/actions/trpc-declarations/action.yml',
    '.github/actions/harness-sdk-build/action.yml',
    'scripts/trpc-declaration-key.mjs',
    'scripts/harness-sdk-build-key.mjs',
    'scripts/build-key-inputs.mjs',
    'patches/a.patch',
  ]) {
    const result = select([file]);
    assert.equal(result.full, true, file);
    assert.equal(result.dirs.length, items.length, file);
    assert.deepEqual(result.full_checks, ['lint', 'typecheck'], file);
  }
  assert.equal(select(['<no base revision>']).full, true);
});

test('a check script change runs only that check everywhere', () => {
  assert.deepEqual(select(['scripts/lint-all.sh']), {
    full: false,
    reasons: [],
    full_checks: ['lint'],
    dirs: [],
    packages: [],
    ...noTests,
  });
  const both = select(['scripts/typecheck-all.sh', 'services/leaf/src/a.ts']);
  assert.deepEqual(both.full_checks, ['typecheck']);
  assert.deepEqual(both.packages, ['leaf']);
});

test('dependency manifest changes select the workspaces whose dependencies changed', () => {
  for (const manifest of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    assert.deepEqual(select([manifest], ['services/leaf']), {
      full: false,
      reasons: [],
      full_checks: [],
      dirs: ['services/leaf'],
      packages: ['leaf'],
      ...noTests,
    });
    assert.deepEqual(select([manifest], []).dirs, [], manifest);
    assert.equal(select([manifest], ['*']).full, true, manifest);
    assert.equal(select([manifest], ['.']).full, true, manifest);
  }
  // Either manifest reaches the readers of the workspace it names.
  assert.deepEqual(select(['pnpm-workspace.yaml'], ['packages/trpc']).packages, [
    '@kilocode/trpc',
    'kilo-app',
  ]);
  assert.deepEqual(select(['pnpm-lock.yaml', 'pnpm-workspace.yaml'], ['packages/db']).packages, [
    '@kilocode/db',
    '@kilocode/trpc',
    'kilo-app',
    'web',
  ]);
});

test('documents and neutral root locations are the shared neutral set', () => {
  for (const file of [
    'README.md',
    'packages/db/README.md',
    'packages/db/AGENTS.md',
    'docs/a.ts',
    'dev/a.ts',
    '.github/workflows/deploy.yml',
    'scripts/affected-workspaces.mjs',
  ]) {
    assert.equal(isNeutral(file), true, file);
  }
  for (const file of [
    'packages/db/src/schema.ts',
    'apps/mobile/src/app/index.tsx',
    'pnpm-workspace.yaml',
    'package.json',
  ]) {
    assert.equal(isNeutral(file), false, file);
  }
});

test('the neutral filter keeps every path a check reads', () => {
  // The paths the test matrix still sees after the detector drops the neutral
  // ones.
  const input = [
    'README.md',
    'packages/db/README.md',
    'packages/db/src/schema.ts',
    'apps/web/.env.test',
    'services/leaf/src/index.ts',
  ];
  assert.deepEqual(
    input.filter(file => !isNeutral(file)),
    ['packages/db/src/schema.ts', 'apps/web/.env.test', 'services/leaf/src/index.ts']
  );
});

// leaf-reader depends on leaf, so a full edge into leaf reaches it too.
const dataItems = [
  ...items,
  workspace('leaf-reader', 'services/leaf-reader', { leaf: 'workspace:*' }),
];
const selectData = (changedFiles, references) =>
  selectAffected({ items: dataItems, changedFiles, dependencyDirs: [], references });

test('a test that reads another workspace as data runs only its tests', () => {
  const references = [
    ['services/leaf/src/slash-commands.test.ts', 'apps/mobile/src/i18n/en.json', true],
  ];
  assert.deepEqual(selectData(['apps/mobile/src/app/index.tsx'], references), {
    full: false,
    reasons: [],
    full_checks: [],
    dirs: ['apps/mobile'],
    packages: ['kilo-app'],
    test_only_dirs: ['services/leaf'],
    test_only_packages: ['leaf'],
    test_only_files: ['services/leaf/src/slash-commands.test.ts'],
  });
  for (const file of ['services/leaf/src/__tests__/copy.ts', 'services/leaf/src/copy.spec.tsx']) {
    const result = selectData(['apps/mobile/README.md'], [[file, 'apps/mobile/README.md', true]]);
    assert.deepEqual(result.dirs, [], file);
    assert.deepEqual(result.test_only_files, [file]);
  }
});

test('a test data read selects tests only when the read workspace has a changed file', () => {
  const references = [['services/leaf/src/a.test.ts', 'apps/web/src/sandbox.ts', true]];
  const viaDependency = selectData(['packages/db/src/schema.ts'], references);
  assert.ok(viaDependency.packages.includes('web'));
  assert.deepEqual(viaDependency.test_only_dirs, []);
  const nested = selectData(
    ['services/agent/wrapper/src/main.ts'],
    [['services/leaf/src/a.test.ts', 'services/agent', true]]
  );
  assert.deepEqual(nested.test_only_dirs, ['services/leaf']);
});

test('a test that reads a root path as data runs only its tests', () => {
  const result = selectData(
    ['tools/fixtures/a.json'],
    [['services/leaf/src/a.test.ts', 'tools/fixtures', true]]
  );
  assert.equal(result.full, false);
  assert.deepEqual(result.dirs, []);
  assert.deepEqual(result.test_only_dirs, ['services/leaf']);
});

test('a module import or a non-test path read stays a full edge', () => {
  for (const reference of [
    ['services/leaf/src/a.test.ts', 'apps/mobile/src/lib/sentinel', false],
    ['services/leaf/vitest.config.ts', 'apps/mobile/src', true],
    ['services/leaf/src/copy.ts', 'apps/mobile/src/i18n/en.json', true],
  ]) {
    const result = selectData(['apps/mobile/src/app/index.tsx'], [reference]);
    assert.deepEqual(result.packages, ['kilo-app', 'leaf', 'leaf-reader'], reference[0]);
    assert.deepEqual(result.test_only_dirs, [], reference[0]);
  }
});

test('module specifiers are told apart from paths read as data', () => {
  const at = (text, literal = "'../x'") => isModuleSpecifier(text, text.indexOf(literal));
  for (const text of [
    "import { a } from '../x';",
    "export * from '../x';",
    "import '../x';",
    "import /* comment */ '../x';",
    "import /* first */ /* second */ '../x';",
    "import /* multi\nline */ '../x';",
    "import // comment\n '../x';",
    "import /* block */ // line\n /* block */ '../x';",
    "import { a } from /* comment */ '../x';",
    "export * from // comment\n '../x';",
    "const url = 'https://example.test'; import /* comment */ '../x';",
    "const a = import /* callee */ (/* argument */ '../x');",
    "vi.mock /* callee */ (// argument\n '../x');",
    "const a = vi.importActual /* callee */ <typeof A> /* type */ (/* argument */ '../x');",
    "const a = await import('../x');",
    "type A = typeof import('../x');",
    "const a = require('../x');",
    "vi.mock('../x', () => ({}));",
    "jest.doMock(\n  '../x'\n);",
    "const a = await vi.importActual<typeof A>('../x');",
    "const a = jest.requireActual<{\n  run(): Promise<void>;\n  map: () => Map<string, number>;\n}>('../x');",
  ]) {
    assert.equal(at(text), true, text);
  }
  for (const text of [
    "const a = new URL('../x', import.meta.url);",
    "const a = fileURLToPath(\n  new URL('../x', import.meta.url)\n);",
    "const a = join(__dirname, '../x');",
    "readFileSync('../x');",
    "it.each(['../x'])('reads %s', () => {});",
    "const a = '../x';",
    "readFileSync(/* comment */ '../x');",
    "const a = /* import */ '../x';",
    "const a = // import\n '../x';",
  ]) {
    assert.equal(at(text), false, text);
  }
});

test('commented imports keep the reader and its dependents fully affected', () => {
  for (const text of [
    "import /* comment */ '../x';",
    "import // comment\n '../x';",
    "vi.mock /* callee */ (/* argument */ '../x');",
  ]) {
    const result = selectData(
      ['apps/mobile/src/app/index.tsx'],
      [
        [
          'services/leaf/src/a.test.ts',
          'apps/mobile/src/lib/sentinel',
          !isModuleSpecifier(text, text.indexOf("'../x'")),
        ],
      ]
    );
    assert.deepEqual(result.packages, ['kilo-app', 'leaf', 'leaf-reader'], text);
    assert.deepEqual(result.test_only_dirs, [], text);
  }
});
