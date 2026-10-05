import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOptions } from './options.js';

void test('parseOptions scopes an update to one environment', () => {
  assert.deepEqual(
    parseOptions(['set', 'TEST_SECRET', '--only', 'staging', '--staging-file=value']),
    {
      command: 'set',
      name: 'TEST_SECRET',
      dryRun: false,
      only: 'staging',
      valueFiles: { staging: 'value' },
    }
  );
});

void test('parseOptions accepts the inline only syntax', () => {
  assert.deepEqual(parseOptions(['set', 'TEST_SECRET', '--dry-run', '--only=production']), {
    command: 'set',
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

void test('parseOptions parses a project copy', () => {
  assert.deepEqual(
    parseOptions([
      'copy',
      '--from',
      'kilocode-global-app',
      '--to=kilocode-ai-gateway',
      '--only',
      'production',
      '--exclude',
      'GLOBAL_KILO_BACKEND',
      '--exclude=OTHER_SETTING',
      '--dry-run',
    ]),
    {
      command: 'copy',
      from: 'kilocode-global-app',
      to: 'kilocode-ai-gateway',
      dryRun: true,
      only: 'production',
      exclude: ['GLOBAL_KILO_BACKEND', 'OTHER_SETTING'],
    }
  );
});

void test('parseOptions requires distinct known projects for a copy', () => {
  assert.throws(() => parseOptions(['copy', '--to', 'kilocode-ai-gateway']), /PROJECT: /);
  assert.throws(
    () => parseOptions(['copy', '--from', 'kilocode-preview', '--to', 'kilocode-ai-gateway']),
    /PROJECT: kilocode-app \| kilocode-global-app \| kilocode-ai-gateway/
  );
  assert.throws(
    () => parseOptions(['copy', '--from', 'kilocode-app', '--to', 'kilocode-app']),
    /must be different projects/
  );
});

void test('parseOptions excludes existing variables with their exact case', () => {
  assert.deepEqual(
    parseOptions([
      'copy',
      '--from',
      'kilocode-global-app',
      '--to',
      'kilocode-ai-gateway',
      '--exclude',
      'apiUrl',
      '--exclude=Mixed_Case_2',
    ]),
    {
      command: 'copy',
      from: 'kilocode-global-app',
      to: 'kilocode-ai-gateway',
      dryRun: false,
      only: undefined,
      exclude: ['apiUrl', 'Mixed_Case_2'],
    }
  );
  assert.throws(
    () =>
      parseOptions([
        'copy',
        '--from',
        'kilocode-global-app',
        '--to',
        'kilocode-ai-gateway',
        '--exclude',
        '2FAST',
      ]),
    /not start with a digit/
  );
});

void test('parseOptions parses a firewall copy with path rewrites', () => {
  assert.deepEqual(
    parseOptions([
      'copy-firewall',
      '--from',
      'kilocode-app',
      '--to',
      'kilocode-ai-gateway',
      '--rewrite-path',
      '/api/gateway/=/api/v1/',
      '--rewrite-path=/api/openrouter/=/api/v1/',
      '--dry-run',
    ]),
    {
      command: 'copy-firewall',
      from: 'kilocode-app',
      to: 'kilocode-ai-gateway',
      dryRun: true,
      rewritePaths: [
        { from: '/api/gateway/', to: '/api/v1/' },
        { from: '/api/openrouter/', to: '/api/v1/' },
      ],
    }
  );
});

void test('parseOptions rejects path rewrites that are not absolute FROM=TO pairs', () => {
  for (const rewrite of ['/api/gateway/', 'api/gateway/=/api/v1/', '/api/gateway/=api/v1/']) {
    assert.throws(
      () =>
        parseOptions([
          'copy-firewall',
          '--from',
          'kilocode-app',
          '--to',
          'kilocode-ai-gateway',
          '--rewrite-path',
          rewrite,
        ]),
      /--rewrite-path takes FROM=TO/
    );
  }
});
