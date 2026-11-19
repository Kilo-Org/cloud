import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyDump,
  expectationMismatch,
  MANIFEST_COLUMNS,
  parseManifest,
  readManifest,
  linkTarget,
  parseShard,
  resolveTemplates,
  shardBatches,
  TemplateError,
  type RouteFile,
  type SeedMap,
} from './batch-manifest';
import { SEED_STEPS, seedAll, stepsFor, templateProblems } from './seed-all';

const route = (file: string): RouteFile => ({
  file,
  segments: file
    .replace(/\.tsx$/, '')
    .split('/')
    .filter(part => part !== 'index'),
});

test('a link resolves through an omitted group and a catch-all, preferring the most specific', () => {
  const routes = [
    route('(app)/code-reviewer/[scope]/[platform]/(edit)/style.tsx'),
    route('(app)/code-reviewer/[scope]/[platform]/index.tsx'),
    route('(app)/pr-review/[platform]/[...identity]/index.tsx'),
    route('(app)/pr-review/[platform]/[...identity]/merge.tsx'),
    route('(app)/pr-review/[owner]/[repo]/[number]/index.tsx'),
    route('(app)/(tabs)/(3_profile)/triggers/[trigger-id].tsx'),
  ];
  const file = (link: string) => linkTarget(routes, link).route?.file;
  assert.equal(
    file('kiloapp:///(app)/code-reviewer/personal/github/style'),
    '(app)/code-reviewer/[scope]/[platform]/(edit)/style.tsx'
  );
  assert.equal(
    file('kiloapp:///(app)/pr-review/gitlab/acme/sample/7'),
    '(app)/pr-review/[platform]/[...identity]/index.tsx'
  );
  assert.equal(
    file('kiloapp:///(app)/pr-review/gitlab/group/sub/repo/12/merge'),
    '(app)/pr-review/[platform]/[...identity]/merge.tsx'
  );
  assert.equal(
    file('kiloapp:///(app)/pr-review/acme/sample/7'),
    '(app)/pr-review/[owner]/[repo]/[number]/index.tsx'
  );
  assert.equal(
    file('kiloapp:///(app)/triggers/missing'),
    '(app)/(tabs)/(3_profile)/triggers/[trigger-id].tsx'
  );
  assert.equal(file('kiloapp:///(app)/pr-review'), undefined);
});

const ids = ['T2-G09a', 'T1-G02', 'Gauth', 'T1-G11a', 'T2-G12', 'T1-G13a', 'T2-auth03'];

test('shards partition the batches and ignore manifest order', () => {
  const batches = ids.map(id => ({ id }));
  const shards = [1, 2, 3].map(index => shardBatches(batches, { index, count: 3 }).map(b => b.id));
  assert.deepEqual(shards.flat().sort(), [...ids].sort());
  assert.equal(new Set(shards.flat()).size, ids.length);
  const reversed = [1, 2, 3].map(index =>
    shardBatches([...batches].reverse(), { index, count: 3 }).map(b => b.id)
  );
  assert.deepEqual(reversed, shards);
  assert.deepEqual(shards[0], ['Gauth', 'T1-G13a', 'T2-auth03']);
});

test('a shard flag outside 1..n is rejected', () => {
  assert.deepEqual(parseShard('2/4'), { index: 2, count: 4 });
  for (const bad of ['0/2', '3/2', '1/0', '1', 'a/b']) assert.throws(() => parseShard(bad));
});

const seeds: SeedMap = {
  email: 'kilo-e2e-a1@example.com',
  createdAt: '2026-11-19T00:00:00.000Z',
  steps: {
    'security-findings': {
      topic: 'app:security-agent-findings',
      ok: true,
      values: { openFindingId: '7e6d9528-5c6e-4c46-af6a-1b8ca8bc93d5', dismissedFindingId: null },
    },
    'review-list': { topic: 'code-reviews:review-list', ok: false, values: {}, error: 'exit 1' },
  },
};

test('seed templates resolve to the seeded ids', () => {
  assert.equal(
    resolveTemplates(
      'kiloapp:///(app)/security-agent/personal/findings/{{seed:security-findings.openFindingId}}',
      seeds
    ),
    'kiloapp:///(app)/security-agent/personal/findings/7e6d9528-5c6e-4c46-af6a-1b8ca8bc93d5'
  );
  assert.equal(
    resolveTemplates('kiloapp:///(app)/(tabs)/(0_home)', undefined),
    'kiloapp:///(app)/(tabs)/(0_home)'
  );
});

