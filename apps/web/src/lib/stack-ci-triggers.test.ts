import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import picomatch from 'picomatch';

// Match the pinned dorny/paths-filter action's picomatch 2.x behavior, including dotfiles.
type Step = { name?: string; id?: string; run?: string; with?: { filters?: string } };
type Workflow = {
  on: {
    push: { branches: string[] };
    pull_request: { branches: string[]; paths?: string[] };
    pull_request_target?: unknown;
  };
  jobs: Record<
    string,
    { if?: string; needs?: string[]; steps: Step[]; outputs?: Record<string, string> }
  >;
};
const workflowFiles = ['ci.yml', 'kilo-app-ci.yml'];
const stackPattern = 'mobile-provider-parity-1d93-s*';
const stackBranch = 'mobile-provider-parity-1d93-s2';
const routePattern = String.raw`apps/mobile/src/app/\(app\)/provider-review/**`;
const routes = [
  'apps/mobile/src/app/(app)/provider-review/_layout.tsx',
  'apps/mobile/src/app/(app)/provider-review/[identity]/(surface)/index.tsx',
];
const source = (file: string) =>
  readFileSync(resolve(__dirname, '../../../../.github/workflows', file), 'utf8');
const parse = (text: string) => load(text) as Workflow;
const ciSource = source('ci.yml');
const ci = parse(ciSource);
const matches = (patterns: string[], value: string) => picomatch(patterns, { dot: true })(value);

function matchesPullRequest(workflow: Workflow, branch: string, file: string) {
  const trigger = workflow.on.pull_request;
  return matches(trigger.branches, branch) && (!trigger.paths || matches(trigger.paths, file));
}

function backendPatterns(workflow: Workflow) {
  const filters = workflow.jobs.changes.steps.find(step => step.id === 'filter')?.with?.filters;
  if (typeof filters !== 'string') throw new Error('Missing paths-filter configuration');
  return (load(filters) as { kilocode_backend: string[] }).kilocode_backend;
}

function selectsGuard(workflow: Workflow, branch: string, file: string) {
  return matchesPullRequest(workflow, branch, file) && matches(backendPatterns(workflow), file);
}

function assertTargets(workflow: Workflow) {
  for (const branch of [
    'main',
    ...Array.from({ length: 21 }, (_, index) => `mobile-provider-parity-1d93-s${index + 1}`),
  ]) {
    expect(matchesPullRequest(workflow, branch, routes[0])).toBe(true);
  }
}

// Each row is a separate changed-path fixture. Server roots share the existing web pattern.
const monitoredPaths = [
  ['.github/workflows/ci.yml', '.github/workflows/ci.yml'],
  ['.github/workflows/kilo-app-ci.yml', '.github/workflows/kilo-app-ci.yml'],
  [
    'apps/mobile/src/components/pr-review/new-consumer.tsx',
    'apps/mobile/src/components/pr-review/**',
  ],
  ['apps/mobile/src/lib/pr-review/nested/new-consumer.ts', 'apps/mobile/src/lib/pr-review/**'],
  ...routes.map(path => [path, routePattern]),
  ['apps/web/src/lib/provider-review/new-consumer.ts', 'apps/web/src/**'],
  ['apps/web/src/routers/provider-review-router.ts', 'apps/web/src/**'],
  ['apps/web/src/lib/provider-review-boundary.test.ts', 'apps/web/src/**'],
  ['apps/web/src/lib/stack-ci-triggers.test.ts', 'apps/web/src/**'],
];

describe('standard stack CI guard execution', () => {
  it.each(workflowFiles)(
    '%s retains main and all stack targets without privileged triggers',
    file => {
      const workflow = parse(source(file));
      assertTargets(workflow);
      expect(workflow.on.push.branches).toEqual(['main']);
      expect(workflow.on).not.toHaveProperty('pull_request_target');
    }
  );

  it.each(monitoredPaths)('%s selects the guard and requires %s', (file, pattern) => {
    for (const branch of ['main', stackBranch]) {
      expect(selectsGuard(ci, branch, file)).toBe(true);
      const removed = ciSource.replace(`- '${pattern}'`, '');
      expect(removed).not.toBe(ciSource);
      expect(selectsGuard(parse(removed), branch, file)).toBe(false);
    }
  });

  it.each(workflowFiles)('a workflow-only removal of the %s stack target fails the guard', file => {
    expect(selectsGuard(ci, stackBranch, `.github/workflows/${file}`)).toBe(true);
    const removed = parse(source(file).replace(stackPattern, 'main'));
    expect(() => assertTargets(removed)).toThrow();
  });

  it('preserves literal Expo parentheses through both YAML parses', () => {
    expect(
      selectsGuard(ci, stackBranch, 'apps/mobile/src/app/app/provider-review/_layout.tsx')
    ).toBe(false);
    const unescaped = parse(
      ciSource.replace(routePattern, 'apps/mobile/src/app/(app)/provider-review/**')
    );
    for (const file of routes) expect(selectsGuard(unescaped, stackBranch, file)).toBe(false);
  });

  it('keeps the existing prerequisites and root test command on the backend filter', () => {
    expect(ci.jobs.changes.outputs?.kilocode_backend).toBe(
      '${{ steps.filter.outputs.kilocode_backend }}'
    );
    expect(ci.jobs.test.if).toBe("needs.changes.outputs.kilocode_backend == 'true'");
    expect(ci.jobs.test.needs).toEqual([
      'changes',
      'typecheck',
      'lint',
      'format-check',
      'drizzle-check',
    ]);
    for (const prerequisite of ['typecheck', 'lint', 'format-check', 'drizzle-check']) {
      expect(ci.jobs[prerequisite]).toBeDefined();
      expect(ci.jobs[prerequisite].if).toBeUndefined();
    }
    expect(ci.jobs.test.steps.find(step => step.name === 'Run tests')).toEqual({
      name: 'Run tests',
      run: 'pnpm run test',
    });
  });
});
