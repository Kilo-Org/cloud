import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import test from 'node:test';
import { load } from 'js-yaml';

const workflows = ['ci', 'kilo-app-ci'].map(name =>
  load(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'))
);
const matches = (value, patterns) => patterns.some(pattern => matchesGlob(value, pattern));

function assertStackCoverage([root, mobile]) {
  for (const workflow of [root, mobile]) {
    assert.deepEqual(workflow.on.push.branches, ['main'], 'pushes must remain main-only');
    const branches = workflow.on.pull_request.branches;
    for (const base of [
      'main',
      ...Array.from({ length: 17 }, (_, i) => `mobile-pr-review-context-5458-s${i + 1}`),
    ]) {
      assert.ok(matches(base, branches), `missing PR base: ${base}`);
    }
    for (const base of [
      'feature/unrelated',
      'mainly',
      'mobile-pr-review-context-5459-s1',
      'mobile-pr-review-context-5458',
    ]) {
      assert.ok(!matches(base, branches), `unrelated PR base: ${base}`);
    }
  }
  assert.ok(Object.hasOwn(mobile.on, 'workflow_call'), 'mobile workflow_call must remain');
  for (const event of ['push', 'pull_request']) {
    assert.ok(
      matches('apps/web/src/lib/github-pr-review/context-dtos.ts', mobile.on[event].paths),
      `missing mobile helper coverage: ${event}`
    );
    for (const path of [
      'apps/web/src/lib/unrelated.ts',
      'dev/local/scripts/pr-review-provider-mock.ts',
      'apps/extension/src/index.ts',
    ]) {
      assert.ok(!matches(path, mobile.on[event].paths), `unrelated mobile path: ${event}: ${path}`);
    }
  }
  assert.equal(root.jobs.changes.if, undefined, 'changes job must be unconditional');
  const steps = root.jobs.changes.steps;
  const dependencyTest = steps.findIndex(
    step => step.run === 'node --test scripts/changed-dependencies.test.mjs'
  );
  assert.ok(dependencyTest >= 0, 'missing dependency test');
  const configTest = steps[dependencyTest + 1];
  assert.equal(
    configTest?.run,
    'node --test scripts/stack-ci-config.test.mjs',
    'missing adjacent configuration test'
  );
  assert.equal(configTest.if, undefined, 'configuration test must be unconditional');
  const filter = steps.find(step => step.id === 'filter');
  const filters = load(filter.with.filters);
  for (const name of ['mock', 'control', 'scenarios']) {
    for (const suffix of ['ts', 'test.ts']) {
      assert.ok(
        matches(
          `dev/local/scripts/pr-review-provider-${name}.${suffix}`,
          filters.pr_review_fixtures ?? []
        ),
        'missing dev-fixture filter'
      );
    }
  }
  for (const path of [
    'dev/local/scripts/unrelated.test.ts',
    'apps/web/src/lib/github-pr-review/context-dtos.ts',
  ]) {
    assert.ok(!matches(path, filters.pr_review_fixtures), `unrelated dev-fixture path: ${path}`);
  }
  const fixtureTest = steps.find(
    step => step.run === 'pnpm exec tsx --test dev/local/scripts/pr-review-provider-*.test.ts'
  );
  assert.equal(
    fixtureTest?.if,
    "steps.filter.outputs.pr_review_fixtures == 'true'",
    'missing focused dev-fixture test'
  );
  assert.ok(
    steps.indexOf(fixtureTest) > steps.indexOf(filter),
    'dev-fixture test must follow filtering'
  );
}

test('main and every stacked PR run the required configuration and source suites', () => {
  assertStackCoverage(workflows);
});

for (const [index, name] of ['root', 'mobile'].entries()) {
  test(`rejects a missing ${name} stack pattern`, () => {
    const fixture = structuredClone(workflows);
    fixture[index].on.pull_request.branches = ['main'];
    assert.throws(() => assertStackCoverage(fixture), /missing PR base/);
  });
  test(`rejects non-main ${name} pushes and unrelated PR bases`, () => {
    const fixture = structuredClone(workflows);
    fixture[index].on.push.branches.push('feature');
    assert.throws(() => assertStackCoverage(fixture), /main-only/);
    fixture[index].on.push.branches = ['main'];
    fixture[index].on.pull_request.branches.push('**');
    assert.throws(() => assertStackCoverage(fixture), /unrelated PR base/);
  });
}

for (const event of ['push', 'pull_request']) {
  test(`rejects missing mobile helper coverage on ${event}`, () => {
    const fixture = structuredClone(workflows);
    fixture[1].on[event].paths = fixture[1].on[event].paths.filter(
      path => !path.includes('github-pr-review')
    );
    assert.throws(() => assertStackCoverage(fixture), /missing mobile helper coverage/);
  });
  for (const path of ['apps/web/src/lib/**', 'dev/**', 'apps/extension/**']) {
    test(`rejects broad mobile filter ${path} on ${event}`, () => {
      const fixture = structuredClone(workflows);
      fixture[1].on[event].paths.push(path);
      assert.throws(() => assertStackCoverage(fixture), /unrelated mobile path/);
    });
  }
}

for (const path of ['dev/**', 'apps/web/src/**']) {
  test(`rejects broad dev-fixture filter ${path}`, () => {
    const fixture = structuredClone(workflows);
    const filter = fixture[0].jobs.changes.steps.find(step => step.id === 'filter');
    filter.with.filters = `pr_review_fixtures: ["dev/local/scripts/pr-review-provider-*.ts", "${path}"]`;
    assert.throws(() => assertStackCoverage(fixture), /unrelated dev-fixture path/);
  });
}

test('rejects removed mobile calls, gated configuration tests, and skipped fixture tests', () => {
  const fixture = structuredClone(workflows);
  delete fixture[1].on.workflow_call;
  assert.throws(() => assertStackCoverage(fixture), /workflow_call/);
  fixture[1].on.workflow_call = null;
  fixture[0].jobs.changes.if = 'false';
  assert.throws(() => assertStackCoverage(fixture), /changes job must be unconditional/);
  delete fixture[0].jobs.changes.if;
  const steps = fixture[0].jobs.changes.steps;
  const configTest = steps.find(
    step => step.run === 'node --test scripts/stack-ci-config.test.mjs'
  );
  configTest.if = 'false';
  assert.throws(() => assertStackCoverage(fixture), /unconditional/);
  delete configTest.if;
  const configIndex = steps.indexOf(configTest);
  steps.splice(configIndex, 1);
  assert.throws(() => assertStackCoverage(fixture), /missing adjacent configuration test/);
  steps.splice(configIndex, 0, configTest);
  const filter = steps.find(step => step.id === 'filter');
  const filters = filter.with.filters;
  filter.with.filters = 'pr_review_fixtures: []';
  assert.throws(() => assertStackCoverage(fixture), /missing dev-fixture filter/);
  filter.with.filters = filters;
  const fixtureTest = steps.find(step => step.run?.includes('pr-review-provider-*.test.ts'));
  fixtureTest.if = 'false';
  assert.throws(() => assertStackCoverage(fixture), /missing focused dev-fixture test/);
});
