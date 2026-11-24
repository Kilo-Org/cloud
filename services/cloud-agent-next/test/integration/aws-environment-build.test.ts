import { prepareAwsSnapshotStartup } from '../../src/sandbox-control/aws-snapshot-startup.js';
import { createByocAwsEcsProviderAdapter } from '../../src/byoc/aws-ecs-provider.js';
import { awsEcsOperationSchema } from '../../src/sandbox-control/aws-ecs-operation.js';
import type { AwsComputeStorage } from '../../src/sandbox-control/aws-compute-lifecycle.js';
import { mintSandboxLaunchCredential } from '../../src/sandbox-control/credential.js';
import {
  AWS_BUILD_TEST_CREDENTIAL_ID,
  AWS_BUILD_TEST_OWNER,
  AWS_BUILD_TEST_SECRET,
} from '../fixtures/aws-builder-transport.js';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@kilocode/worker-utils/sha256';
import {
  AWS_EGRESS_CREDENTIAL_HEADER,
  AWS_EGRESS_IDENTITY_HEADER,
  awsEgressPolicySchema,
} from '@kilocode/worker-utils/aws-egress';
import { environmentBuildArchiveUploadSchema } from '../../src/shared/environment-build-archive.js';
import { decodeAwsArchiveSnapshot } from '../../src/shared/aws-archive.js';
import { handleAwsBuildEgress } from '../../src/egress/aws-route.js';
import { awsBuilderTransport } from '../fixtures/aws-builder-transport.js';
import { awsBuildHarness } from './helpers/aws-environment-build.js';

const ready = {
  outcome: 'ready' as const,
  commit: 'f'.repeat(40),
  branch: 'main',
  setupDurationMs: 50,
};
afterEach(async () => {
  vi.unstubAllGlobals();
  await reset();
});
async function setup() {
  const transport = await awsBuilderTransport();
  vi.stubGlobal('fetch', transport.transport);
  const h = await awsBuildHarness(transport);
  const admitted = await h.request();
  if (admitted.status !== 'accepted') throw new Error(`Build rejected: ${admitted.status}`);
  return { ...h, transport, buildId: admitted.buildId };
}
async function running() {
  const h = await setup();
  await h.tick();
  expect(h.transport.errors).toEqual([]);
  expect(h.launchErrors).toEqual([]);
  expect((await h.status()).activeBuild?.state).toBe('preparing');
  return { ...h, auth: h.auth() };
}
async function prepare(h: Awaited<ReturnType<typeof running>>) {
  const input = await h.stub.runnerInput(h.auth);
  if ('status' in input || !('filesystemArchive' in input) || !input.filesystemArchive)
    throw new Error('Builder input unavailable');
  await expect(h.stub.runnerRetireScm(h.auth)).resolves.toBe('ok');
  const body = 'synthetic archive bytes';
  const descriptor = {
    format: 1 as const,
    baseImage: input.filesystemArchive.baseImage,
    sha256: await sha256Hex(body),
    size: body.length,
    expandedBytes: 0,
    fileCount: 0,
    deletedCount: 0,
  };
  const upload = environmentBuildArchiveUploadSchema.parse(
    await h.stub.runnerArchive(h.auth, { action: 'prepare', descriptor })
  );
  return { input, descriptor, upload, body };
}

async function forwardBuildScm(
  h: Awaited<ReturnType<typeof running>>,
  proof: { credential: string; identity: string },
  request: Request
) {
  const headers = new Headers(request.headers);
  headers.set('x-kilo-egress-credential', proof.credential);
  headers.set('x-kilo-egress-identity', proof.identity);
  headers.set('x-kilo-egress-target', request.url);
  return handleAwsBuildEgress(
    new Request('https://worker.test/build-scm', {
      method: request.method,
      headers,
      body: request.body,
    }),
    h.workerEnv,
    h.environmentId,
    h.buildId,
    'scm'
  );
}

