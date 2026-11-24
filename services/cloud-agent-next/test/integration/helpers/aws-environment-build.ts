import { createAwsBuildEndpoints } from '../../../src/environment-build/aws-build-endpoints.js';
import { createBuilderPreparation } from '../../../src/environment-build/builder-preparation.js';
import { env, runInDurableObject } from 'cloudflare:test';
import type { EnvironmentReference } from '@kilocode/cloud-agent-profile';
import { sandboxAllocationSchema } from '@kilocode/worker-utils/sandbox-allocation';
import type { Env } from '../../../src/types.js';
import type { EnvironmentBuild } from '../../../src/environment-build/environment-build-do.js';
import {
  EnvironmentBuildCoordinator,
  type CoordinatorDeps,
  type RunnerAuth,
} from '../../../src/environment-build/coordinator.js';
import type { BuildStore } from '../../../src/environment-build/store.js';
import { createBuilderProvider } from '../../../src/environment-build/builder-provider.js';
import { createAwsEnvironmentBuildServices } from '../../../src/environment-build/aws-build.js';
import { resolveAwsEnvironmentBuildTarget } from '../../../src/environment-build/aws-build-target.js';
import {
  mintRunnerCredential,
  verifyRunnerCredential,
} from '../../../src/environment-build/runner-credential.js';
import { readAwsBuildState } from '../../../src/environment-build/aws-build-state.js';
import { awsBuilderAllocation } from '../../../src/environment-build/aws-build-target.js';
import { parseBuildInput } from '../../../src/environment-build/store.js';
import { awsBuildTargetSchema } from '../../../src/environment-build/aws-build-target.js';
import {
  type awsBuilderTransport,
  AWS_BUILD_TEST_OWNER as OWNER,
  AWS_BUILD_TEST_SECRET as SECRET,
} from '../../fixtures/aws-builder-transport.js';
import { FAKE_DOWNLOADED_RUNTIME_ENV } from './fake-credentials.js';

type Host = {
  initialized: Promise<void>;
  store: BuildStore;
  coordinator: EnvironmentBuildCoordinator;
  awsEndpoints: ReturnType<typeof createAwsBuildEndpoints>;
};
const namespace = (
  env as unknown as { ENVIRONMENT_BUILD: DurableObjectNamespace<EnvironmentBuild> }
).ENVIRONMENT_BUILD;

