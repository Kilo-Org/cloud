import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  acquireTracked,
  cleanupScenario,
  createScenarioOperation,
  createScenarioResources,
  isDockerExecFailureForContainer,
  type OperationRole,
} from '../../e2e/lifecycle-file-state.js';
import { ControlPlaneContainerUnavailableError } from '../../e2e/sandbox-control.js';
import type { DriverConfig } from '../../e2e/client.js';

const config: DriverConfig = {
  workerUrl: 'http://worker.test',
  user: { id: 'user_1', email: 'user@example.test', api_token_pepper: 'pepper' },
  nextAuthSecret: 'test-secret',
  gitUrl: 'https://example.test/repo.git',
  model: 'kilo/fake-deterministic',
  fakeLlmUrl: 'http://fake.test',
};

// Mirrors the server-side operationKey contract (src/router/schemas.ts) that
// rejected the prefixed keys this scenario file used to send.
const operationKeySchema = z.string().uuid();

const operationRoles: OperationRole[] = [
  'long-session',
  'cold-resume',
  'cold-resume-admission',
  'multi-session-planner',
  'multi-session-implementer',
  'multi-session-reviewer',
];

describe('file-state resource acquisition', () => {
  it('reports an ambiguous creation failure with its operation key', async () => {
    const resources = createScenarioResources(config, 1_000);
    const operation = acquireTracked(
      resources,
      'prepare browser session',
      async () => {
        throw new Error('response body connection reset');
      },
      () => undefined,
      { operationKey: 'create-op-1', uncertainOnFailure: true }
    );

    await expect(operation).rejects.toThrow('response body connection reset');
    const cleanup = await cleanupScenario(resources);

    expect(cleanup.uncleanedResource).toBe(true);
    expect(cleanup.failures.join('|')).toContain('operationKey=create-op-1');
  });
});

describe('file-state scenario operation keys', () => {
  it.each(operationRoles)('builds a server-valid UUID for %s', role => {
    const operation = createScenarioOperation(role);

    expect(operationKeySchema.safeParse(operation.operationKey).success).toBe(true);
    expect(operation.label).toBe(role);
  });

  it('generates a distinct key for each call', () => {
    const keys = operationRoles.map(role => createScenarioOperation(role).operationKey);
    expect(new Set(keys).size).toBe(operationRoles.length);
  });
});

describe('isDockerExecFailureForContainer', () => {
  const selected = 'abc123def456';
  const other = 'ffffffffffff';

  it('matches the exact failed docker-exec command for the selected container', () => {
    const error = new Error(`Command failed: docker exec ${selected} bun -e \nrun()`);

    expect(isDockerExecFailureForContainer(error, selected)).toBe(true);
  });

  it('rejects a docker-exec command for a different container', () => {
    const error = new Error(`Command failed: docker exec ${other} bun -e run()`);

    expect(isDockerExecFailureForContainer(error, selected)).toBe(false);
  });

  it('rejects a different container command that embeds the selected id', () => {
    const error = new Error(`Command failed: docker exec ${other} docker exec ${selected} nested`);

    expect(isDockerExecFailureForContainer(error, selected)).toBe(false);
  });

  it('rejects a non-Docker assertion that merely mentions the command', () => {
    const error = new Error(`assertion failed: unexpected docker exec ${selected} command`);

    expect(isDockerExecFailureForContainer(error, selected)).toBe(false);
  });

  it('rejects the typed container-unavailable error', () => {
    const error = new ControlPlaneContainerUnavailableError(
      `Kilo completion could not reach ${selected}: the container is gone`
    );

    expect(isDockerExecFailureForContainer(error, selected)).toBe(false);
  });
});
