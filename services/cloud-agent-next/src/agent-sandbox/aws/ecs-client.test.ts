import { describe, expect, it } from 'vitest';
import {
  AwsEcsRunRejectedError,
  assertEcsTask,
  assertEcsTaskDefinition,
  createEcsClient,
  ecsRunRequestSchema,
  type EcsRunRequest,
  type EcsTaskDefinition,
} from './ecs-client.js';
import {
  ECS_TEST_CONFIG as config,
  ECS_TEST_CREDENTIALS as credentials,
  ecsDefinition,
  ecsTask,
} from '../../../test/fixtures/aws-ecs.js';

function request(): EcsRunRequest {
  return {
    cluster: config.clusterArn,
    taskDefinition: config.taskDefinitionArn,
    capacityProviderStrategy: [{ capacityProvider: config.capacityProvider, weight: 1 }],
    count: 1,
    clientToken: 'allocation-1',
    startedBy: 'allocation-1',
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: [config.subnetId],
        securityGroups: [config.securityGroupId],
        assignPublicIp: 'DISABLED',
      },
    },
    overrides: {
      containerOverrides: [
        { name: 'sandbox', command: ['--input-type=module', '-e', 'void 0'], environment: [] },
      ],
    },
    enableExecuteCommand: false,
  };
}
describe('ECS transport and isolation boundary', () => {
  it.each([
    { taskArns: [ecsTask().taskArn], nextToken: null, expected: ecsTask().taskArn },
    { taskArns: [], expected: undefined },
    { taskArns: [ecsTask().taskArn], nextToken: 'more', expected: undefined },
    { taskArns: [ecsTask().taskArn, ecsTask().taskArn], expected: undefined },
  ])(
    'uses one bounded intent query and accepts only a complete unique result: $nextToken',
    async ({ expected, ...response }) => {
      let calls = 0;
      const client = createEcsClient({
        credentials,
        region: 'us-east-1',
        fetch: async input => {
          calls++;
          expect(input.headers.get('x-amz-target')).toBe(
            'AmazonEC2ContainerServiceV20141113.ListTasks'
          );
          expect(await input.json()).toEqual({
            cluster: config.clusterArn,
            startedBy: 'allocation-1',
            maxResults: 2,
          });
          return Response.json(response);
        },
      });
      expect(await client.findByStartedBy(config.clusterArn, 'allocation-1')).toBe(expected);
      expect(calls).toBe(1);
    }
  );

  it.each([
    [403, 'AccessDeniedException', true],
    [400, 'AccessDeniedException', true],
    [400, 'InvalidParameterException', true],
    [400, 'ConflictException', false],
    [400, 'ClientException', false],
    [503, 'ServiceUnavailableException', false],
  ] as const)(
    'classifies RunTask %s %s certainty at the transport boundary',
    async (status, code, definite) => {
      const client = createEcsClient({
        credentials,
        region: 'us-east-1',
        fetch: async () =>
          Response.json(
            { __type: code, message: 'sensitive diagnostics' },
            { status, headers: { 'x-amzn-errortype': code } }
          ),
      });
      let failure: unknown;
      try {
        await client.run(request());
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure instanceof AwsEcsRunRejectedError).toBe(definite);
      expect(String(failure)).not.toContain('sensitive diagnostics');
      // The same provider error on a read does not prove anything about a prior RunTask.
      await expect(client.get(config.clusterArn, ecsTask().taskArn)).rejects.not.toBeInstanceOf(
        AwsEcsRunRejectedError
      );
    }
  );

  it('keeps an untyped parameter refusal uncertain', async () => {
    const client = createEcsClient({
      credentials,
      region: 'us-east-1',
      fetch: async () => Response.json({ __type: 'InvalidParameterException' }, { status: 400 }),
    });
    await expect(client.run(request())).rejects.not.toBeInstanceOf(AwsEcsRunRejectedError);
  });

  it('signs the exact launch request and preserves physical identity before metadata validation', async () => {
    const client = createEcsClient({
      credentials,
      region: 'us-east-1',
      fetch: async input => {
        expect(input.url).toBe('https://ecs.us-east-1.amazonaws.com/');
        expect(input.headers.get('x-amz-target')).toBe(
          'AmazonEC2ContainerServiceV20141113.RunTask'
        );
        expect(input.headers.get('authorization')).toContain('/us-east-1/ecs/aws4_request');
        expect(await input.json()).toEqual(request());
        return Response.json({
          tasks: [
            {
              taskArn: ecsTask().taskArn,
              taskDefinitionArn: 'unexpected',
              overrides: { environment: 'sensitive' },
            },
          ],
          failures: [{ reason: 'raw diagnostics' }],
        });
      },
    });
    expect(await client.run(request())).toEqual({ taskArn: ecsTask().taskArn });
  });
  it('removes raw AWS diagnostics, override secrets, and unowned fields from task observations', async () => {
    const task = ecsTask();
    const client = createEcsClient({
      credentials,
      region: 'us-east-1',
      fetch: async () =>
        Response.json({
          tasks: [
            {
              ...task,
              stoppedReason: 'secret diagnostics',
              overrides: {
                containerOverrides: [{ environment: [{ name: 'SECRET', value: 'sensitive' }] }],
              },
            },
          ],
        }),
    });
    const result = await client.get(config.clusterArn, task.taskArn);
    expect(JSON.stringify(result)).not.toContain('sensitive');
    expect(JSON.stringify(result)).not.toContain('secret diagnostics');
    expect(result?.taskArn).toBe(task.taskArn);
  });
  it('returns unknown only for an exact MISSING task and rejects other read failures', async () => {
    let arn = ecsTask().taskArn;
    const client = createEcsClient({
      credentials,
      region: 'us-east-1',
      fetch: async () => Response.json({ tasks: [], failures: [{ arn, reason: 'MISSING' }] }),
    });
    expect(await client.get(config.clusterArn, arn)).toBeUndefined();
    arn = arn.replace('d'.repeat(32), 'e'.repeat(32));
    await expect(client.get(config.clusterArn, ecsTask().taskArn)).rejects.toThrow(
      'InvalidEcsResponse'
    );
  });
  it('rejects malformed, oversized, duplicate-task and empty launch responses without exposing bodies', async () => {
    for (const body of [
      'raw secret',
      JSON.stringify({ tasks: [] }),
      JSON.stringify({ tasks: [ecsTask(), ecsTask()] }),
      'x'.repeat(1_048_577),
    ]) {
      const client = createEcsClient({
        credentials,
        region: 'us-east-1',
        fetch: async () => new Response(body),
      });
      await expect(client.run(request())).rejects.toThrow('AWS request failed');
    }
  });
  it('checks the returned stop identity', async () => {
    const other = ecsTask().taskArn.replace('d'.repeat(32), 'e'.repeat(32));
    const client = createEcsClient({
      credentials,
      region: 'us-east-1',
      fetch: async input => {
        expect(input.headers.get('x-amz-target')).toContain('StopTask');
        expect(await input.json()).toMatchObject({
          cluster: config.clusterArn,
          task: ecsTask().taskArn,
        });
        return Response.json({ task: { taskArn: other } });
      },
    });
    await expect(client.stop(config.clusterArn, ecsTask().taskArn)).rejects.toThrow(
      'InvalidEcsResponse'
    );
  });
  it('rejects task roles, public networking, extra tasks, and unbounded bootstrap overrides', () => {
    expect(ecsRunRequestSchema.safeParse({ ...request(), count: 2 }).success).toBe(false);
    const role = request();
    Object.assign(role.overrides, { taskRoleArn: 'arn:aws:iam::123456789012:role/task' });
    expect(ecsRunRequestSchema.safeParse(role).success).toBe(false);
    const publicIp = request();
    Object.assign(publicIp.networkConfiguration.awsvpcConfiguration, { assignPublicIp: 'ENABLED' });
    expect(ecsRunRequestSchema.safeParse(publicIp).success).toBe(false);
    const env = request();
    Object.assign(env.overrides.containerOverrides[0], {
      environment: [{ name: 'AWS_ACCESS_KEY_ID', value: 'credential' }],
    });
    expect(ecsRunRequestSchema.safeParse(env).success).toBe(false);
    const huge = request();
    huge.overrides.containerOverrides[0].command = ['x'.repeat(8192)];
    expect(ecsRunRequestSchema.safeParse(huge).success).toBe(false);
  });
  it.each([
    { taskRoleArn: 'arn:aws:iam::123456789012:role/task' },
    { networkMode: 'host' },
    { executionRoleArn: 'arn:aws:iam::123456789012:role/other' },
    { requiresCompatibilities: ['EC2'] },
    { trustedExecutionConfiguration: { isolationMode: 'SHARED' } },
    { volumes: [{ name: 'external', host: { sourcePath: '/host' } }] },
  ] satisfies Partial<EcsTaskDefinition>[])('rejects an unsafe definition %j', patch => {
    expect(() => assertEcsTaskDefinition({ ...ecsDefinition(), ...patch }, config)).toThrow(
      'TaskDefinitionMismatch'
    );
  });
  it.each([
    { image: config.runtimeImage.replace('c'.repeat(64), 'd'.repeat(64)) },
    { privileged: true },
    { environment: [{ name: 'AWS_SECRET_ACCESS_KEY', value: 'sensitive' }] },
    { secrets: [{ name: 'SECRET', valueFrom: 'private' }] },
    { environmentFiles: [{ type: 's3', value: 'private' }] },
    { credentialSpecs: ['private'] },
    { mountPoints: [{ sourceVolume: 'host', containerPath: '/host' }] },
  ])('rejects an unsafe container %j', patch => {
    const value = ecsDefinition();
    Object.assign(value.containerDefinitions[0], patch);
    expect(() => assertEcsTaskDefinition(value, config)).toThrow('TaskDefinitionMismatch');
  });
  it('accepts a pinned isolated definition and rejects changed task runtime identity', () => {
    expect(() => assertEcsTaskDefinition(ecsDefinition(), config)).not.toThrow();
    expect(() => assertEcsTask(ecsTask(), config, ecsTask().taskArn)).not.toThrow();
    for (const patch of [
      { enableExecuteCommand: true },
      { capacityProviderName: 'other' },
      { trustedExecutionSummary: { isolationMode: 'SHARED' } },
      { attachments: [] },
      { overrides: { taskRoleArn: 'arn:aws:iam::123456789012:role/task' } },
    ])
      expect(() => assertEcsTask({ ...ecsTask(), ...patch }, config, ecsTask().taskArn)).toThrow(
        'TaskIdentityMismatch'
      );
  });
});
