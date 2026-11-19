import assert from 'node:assert/strict';
import test from 'node:test';

import { listRouteFiles, parseManifest, readManifest, type RouteFile } from './batch-manifest';
import {
  coverageProblems,
  formatCoverage,
  generateCoverage,
  parseCoverage,
  readCoverage,
} from './coverage';

const routes: RouteFile[] = [
  { file: '(app)/(tabs)/(0_home)/index.tsx', segments: ['(app)', '(tabs)', '(0_home)'] },
  { file: '(app)/todos/[list-id].tsx', segments: ['(app)', 'todos', '[list-id]'] },
];

const manifest = parseManifest(
  [
    'batch\ttier\tphase\tmatrix\tplatforms\tstate\tforce\tlink\tkind\tscreen',
    'T1-G02\tT1\tsigned-in\tstandard\tandroid,ios\thappy\t-\tkiloapp:///(app)/(tabs)/(0_home)\tscreen\t(app)/(tabs)/(0_home)',
    'T2-G02\tT2\tsigned-in\tbase\tandroid\tnon-retryable-error\t-\tkiloapp:///(app)/todos/missing\tnot-found\t(app)/todos/[list-id]',
  ].join('\n')
);

test('generated cells name the manifest links and keep hand-written cells', () => {
  const first = generateCoverage(routes, manifest, []);
  const todos = first.find(
    row => row.file === '(app)/todos/[list-id].tsx' && row.platform === 'ios'
  );
  assert.deepEqual(todos?.cells['non-retryable-error'], []);
  const edited = parseCoverage(
    formatCoverage(first).replace(
      /(\(app\)\/todos\/\[list-id\]\.tsx\t[^\t]+\troute\tios\t)none/,
      '$1n/a: a list query has no loading state'
    )
  );
  const second = generateCoverage(routes, manifest, edited);
  const android = second.find(
    row => row.file === '(app)/todos/[list-id].tsx' && row.platform === 'android'
  );
  const ios = second.find(
    row => row.file === '(app)/todos/[list-id].tsx' && row.platform === 'ios'
  );
  assert.deepEqual(android?.cells['non-retryable-error'], [
    'T2-G02 kiloapp:///(app)/todos/missing',
  ]);
  assert.deepEqual(ios?.cells.loading, ['n/a: a list query has no loading state']);
  assert.deepEqual(coverageProblems(routes, manifest, second), []);
});

test('a route file without a coverage row fails the check', () => {
  const committed = generateCoverage(routes, manifest, []);
  const added: RouteFile[] = [
    ...routes,
    { file: '(app)/new-screen.tsx', segments: ['(app)', 'new-screen'] },
  ];
  assert.deepEqual(coverageProblems(added, manifest, committed), [
    'route (app)/new-screen.tsx has no android coverage row',
    'route (app)/new-screen.tsx has no ios coverage row',
  ]);
  assert.deepEqual(coverageProblems(routes.slice(0, 1), manifest, committed), [
    'coverage row (app)/todos/[list-id].tsx names no route file',
    'coverage row (app)/todos/[list-id].tsx names no route file',
  ]);
});

test('a manifest change leaves the committed map stale', () => {
  const committed = generateCoverage(routes, manifest.slice(0, 1), []);
  assert.deepEqual(coverageProblems(routes, manifest, committed), [
    'generated cells are stale; run `batches coverage --write`',
  ]);
});

test('the committed coverage map has a row for every app route file', () => {
  assert.deepEqual(coverageProblems(listRouteFiles(), readManifest(), readCoverage()), []);
});
