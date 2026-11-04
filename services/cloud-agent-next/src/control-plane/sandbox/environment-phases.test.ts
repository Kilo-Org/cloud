import { describe, expect, it } from 'vitest';
import type { SessionEnvironmentReference } from '../../environment-build/reference.js';
import type { ControlPlaneRouteSpec } from '../../shared/control-plane-protocol.js';
import { environmentPhaseSpec } from './environment-phases.js';
import type { RepositoryLaunchRecord } from './repository-launch.js';

const environmentId = '11111111-1111-4111-8111-111111111111';

const environment = {
  environmentId,
  owner: { type: 'user', id: 'user-1' },
  configurationRevision: 3,
  repository: { platform: 'github', repoFullName: 'acme/widgets' },
} satisfies SessionEnvironmentReference;

const spec: ControlPlaneRouteSpec = {
  sessionId: 'ses_a',
  kiloSessionId: 'kilo_a',
  attemptId: 'attempt-1',
  directory: '/workspace',
  setupCommands: ['install'],
  environmentSetupCommandCount: 1,
  startCommands: ['serve'],
};

function launch(overrides: Partial<RepositoryLaunchRecord> = {}): RepositoryLaunchRecord {
  return {
    allocationId: 'alloc-1',
    startSource: 'repository',
    confirmed: true,
    environmentSnapshot: { environmentId, revision: 3 },
    ...overrides,
  };
}

function phases(
  overrides: Partial<Parameters<typeof environmentPhaseSpec>[0]> = {}
): ControlPlaneRouteSpec {
  return environmentPhaseSpec({
    spec,
    environment,
    launch: launch(),
    allocationId: 'alloc-1',
    runsStartCommands: true,
    ...overrides,
  });
}

describe('environmentPhaseSpec', () => {
  it.each([
    ['a snapshot built at the route revision', {}],
    [
      'an older snapshot revision',
      { launch: launch({ environmentSnapshot: { environmentId, revision: 2 } }) },
    ],
  ] as const)('marks %s as the start of the allocation', (_name, overrides) => {
    expect(phases(overrides)).toMatchObject({
      setupCommands: ['install'],
      environmentSetupCommandCount: 1,
      startCommands: ['serve'],
      startedFromEnvironmentSnapshot: true,
    });
  });

  it.each([
    [
      'another environment',
      {
        launch: launch({
          environmentSnapshot: {
            environmentId: '22222222-2222-4222-8222-222222222222',
            revision: 3,
          },
        }),
      },
    ],
    ['a launch that offered no snapshot', { launch: launch({ environmentSnapshot: undefined }) }],
    ['an image start', { launch: launch({ startSource: 'image' }) }],
    ['another allocation', { allocationId: 'alloc-2' }],
    ['a route without an environment', { environment: null }],
  ] as const)('does not mark %s as the start of the allocation', (_name, overrides) => {
    const result = phases(overrides);
    expect(result).not.toHaveProperty('startedFromEnvironmentSnapshot');
    expect(result).toMatchObject({ setupCommands: ['install'], startCommands: ['serve'] });
  });

  it('appends start commands to setup for a wrapper that predates them', () => {
    const result = phases({ runsStartCommands: false });
    expect(result.setupCommands).toEqual(['install', 'serve']);
    expect(result).not.toHaveProperty('startCommands');
    expect(result).not.toHaveProperty('environmentSetupCommandCount');
    expect(result).not.toHaveProperty('startedFromEnvironmentSnapshot');
  });

  it('leaves setup untouched for an older wrapper when there are no start commands', () => {
    const result = phases({
      runsStartCommands: false,
      spec: { ...spec, startCommands: undefined },
    });
    expect(result.setupCommands).toEqual(['install']);
    expect(result).not.toHaveProperty('startCommands');
  });
});
