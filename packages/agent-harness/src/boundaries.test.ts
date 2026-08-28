import { globSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cruise, type IForbiddenRuleType } from 'dependency-cruiser';
import extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config';
import ts from 'typescript';
import { afterEach, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const core = '^packages/agent-harness/src/(?!react\\.ts$)';
const browser = '^apps/web/src/(lib/agent-harness/(browser-|transport\\.)|components/quick-chat/)';
const native = '^apps/mobile/src/lib/agent-harness/';
const rules: IForbiddenRuleType[] = [
  {
    name: 'portable-core',
    severity: 'error',
    from: { path: core },
    to: {
      reachable: true,
      pathNot: `${core}|^packages/mcp-gateway/src/|(^|/)node_modules/zod/`,
    },
  },
  {
    name: 'no-client-executors-or-credentials',
    severity: 'error',
    from: { path: `${browser}|${native}|^packages/agent-harness/src/react\\.ts$` },
    to: {
      reachable: true,
      path: '^services/|^packages/(db|encryption|worker-utils|cloud-agent-profile)/|^apps/web/src/(routers/|app/api/|lib/(tokens|drizzle|agent-harness/(?!browser-|transport\\.)))|(^|/)(server-only|@ai-sdk|@modelcontextprotocol|ai)(/|$)',
    },
  },
];

async function violations(baseDir: string, files: string[], project?: string) {
  // The resolver follows symlinks before calculating paths relative to this directory.
  const directory = realpathSync(baseDir);
  const tsConfigFile = project ? join(directory, project, 'tsconfig.json') : undefined;
  const tsConfig = tsConfigFile ? extractTSConfig(tsConfigFile) : undefined;
  // Otherwise dependency-cruiser resolves aliases from process.cwd(), not the project.
  if (tsConfig && project) tsConfig.options.baseUrl ??= join(directory, project);
  const { output } = await cruise(
    files,
    {
      baseDir: directory,
      validate: true,
      ruleSet: { forbidden: rules },
      doNotFollow: { path: 'node_modules' },
      enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'default'] },
      exclude: '\\.test\\.[jt]sx?$',
      tsConfig: tsConfigFile ? { fileName: tsConfigFile } : undefined,
    },
    undefined,
    { tsConfig }
  );
  if (typeof output === 'string') throw new Error('Expected a dependency graph');
  return output.summary.violations;
}

function portabilityErrors(files: string[]) {
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts'],
    types: [],
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n'));
}

const fixtures: string[] = [];
afterEach(() => fixtures.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function fixture(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), 'harness-boundary-'));
  fixtures.push(directory);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
  return directory;
}

it('keeps the portable package and present host entrypoints within their boundaries', async () => {
  const surfaces = [
    ['packages/agent-harness', ['packages/agent-harness/src/**/*.ts']],
    [
      'apps/web',
      [
        'apps/web/src/lib/agent-harness/browser-*.ts',
        'apps/web/src/lib/agent-harness/transport.ts',
        'apps/web/src/components/quick-chat/**/*.tsx',
      ],
    ],
    ['apps/mobile', ['apps/mobile/src/lib/agent-harness/**/*.ts']],
  ] as const;
  for (const [project, patterns] of surfaces) {
    const files = globSync([...patterns], { cwd: root }).filter(
      file => !/\.test\.[jt]sx?$/.test(file)
    );
    if (files.length) expect(await violations(root, files, project)).toEqual([]);
    if (project === 'packages/agent-harness') {
      expect(
        portabilityErrors(
          files.filter(file => !file.endsWith('/react.ts')).map(file => join(root, file))
        )
      ).toEqual([]);
    }
  }
});

const entry = 'packages/agent-harness/src/entry.ts';
const relay = 'packages/mcp-gateway/src/relay.ts';
const relayImport = "export * from '../../mcp-gateway/src/relay';";
it('allows a transitive portable helper but rejects its Node builtin import', async () => {
  const directory = fixture({
    [entry]: relayImport,
    [relay]: 'export const value = Math.max(1, 2);',
  });
  expect(await violations(directory, [entry])).toEqual([]);
  expect(portabilityErrors([join(directory, entry)])).toEqual([]);
  writeFileSync(join(directory, relay), "import 'node:fs';");
  expect(await violations(directory, [entry])).toContainEqual(
    expect.objectContaining({
      from: entry,
      to: 'fs',
      rule: { name: 'portable-core', severity: 'error' },
    })
  );
});
it.each([
  'services/agent-harness/src/dispatch.ts',
  'apps/web/src/lib/tokens.ts',
  'node_modules/react-native/index.js',
  'node_modules/react/index.js',
  'node_modules/idb/index.js',
])('rejects a transitive core import of %s', async target => {
  const directory = fixture({
    [entry]: relayImport,
    [relay]: `export * from '${relative(dirname(relay), target)}';`,
    [target]: 'export const value = 1;',
  });
  expect(await violations(directory, [entry])).toContainEqual(
    expect.objectContaining({ from: entry, to: target })
  );
});

it.each(['window', 'document', 'navigator', 'localStorage', 'indexedDB'])(
  'rejects the browser global %s through a helper',
  name => {
    const directory = fixture({
      [entry]: relayImport,
      [relay]: `export const value = ${name};`,
    });
    expect(portabilityErrors([join(directory, entry)]).join('\n')).toContain(
      `Cannot find name '${name}'`
    );
  }
);

it.each([
  'apps/web/src/lib/agent-harness/browser-bridge.ts',
  'apps/mobile/src/lib/agent-harness/native-bridge.ts',
])('rejects transitive credentials from the host %s', async host => {
  const target = 'apps/web/src/lib/tokens.ts';
  const project = host.startsWith('apps/web/') ? 'apps/web' : 'apps/mobile';
  const helper = `${project}/src/relay.ts`;
  const directory = fixture({
    [`${project}/tsconfig.json`]: JSON.stringify({
      compilerOptions: { paths: { '@/*': ['./src/*'] } },
    }),
    [host]: "export * from '@/relay';",
    [helper]: `export * from '${relative(dirname(helper), relay)}';`,
    [relay]: `export * from '${relative(dirname(relay), target)}';`,
    [target]: 'export const credential = "fixture";',
  });
  expect(await violations(directory, [host], project)).toContainEqual(
    expect.objectContaining({ from: host, to: target })
  );
});
