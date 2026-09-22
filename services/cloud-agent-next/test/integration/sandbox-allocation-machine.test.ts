import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AttachSessionInput, SandboxControl } from '../../src/persistence/SandboxControl.js';
import { getSandboxSessionStub } from '../../src/sandbox-session/session-stub.js';
import { createMemoryProviderAdapter } from '../../src/sandbox-control/provider.js';
import { encodeCloudflareProviderRef } from '../../src/sandbox-control/cloudflare-provider.js';
import { ALLOCATION_TRANSITION_EVENT } from '../../src/sandbox-control/allocation-transition.js';
import { readCanonicalAllocationRecord } from '../../src/sandbox-state/persist/access.js';
import type { AllocationRecord } from '../../src/sandbox-state/model/allocation.js';
import { seedCanonicalRunning } from './canonical-allocation-fixtures.js';
import { deriveKiloSandboxTargets } from '../../src/kilo/kilo-targets.js';

const ownerId = 'user_allocation_machine';
const kiloToken = 'allocation-machine-kilo-token';

async function readState(storage: Parameters<typeof readCanonicalAllocationRecord>[0]) {
  return (await readCanonicalAllocationRecord(storage)) as AllocationRecord | undefined;
}

/**
 * Capture the canonical transitions reported from the single dispatch boundary
 * by shadowing the DO's private `logDiagnostic` with a direct assignment (the
 * same pattern the stale-fence test uses for `controller.dispatch`).
 */
function captureAllocationTransitions(instance: SandboxControl): Array<Record<string, unknown>> {
  const emissions: Array<Record<string, unknown>> = [];
  const target = instance as unknown as {
    logDiagnostic(event: string, fields: Record<string, unknown>, level?: 'info' | 'warn'): void;
  };
  const original = target.logDiagnostic.bind(instance);
  target.logDiagnostic = (event, fields, level) => {
    if (event === ALLOCATION_TRANSITION_EVENT) emissions.push(fields);
    original(event, fields, level);
  };
  return emissions;
}

function installMemoryProvider(
  instance: SandboxControl,
  provider = createMemoryProviderAdapter()
): ReturnType<typeof createMemoryProviderAdapter> {
  const targets = deriveKiloSandboxTargets({}, kiloToken);
  if (!targets.success) throw new Error('Invalid allocation-machine targets');
  Object.assign(instance, {
    provider,
    createProviderAdapter: () => provider,
    providerBinding: { kind: 'cloudflare' },
    env: {
      ...instance['env'],
      KILOCODE_BACKEND_BASE_URL: targets.targets.backendBaseUrl,
      KILO_OPENROUTER_BASE: targets.targets.providerBaseUrl,
      KILO_SESSION_INGEST_URL: targets.targets.sessionIngestBaseUrl,
      GIT_TOKEN_SERVICE: {
        async issueKiloSessionCapability() {
          return { success: true, capability: `kka1.${crypto.randomUUID()}` };
        },
      },
      SandboxSmallContainment: {
        idFromName: (name: string) => ({ toString: () => `contained-small:${name}` }),
      },
    },
  });
  return provider;
}

