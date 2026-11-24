import { describe, expect, it } from 'vitest';
import { ECS_TEST_CONFIG } from '../../test/fixtures/aws-ecs.js';
import {
  awsRecoveryStep,
  transitionAwsOperation,
  AWS_LAUNCH_RECOVERY_MS,
} from './aws-compute-lifecycle.js';
import type { AwsComputeOperation } from './aws-compute-lifecycle.js';
import type { AwsEcsOperation } from './aws-ecs-operation.js';
type Config = AwsEcsOperation['config'];
type Ref = AwsEcsOperation['ref'];
type Request = NonNullable<AwsEcsOperation['request']>;
type AwsOperation = AwsComputeOperation<Config, Ref, Request>;

const now = 10_000;
const created: AwsOperation = {
  ref: { provider: 'aws-ecs', sandboxId: 'sbx_test', intentId: 'intent-1', createdAt: now },
  config: ECS_TEST_CONFIG,
  phase: 'created',
};
const prepared: AwsOperation = {
  ...created,
  phase: 'launching',
  submission: 'prepared',
  requestAt: now,
  deadlineAt: now + 28_680_000,
  request: {
    cluster: ECS_TEST_CONFIG.clusterArn,
    taskDefinition: ECS_TEST_CONFIG.taskDefinitionArn,
    capacityProviderStrategy: [{ capacityProvider: ECS_TEST_CONFIG.capacityProvider, weight: 1 }],
    count: 1,
    clientToken: created.ref.intentId,
    startedBy: created.ref.intentId,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: [ECS_TEST_CONFIG.subnetId],
        securityGroups: [ECS_TEST_CONFIG.securityGroupId],
        assignPublicIp: 'DISABLED',
      },
    },
    overrides: {
      containerOverrides: [{ name: 'sandbox', command: ['-e', 'void 0'], environment: [] }],
    },
    enableExecuteCommand: false,
  },
};
const apply = (
  operation: AwsOperation,
  event: Parameters<typeof transitionAwsOperation<Config, Ref, Request>>[1]
) => transitionAwsOperation(operation, event, now);

describe('pure AWS operation decisions', () => {
  it('checkpoints preparation once and never replaces an issued request', () => {
    expect(apply(created, { type: 'prepared', operation: prepared })).toEqual(prepared);
    const running: AwsOperation = { ...prepared, phase: 'running', physicalId: 'task-original' };
    expect(apply(running, { type: 'prepared', operation: prepared })).toBe(running);
    expect(created.phase).toBe('created');
  });

  it('claims first submission and makes every additional claim uncertain', () => {
    const first = apply(prepared, { type: 'claim' });
    expect(first.submission).toBe('pending');
    expect(apply(first, { type: 'claim' }).submission).toBe('uncertain');
    expect(apply({ ...prepared, submission: undefined }, { type: 'claim' }).submission).toBe(
      'uncertain'
    );
    expect(prepared.submission).toBe('prepared');
  });

  it('retires only a definite first rejection with no concurrent submission', () => {
    const first = apply(prepared, { type: 'claim' });
    expect(
      apply(first, { type: 'run-rejected', attempt: 'first', certainty: 'definite' }).phase
    ).toBe('terminated');
    for (const [operation, attempt, certainty] of [
      [first, 'replay', 'definite'],
      [first, 'first', 'uncertain'],
      [apply(first, { type: 'claim' }), 'first', 'definite'],
    ] as const) {
      expect(apply(operation, { type: 'run-rejected', attempt, certainty })).toMatchObject({
        phase: 'launching',
        submission: 'uncertain',
      });
    }
  });

  it.each(['created', 'launching', 'running', 'stopping', 'terminated'] as const)(
    'applies Stop from %s without reviving a terminal allocation',
    phase => {
      expect(apply({ ...prepared, phase }, { type: 'stop' }).phase).toBe(
        phase === 'terminated' ? 'terminated' : 'stopping'
      );
    }
  );

  it.each(['stopping', 'terminated'] as const)(
    'refuses preparation and unsubmitted Run after %s',
    phase => {
      const stopped = { ...prepared, phase };
      expect(() => apply(stopped, { type: 'prepared', operation: prepared })).toThrow();
      expect(() => apply(stopped, { type: 'claim' })).toThrow();
      expect(apply(stopped, { type: 'running' }).phase).toBe(phase);
    }
  );

  it('retains a late physical identity behind Stop, but refuses substitution or revival', () => {
    const stopping = apply(prepared, { type: 'stop' });
    const identified = apply(stopping, { type: 'identified', physicalId: 'task-one' });
    expect(identified).toMatchObject({ phase: 'stopping', physicalId: 'task-one' });
    expect(() => apply(identified, { type: 'identified', physicalId: 'task-two' })).toThrow(
      'identity changed'
    );
    const terminal = apply(identified, { type: 'terminated' });
    expect(apply(terminal, { type: 'identified', physicalId: 'task-two' })).toBe(terminal);
  });

  it('keeps phase transitions fenced and drops the request only after retirement', () => {
    expect(apply(prepared, { type: 'running' }).phase).toBe('running');
    for (const phase of ['created', 'running'] as const)
      expect(() => apply({ ...prepared, phase }, { type: 'terminated' })).toThrow();
    const stopping = apply(prepared, { type: 'stop' });
    expect(stopping.request).toBe(prepared.request);
    expect(apply(stopping, { type: 'terminated' })).toEqual({ ...created, phase: 'terminated' });
  });

  it('bounds uncertain replay but permits cleanup of known or unsubmitted compute', () => {
    const uncertain: AwsOperation = { ...prepared, submission: 'uncertain' };
    expect(awsRecoveryStep(uncertain, now + AWS_LAUNCH_RECOVERY_MS)).toBe('replay');
    expect(awsRecoveryStep(uncertain, now + AWS_LAUNCH_RECOVERY_MS + 1)).toBe('blocked');
    expect(() =>
      transitionAwsOperation(uncertain, { type: 'claim' }, now + AWS_LAUNCH_RECOVERY_MS + 1)
    ).toThrow();
    expect(awsRecoveryStep(prepared, now + AWS_LAUNCH_RECOVERY_MS + 1)).toBe('unsubmitted');
    expect(
      awsRecoveryStep({ ...uncertain, physicalId: 'task-known' }, now + AWS_LAUNCH_RECOVERY_MS + 1)
    ).toBe('identified');
    expect(awsRecoveryStep(created, now)).toBe('absent');
    expect(
      awsRecoveryStep({ ...uncertain, phase: 'terminated' }, now + AWS_LAUNCH_RECOVERY_MS + 1)
    ).toBe('retired');
  });
});
