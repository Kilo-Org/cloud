import { env, reset, runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { allocation } from '../../src/control-plane/sandbox/sqlite-schema.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import { resolveSecret } from '../../src/auth.js';
import {
  generateSandboxCredential,
  hashSandboxCredential,
  mintSandboxLaunchCredential,
} from '../../src/sandbox-control/credential.js';
import { encodeVercelProviderRef } from '../../src/sandbox-control/vercel-provider.js';
import { CONTROL_PLANE_PROTOCOL_VERSION } from '../../src/shared/control-plane-protocol.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import { waitFor } from './wait-for.js';

const sandboxes = (env as unknown as { SANDBOX_CONTROL: DurableObjectNamespace<SandboxControlV2> })
  .SANDBOX_CONTROL;

afterEach(async () => {
  await reset();
});

describe('Vercel requires customer credentials', () => {
  it('rejects a Kilo-paid allocation before any provider operation', async () => {
    const stub = sandboxes.getByName('ses-retired-vercel');
    const rejection = await runInDurableObject(stub, async instance => {
      try {
        await instance.ensureAllocation({ provider: 'vercel' });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : 'unknown';
      }
    });
    expect(rejection).toBe('byoc_credential_missing');
    expect((await stub.getAllocationState()).kind).toBe('stopped');
  });
});

describe('BYOC snapshot validator on the current control plane', () => {
  it.each(['organization', 'personal'] as const)(
    'persists the %s customer identity, accepts the signed wrapper, and confirms cleanup',
    async ownerType => {
      const generation = crypto.randomUUID();
      const sandboxId = `ses-byoc-validator-${generation.replaceAll('-', '')}`;
      const allocationId = generation;
      const credential = generateSandboxCredential();
      const providerRef = encodeVercelProviderRef({
        sandboxName: `ses-validator-${generation}`,
        sessionId: 'sbox_validator',
      });
      const stub = sandboxes.getByName(sandboxId);
      const input = {
        build: {
          generation,
          credentialId: crypto.randomUUID(),
          ...(ownerType === 'organization'
            ? { organizationId: crypto.randomUUID() }
            : { userId: 'oauth/google/personal-owner' }),
        },
        allocation: {
          providerRef,
          locator: {
            teamId: 'team_customer',
            projectId: 'prj_customer',
            snapshotId: 'snap_customer',
            runtimeBuildId: 'build_customer',
            runtime: 'node24' as const,
          },
          createdAt: Date.now(),
          expiresAt: Date.now() + 600_000,
        },
        credentialHash: await hashSandboxCredential(credential),
      };
      await stub.initializeSnapshotValidator(input);
      await stub.initializeSnapshotValidator(input);
      const pin = await runInDurableObject(
        stub,
        (_instance, state) =>
          drizzle(state.storage)
            .select({ pin: allocation.provider_pin })
            .from(allocation)
            .where(eq(allocation.id, 'current'))
            .get()?.pin
      );
      // The persisted provider identity contains references only.
      expect(JSON.stringify(pin)).toContain(input.build.credentialId);
      expect(JSON.parse(pin ?? 'null')).toMatchObject({
        byoc:
          ownerType === 'organization'
            ? { organizationId: input.build.organizationId }
            : { userId: input.build.userId },
        billing: null,
      });
      expect(JSON.stringify(pin)).not.toContain(credential);
      expect(JSON.stringify(pin)).not.toContain('accessToken');
      const secret = await resolveSecret(env.NEXTAUTH_SECRET);
      if (!secret) throw new Error('Test signing secret is unavailable');
      const wrapper = await FakeWrapper.connect({
        sandboxId,
        credential: mintSandboxLaunchCredential({ sandboxId, allocationId, credential }, secret),
      });
      wrapper.send({
        type: 'hello',
        protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
        allocationId,
        wrapperId: 'byoc-validator-wrapper',
      });
      expect(await wrapper.next()).toMatchObject({ type: 'welcome' });
      await waitFor(async () => (await stub.getAllocationState()).kind === 'connected');
      expect(await stub.getSnapshotValidatorStatus()).toEqual({
        physical: 'running',
        connection: 'ready',
      });
      const mismatchedCleanup = await runInDurableObject(stub, async instance => {
        try {
          await instance.confirmSnapshotValidatorStopped('different-ref');
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : 'unknown';
        }
      });
      expect(mismatchedCleanup).toContain('allocation changed');
      await stub.confirmSnapshotValidatorStopped(providerRef);
      expect((await stub.getAllocationState()).kind).toBe('stopped');
      const restart = await runInDurableObject(stub, async instance => {
        try {
          await instance.initializeSnapshotValidator(input);
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : 'unknown';
        }
      });
      expect(restart).toContain('allocation changed');
      wrapper.close();
    }
  );
});
