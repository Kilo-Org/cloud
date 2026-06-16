import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWriteOperations,
  validateTargetPreconditions,
  validateVariableName,
  WEB_ENVIRONMENTS,
  WEB_ENV_PROJECTS,
  type TargetState,
} from './plan.js';

function states(present: boolean): TargetState[] {
  return WEB_ENVIRONMENTS.flatMap(environment =>
    WEB_ENV_PROJECTS.map(project => ({
      project,
      environment,
      variable: present ? { key: 'API_TOKEN', type: 'encrypted' as const } : undefined,
    }))
  );
}

void test('builds the fixed project and environment matrix in risk order', () => {
  const operations = buildWriteOperations(true);
  assert.deepEqual(
    operations.map(operation => `${operation.project}/${operation.environment}`),
    [
      'kilocode-app/development',
      'kilocode-global-app/development',
      'kilocode-app/staging',
      'kilocode-global-app/staging',
      'kilocode-app/production',
      'kilocode-global-app/production',
    ]
  );
  assert.deepEqual(
    operations.map(operation => operation.expectedType),
    ['encrypted', 'encrypted', 'sensitive', 'sensitive', 'sensitive', 'sensitive']
  );
});

void test('keeps every target encrypted for non-sensitive variables', () => {
  assert.ok(buildWriteOperations(false).every(operation => operation.expectedType === 'encrypted'));
});

void test('enforces strict add and update preconditions', () => {
  assert.doesNotThrow(() => validateTargetPreconditions('add', states(false)));
  assert.doesNotThrow(() => validateTargetPreconditions('update', states(true)));
  assert.throws(() => validateTargetPreconditions('add', states(true)), /already exists/);
  assert.throws(() => validateTargetPreconditions('update', states(false)), /missing/);
});

void test('requires explicit non-sensitive mode for client-exposed names', () => {
  assert.throws(() => validateVariableName('NEXT_PUBLIC_API_TOKEN', true), /--no-sensitive/);
  assert.doesNotThrow(() => validateVariableName('NEXT_PUBLIC_API_TOKEN', false));
  assert.throws(() => validateVariableName('bad-name', false), /uppercase/);
});
