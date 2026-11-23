import { mintSandboxLaunchCredential } from './credential.js';
import { mintAwsEgressCredentialUntil } from '../egress/aws-credential.js';
import { ECS_TEST_CONFIG } from '../../test/fixtures/aws-ecs.js';
import { describe, expect, it } from 'vitest';
import { ecsDefinition, ecsProviderFixture } from '../../test/fixtures/aws-ecs.js';
import { AWS_ABSENCE_SETTLE_MS, AWS_LAUNCH_RECOVERY_MS } from './aws-compute-lifecycle.js';
import { decodeAwsProviderRef } from './aws-operation.js';
import { awsEcsOperationSchema } from './aws-ecs-operation.js';

function proxyUrl(origin: string, password: string): string {
  const url = new URL(origin);
  url.username = 'kilo';
  url.password = password;
  return url.href;
}
const intent = { intentId: '11111111-1111-4111-8111-111111111111', createdAt: 10_000 };
const settledAt = 10_001 + AWS_LAUNCH_RECOVERY_MS + AWS_ABSENCE_SETTLE_MS;
const sandboxId = 'ses-abcdef';
const proxyExpiresAt = Math.floor((Date.now() + 2 * 86_400_000) / 1000) * 1000;
const proxyToken = mintAwsEgressCredentialUntil(
  {
    launchCredential: mintSandboxLaunchCredential(
      {
        sandboxId,
        allocationId: intent.intentId,
        credential: 'a'.repeat(64),
      },
      'test-secret'
    ),
    stackId: ECS_TEST_CONFIG.stackId,
    generation: ECS_TEST_CONFIG.proxy.generation,
  },
  'test-secret',
  proxyExpiresAt
);
const startup = {
  command: { argv: ['/bin/sh', '-c', 'echo test'] },
  env: {
    SANDBOX_CONTROL_CREDENTIAL: 'launch-only-credential',
    HTTPS_PROXY: proxyUrl('http://proxy.internal.example.com:3128/', proxyToken),
  },
};
async function create(f: ReturnType<typeof ecsProviderFixture>) {
  const result = await f.adapter().create(intent);
  if (!('providerRef' in result)) throw new Error('missing ref');
  return result.providerRef;
}
function gate() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, release: resolve };
}