describe('sandbox allocation machine (live wiring)', () => {
  it('creates through the canonical create effect and settles to stopped on demand', async () => {
    const stub = env.SANDBOX_CONTROL.getByName(`ses-${crypto.randomUUID().replaceAll('-', '')}`);
    await runInDurableObject(stub, async (instance, state) => {
      installMemoryProvider(instance);
      const input: AttachSessionInput = {
        sessionId: `workspace_${crypto.randomUUID()}`,
        kiloSessionId: `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`,
        directory: '/workspace/allocation-machine',
        ownerId,
      };
      await instance.initializeOwner(ownerId);

      const sessionStub = getSandboxSessionStub(env, ownerId, input.sessionId);
      await runInDurableObject(sessionStub, async session => {
        const registered = await session.registerSession({
          identity: {
            sessionId: input.sessionId,
            userId: ownerId,
            createdOnPlatform: 'cloud-agent-web',
          },
          auth: { kiloSessionId: input.kiloSessionId, kilocodeToken: kiloToken },
          agent: { mode: 'code', model: 'test-model' },
          workspace: { sandboxId: instance.sandboxId, sandboxProvider: 'cloudflare' },
        });
        expect(registered.success).toBe(true);
      });

      const created = await instance.ensureReady({
        ownerId,
        sessionId: input.sessionId,
        provider: 'cloudflare',
        allowCreate: true,
      });
      expect(created.physical).toBe('running');
      expect((await readState(state.storage))?.state.kind).toBe('allocated');

      const stopped = await instance.beginStop('test');
      expect(stopped.state.kind).toBe('stopped');
      expect((await readState(state.storage))?.state.kind).toBe('stopped');
    });
  });

  it('stops a healthy idle allocation at its idle deadline exactly once', async () => {
    const stub = env.SANDBOX_CONTROL.getByName(`ses-${crypto.randomUUID().replaceAll('-', '')}`);
    await runInDurableObject(stub, async (instance, state) => {
      const provider = installMemoryProvider(instance);
      const emissions = captureAllocationTransitions(instance);
      const providerRef = encodeCloudflareProviderRef({
        sandboxId: instance.sandboxId,
        containment: true,
        instanceId: 'idle-intent',
      });
      await instance.initializeOwner(ownerId);
      await seedCanonicalRunning(state.storage, providerRef, {
        provider: 'cloudflare',
        intentId: 'idle-intent',
        allocationName: instance.sandboxId,
        health: 'healthy',
        idleAt: Date.now() - 1,
      });

      await instance.alarm();
      const stopping = await readState(state.storage);
      expect(stopping?.state.kind === 'stopping' || stopping?.state.kind === 'stopped').toBe(true);

      await instance.alarm();
      expect((await readState(state.storage))?.state.kind).toBe('stopped');
      const idleStops = emissions.filter(fields => fields.to === 'stopped');
      expect(idleStops).toHaveLength(1);
      expect(provider.lastLeaseMs).toBeDefined();
    });
  });

  it('exits check_required through an explicit CHECK', async () => {
    const stub = env.SANDBOX_CONTROL.getByName(`ses-${crypto.randomUUID().replaceAll('-', '')}`);
    await runInDurableObject(stub, async (instance, state) => {
      const provider = createMemoryProviderAdapter({ stopRetryable: true });
      installMemoryProvider(instance, provider);
      const providerRef = encodeCloudflareProviderRef({
        sandboxId: instance.sandboxId,
        containment: true,
        instanceId: 'check-intent',
      });
      await instance.initializeOwner(ownerId);
      await seedCanonicalRunning(state.storage, providerRef, {
        provider: 'cloudflare',
        intentId: 'check-intent',
        allocationName: instance.sandboxId,
        health: 'healthy',
      });

      await instance.beginStop('test');
      const exhausted = await readState(state.storage);
      expect(exhausted?.state.kind).toBe('stopping');
      if (exhausted?.state.kind !== 'stopping') return;
      expect(exhausted.state.step).toBe('check_required');

      // The provider reports absence only when the explicit CHECK observes it.
      const settled = await instance.confirmStopped();
      expect(settled.state.kind).toBe('stopped');
      expect((await readState(state.storage))?.state.kind).toBe('stopped');
    });
  });

  it('rejects a stale fenced stop result after replacement without a second terminalization', async () => {
    const stub = env.SANDBOX_CONTROL.getByName(`ses-${crypto.randomUUID().replaceAll('-', '')}`);
    await runInDurableObject(stub, async (instance, state) => {
      installMemoryProvider(instance);
      const emissions = captureAllocationTransitions(instance);
      const sessionId = `workspace_${crypto.randomUUID()}`;
      const kiloSessionId = `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
      await instance.initializeOwner(ownerId);
      const sessionStub = getSandboxSessionStub(env, ownerId, sessionId);
      await runInDurableObject(sessionStub, async session => {
        await session.registerSession({
          identity: { sessionId, userId: ownerId, createdOnPlatform: 'cloud-agent-web' },
          auth: { kiloSessionId, kilocodeToken: kiloToken },
          agent: { mode: 'code', model: 'test-model' },
          workspace: { sandboxId: instance.sandboxId, sandboxProvider: 'cloudflare' },
        });
      });

      const firstRef = encodeCloudflareProviderRef({
        sandboxId: instance.sandboxId,
        containment: true,
        instanceId: 'stale-intent',
      });
      await seedCanonicalRunning(state.storage, firstRef, {
        provider: 'cloudflare',
        intentId: 'stale-intent',
        allocationName: instance.sandboxId,
        health: 'healthy',
      });
      const first = await readState(state.storage);
      if (first?.state.kind !== 'allocated') throw new Error('Missing first allocation');

      // Capture the *real* `DESTROY_CONFIRMED` the first allocation produces.
      // Effect results are fed back through the controller's dispatch (the
      // orchestrator only front-ends the initial event), so wrap the controller.
      const orchestrator = instance['allocationOrchestrator'] as {
        controller: { dispatch(event: unknown, now?: number): Promise<unknown> };
      };
      const controller = orchestrator.controller;
      const originalControllerDispatch = controller.dispatch.bind(controller);
      let staleConfirmation: unknown;
      controller.dispatch = async (event: unknown, now?: number) => {
        if (
          staleConfirmation === undefined &&
          (event as { type?: string }).type === 'DESTROY_CONFIRMED'
        ) {
          staleConfirmation = structuredClone(event);
        }
        return originalControllerDispatch(event, now);
      };

      // Retire the first allocation and provision a replacement.
      await instance.beginStop('test');
      await instance.confirmStopped();
      expect((await readState(state.storage))?.state.kind).toBe('stopped');
      if (staleConfirmation === undefined) throw new Error('No first confirmation captured');

      await instance.ensureReady({ ownerId, sessionId, provider: 'cloudflare', allowCreate: true });
      const created = await readState(state.storage);
      expect(created?.state.kind).toBe('allocated');

      // Park the replacement in `stopping.destroying`, where `DESTROY_CONFIRMED`
      // *is* a supported event, so only the fence can reject the stale result.
      await controller.dispatch({ type: 'CANCEL', scope: 'allocation', reason: 'test' });
      const replacement = await readState(state.storage);
      expect(replacement?.state.kind).toBe('stopping');
      if (replacement?.state.kind !== 'stopping') return;
      expect(replacement.state.step).toBe('destroying');

      const stoppedEmissions = () => emissions.filter(fields => fields.to === 'stopped').length;
      const before = stoppedEmissions();
      // The first allocation's `confirmStopped` must have produced the terminal
      // emission, so the stale-fence check below is not vacuous.
      expect(before).toBeGreaterThanOrEqual(1);

      // The old allocation's real confirmation must be fenced out: unchanged
      // replacement state and no second terminalization.
      await controller.dispatch(staleConfirmation);
      expect(await readState(state.storage)).toEqual(replacement);
      expect(stoppedEmissions()).toBe(before);

      // A duplicate stale result must not terminalize either.
      await controller.dispatch(staleConfirmation);
      expect(await readState(state.storage)).toEqual(replacement);
      expect(stoppedEmissions()).toBe(before);
    });
  });
});
