import { KILO_GATEWAY_INFERENCE_SCOPE, utsScopeEntry } from '@kilocode/uts-contracts';
import { describe, expect, it } from 'vitest';
import { CI_LEGACY_SUBJECT_REPOSITORY, ciPolicies, ciSubject } from '../../src/ci/policy';

/** The CI trust policy loader (src/ci/policy.ts): the switch and every load rule. */

const policy = {
  name: 'ci-example-smoke',
  repository: 'Example-Org/example',
  repositoryId: '111111',
  repositoryOwnerId: '222222',
  environment: 'smoke',
  refs: ['refs/heads/main'],
  jobWorkflowRefs: ['Example-Org/example/.github/workflows/smoke.yml@refs/heads/main'],
  events: ['push', 'workflow_dispatch'],
  subject: 'ci/example-bot',
  scopes: [KILO_GATEWAY_INFERENCE_SCOPE],
  lifetimeSeconds: 3600,
};

const load = (value: unknown, environment: 'production' | 'staging' | 'development' = 'staging') =>
  ciPolicies(
    { CI_TOKEN_POLICIES: typeof value === 'string' ? value : JSON.stringify(value) },
    environment,
    utsScopeEntry
  );

describe('CI trust policies', () => {
  it('stay off without the var, with an empty var and with an empty list', () => {
    expect(ciPolicies({}, 'production', utsScopeEntry)).toEqual({ status: 'off' });
    expect(load('')).toEqual({ status: 'off' });
    expect(load([])).toEqual({ status: 'off' });
  });

  it('load a valid list in every environment', () => {
    for (const environment of ['production', 'staging', 'development'] as const) {
      const loaded = load([policy], environment);
      expect(loaded.status).toBe('on');
    }
  });

  it('build the immutable subject from the ids and the environment', () => {
    const loaded = load([policy]);
    if (loaded.status !== 'on') throw new Error('expected on');
    expect(ciSubject(loaded.policies[0])).toBe(
      'repo:Example-Org@222222/example@111111:environment:smoke'
    );
  });

  it('are misconfigured, and so off, for a var that is not JSON or breaks the schema', () => {
    expect(load('[{').status).toBe('misconfigured');
    for (const broken of [
      { ...policy, extra: true },
      { ...policy, name: 'smoke' },
      { ...policy, events: ['pull_request_target'] },
      { ...policy, lifetimeSeconds: 7200 },
      { ...policy, environment: undefined },
      { ...policy, repositoryId: 'abc' },
    ]) {
      expect(load([broken]).status).toBe('misconfigured');
    }
  });

  it('refuse each cross-field rule with a message that names no value', () => {
    const cases: [unknown[], string, ('production' | 'staging')?][] = [
      [[{ ...policy, events: ['push', 'push'] }], 'events contains a duplicate'],
      [[{ ...policy, events: ['workflow_run', 'push'] }], 'accepts no other event'],
      [[{ ...policy, events: ['workflow_run'] }], 'cannot accept workflow_run', 'production'],
      [
        [
          {
            ...policy,
            refs: ['refs/heads/main', 'refs/heads/next'],
            jobWorkflowRefs: ['Example-Org/example/.github/workflows/smoke.yml@refs/heads/next'],
          },
        ],
        'accepts only refs/heads/main',
        'production',
      ],
      [
        [
          {
            ...policy,
            jobWorkflowRefs: ['Other-Org/other/.github/workflows/x.yml@refs/heads/main'],
          },
        ],
        'not a workflow file of the repository',
      ],
      [
        [
          {
            ...policy,
            jobWorkflowRefs: ['Example-Org/example/.github/workflows/smoke.yml@refs/heads/dev'],
          },
        ],
        'refs does not list',
      ],
      [[{ ...policy, legacySubject: true }], 'legacySubject is allowed only for Kilo-Org/kilocode'],
      [[{ ...policy, scopes: ['gateway:unknown'] }], 'a scope is not registered'],
      [[{ ...policy, scopes: ['kilo-api:sessions.write'] }], 'not PAT-eligible'],
      [[{ ...policy, scopes: ['uts:pats.manage'] }], 'not PAT-eligible'],
      [[policy, policy], 'two policies share a name'],
      [
        [policy, { ...policy, name: 'ci-example-other', scopes: ['uts:probe.read'] }],
        'share a repository, GitHub environment and workflow file',
      ],
    ];
    for (const [value, message, environment] of cases) {
      const loaded = load(value, environment);
      if (loaded.status !== 'misconfigured') throw new Error(`expected misconfigured: ${message}`);
      expect(loaded.problems).toEqual(expect.arrayContaining([expect.stringContaining(message)]));
      expect(loaded.problems.join(' ')).not.toContain('ci/example-bot');
    }
  });

  it('allow legacySubject for Kilo-Org/kilocode with its ids', () => {
    const kilocode = {
      ...policy,
      ...CI_LEGACY_SUBJECT_REPOSITORY,
      jobWorkflowRefs: ['Kilo-Org/kilocode/.github/workflows/smoke-test.yml@refs/heads/main'],
      legacySubject: true,
    };
    expect(load([kilocode]).status).toBe('on');
    expect(load([{ ...kilocode, repositoryId: '1' }]).status).toBe('misconfigured');
  });
});