/** Real coordinator, SQLite, JWTs, encrypted configuration and AWS adapters. Profile and AWS services are simulated. */
export async function awsBuildHarness(transport: Awaited<ReturnType<typeof awsBuilderTransport>>) {
  const environmentId = crypto.randomUUID();
  const stub = namespace.getByName(environmentId);
  const launchErrors: string[] = [];
  let cancelRun = false;
  const profile = { revision: 1, deleted: false, access: 'manage' as 'manage' | 'read' | 'none' };
  const reference = (): EnvironmentReference => ({
    environmentId,
    owner: OWNER,
    configurationRevision: profile.revision,
    repository: { platform: 'github', repoFullName: 'acme/widgets' },
  });
  const fakeEnv = {
    ...env,
    ...FAKE_DOWNLOADED_RUNTIME_ENV,
    WORKER_URL: 'https://worker.test',
    KILOCODE_BACKEND_BASE_URL: 'https://backend.test',
    NEXTAUTH_SECRET: { get: async () => SECRET },
    INTERNAL_API_SECRET_PROD: { get: async () => 'synthetic-internal' },
    AGENT_ENV_VARS_PRIVATE_KEY: transport.privateKey,
    BYOC_AWS_IDS: OWNER.id,
    AWS_BYOC_CREDENTIALS: JSON.stringify({
      accessKeyId: 'AKIABOOT0000000000',
      secretAccessKey: 'synthetic-bootstrap',
    }),
    AWS_BYOC_KILO_ROLE_ARN: 'arn:aws:iam::123456789012:role/kilo',
    GIT_TOKEN_SERVICE: transport.broker,
  } as unknown as Env;
  async function install() {
    await runInDurableObject(stub, async (instance: EnvironmentBuild, state) => {
      const host = instance as unknown as Host;
      await host.initialized;
      const readReference = async () => (profile.deleted ? null : reference());
      const actorAccess = async () => profile.access;
      const aws = createAwsEnvironmentBuildServices({
        env: fakeEnv,
        store: host.store,
        transaction: write => state.storage.transactionSync(write),
        reference: readReference,
        actorAccess,
        refuse: (buildId, reason) => host.coordinator.refuseBuild(buildId, reason),
      });
      const provider = createBuilderProvider({
        env: fakeEnv,
        aws,
        containers: fakeEnv.SANDBOX_CONTAINERS,
      });
      const launch = provider.launch.bind(provider);
      provider.launch = async (...args) => {
        try {
          return await launch(...args);
        } catch (error) {
          launchErrors.push(String(error));
          throw error;
        }
      };
      const deps: CoordinatorDeps = {
        now: Date.now,
        uuid: () => crypto.randomUUID(),
        store: host.store,
        transaction: write => state.storage.transactionSync(write),
        armAlarm: async () => {},
        environment: {
          reference: readReference,
          actorAccess,
          buildInput: async () => ({
            reference: reference(),
            repoFullName: 'acme/widgets',
            commands: ['pnpm install'],
            plainVars: { PLAIN: 'value' },
            encryptedSecrets: {},
            egressMode: 'allowlist',
            egressAllowlist: ['registry.npmjs.org'],
            sandboxAllocation: 'aws-ecs-8g',
          }),
          buildTarget: input =>
            resolveAwsEnvironmentBuildTarget(
              fakeEnv,
              input.reference,
              sandboxAllocationSchema.parse(input.sandboxAllocation)
            ),
          gitSource: async () => ({
            ok: true,
            git: {
              url: 'https://github.com/acme/widgets.git',
              token: 'synthetic-server-only-source-token',
              platform: 'github',
            },
          }),
        },
        provider,
        runnerUrl: (environment, build) =>
          `https://worker.test/environment-build/${environment}/${build}`,
        runnerCredential: async claims =>
          mintRunnerCredential({ ...claims, credential: 'a'.repeat(64) }, SECRET),
        runnerCredentialMatches: async (_claims, credential) => credential === 'a'.repeat(64),
        preparation: createBuilderPreparation({
          aws,
          gitSource: input => deps.environment.gitSource(input),
          decryptSecrets: () => ({}),
        }),
        billingInput: ({ sandboxId, buildId }) => ({
          sandboxId: sandboxId as never,
          subject: { type: 'org', id: OWNER.id },
          actor: { type: 'user', id: 'user-builder' },
          sessionId: `environment-build:${buildId}`,
          metadata: { origin: 'environment-build' },
        }),
        builderSandboxId: 'ses-' + '0'.repeat(48),
        unsupportedReason: () => null,
        log: () => {},
      };
      host.coordinator = new EnvironmentBuildCoordinator(environmentId, deps);
      host.awsEndpoints = createAwsBuildEndpoints({
        aws,
        authorizePreparing: auth => host.coordinator.authorizeRunner(auth, ['preparing']),
      });
      transport.setCheckpoint(async request => {
        const build = host.store.activeBuild();
        if (!build?.allocation_id) throw new Error('Compute request has no durable build');
        const input = parseBuildInput(build);
        const target = awsBuildTargetSchema.parse(input.target);
        const allocation = awsBuilderAllocation({
          target,
          environmentId,
          buildId: build.id,
          allocationId: build.allocation_id,
          actorUserId: build.actor_user_id,
          owner: OWNER,
        });
        const issued = readAwsBuildState(host.store.providerState(build.id), allocation).operation
          ?.request;
        if (JSON.stringify(issued) !== JSON.stringify(request))
          throw new Error('Compute request preceded durable checkpoint');
      });
      transport.onRun(async () => {
        if (!cancelRun) return;
        cancelRun = false;
        const build = host.store.activeBuild();
        if (!build) throw new Error('Test expected active build');
        await host.coordinator.cancel(build.id);
      });
      await state.storage.deleteAlarm();
    });
  }
  await install();
  return {
    workerEnv: fakeEnv,
    environmentId,
    stub,
    profile,
    launchErrors,
    reinstall: install,
    cancelDuringRun: () => {
      cancelRun = true;
    },
    request: () =>
      stub.requestBuild({
        environmentId,
        owner: OWNER,
        expectedRevision: profile.revision,
        requestId: crypto.randomUUID(),
        trigger: 'manual',
        actorUserId: 'user-builder',
      }),
    status: () =>
      stub.status({ environmentId, owner: OWNER, configurationRevision: profile.revision }),
    tick: () =>
      runInDurableObject(stub, (instance: EnvironmentBuild) =>
        (instance as unknown as Host).coordinator.alarm()
      ),
    async row(buildId: string) {
      return runInDurableObject(stub, (instance: EnvironmentBuild) => {
        const store = (instance as unknown as Host).store;
        return {
          build: store.build(buildId),
          state: store.providerState(buildId),
          published: store.published(),
        };
      });
    },
    auth(): RunnerAuth {
      const { runner } = transport.launch();
      const claims = verifyRunnerCredential(runner.credential, SECRET);
      if (!claims) throw new Error('Invalid test runner JWT');
      return claims;
    },
  };
}
