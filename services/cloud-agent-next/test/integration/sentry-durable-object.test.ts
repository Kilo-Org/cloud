import {
  env,
  abortAllDurableObjects,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import type { ErrorEvent } from '@sentry/core';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { setBillingContext } from '@kilocode/container-usage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { containerLimitError } from '../../src/container-limit-test-helpers.js';
import {
  SandboxControlV2,
  type StoredProviderPin,
} from '../../src/control-plane/sandbox/sandbox-do.js';
import { allocation } from '../../src/control-plane/sandbox/sqlite-schema.js';
import { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { SandboxContainers } from '../../src/sandbox-containers/SandboxContainers.js';
import { instrumentCloudAgentDurableObject } from '../../src/sentry.js';
import type { Env } from '../../src/types.js';
import type {
  SentryBillingAdmissionContainer,
  SentryDurableObjectProbe,
} from './helpers/sentry-durable-object.js';
import { waitFor } from './wait-for.js';

type ProbeNamespace = DurableObjectNamespace<SentryDurableObjectProbe>;
const probes = env as typeof env & {
  SENTRY_SESSION_PROBE: ProbeNamespace;
  SENTRY_LEGACY_SESSION_PROBE: ProbeNamespace;
  SENTRY_SANDBOX_CONTROL_PROBE: ProbeNamespace;
  SENTRY_SANDBOX_CONTAINER_PROBE: ProbeNamespace;
  SENTRY_BILLING_ADMISSION_CONTAINER: DurableObjectNamespace<SentryBillingAdmissionContainer>;
  SENTRY_DISABLED_PROBE: ProbeNamespace;
};

const billingInput = {
  sandboxId: 'ses-0123456789abcdef',
  subject: { type: 'user', id: 'test-user' },
  actor: { type: 'user', id: 'test-user' },
  sessionId: 'workspace_test',
  metadata: { origin: 'cloud-agent' },
};

let events: ErrorEvent[];
let envelopeTypes: string[];
let transport: ReturnType<typeof vi.fn>;

beforeEach(() => {
  events = [];
  envelopeTypes = [];
  transport = vi.fn(async (input: string, init: RequestInit) => {
    expect(new URL(input).origin).toBe('https://o1.ingest.sentry.io');
    expect(new URL(input).pathname).toBe('/api/42/envelope/');
    expect(init.method).toBe('POST');
    if (typeof init.body !== 'string') throw new Error('Expected a serialized Sentry envelope');
    const lines = init.body.split('\n');
    for (let index = 1; index < lines.length; index += 2) {
      const header = JSON.parse(lines[index]) as { type: string };
      envelopeTypes.push(header.type);
      if (header.type === 'event') events.push(JSON.parse(lines[index + 1]) as ErrorEvent);
    }
    return new Response('', { status: 200 });
  });
  vi.stubGlobal('fetch', transport);
});

afterEach(async () => {
  await abortAllDurableObjects();
  await reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function captured(count: number): Promise<void> {
  await waitFor(() => expect(events).toHaveLength(count));
  expect(envelopeTypes).toEqual(Array.from({ length: count }, () => 'event'));
}

const telemetryEnv = {
  ...env,
  CLOUD_AGENT_SENTRY_DSN: 'https://public@o1.ingest.sentry.io/42',
  CLOUD_AGENT_SENTRY_ENVIRONMENT: 'test',
} as Env;
const sandboxId = `ses-${'a'.repeat(48)}`;
const sessionId = 'workspace_stored';
const userId = 'oauth/google:123456';
const subject = { type: 'org', id: 'org-stored' } as const;

describe('Cloud Agent Durable Object real SDK boundaries', () => {
  it('returns a container limit rejection across RPC without sending it to Sentry', async () => {
    const stub = probes.SENTRY_BILLING_ADMISSION_CONTAINER.getByName(billingInput.sandboxId);
    await expect(stub.ensureBillingAdmission(billingInput, 'standard-4')).resolves.toEqual({
      success: false,
      code: 'container_limit_reached',
      message: containerLimitError('user', 3).message,
    });
    await runInDurableObject(stub, () => undefined);
    expect(transport).not.toHaveBeenCalled();
  });

  it('still captures unexpected billing admission faults', async () => {
    const stub = probes.SENTRY_BILLING_ADMISSION_CONTAINER.getByName(billingInput.sandboxId);
    await runInDurableObject(stub, (_instance, ctx) =>
      ctx.storage.put('container-usage:budget-block:v1', {})
    );
    await expect(
      async () => await stub.ensureBillingAdmission(billingInput, 'standard-4')
    ).rejects.toThrow('ZodError');
    await captured(1);
    expect(events[0]?.contexts?.cloud_agent).toEqual({
      component: 'sandbox-container',
      sandboxId: billingInput.sandboxId,
    });
    expect(events[0]?.exception?.values?.[0]?.mechanism).toEqual({
      type: 'auto.faas.cloudflare.durable_object',
      handled: false,
    });
  });

  it('uses persisted session metadata instead of deriving user identity from the DO name', async () => {
    const InstrumentedSession = instrumentCloudAgentDurableObject(SandboxSessionV2, 'session');
    const stub = env.SANDBOX_SESSION.getByName('private-do-owner:workspace_name');
    await runInDurableObject(stub, async (instance, ctx) => {
      await instance.getMetadata();
      await ctx.storage.put('session_metadata', {
        metadataSchemaVersion: 2,
        identity: { userId, orgId: subject.id, sessionId },
        auth: { kilocodeToken: 'private-session-token' },
        workspace: { sandboxId, sandboxProvider: 'cloudflare-containers' },
        lifecycle: { version: 1, timestamp: 1 },
      });
      const session = new InstrumentedSession(ctx, telemetryEnv);
      await expect(session.finishWorktreeDeletion('not-a-worktree')).rejects.toThrow();
    });
    await captured(1);
    expect(events[0]?.user).toEqual({ id: userId });
    expect(events[0]?.tags).toEqual({
      component: 'session',
      orgId: subject.id,
      sessionId,
      sandboxId,
    });
    expect(JSON.stringify(events)).not.toContain('private-');
  });

  it('uses the stored sandbox owner and allocation attribution', async () => {
    const InstrumentedSandbox = instrumentCloudAgentDurableObject(
      SandboxControlV2,
      'sandbox-control'
    );
    const stub = env.SANDBOX_CONTROL.getByName(sandboxId);
    await runInDurableObject(stub, async (instance, ctx) => {
      await instance.getAllocationState();
      await ctx.storage.put('control_plane_owner', userId);
      const pin: StoredProviderPin = {
        provider: 'cloudflare-containers',
        allocationName: sandboxId,
        configuration: null,
        locator: null,
        containment: null,
        billing: {
          sandboxId,
          sessionId,
          subject,
          actor: { type: 'bot', id: 'private-bot-id' },
          onBehalfOf: subject,
        },
      };
      drizzle(ctx.storage)
        .update(allocation)
        .set({ provider_pin: JSON.stringify(pin) })
        .run();
      const sandbox = new InstrumentedSandbox(ctx, telemetryEnv);
      await expect(sandbox.getSnapshotValidatorStatus()).rejects.toThrow('not registered');
    });
    await captured(1);
    expect(events[0]?.user).toEqual({ id: userId });
    expect(events[0]?.tags).toEqual({
      component: 'sandbox-control',
      orgId: subject.id,
      sessionId,
      sandboxId,
    });
    expect(JSON.stringify(events)).not.toContain('private-');
  });

  it('uses the persisted Kilo user, not the bot actor, from native container billing', async () => {
    const InstrumentedContainers = instrumentCloudAgentDurableObject(
      SandboxContainers,
      'sandbox-container'
    );
    const stub = env.SANDBOX_CONTAINERS.getByName(sandboxId);
    await runInDurableObject(stub, async (_instance, ctx) => {
      await setBillingContext(ctx.storage, {
        service: 'cloud-agent-next-test',
        instanceId: sandboxId,
        sku: 'test-sku',
        startEpochMs: 0,
        sessionId,
        subject,
        actor: { type: 'bot', id: 'private-bot-id' },
        onBehalfOf: subject,
        metadata: { billingUserId: userId, prompt: 'private-billing-metadata' },
      });
      const containers = new InstrumentedContainers(ctx, telemetryEnv);
      await expect(containers.forceDestroyForControlPlane()).rejects.toThrow('unavailable');
    });
    await captured(1);
    expect(events[0]?.user).toEqual({ id: userId });
    expect(events[0]?.tags).toEqual({
      component: 'sandbox-container',
      orgId: subject.id,
      sessionId,
      sandboxId,
    });
    expect(JSON.stringify(events)).not.toContain('private-');
  });

  it.each([
    [
      'SENTRY_SESSION_PROBE',
      'session',
      'sessionId',
      'private-owner:workspace_session',
      'workspace_session',
    ],
    [
      'SENTRY_LEGACY_SESSION_PROBE',
      'legacy-session',
      'sessionId',
      'oauth/google:private-owner:agent_legacy',
      'agent_legacy',
    ],
    [
      'SENTRY_SANDBOX_CONTROL_PROBE',
      'sandbox-control',
      'sandboxId',
      'sandbox_control',
      'sandbox_control',
    ],
    [
      'SENTRY_SANDBOX_CONTAINER_PROBE',
      'sandbox-container',
      'sandboxId',
      'sandbox_container',
      'sandbox_container',
    ],
  ] as const)(
    'captures untraced RPC failures for %s with the DO identity',
    async (binding, component, identity, name, canonicalId) => {
      const stub = probes[binding].getByName(name);
      expect(await stub.snapshot()).toMatchObject({
        name,
        constructed: true,
        value: 42,
        instrumentedContext: true,
        hasSentryClient: true,
      });
      expect(await stub.roundTrip(7)).toBe(7);
      await expect(async () => await stub.rpcFailure()).rejects.toThrow(
        'private-async-rpc-failure'
      );
      await captured(1);
      expect(events[0]?.contexts?.cloud_agent).toEqual({ component, [identity]: canonicalId });
      expect(events[0]).not.toHaveProperty('user');
      expect(events[0]?.tags).not.toHaveProperty('orgId');
      expect(events[0]?.exception?.values?.[0]?.type).toBe('TypeError');
      expect(events[0]?.exception?.values?.[0]?.mechanism).toEqual({
        type: 'auto.faas.cloudflare.durable_object',
        handled: false,
      });
      expect(events[0]?.exception?.values?.[0]?.stacktrace?.frames?.length).toBeGreaterThan(0);
      expect(events[0]?.environment).toBe('test');
      expect(events[0]?.release).toBe('sentry-worker-test-version');
      expect(JSON.stringify(events)).not.toContain('private-');
    }
  );

  it('preserves synchronous RPC errors and captures them without caller trace metadata', async () => {
    const stub = probes.SENTRY_SESSION_PROBE.getByName('private-owner:workspace_sync');
    await expect(async () => await stub.rpcSyncFailure()).rejects.toThrow(
      'private-sync-rpc-failure'
    );
    await captured(1);
    expect(events[0]?.exception?.values?.[0]?.type).toBe('RangeError');
    expect(events[0]?.contexts?.cloud_agent).toEqual({
      component: 'session',
      sessionId: 'workspace_sync',
    });
  });

  it.each([
    'UNAUTHORIZED',
    'FORBIDDEN',
    'BAD_REQUEST',
    'PAYMENT_REQUIRED',
    'NOT_FOUND',
    'CONFLICT',
  ] as const)(
    'does not transport expected %s RPC failures or change their rejection',
    async code => {
      const stub = probes.SENTRY_SESSION_PROBE.getByName(
        `private-owner:workspace_expected_${code}`
      );
      await expect(async () => await stub.rpcFailure(code)).rejects.toThrow('private-trpc-failure');
      await runInDurableObject(stub, () => undefined);
      expect(events).toEqual([]);
      expect(transport).not.toHaveBeenCalled();
    }
  );

  it('captures INTERNAL_SERVER_ERROR tRPC failures', async () => {
    const stub = probes.SENTRY_SESSION_PROBE.getByName('private-owner:workspace_internal');
    await expect(async () => await stub.rpcFailure('INTERNAL_SERVER_ERROR')).rejects.toThrow(
      'private-trpc-failure'
    );
    await captured(1);
    expect(events[0]?.exception?.values?.[0]?.type).toBe('TRPCError');
  });

  it('captures an actual alarm failure and preserves the storage side effect', async () => {
    const stub = probes.SENTRY_SANDBOX_CONTROL_PROBE.getByName('sandbox_alarm');
    await stub.scheduleAlarm();
    await expect(runDurableObjectAlarm(stub)).rejects.toThrow('private-alarm-failure');
    await captured(1);
    expect(await runInDurableObject(stub, (_instance, ctx) => ctx.storage.get('alarm-ran'))).toBe(
      true
    );
    expect(events[0]?.contexts?.cloud_agent).toEqual({
      component: 'sandbox-control',
      sandboxId: 'sandbox_alarm',
    });
    expect(events[0]?.exception?.values?.[0]?.type).toBe('Error');
  });

  it('captures actual hibernatable WebSocket message failures', async () => {
    const stub = probes.SENTRY_SESSION_PROBE.getByName('private-owner:workspace_websocket');
    const response = await stub.fetch('https://probe.test/', {
      headers: { Upgrade: 'websocket' },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error('The test Durable Object did not return a WebSocket');
    socket.accept();
    const pong = new Promise(resolve =>
      socket.addEventListener('message', resolve, { once: true })
    );
    socket.send('ping');
    await pong;
    expect(transport).not.toHaveBeenCalled();
    socket.send('fail');
    await captured(1);
    expect(events[0]?.contexts?.cloud_agent).toEqual({
      component: 'session',
      sessionId: 'workspace_websocket',
    });
    expect(events[0]?.exception?.values?.[0]?.type).toBe('SyntaxError');
    socket.close();
  });

  it('leaves constructors, synchronous returns, errors, and transport untouched without a DSN', async () => {
    const stub = probes.SENTRY_DISABLED_PROBE.getByName('private-owner:workspace_disabled');
    expect(await stub.snapshot()).toMatchObject({
      name: 'private-owner:workspace_disabled',
      constructed: true,
      value: 42,
      instrumentedContext: false,
      sentryClientUnchanged: true,
    });
    await runInDurableObject(stub, instance => {
      expect(instance.roundTrip(7)).toBe(7);
      expect(() => instance.rpcSyncFailure()).toThrow('private-sync-rpc-failure');
    });
    await expect(async () => await stub.rpcFailure()).rejects.toThrow('private-async-rpc-failure');
    await runInDurableObject(stub, async instance => {
      await expect(instance.alarm()).rejects.toThrow('private-alarm-failure');
      expect(() => instance.webSocketMessage({} as WebSocket, 'fail')).toThrow(
        'private-websocket-failure'
      );
    });
    await runInDurableObject(stub, () => undefined);
    expect(transport).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it.each(['cold', 'warm'] as const)(
    'isolates identity across overlapping %s DO calls and different components',
    async mode => {
      const session = probes.SENTRY_SESSION_PROBE.getByName('private-owner:workspace_concurrent');
      const sandbox = probes.SENTRY_SANDBOX_CONTROL_PROBE.getByName('sandbox_concurrent');
      const otherSession = probes.SENTRY_SESSION_PROBE.getByName(
        'oauth/google:private-owner:workspace_other'
      );
      if (mode === 'warm') {
        await session.snapshot();
        await sandbox.snapshot();
        await otherSession.snapshot();
      }
      const sessionFailure = expect(async () => await session.heldFailure('type')).rejects.toThrow(
        'private-concurrent-session-failure'
      );
      await waitFor(async () => expect(await session.hasHeldFailure()).toBe(true));
      const sandboxFailure = expect(async () => await sandbox.heldFailure('range')).rejects.toThrow(
        'private-concurrent-sandbox-failure'
      );
      await waitFor(async () => expect(await sandbox.hasHeldFailure()).toBe(true));
      const otherFailure = expect(
        async () => await otherSession.heldFailure('syntax')
      ).rejects.toThrow('private-concurrent-other-session-failure');
      await waitFor(async () => expect(await otherSession.hasHeldFailure()).toBe(true));
      await sandbox.releaseFailure();
      await sandboxFailure;
      await otherSession.releaseFailure();
      await otherFailure;
      await session.releaseFailure();
      await sessionFailure;
      await waitFor(() => expect(events).toHaveLength(3), { timeout: 2_000 });
      expect(
        events.find(event => event.exception?.values?.[0]?.type === 'TypeError')?.contexts
          ?.cloud_agent
      ).toEqual({
        component: 'session',
        sessionId: 'workspace_concurrent',
      });
      expect(
        events.find(event => event.exception?.values?.[0]?.type === 'RangeError')?.contexts
          ?.cloud_agent
      ).toEqual({
        component: 'sandbox-control',
        sandboxId: 'sandbox_concurrent',
      });
      expect(
        events.find(event => event.exception?.values?.[0]?.type === 'SyntaxError')?.contexts
          ?.cloud_agent
      ).toEqual({
        component: 'session',
        sessionId: 'workspace_other',
      });
      expect(JSON.stringify(events)).not.toContain('private-owner');
    },
    10_000
  );
});
