import { describe, expect, it, vi } from 'vitest';
import { awsProviderFixture } from '../../test/fixtures/aws-provider.js';
import { AWS_LAUNCH_RECOVERY_MS } from './aws-provider.js';
import { encodeAwsProviderRef } from './aws-operation.js';
import { ProviderCreationError } from './provider.js';
import { AwsRequestError } from '@kilocode/worker-utils/aws-client';
import { providerFailureReason } from './provider-failure.js';
import { AwsMicrovmRunRejectedError } from '../agent-sandbox/aws/microvm-client.js';

const intent = { intentId: 'allocation-1', createdAt: 10_000 };
const startup = {
  command: { argv: ['/bin/sh', '-c', 'echo test'] },
  env: { CALLER: 'value', SANDBOX_CONTROL_CREDENTIAL: 'original-credential' },
};
async function create(adapter: ReturnType<ReturnType<typeof awsProviderFixture>['adapter']>) {
  const result = await adapter.create(intent);
  if (!('providerRef' in result)) throw new Error('missing ref');
  return result.providerRef;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { promise, release };
}

describe('AWS durable allocation lifecycle', () => {
  it('creates only an intent; compute starts from the immutable launch document', async () => {
    const f = awsProviderFixture();
    const adapter = f.adapter();
    const ref = await create(adapter);
    expect(f.vms.size).toBe(0);
    expect(await adapter.observe(ref)).toEqual({ status: 'unknown' });
    await adapter.launch(ref, startup);
    expect(f.vms.size).toBe(1);
    expect(f.launchedDocument()).toMatchObject({
      argv: startup.command.argv,
      env: { ...startup.env, PROVIDER_INSTANCE_ID: ref },
    });
    expect(f.operations.get(intent.intentId)).not.toHaveProperty('launchDocument');
    expect(f.operations.get(intent.intentId)).not.toHaveProperty('credentials');
    await adapter.confirmAdmission(ref);
    expect(f.objects.size).toBe(0);
  });

  it('recovers a discarded success across adapter restart without changing URL, token or credential', async () => {
    const f = awsProviderFixture();
    const first = f.adapter();
    const ref = await create(first);
    f.loseNextReply();
    await expect(first.launch(ref, startup)).rejects.toThrow('TransportError');
    expect(f.vms.size).toBe(1);
    expect(f.operations.get(intent.intentId)?.microvmId).toBeUndefined();
    const restarted = f.adapter();
    await restarted.reconcileLaunch(ref);
    expect(f.vms.size).toBe(1);
    expect(f.submitted).toHaveLength(2);
    expect(f.submitted[1]).toEqual(f.submitted[0]);
    expect(f.signedUrls()).toBe(1);
    expect(f.launchedDocument().env.SANDBOX_CONTROL_CREDENTIAL).toBe('original-credential');
    expect(await restarted.observe(ref)).toEqual({ status: 'active' });
  });

  it('retires a definite first rejection and admits the next message after the replay bound', async () => {
    const f = awsProviderFixture();
    const adapter = f.adapter();
    const ref = await create(adapter);
    f.rejectNextRun(new AwsMicrovmRunRejectedError(403, 'AccessDeniedException'));
    await expect(adapter.launch(ref, startup)).rejects.toMatchObject({
      reason: 'byoc_aws_forbidden',
    });
    expect(f.operations.get(intent.intentId)?.phase).toBe('terminated');
    expect(f.vms.size).toBe(0);
    f.setNow(10_001 + AWS_LAUNCH_RECOVERY_MS);
    const next = await f.adapter().create({ intentId: 'next-allocation', createdAt: 20_000 });
    if (!('providerRef' in next)) throw new Error('missing ref');
    await f.adapter().launch(next.providerRef, startup);
    expect(f.vms.size).toBe(1);
  });

  it('does not treat a rejected replay as proof that an earlier submission failed', async () => {
    const f = awsProviderFixture();
    const adapter = f.adapter();
    const ref = await create(adapter);
    f.loseNextReply();
    await expect(adapter.launch(ref, startup)).rejects.toThrow('TransportError');
    f.rejectNextRun(new AwsMicrovmRunRejectedError(403, 'AccessDeniedException'));
    await expect(f.adapter().reconcileLaunch(ref)).rejects.toMatchObject({
      reason: 'byoc_aws_forbidden',
    });
    expect(f.operations.get(intent.intentId)?.phase).toBe('launching');
    expect(f.vms.size).toBe(1);
    await f.adapter().reconcileLaunch(ref);
    expect(f.vms.size).toBe(1);
    expect(f.operations.get(intent.intentId)?.microvmId).toBe('microvm-1');
  });

  it('preserves uncertainty for legacy records without submission evidence', async () => {
    const f = awsProviderFixture();
    const adapter = f.adapter();
    const ref = await create(adapter);
    f.loseNextReply();
    await expect(adapter.launch(ref, startup)).rejects.toThrow();
    const value = f.operations.get(intent.intentId);
    if (!value) throw new Error('missing operation');
    delete value.submission;
    f.rejectNextRun(new AwsMicrovmRunRejectedError(403, 'AccessDeniedException'));
    await expect(f.adapter().reconcileLaunch(ref)).rejects.toThrow();
    expect(f.operations.get(intent.intentId)?.phase).toBe('launching');
    expect(f.vms.size).toBe(1);
  });

  it('does not retire another successful submission when the first rejection arrives late', async () => {
    const f = awsProviderFixture();
    const adapter = f.adapter();
    const ref = await create(adapter);
    const waiting = gate();
    f.gateRun(waiting.promise);
    f.rejectNextRun(new AwsMicrovmRunRejectedError(403, 'AccessDeniedException'));
    const first = expect(adapter.launch(ref, startup)).rejects.toMatchObject({
      reason: 'byoc_aws_forbidden',
    });
    await vi.waitFor(() => expect(f.submitted).toHaveLength(1));
    f.gateRun(undefined);
    await f.adapter().reconcileLaunch(ref);
    waiting.release();
    await first;
    expect(f.operations.get(intent.intentId)?.phase).toBe('running');
    expect(f.operations.get(intent.intentId)?.microvmId).toBe('microvm-1');
    expect(f.vms.size).toBe(1);
  });

  it('keeps an unclassified provider failure uncertain', async () => {
    const f = awsProviderFixture();
    const adapter = f.adapter();
    const ref = await create(adapter);
    f.rejectNextRun(new AwsRequestError(503, 'InternalServerException'));
    await expect(adapter.launch(ref, startup)).rejects.toThrow();
    expect(f.operations.get(intent.intentId)?.phase).toBe('launching');
  });

  it('stops an ambiguous launch using the exact checkpoint before confirming termination', async () => {
    const f = awsProviderFixture();
    const adapter = f.adapter();
    const ref = await create(adapter);
    f.loseNextReply();
    await expect(adapter.launch(ref, startup)).rejects.toThrow();
    expect(await f.adapter().stop(ref)).toBe('terminal');
    expect(f.vms.size).toBe(1);
    expect([...f.vms.values()][0]?.current.state).toBe('TERMINATED');
    expect(f.objects.size).toBe(0);
    expect(f.submitted[1]).toEqual(f.submitted[0]);
  });

  it('uses a fresh Get after a replay returns stale PENDING for a terminated VM', async () => {
    const f = awsProviderFixture();
    const adapter = f.adapter();
    const ref = await create(adapter);
    f.loseNextReply();
    await expect(adapter.launch(ref, startup)).rejects.toThrow();
    f.setRunning(false);
    await expect(f.adapter().reconcileLaunch(ref)).rejects.toThrow('stopped');
    expect(f.vms.size).toBe(1);
    expect(await f.adapter().stop(ref)).toBe('terminal');
  });

  it('does not replay beyond the recovery bound or hide unresolved cleanup', async () => {
    const f = awsProviderFixture();
    const adapter = f.adapter();
    const ref = await create(adapter);
    f.loseNextReply();
    await expect(adapter.launch(ref, startup)).rejects.toThrow();
    f.setNow(10_001 + AWS_LAUNCH_RECOVERY_MS);
    expect(await adapter.observe(ref)).toEqual({ status: 'unknown' });
    expect(f.submitted).toHaveLength(1);
    await expect(adapter.reconcileLaunch(ref)).rejects.toMatchObject({
      permanentReason: 'provider_cleanup_required',
    });
    await expect(adapter.validateWrapperAdmission(ref)).rejects.toMatchObject({
      permanentReason: 'provider_cleanup_required',
    });
    await expect(adapter.stop(ref)).rejects.toMatchObject({
      permanentReason: 'provider_cleanup_required',
    });
    expect(f.submitted).toHaveLength(1);
    await expect(
      adapter.create({ intentId: 'next-allocation', createdAt: 20_000 })
    ).rejects.toMatchObject({ permanentReason: 'provider_cleanup_required' });
    expect(f.operations.get(intent.intentId)?.request).toEqual(f.submitted[0]);
    expect(f.operations.has('next-allocation')).toBe(false);
  });

  it('persists confirmed termination before launch document cleanup and retries cleanup after restart', async () => {
    const f = awsProviderFixture();
    const adapter = f.adapter();
    const ref = await create(adapter);
    await adapter.launch(ref, startup);
    f.failDelete(true);
    expect(await adapter.stop(ref)).toBe('terminal');
    expect(await adapter.stop(ref)).toBe('terminal');
    expect([...f.vms.values()][0]?.current.state).toBe('TERMINATED');
    expect(f.operations.get(intent.intentId)?.phase).toBe('terminated');
    expect(f.objects.size).toBe(1);

    const restarted = f.adapter();
    expect(await restarted.observe(ref)).toEqual({ status: 'terminal' });
    await expect(
      restarted.create({ intentId: 'next-allocation', createdAt: 20_000 })
    ).resolves.toHaveProperty('providerRef');
    f.failDelete(false);
    expect(await restarted.stop(ref)).toBe('terminal');
    expect(f.objects.size).toBe(0);
    expect(f.submitted).toHaveLength(1);
  });

  it('does not persist termination when the compute stop fails', async () => {
    const f = awsProviderFixture();
    const adapter = f.adapter();
    const ref = await create(adapter);
    await adapter.launch(ref, startup);
    f.failStop();
    expect(await adapter.stop(ref)).toBe('retryable');
    expect(f.operations.get(intent.intentId)?.phase).toBe('stopping');
    expect([...f.vms.values()][0]?.current.state).toBe('RUNNING');
    expect(f.objects.size).toBe(1);
    await expect(
      adapter.create({ intentId: 'next-allocation', createdAt: 20_000 })
    ).rejects.toBeInstanceOf(ProviderCreationError);
  });

  it('stops a known physical allocation after the launch replay window', async () => {
    const f = awsProviderFixture();
    const adapter = f.adapter();
    const ref = await create(adapter);
    await adapter.launch(ref, startup);
    f.setNow(10_001 + AWS_LAUNCH_RECOVERY_MS);
    expect(await adapter.stop(ref)).toBe('terminal');
    expect(f.submitted).toHaveLength(1);
    expect([...f.vms.values()][0]?.current.state).toBe('TERMINATED');
  });

  it('stops a prepared request before its first submission and prevents a late launch', async () => {
    const f = awsProviderFixture();
    const waiting = gate();
    const adapter = f.adapter({
      ...f.storage,
      async update(id, transition) {
        const value = await f.storage.update(id, transition);
        if (value.submission === 'prepared') await waiting.promise;
        return value;
      },
    });
    const ref = await create(adapter);
    const launch = expect(adapter.launch(ref, startup)).rejects.toThrow('stopped');
    await vi.waitFor(() => expect(f.operations.get(intent.intentId)?.submission).toBe('prepared'));
    f.setNow(10_001 + AWS_LAUNCH_RECOVERY_MS);
    expect(await f.adapter().stop(ref)).toBe('terminal');
    waiting.release();
    await launch;
    expect(f.submitted).toHaveLength(0);
    expect(f.vms.size).toBe(0);
    expect(f.operations.get(intent.intentId)?.phase).toBe('terminated');
  });

  it('prevents Stop during upload from creating a later VM', async () => {
    const f = awsProviderFixture();
    const adapter = f.adapter();
    const ref = await create(adapter);
    const waiting = gate();
    f.gatePut(waiting.promise);
    const launch = adapter.launch(ref, startup);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await adapter.stop(ref)).toBe('terminal');
    waiting.release();
    await expect(launch).rejects.toThrow('stopping');
    expect(f.vms.size).toBe(0);
  });

  it('keeps a stop fence when the original Run response returns late', async () => {
    const f = awsProviderFixture();
    const adapter = f.adapter();
    const ref = await create(adapter);
    const waiting = gate();
    f.gateRun(waiting.promise);
    const launch = adapter.launch(ref, startup);
    await f.runStarted;
    f.gateRun(undefined);
    expect(await adapter.stop(ref)).toBe('terminal');
    waiting.release();
    await expect(launch).rejects.toThrow();
    expect([...f.vms.values()][0]?.current.state).toBe('TERMINATED');
    expect(f.operations.get(intent.intentId)?.phase).toBe('terminated');
  });

  it('rejects unexpected runtime credentials and still retains cleanup authority', async () => {
    const f = awsProviderFixture();
    f.overrideResponse({ executionRoleArn: 'arn:aws:iam::123456789012:role/unexpected' });
    const adapter = f.adapter();
    const ref = await create(adapter);
    await expect(adapter.launch(ref, startup)).rejects.toMatchObject({
      reason: 'provider_identity_mismatch',
    });
    await expect(adapter.validateWrapperAdmission?.(ref)).rejects.toMatchObject({
      reason: 'provider_identity_mismatch',
    });
    expect(await adapter.stop(ref)).toBe('terminal');
  });

  it('preserves revoked access through cleanup, creation, hello and reconciliation', async () => {
    const f = awsProviderFixture();
    const adapter = f.adapter();
    const ref = await create(adapter);
    f.loseNextReply();
    await expect(adapter.launch(ref, startup)).rejects.toThrow('TransportError');
    f.failRuntime(new AwsRequestError(403, 'AccessDeniedException'));
    for (const operation of [
      () => adapter.validateWrapperAdmission(ref),
      () => adapter.reconcileLaunch(ref),
      () => adapter.stop(ref),
      () => adapter.create({ intentId: 'next-allocation', createdAt: 20_000 }),
    ]) {
      const before = f.runtimeReads();
      const failure = await operation().catch((error: unknown) => error);
      expect(providerFailureReason(failure)).toBe('byoc_aws_forbidden');
      expect(f.runtimeReads() - before).toBe(1);
    }
    expect(f.vms.size).toBe(1);
    expect(f.operations.has('next-allocation')).toBe(false);
  });

  it('keeps lifetime and lease reads local and refuses foreign authority', async () => {
    const f = awsProviderFixture();
    const adapter = f.adapter();
    const ref = await create(adapter);
    await adapter.launch(ref, startup);
    const reads = f.runtimeReads();
    const runs = f.submitted.length;
    expect(await adapter.lifetimeDeadlineAt(ref)).toBe(10_000 + 28_800_000 - 120_000);
    await adapter.ensureLeaseAtLeast(ref, 1000);
    await adapter.reconcileLaunch(ref);
    expect(f.runtimeReads()).toBe(reads);
    expect(f.submitted).toHaveLength(runs);
    const foreign = encodeAwsProviderRef({
      provider: 'aws',
      sandboxId: 'foreign',
      intentId: intent.intentId,
      createdAt: 10_000,
    });
    await expect(adapter.launch(foreign, startup)).rejects.toBeInstanceOf(ProviderCreationError);
    expect(await adapter.stop(foreign)).toBe('retryable');
  });
});