test('a missing id fails with every unresolved reference named', () => {
  const link =
    'kiloapp:///x/{{seed:security-findings.dismissedFindingId}}/{{seed:review-list.newestReviewId}}/{{seed:org-pair.ownerOrganizationId}}/{{seed:security-findings.nope}}';
  assert.throws(
    () => resolveTemplates(link, seeds),
    (error: unknown) =>
      error instanceof TemplateError &&
      error.message.includes('security-findings printed no dismissedFindingId') &&
      error.message.includes('seed step review-list failed') &&
      error.message.includes('seed step org-pair did not run') &&
      error.message.includes('printed no nope')
  );
  assert.throws(
    () => resolveTemplates('kiloapp:///x/{{seed:org-pair.ownerOrganizationId}}', undefined),
    /no --seeds map/
  );
  assert.throws(() => resolveTemplates('kiloapp:///x/{{org-pair}}', seeds), /not a \{\{seed/);
});

test('seed steps follow link templates, provided screens and their needs', () => {
  const [analytics] = parseManifest(
    [
      MANIFEST_COLUMNS.join('\t'),
      'T1-G13a\tT1\tsigned-in\tstandard\tandroid\thappy\t-\tkiloapp:///(app)/code-reviewer/personal/analytics\tscreen\t(app)/code-reviewer/[scope]/analytics',
    ].join('\n')
  );
  assert.ok(analytics);
  assert.deepEqual(stepsFor([analytics]), ['org-pair', 'reviewer-analytics']);
  assert.deepEqual(
    stepsFor(readManifest()),
    SEED_STEPS.map(entry => entry.step)
  );
});

test('a template key its seed step does not declare fails statically', () => {
  assert.deepEqual(templateProblems(readManifest()), []);
  const rows = parseManifest(
    [
      MANIFEST_COLUMNS.join('\t'),
      'T1-G07c\tT1\tsigned-in\tstandard\tandroid\tlong-content\t-\tkiloapp:///(app)/profile-management/{{seed:profile-caps.mcpAtCapProfileId}}/mcp\tscreen\t(app)/profile-management/[profileId]/mcp',
      'T1-G07c\tT1\tsigned-in\tstandard\tandroid\thappy\t-\tkiloapp:///x/{{seed:nope.id}}\tclean\t-',
    ].join('\n')
  );
  assert.deepEqual(templateProblems(rows), [
    'line 2: {{seed:profile-caps.mcpAtCapProfileId}}: profile-caps declares no mcpAtCapProfileId',
    'line 3: {{seed:nope.id}} names no seed step',
  ]);
});

test('a failed seed step keeps its error line, and a missing declared key fails the step', () => {
  const map = seedAll({
    email: 'kilo-e2e@example.com',
    steps: ['security-findings', 'security-org-scopes'],
    run: topic =>
      topic === 'app:security-agent-findings'
        ? {
            status: 1,
            stdout: '',
            stderr: [
              'Seed runner failed: Error: Failed query: insert into "security_findings"',
              '    at PgPreparedQuery.queryWithCache (node_modules/drizzle-orm/pg-core/session.js:41:15)',
              '  {',
              "    query: 'insert into …',",
              '  }',
              '}',
            ].join('\n'),
          }
        : { status: 0, stdout: '{"userId":"u"}\n', stderr: '' },
    log: () => undefined,
  });
  assert.equal(
    map.steps['security-findings']?.error,
    'exit 1: Seed runner failed: Error: Failed query: insert into "security_findings"'
  );
  assert.equal(map.steps['security-org-scopes']?.error, 'printed no organizationId');
});

test('a titled not-found screen meets a not-found row', () => {
  // T2-G04 on iOS: /(3_profile)/triggers/not-a-seeded-trigger settles on the
  // trigger screen's own not-found state, titled with what was not found.
  const state = classifyDump([
    { text: 'Profile' },
    { label: 'Profile, tab, 4 of 4' },
    { text: 'Triggers & webhooks' },
    { text: 'not-a-seeded-trigger' },
    { text: 'Trigger not found' },
  ]);
  assert.equal(state.notFound, true);
  assert.equal(
    expectationMismatch(
      { kind: 'not-found', screen: '(app)/(tabs)/(3_profile)/triggers/[trigger-id]' },
      '(app)/(tabs)/(3_profile)/triggers/[trigger-id]',
      state
    ),
    undefined
  );
  // Text that only mentions the phrase mid-sentence is not the state.
  assert.equal(classifyDump([{ text: 'Not found items are listed below' }]).notFound, false);
});
