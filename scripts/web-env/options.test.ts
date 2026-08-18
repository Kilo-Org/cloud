import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOptions } from './options.js';

void test('parseOptions scopes an update to one environment', () => {
  assert.deepEqual(
    parseOptions(['set', 'TEST_SECRET', '--only', 'staging', '--staging-file=value']),
    {
      name: 'TEST_SECRET',
      dryRun: false,
      only: 'staging',
      valueFiles: { staging: 'value' },
    }
  );
});

void test('parseOptions accepts the inline only syntax', () => {
  assert.deepEqual(parseOptions(['set', 'TEST_SECRET', '--dry-run', '--only=production']), {
    name: 'TEST_SECRET',
    dryRun: true,
    only: 'production',
    valueFiles: {},
  });
});

void test('parseOptions rejects unsupported environments', () => {
  assert.throws(
    () => parseOptions(['set', 'TEST_SECRET', '--only', 'preview']),
    /ENVIRONMENT: development \| staging \| production/
  );
});

void test('parseOptions rejects value files outside the selected environment', () => {
  assert.throws(
    () =>
      parseOptions([
        'set',
        'TEST_SECRET',
        '--only',
        'staging',
        '--production-file',
        'production-value',
      ]),
    /--only staging cannot be combined with value files for other environments/
  );
});
