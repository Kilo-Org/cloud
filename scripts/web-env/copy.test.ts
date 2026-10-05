import assert from 'node:assert/strict';
import test from 'node:test';
import { planEnvironment } from './copy.js';
import type { EnvRecord } from './shared.js';

function record(overrides: Partial<EnvRecord> & Pick<EnvRecord, 'key'>): EnvRecord {
  return {
    id: `id-${overrides.key}`,
    type: 'encrypted',
    target: ['production'],
    customEnvironmentIds: [],
    ...overrides,
  };
}

void test('planEnvironment selects production records by target and keeps their sensitivity', () => {
  const plan = planEnvironment(
    [
      record({ key: 'SECRET_TOKEN', type: 'sensitive' }),
      record({ key: 'PUBLIC_URL', type: 'plain', value: 'https://example.com' }),
      record({ key: 'API_HOST' }),
      record({ key: 'apiUrl' }),
      record({ key: 'DEV_ONLY', target: ['development'] }),
    ],
    'production',
    'staging-id',
    new Set()
  );

  assert.deepEqual(plan.variables, [
    { name: 'API_HOST', sensitive: false, recordId: 'id-API_HOST', plainValue: undefined },
    {
      name: 'PUBLIC_URL',
      sensitive: false,
      recordId: 'id-PUBLIC_URL',
      plainValue: 'https://example.com',
    },
    { name: 'SECRET_TOKEN', sensitive: true, recordId: 'id-SECRET_TOKEN', plainValue: undefined },
    { name: 'apiUrl', sensitive: false, recordId: 'id-apiUrl', plainValue: undefined },
  ]);
  assert.deepEqual(plan.skipped, []);
});

void test('planEnvironment matches staging through its custom environment ID', () => {
  const plan = planEnvironment(
    [
      record({ key: 'STAGING_TOKEN', target: [], customEnvironmentIds: ['staging-id'] }),
      record({ key: 'PRODUCTION_TOKEN' }),
      record({ key: 'OTHER_CUSTOM', target: [], customEnvironmentIds: ['other-id'] }),
    ],
    'staging',
    'staging-id',
    new Set()
  );

  assert.deepEqual(
    plan.variables.map(variable => variable.name),
    ['STAGING_TOKEN']
  );
});

void test('planEnvironment reports branch, excluded and unsupported records as skipped', () => {
  const plan = planEnvironment(
    [
      record({ key: 'BRANCH_TOKEN', gitBranch: 'feature' }),
      record({ key: 'EXCLUDED_TOKEN' }),
      record({ key: 'apiUrl' }),
      record({ key: 'SYSTEM_VALUE', type: 'system' }),
      record({ key: 'KEPT_TOKEN' }),
    ],
    'production',
    undefined,
    new Set(['EXCLUDED_TOKEN', 'apiUrl'])
  );

  assert.deepEqual(
    plan.variables.map(variable => variable.name),
    ['KEPT_TOKEN']
  );
  assert.deepEqual(plan.skipped, [
    { name: 'BRANCH_TOKEN', reason: 'only applies to branch feature' },
    { name: 'EXCLUDED_TOKEN', reason: 'excluded with --exclude' },
    { name: 'SYSTEM_VALUE', reason: 'unsupported Vercel type system' },
    { name: 'apiUrl', reason: 'excluded with --exclude' },
  ]);
});

void test('planEnvironment rejects a variable defined twice for one environment', () => {
  assert.throws(
    () =>
      planEnvironment(
        [record({ key: 'TWICE', id: 'first' }), record({ key: 'TWICE', id: 'second' })],
        'production',
        undefined,
        new Set()
      ),
    /TWICE is defined more than once for production/
  );
});