describe('ECS real environment coordinator with simulated AWS HTTP', () => {
  const provider = 'aws-ecs';
  it('launches, serves broker aliases, verifies an archive, publishes and stops the physical allocation', async () => {
    const h = await running();
    const { document, proof, runner } = h.transport.launch();
    expect(document.env).not.toHaveProperty('KILO_TOKEN');
    expect(document.argv.join(' ')).toContain('environment-builder');
    const input = await h.stub.runnerInput(h.auth);
    expect(input).toMatchObject({
      git: { token: expect.stringMatching(/^kcp/) },
      commands: ['pnpm install'],
    });
    expect(JSON.stringify(input)).not.toContain('kgh2.');
    expect(JSON.stringify(input)).not.toContain('synthetic-server-only-source-token');
    expect(h.transport.brokerCalls).toEqual([
      expect.objectContaining({ accessPurpose: 'workflow', allowUserAuthorization: false }),
    ]);
    const proxyRequest = (credential = proof.credential) =>
      new Request('https://worker.test/build-proxy-policy', {
        method: 'POST',
        headers: {
          [AWS_EGRESS_CREDENTIAL_HEADER]: credential,
          [AWS_EGRESS_IDENTITY_HEADER]: proof.identity,
        },
      });
    const policy = await handleAwsBuildEgress(
      proxyRequest(),
      h.workerEnv,
      h.environmentId,
      h.buildId,
      'policy'
    );
    expect(policy.status).toBe(200);
    const parsed = awsEgressPolicySchema.parse(await policy.json());
    expect(parsed.allowlist).toEqual(
      expect.arrayContaining([
        'registry.npmjs.org',
        'worker.test',
        'customer-artifacts.s3.us-east-1.amazonaws.com',
      ])
    );
    expect(parsed.interceptedHosts).toContain('github.com');
    if (!('git' in input) || !input.git?.token) throw new Error('Missing build alias');
    const git = () =>
      new Request('https://github.com/acme/widgets.git/info/refs?service=git-upload-pack', {
        headers: { authorization: `Basic ${btoa(`x-access-token:${input.git?.token}`)}` },
      });
    const cloned = await forwardBuildScm(h, proof, git());
    expect(cloned.status).toBe(200);
    expect(await cloned.text()).toBe('synthetic git response');
    expect(h.transport.redemptions).toEqual([
      expect.objectContaining({
        capability: expect.stringMatching(/^kgh2\./),
        outboundContainerId: expect.stringContaining(`${provider}-environment-build:`),
      }),
    ]);
    const alias = input.git.token;
    const wrongAlias = alias.slice(0, -1) + (alias.endsWith('a') ? 'b' : 'a');
    const otherCredential = await forwardBuildScm(
      h,
      proof,
      new Request(git().url, {
        headers: { authorization: `Basic ${btoa(`x-access-token:${wrongAlias}`)}` },
      })
    );
    expect(otherCredential.status).toBe(403);
    expect(h.transport.redemptions).toHaveLength(1);

    const wrongPurpose = await handleAwsBuildEgress(
      proxyRequest(runner.credential),
      h.workerEnv,
      h.environmentId,
      h.buildId,
      'policy'
    );
    expect(wrongPurpose.status).toBe(401);
    const wrongBuild = await handleAwsBuildEgress(
      proxyRequest(),
      h.workerEnv,
      h.environmentId,
      crypto.randomUUID(),
      'policy'
    );
    expect(wrongBuild.status).toBe(401);
    const { body, upload, descriptor } = await prepare(h);
    expect((await fetch(upload.url, { method: 'PUT', headers: upload.headers, body })).status).toBe(
      200
    );
    await expect(h.stub.runnerArchive(h.auth, { action: 'complete' })).resolves.toEqual({
      ok: true,
    });
    const reserved = await h.row(h.buildId);
    await expect(h.stub.runnerResult(h.auth, ready)).resolves.toBe('ok');
    for (let i = 0; i < 5; i++) await h.tick();
    const done = await h.status();
    expect(done.latestBuild).toMatchObject({ state: 'succeeded', cleanup: 'confirmed' });
    const persisted = await h.row(h.buildId);
    expect(persisted.published).toMatchObject({ provider, baseImage: descriptor.baseImage });
    expect(decodeAwsArchiveSnapshot(persisted.published?.snapshotId ?? '')?.archive).toEqual(
      descriptor
    );
    expect(persisted.published?.capturedAt).toBe(
      (reserved.state as { archive: { reservedAt: number } }).archive.reservedAt
    );
    expect(h.transport.physicalCount()).toBe(1);
    expect(h.transport.stopped()).toBe(true);
    expect(h.transport.deleted).toHaveLength(1);
    expect([...h.transport.objects.keys()]).toEqual([expect.stringMatching(/^kilo\/archives\//)]);
    const snapshot = persisted.published;
    if (!snapshot) throw new Error('Missing published test archive');
    const sessionOperations = new Map<string, unknown>();
    function sessionStorage<T>(): AwsComputeStorage<T> {
      return {
        get: async id => sessionOperations.get(id),
        async update(id, transition) {
          const next = transition(sessionOperations.get(id));
          sessionOperations.set(id, next);
          return next;
        },
        list: async () => new Map(sessionOperations),
        delete: async id => {
          sessionOperations.delete(id);
        },
      };
    }
    h.transport.setCheckpoint(async request => {
      const raw = [...sessionOperations.values()][0];
      const operation = awsEcsOperationSchema.parse(raw);
      expect(operation.request).toEqual(request);
      expect(operation.startSource).toBe('repository');
    });
    const sandboxId = 'ses-' + '9'.repeat(48);
    const common = {
      prepareSnapshot: prepareAwsSnapshotStartup,
      env: h.workerEnv,
      sandboxId,
      source: {
        organizationId: AWS_BUILD_TEST_OWNER.id,
        credentialId: AWS_BUILD_TEST_CREDENTIAL_ID,
      },
    };
    const session = createByocAwsEcsProviderAdapter({ ...common, storage: sessionStorage() });
    const allocationId = crypto.randomUUID();
    const created = await session.create({ intentId: allocationId, createdAt: Date.now() });
    if (!('providerRef' in created)) throw new Error('Missing session provider reference');
    try {
      expect(session.environmentSnapshots).toBe('launch');
      expect(
        await session.launch(
          created.providerRef,
          {
            command: { argv: ['/usr/local/bin/node', '/fresh-session-runtime.mjs'] },
            env: {
              SANDBOX_CONTROL_CREDENTIAL: mintSandboxLaunchCredential(
                { sandboxId, allocationId, credential: 'c'.repeat(64) },
                AWS_BUILD_TEST_SECRET
              ),
            },
          },
          {
            snapshot: {
              provider,
              baseImage: snapshot.baseImage,
              snapshotId: snapshot.snapshotId,
            },
            deadlineAt: Date.now() + 60_000,
          }
        )
      ).toEqual({ startSource: 'repository' });
      const bytes = [...h.transport.objects.entries()].find(([key]) =>
        key.startsWith('kilo/launch/')
      )?.[1].bytes;
      if (!bytes) throw new Error('Missing session launch document');
      const restored = JSON.parse(new TextDecoder().decode(bytes)) as {
        argv: string[];
        env: Record<string, string>;
      };
      expect(restored.env.HTTPS_PROXY).toContain('http://kilo:');
      expect(restored.env.KILO_AWS_EGRESS_CA_CERTIFICATE).toContain('BEGIN CERTIFICATE');
      expect(JSON.parse(restored.argv[4])).toMatchObject({
        argv: ['/usr/local/bin/node', '/fresh-session-runtime.mjs'],
        root: '/',
      });
      expect(await session.reconcileLaunch(created.providerRef)).toEqual({
        startSource: 'repository',
      });
    } finally {
      expect(await session.stop(created.providerRef)).toBe('terminal');
    }
    expect(h.transport.physicalCount()).toBe(2);
    expect(h.transport.stopped()).toBe(true);
    expect([...h.transport.objects.keys()]).toEqual([expect.stringMatching(/^kilo\/archives\//)]);
  });

  it.each(['archive', 'cleanup'] as const)(
    'keeps SCM authority independent of display step %s',
    async step => {
      const h = await running();
      const { proof } = h.transport.launch();
      const input = await h.stub.runnerInput(h.auth);
      if (!('git' in input) || !input.git?.token) throw new Error('Missing build alias');
      await h.stub.runnerEvents(h.auth, { sequence: 0, step });
      const policy = await h.stub.getAwsBuildEgressPolicy(h.environmentId, h.buildId, proof);
      expect(awsEgressPolicySchema.parse(await policy.json()).interceptedHosts).toContain(
        'github.com'
      );
      const request = () =>
        new Request('https://github.com/acme/widgets.git/info/refs?service=git-upload-pack', {
          headers: { authorization: `Basic ${btoa(`x-access-token:${input.git?.token}`)}` },
        });
      const cloned = await forwardBuildScm(h, proof, request());
      expect(cloned.status).toBe(200);
      expect(await cloned.text()).toBe('synthetic git response');
      await h.stub.cancel({ environmentId: h.environmentId, buildId: h.buildId });
      expect((await forwardBuildScm(h, proof, request())).status).toBe(403);
    }
  );

  it('retires SCM durably and refuses a replayed input or late grant', async () => {
    const h = await running();
    const { proof } = h.transport.launch();
    const input = await h.stub.runnerInput(h.auth);
    if (!('git' in input) || !input.git?.token) throw new Error('Missing build alias');
    expect(await h.stub.runnerRetireScm({ ...h.auth, allocationId: crypto.randomUUID() })).toEqual({
      refused: 'unauthorized',
    });
    expect((await h.row(h.buildId)).state).not.toHaveProperty('scm', 'retired');
    expect(await h.stub.runnerRetireScm(h.auth)).toBe('ok');
    await h.reinstall();
    expect((await h.row(h.buildId)).state).toHaveProperty('scm', 'retired');
    expect(await h.stub.runnerRetireScm(h.auth)).toBe('ok');
    // Display progress can arrive out of order without restoring authority.
    await h.stub.runnerEvents(h.auth, { sequence: 1, step: 'clone' });
    expect(await h.stub.runnerInput(h.auth)).toEqual({ refused: 'gone' });
    const policy = await h.stub.getAwsBuildEgressPolicy(h.environmentId, h.buildId, proof);
    expect(awsEgressPolicySchema.parse(await policy.json()).interceptedHosts).not.toContain(
      'github.com'
    );
    const request = new Request(
      'https://github.com/acme/widgets.git/info/refs?service=git-upload-pack',
      {
        headers: { authorization: `Basic ${btoa(`x-access-token:${input.git?.token}`)}` },
      }
    );
    expect((await forwardBuildScm(h, proof, request)).status).toBe(403);
    expect(h.transport.redemptions).toHaveLength(0);
  });

  it('does not persist a grant issued concurrently with retirement', async () => {
    const h = await running();
    await runInDurableObject(h.stub, async instance => {
      const issuing = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      h.transport.onIssue(async () => {
        issuing.resolve();
        await released.promise;
      });
      const pending = instance.runnerInput(h.auth);
      await issuing.promise;
      try {
        expect(await instance.runnerRetireScm(h.auth)).toBe('ok');
      } finally {
        released.resolve();
      }
      expect(await pending).toEqual({ refused: 'gone' });
    });
    expect((await h.row(h.buildId)).state).toHaveProperty('scm', 'retired');
  });

  it.each([true, false])(
    'cancels during Run and recovers cleanup authority (lost reply: %s)',
    async lostReply => {
      const h = await setup();
      h.cancelDuringRun();
      if (lostReply) h.transport.loseNextReply();
      await h.tick();
      // Recreate the coordinator after a lost response. Durable state and AWS effects survive.
      await h.reinstall();
      for (let i = 0; i < 4; i++) await h.tick();
      expect((await h.status()).latestBuild).toMatchObject({
        state: 'canceled',
        cleanup: 'confirmed',
      });
      expect(h.transport.physicalCount()).toBe(1);
      expect(h.transport.runCalls()).toBe(lostReply ? 2 : 1);
      expect(h.transport.requests.size).toBe(1);
      expect(h.transport.stopped()).toBe(true);
      expect((await h.row(h.buildId)).published).toBeNull();
      expect(h.transport.objects.size).toBe(0);
    }
  );

  it('refuses late archive completion after cancellation and retains the object for lifecycle expiration', async () => {
    const h = await running();
    const { body, upload } = await prepare(h);
    await h.stub.cancel({ environmentId: h.environmentId, buildId: h.buildId });
    await fetch(upload.url, { method: 'PUT', headers: upload.headers, body });
    expect(await h.stub.runnerArchive(h.auth, { action: 'complete' })).not.toEqual({ ok: true });
    // Acknowledge a late result without applying it. The cancellation remains final.
    expect(await h.stub.runnerResult(h.auth, ready)).toBe('ok');
    for (let i = 0; i < 4; i++) await h.tick();
    expect((await h.row(h.buildId)).published).toBeNull();
    expect((await h.status()).latestBuild?.state).toBe('canceled');
    expect((await h.row(h.buildId)).state).not.toHaveProperty('archive.verifiedAt');
    expect(h.transport.stopped()).toBe(true);
    expect([...h.transport.objects.keys()]).toEqual([expect.stringMatching(/^kilo\/archives\//)]);
    expect(h.transport.deleted.every(key => key.startsWith('kilo/launch/'))).toBe(true);
  });

  it('refuses authority revoked during broker issuance and never persists or delivers the late grant', async () => {
    const h = await running();
    h.transport.onIssue(async () => {
      h.profile.access = 'none';
    });
    expect(await h.stub.runnerInput(h.auth)).not.toHaveProperty('git');
    const row = await h.row(h.buildId);
    expect(row.state).not.toHaveProperty('scm');
    for (let i = 0; i < 4; i++) await h.tick();
    expect((await h.status()).latestBuild).toMatchObject({
      state: 'failed',
      failureReason: 'actor_unauthorized',
      cleanup: 'confirmed',
    });
    expect(h.transport.stopped()).toBe(true);
  });

  it('reports authenticated runtime startup failure and stops promptly', async () => {
    const h = await running();
    await expect(
      h.stub.runnerStartupFailure(
        { ...h.auth, allocationId: crypto.randomUUID() },
        'artifact_invalid'
      )
    ).resolves.toEqual({ refused: 'unauthorized' });
    expect((await h.status()).activeBuild?.state).toBe('preparing');
    await expect(h.stub.runnerStartupFailure(h.auth, 'artifact_invalid')).resolves.toBe('ok');
    for (let i = 0; i < 4; i++) await h.tick();
    expect((await h.status()).latestBuild).toMatchObject({
      state: 'failed',
      failureReason: 'builder_start_failed',
      failureDetail: 'The runtime download failed verification. Retry the build.',
      cleanup: 'confirmed',
    });
    expect(h.transport.stopped()).toBe(true);
  });

  it('fails promptly when repository access is revoked after admission', async () => {
    const h = await running();
    h.transport.setIssueFailure({ success: false, reason: 'repository_not_installed' });
    expect(await h.stub.runnerInput(h.auth)).toEqual({ refused: 'gone' });
    expect((await h.row(h.buildId)).build).toMatchObject({
      state: 'stopping',
      failure_reason: 'repository_unauthorized',
    });
    for (let i = 0; i < 4; i++) await h.tick();
    expect((await h.status()).latestBuild).toMatchObject({
      state: 'failed',
      failureReason: 'repository_unauthorized',
      cleanup: 'confirmed',
    });
    expect(h.transport.stopped()).toBe(true);
    expect((await h.row(h.buildId)).published).toBeNull();
  });

  it.each(['database_not_configured', 'rpc_error'] as const)(
    'retries input after %s without failing the build',
    async reason => {
      const h = await running();
      if (reason === 'rpc_error') {
        h.transport.onIssue(async () => {
          throw new Error('Synthetic broker transport failure');
        });
      } else {
        h.transport.setIssueFailure({ success: false, reason });
      }
      expect(await h.stub.runnerInput(h.auth)).toEqual({ refused: 'unavailable' });
      expect((await h.status()).activeBuild?.state).toBe('preparing');
      h.transport.setIssueFailure(undefined);
      h.transport.onIssue(async () => {});
      expect(await h.stub.runnerInput(h.auth)).toMatchObject({
        git: { token: expect.stringMatching(/^kcp/) },
      });
      expect((await h.status()).activeBuild?.state).toBe('preparing');
      expect(h.transport.runCalls()).toBe(1);
    }
  );

  it('refuses ready publication without a verified archive', async () => {
    const h = await running();
    await h.stub.runnerResult(h.auth, ready);
    for (let i = 0; i < 4; i++) await h.tick();
    expect((await h.status()).latestBuild).toMatchObject({
      state: 'failed',
      failureReason: 'archive_failed',
    });
    expect((await h.row(h.buildId)).published).toBeNull();
    expect(h.transport.stopped()).toBe(true);
  });
});