describe('ECS through the shared AWS allocation lifecycle', () => {
  it.each([
    [403, 'AccessDeniedException', 'byoc_aws_forbidden'],
    [400, 'InvalidParameterException', 'invalid_configuration'],
  ] as const)(
    'retires definite first RunTask rejection %s %s without a stuck cleanup record',
    async (status, code, reason) => {
      const f = ecsProviderFixture();
      const ref = await create(f);
      f.rejectNextRun(status, code);
      await expect(f.adapter().launch(ref, startup)).rejects.toMatchObject({ reason });
      expect(f.operations.get(intent.intentId)?.phase).toBe('terminated');
      expect(f.tasks.size).toBe(0);
      f.setNow(intent.createdAt + AWS_LAUNCH_RECOVERY_MS + 1);
      expect(await f.adapter().stop(ref)).toBe('terminal');
      expect(f.submitted).toHaveLength(1);
      expect(f.documents.size).toBe(0);
      await expect(
        f.adapter().create({ intentId: 'replacement', createdAt: 500_000 })
      ).resolves.toHaveProperty('providerRef');
    }
  );

  it('retains uncertain RunTask failures and late concurrent success for physical cleanup', async () => {
    const f = ecsProviderFixture();
    const ref = await create(f);
    const waiting = gate();
    f.rejectNextRun(403, 'AccessDeniedException');
    f.gateRun(waiting.promise);
    const first = f.adapter().launch(ref, startup);
    const firstFailure = expect(first).rejects.toMatchObject({ reason: 'byoc_aws_forbidden' });
    await f.runStarted;
    f.gateRun();
    await f.adapter().reconcileLaunch(ref);
    waiting.release();
    await firstFailure;
    expect(f.operations.get(intent.intentId)?.phase).toBe('running');
    expect(f.tasks.size).toBe(1);
    expect(await f.adapter().stop(ref)).toBe('terminal');
    expect([...f.tasks.values()][0].lastStatus).toBe('STOPPED');
  });

  it('keeps a confirmed ECS stop terminal when S3 cleanup fails and retries only the object deletion', async () => {
    const f = ecsProviderFixture();
    const ref = await create(f);
    await f.adapter().launch(ref, startup);
    f.failDelete(true);
    expect(await f.adapter().stop(ref)).toBe('terminal');
    expect(f.operations.get(intent.intentId)?.phase).toBe('terminated');
    expect([...f.tasks.values()][0].lastStatus).toBe('STOPPED');
    f.failDelete(false);
    f.failObserve();
    f.failStop();
    expect(await f.adapter().stop(ref)).toBe('terminal');
    expect(f.documents.size).toBe(0);
    expect(f.submitted).toHaveLength(1);
  });

  it('keeps its reference separate and launches the common document without an eight-hour deadline', async () => {
    const f = ecsProviderFixture();
    const ref = await create(f);
    expect(decodeAwsProviderRef(ref)).toBeNull();
    expect(f.tasks.size).toBe(0);
    const adapter = f.adapter();
    await adapter.launch(ref, startup);
    const request = f.submitted[0];
    expect(request.overrides.containerOverrides[0].command[0]).toBe('--input-type=module');
    expect(JSON.stringify(request)).not.toContain(startup.env.SANDBOX_CONTROL_CREDENTIAL);
    expect(JSON.parse([...f.documents.values()][0])).toMatchObject({
      argv: startup.command.argv,
      env: { ...startup.env, PROVIDER_INSTANCE_ID: ref },
    });
    expect(f.operations.get(intent.intentId)).not.toHaveProperty('microvmId');
    expect(f.operations.get(intent.intentId)).not.toHaveProperty('physicalId');
    expect(f.operations.get(intent.intentId)).not.toHaveProperty('deadlineAt');
    expect(await adapter.allocationDeadline(ref)).toEqual({
      at: proxyExpiresAt,
      reason: 'byoc_aws_proxy_expired',
    });
    f.setNow(Date.now() + 9 * 3_600_000);
    await expect(f.adapter().reconcileLaunch(ref)).resolves.toEqual({ startSource: 'image' });
    expect(f.submitted).toHaveLength(1);
    expect(f.tasks.size).toBe(1);
    expect(await f.adapter().allocationDeadline(ref)).toEqual({
      at: proxyExpiresAt,
      reason: 'byoc_aws_proxy_expired',
    });
    await expect(adapter.ensureLeaseAtLeast(ref, 100 * 86_400_000)).resolves.toBeUndefined();
    await adapter.confirmAdmission(ref);
    expect(f.documents.size).toBe(0);
  });
  it('reads the exact proxy expiry after recreation without AWS access or a second saved deadline', async () => {
    const f = ecsProviderFixture();
    const ref = await create(f);
    expect(await f.adapter().allocationDeadline(ref)).toBeUndefined();
    await f.adapter().launch(ref, startup);
    f.failRuntime(new Error('No remote deadline reads'));
    f.setNow(proxyExpiresAt + 1);
    expect(await f.adapter().allocationDeadline(ref)).toEqual({
      at: proxyExpiresAt,
      reason: 'byoc_aws_proxy_expired',
    });
    expect(f.operations.get(intent.intentId)).not.toHaveProperty('deadlineAt');
  });

  it('fails closed if an issued checkpoint has no usable allocation proxy credential', async () => {
    const f = ecsProviderFixture();
    const ref = await create(f);
    await f.adapter().launch(ref, {
      ...startup,
      env: { ...startup.env, HTTPS_PROXY: proxyUrl('http://proxy.internal:3128', 'invalid') },
    });
    expect(await f.adapter().allocationDeadline(ref)).toEqual({
      at: 0,
      reason: 'invalid_configuration',
    });
  });

  it('replays the exact checkpoint after a lost success without creating another task', async () => {
    const f = ecsProviderFixture();
    const ref = await create(f);
    f.loseNextReply();
    await expect(f.adapter().launch(ref, startup)).rejects.toThrow('TransportError');
    expect(f.tasks.size).toBe(1);
    expect(f.operations.get(intent.intentId)?.taskArn).toBeUndefined();
    await f.adapter().reconcileLaunch(ref);
    expect(f.tasks.size).toBe(1);
    expect(f.submitted[1]).toEqual(f.submitted[0]);
    expect(f.signedUrls()).toBe(1);
    expect(await f.adapter().stop(ref)).toBe('terminal');
    expect([...f.tasks.values()][0].lastStatus).toBe('STOPPED');
    expect(f.documents.size).toBe(0);
  });
  it('keeps missing task reads unknown and refuses wrapper admission until the task is visible', async () => {
    const f = ecsProviderFixture();
    const ref = await create(f);
    f.setMissing(true);
    await f.adapter().launch(ref, startup);
    expect(f.operations.get(intent.intentId)?.phase).toBe('launching');
    expect(await f.adapter().observe(ref)).toEqual({ status: 'unknown' });
    await expect(f.adapter().validateWrapperAdmission(ref)).rejects.toThrow('not ready');
    expect(await f.adapter().stop(ref)).toBe('retryable');
    expect(f.operations.get(intent.intentId)?.request).toBeDefined();
    f.setMissing(false);
    expect(await f.adapter().stop(ref)).toBe('terminal');
  });
  it('accepts provisioning without an ENI and validates runtime networking before wrapper admission', async () => {
    const f = ecsProviderFixture();
    const ref = await create(f);
    f.setTaskPatch({
      lastStatus: 'PROVISIONING',
      capacityProviderName: undefined,
      attachments: undefined,
    });
    await f.adapter().launch(ref, startup);
    await expect(f.adapter().validateWrapperAdmission(ref)).rejects.toThrow('not ready');
    f.setTaskPatch({ lastStatus: 'RUNNING' });
    await expect(f.adapter().validateWrapperAdmission(ref)).rejects.toMatchObject({
      reason: 'provider_identity_mismatch',
    });
    expect(await f.adapter().stop(ref)).toBe('terminal');
  });
  it('rejects a shared-container definition before RunTask', async () => {
    const f = ecsProviderFixture();
    const ref = await create(f);
    f.setDefinition({
      ...ecsDefinition(),
      trustedExecutionConfiguration: { isolationMode: 'SHARED' },
    });
    await expect(f.adapter().launch(ref, startup)).rejects.toMatchObject({
      reason: 'invalid_configuration',
    });
    expect(f.submitted).toHaveLength(0);
    expect(await f.adapter().stop(ref)).toBe('terminal');
    expect(f.documents.size).toBe(0);
  });
  it('retains the returned task identity when admission rejects runtime authority', async () => {
    const f = ecsProviderFixture();
    const ref = await create(f);
    f.setTaskPatch({ overrides: { taskRoleArn: 'arn:aws:iam::123456789012:role/unexpected' } });
    await expect(f.adapter().launch(ref, startup)).rejects.toMatchObject({
      reason: 'provider_identity_mismatch',
    });
    expect(f.operations.get(intent.intentId)?.taskArn).toBeDefined();
    expect(await f.adapter().stop(ref)).toBe('terminal');
  });
  it('keeps Stop authoritative when the first Run reply arrives late', async () => {
    const f = ecsProviderFixture();
    const ref = await create(f);
    const waiting = gate();
    f.gateRun(waiting.promise);
    const launch = f.adapter().launch(ref, startup);
    await f.runStarted;
    f.gateRun();
    expect(await f.adapter().stop(ref)).toBe('terminal');
    waiting.release();
    await expect(launch).rejects.toThrow('stopped');
    expect(f.operations.get(intent.intentId)?.phase).toBe('terminated');
    expect([...f.tasks.values()][0].lastStatus).toBe('STOPPED');
  });
  it('prevents a late upload from launching after Stop', async () => {
    const f = ecsProviderFixture();
    const ref = await create(f);
    const waiting = gate();
    f.gatePut(waiting.promise);
    const launch = f.adapter().launch(ref, startup);
    await f.putStarted;
    expect(await f.adapter().stop(ref)).toBe('terminal');
    waiting.release();
    await expect(launch).rejects.toThrow('stopping');
    expect(f.documents.size).toBe(0);
    expect(f.tasks.size).toBe(0);
  });
  it.each(['reconcile', 'stop', 'replace'] as const)(
    'recovers a lost launch after the replay bound for %s without another RunTask',
    async action => {
      const f = ecsProviderFixture();
      const ref = await create(f);
      f.loseNextReply();
      await expect(f.adapter().launch(ref, startup)).rejects.toThrow('TransportError');
      f.setNow(10_001 + AWS_LAUNCH_RECOVERY_MS);
      if (action === 'reconcile') {
        await expect(f.adapter().reconcileLaunch(ref)).resolves.toEqual({ startSource: 'image' });
        expect(f.operations.get(intent.intentId)?.phase).toBe('running');
      } else if (action === 'stop') {
        expect(await f.adapter().stop(ref)).toBe('terminal');
      } else {
        await expect(
          f.adapter().create({ intentId: 'replacement', createdAt: 500_000 })
        ).resolves.toHaveProperty('providerRef');
      }
      expect(f.operations.get(intent.intentId)?.taskArn).toBe([...f.tasks.values()][0].taskArn);
      expect(f.submitted).toHaveLength(1);
      expect(f.discoveries).toEqual([
        { cluster: ECS_TEST_CONFIG.clusterArn, startedBy: f.submitted[0].startedBy, maxResults: 2 },
      ]);
      if (action !== 'reconcile') {
        expect([...f.tasks.values()][0].lastStatus).toBe('STOPPED');
        expect(f.documents.size).toBe(0);
      }
    }
  );
  it.each(['ambiguous', 'incomplete', 'missing'] as const)(
    'keeps %s discovery uncertain without a second launch',
    async kind => {
      const f = ecsProviderFixture();
      const ref = await create(f);
      f.loseNextReply();
      await expect(f.adapter().launch(ref, startup)).rejects.toThrow();
      f.setNow(settledAt);
      const task = [...f.tasks.values()][0];
      if (kind === 'ambiguous')
        f.setDiscoveryResult({ taskArns: [task.taskArn, task.taskArn.replace(/.$/, '2')] });
      if (kind === 'incomplete')
        f.setDiscoveryResult({ taskArns: [task.taskArn], nextToken: 'more' });
      if (kind === 'missing') f.setMissing(true);
      await expect(f.adapter().stop(ref)).rejects.toMatchObject({
        permanentReason: 'provider_cleanup_required',
      });
      expect(f.operations.get(intent.intentId)?.taskArn).toBeUndefined();
      expect(f.submitted).toHaveLength(1);
      expect(task.lastStatus).toBe('RUNNING');
    }
  );
  it.each(['startedBy', 'clusterArn', 'taskArn'] as const)(
    'does not adopt discovery with mismatched %s',
    async field => {
      const f = ecsProviderFixture();
      const ref = await create(f);
      f.loseNextReply();
      await expect(f.adapter().launch(ref, startup)).rejects.toThrow();
      f.setNow(10_001 + AWS_LAUNCH_RECOVERY_MS);
      const task = [...f.tasks.values()][0];
      f.setDiscoveryResult({ taskArns: [task.taskArn] });
      if (field === 'startedBy') task.startedBy = 'another-intent';
      if (field === 'clusterArn') task.clusterArn = task.clusterArn.replace('customer', 'other');
      // Return a foreign-cluster ARN from both reads, despite the cluster metadata.
      if (field === 'taskArn') {
        task.taskArn = task.taskArn.replace('/customer/', '/other/');
        f.setDiscoveryResult({ taskArns: [task.taskArn] });
      }
      await expect(f.adapter().stop(ref)).rejects.toMatchObject({
        reason: 'provider_identity_mismatch',
      });
      expect(f.operations.get(intent.intentId)?.taskArn).toBeUndefined();
      expect(task.lastStatus).toBe('RUNNING');
      expect(f.submitted).toHaveLength(1);
    }
  );
  it('saves discovered identity before mutable runtime admission so Stop can clean it up', async () => {
    const f = ecsProviderFixture();
    const ref = await create(f);
    f.loseNextReply();
    await expect(f.adapter().launch(ref, startup)).rejects.toThrow();
    f.setNow(10_001 + AWS_LAUNCH_RECOVERY_MS);
    const task = [...f.tasks.values()][0];
    task.taskDefinitionArn = task.taskDefinitionArn.replace(':1', ':2');
    await expect(f.adapter().reconcileLaunch(ref)).rejects.toMatchObject({
      reason: 'provider_identity_mismatch',
    });
    expect(f.operations.get(intent.intentId)?.taskArn).toBe(task.taskArn);
    expect(await f.adapter().stop(ref)).toBe('terminal');
    expect(task.lastStatus).toBe('STOPPED');
    expect(f.submitted).toHaveLength(1);
  });
  it('blocks empty discovery until a replay can no longer create the task, then retires it', async () => {
    const f = ecsProviderFixture();
    const ref = await create(f);
    f.loseNextReply();
    await expect(f.adapter().launch(ref, startup)).rejects.toThrow();
    f.setNow(10_001 + AWS_LAUNCH_RECOVERY_MS);
    f.setDiscoveryResult({ taskArns: [] });
    await expect(f.adapter().reconcileLaunch(ref)).rejects.toMatchObject({
      permanentReason: 'provider_cleanup_required',
    });
    await expect(f.adapter().stop(ref)).rejects.toMatchObject({
      permanentReason: 'provider_cleanup_required',
    });
    await expect(
      f.adapter().create({ intentId: 'replacement', createdAt: 20_000 })
    ).rejects.toMatchObject({ permanentReason: 'provider_cleanup_required' });
    expect(f.operations.get(intent.intentId)?.request).toBeDefined();
    f.setNow(settledAt);
    expect(await f.adapter().stop(ref)).toBe('terminal');
    expect(f.operations.get(intent.intentId)?.phase).toBe('terminated');
    await expect(
      f.adapter().create({ intentId: 'replacement', createdAt: 20_000 })
    ).resolves.toHaveProperty('providerRef');
    expect(f.submitted).toHaveLength(1);
    expect(f.documents.size).toBe(0);
  });
  it('retires a lost launch whose task already stopped and ECS no longer lists', async () => {
    const f = ecsProviderFixture();
    const ref = await create(f);
    f.loseNextReply();
    await expect(f.adapter().launch(ref, startup)).rejects.toThrow();
    const task = [...f.tasks.values()][0];
    task.lastStatus = 'STOPPED';
    f.setNow(settledAt);
    await expect(f.adapter().reconcileLaunch(ref)).rejects.toThrow('stopped');
    await expect(
      f.adapter().create({ intentId: 'replacement', createdAt: 20_000 })
    ).resolves.toHaveProperty('providerRef');
    expect(f.operations.get(intent.intentId)?.phase).toBe('terminated');
    expect(f.operations.get(intent.intentId)?.taskArn).toBeUndefined();
    expect(f.submitted).toHaveLength(1);
    expect(await f.adapter().stop(ref)).toBe('terminal');
    expect(f.documents.size).toBe(0);
  });
  it('confirms termination of an aged task that ECS no longer retains', async () => {
    const f = ecsProviderFixture();
    const ref = await create(f);
    await f.adapter().launch(ref, startup);
    f.forgetTasks();
    expect(await f.adapter().stop(ref)).toBe('retryable');
    expect(f.operations.get(intent.intentId)?.phase).toBe('stopping');
    f.setNow(settledAt);
    await expect(
      f.adapter().create({ intentId: 'replacement', createdAt: 20_000 })
    ).resolves.toHaveProperty('providerRef');
    expect(f.operations.get(intent.intentId)?.phase).toBe('terminated');
    expect(f.documents.size).toBe(0);
  });
  it('rejects persisted request fields that differ from the pinned configuration', async () => {
    const f = ecsProviderFixture();
    const ref = await create(f);
    await f.adapter().launch(ref, startup);
    const value = structuredClone(f.operations.get(intent.intentId));
    if (!value?.request) throw new Error('missing checkpoint');
    value.request.networkConfiguration.awsvpcConfiguration.securityGroups[0] =
      'sg-11111111111111111';
    expect(awsEcsOperationSchema.safeParse(value).success).toBe(false);
  });
});
