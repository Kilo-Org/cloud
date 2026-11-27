import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  createHostedWorkspace,
  createHostedWorkspaceSession,
  deleteWorktree,
  fakeDirective,
  getHostedWorkspaceStatus,
  getSessionSnapshot,
  trpcCall,
  type DriverConfig,
} from './client.js';
import {
  createControlTokenProvider,
  fetchStreamTicket,
  loadDeployedAuthFile,
} from './deployed-auth.js';
import { requireE2eInternalSecret } from './e2e-internal-secret.js';
import { fetchAllocation, type AllocationInspection } from './e2e-surface-client.js';
import { awaitCorrelatedChildText, CONTENT_CORRELATION_BUDGET_MS } from './scenarios-shared.js';
import { bootToCompletion, createScenarioDeadline, sendTurn } from './scenarios-shared-runtime.js';

const REQUEST_MS = 30_000;
const TURN_MS = 240_000;
const MAX_CATALOG_PAGES = 100;
const IDLE_GRACE_MS = 60_000;
const STAGING_HOST_DENYLIST = new Set([
  'cloud-agent-next.kilosessions.ai',
  'cloud-agent-e2e-test.engineering-e11.workers.dev',
  'cloud-agent-e2e-test.kilosessions.ai',
  'cloud-agent-e2e.kiloapps.io',
  'kilocode.ai',
  'app.kilocode.ai',
  'api.kilocode.ai',
  'kilo.ai',
  'app.kilo.ai',
  'api.kilo.ai',
]);

/** The configured fenced e2e Worker hosts (CI variable, deploy input, driver URL). */
function configuredE2eHosts(): string[] {
  const hosts = [process.env.CLOUD_AGENT_E2E_WORKER_HOSTNAME, process.env.E2E_WORKER_HOSTNAME];
  try {
    if (process.env.WORKER_URL) hosts.push(new URL(process.env.WORKER_URL).hostname);
  } catch {
    // An invalid WORKER_URL names no host to refuse.
  }
  return hosts.filter((host): host is string => Boolean(host)).map(host => host.toLowerCase());
}

/** The fenced e2e Worker is never a staging origin, whichever way it is configured. */
function isDeniedStagingHost(hostname: string): boolean {
  const host = hostname.replace(/\.$/, '').toLowerCase();
  return STAGING_HOST_DENYLIST.has(host) || configuredE2eHosts().includes(host);
}

const stagedOrigin = z.url().refine(value => {
  const url = new URL(value);
  return (
    url.protocol === 'https:' &&
    (value === url.origin || value === `${url.origin}/`) &&
    !isDeniedStagingHost(url.hostname)
  );
}, 'Expected a dedicated staging HTTPS origin');
const markerPath = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/)
  .refine(value => value.split('/').every(segment => segment !== '.' && segment !== '..'));
const repositoryName = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/);
const repositoryFixture = z.strictObject({
  fullName: repositoryName,
  markerPath,
  marker: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
});
const fixtureSchema = z
  .strictObject({
    target: z.literal('staging'),
    workerUrl: stagedOrigin,
    backendUrl: stagedOrigin,
    organizationId: z.uuid(),
    integrationId: z.uuid(),
    profileId: z.uuid(),
    primary: repositoryFixture,
    additional: repositoryFixture.extend({ id: z.int().positive() }),
    verifySibling: z.boolean().default(true),
    verifyIdle: z.boolean().default(false),
  })
  .refine(
    ({ primary, additional }) =>
      leaf(primary.fullName).toLowerCase() !== leaf(additional.fullName).toLowerCase() &&
      primary.marker !== additional.marker,
    'Fixture requires distinct checkout directories and distinct markers'
  );
const catalogPageSchema = z.strictObject({
  hostedAdditionalRepositoriesVersion: z.literal(1),
  repositories: z
    .array(
      z.strictObject({ id: z.int().positive(), fullName: repositoryName, private: z.boolean() })
    )
    .max(100),
  nextPage: z.int().min(1).max(MAX_CATALOG_PAGES).optional(),
});

type Fixture = z.infer<typeof fixtureSchema>;

function leaf(fullName: string): string {
  return fullName.slice(fullName.indexOf('/') + 1);
}

export function parseHostedMultiRepositoryFixture(input: unknown): Fixture {
  return fixtureSchema.parse(input);
}

export async function verifyHostedRepositoryCatalog(
  config: DriverConfig,
  fixture: Fixture,
  signal: AbortSignal
): Promise<void> {
  let page = 1;
  const visited = new Set<number>();
  for (let count = 0; count < MAX_CATALOG_PAGES; count += 1) {
    assert(!visited.has(page), 'Hosted repository catalog pagination repeated a page');
    visited.add(page);
    const response = catalogPageSchema.parse(
      await trpcCall<unknown>(
        config,
        'listHostedWorkspaceRepositories',
        {
          organizationId: fixture.organizationId,
          integrationId: fixture.integrationId,
          primaryRepo: fixture.primary.fullName,
          ...(count === 0 ? {} : { page }),
        },
        { method: 'GET', signal }
      )
    );
    assert(
      !response.repositories.some(
        repo => repo.fullName.toLowerCase() === fixture.primary.fullName.toLowerCase()
      ),
      'Hosted repository catalog included its primary repository'
    );
    const selected = response.repositories.find(repo => repo.id === fixture.additional.id);
    if (selected) {
      assert.equal(
        selected.fullName,
        fixture.additional.fullName,
        'Additional repository ID resolved to the wrong name'
      );
      return;
    }
    if (response.nextPage === undefined) break;
    page = response.nextPage;
  }
  throw new Error('Configured additional repository not found in the hosted repository catalog');
}

async function runHostedMultiRepository(
  fixture: Fixture,
  auth: ReturnType<typeof loadDeployedAuthFile>
): Promise<void> {
  const internalApiSecret = requireE2eInternalSecret(
    auth.e2eInternalApiSecret ?? '',
    'The staged auth file e2eInternalApiSecret'
  );
  const controlTokens = createControlTokenProvider({
    backendUrl: fixture.backendUrl,
    sourceToken: auth.token,
  });
  const config: DriverConfig = {
    workerUrl: fixture.workerUrl,
    user: { id: auth.identity.userId },
    getBearerToken: controlTokens.getToken,
    fetchStreamTicket: sessionId =>
      fetchStreamTicket({ backendUrl: fixture.backendUrl, token: auth.token, sessionId }),
    skipBalanceCheck: false,
    kilocodeOrganizationId: fixture.organizationId,
    model: 'kilo/fake-deterministic',
    gitUrl: '',
    fakeLlmUrl: '',
  };
  const deadline = createScenarioDeadline(Date.now(), (fixture.verifyIdle ? 25 : 10) * 60_000);
  const operationKey = randomUUID();
  const workspaces = new Set<string>();
  const repos = [fixture.primary, fixture.additional];
  const paths = repos.map(repo => `${leaf(repo.fullName)}/${repo.markerPath}`).join(':');
  const expectedText = `file-read-pair:${JSON.stringify(repos.map(repo => repo.marker))}`;
  const matchesReadPair = (text: string): boolean => text.trim() === expectedText;
  const prompt = (phase: string): string =>
    fakeDirective(`file-read-pair:${operationKey}-${phase}:${paths}`);
  const inspect = (sessionId: string, label: string): Promise<AllocationInspection> =>
    deadline.within(
      label,
      signal =>
        fetchAllocation(
          { surfaceUrl: fixture.workerUrl, bearerToken: auth.token, internalApiSecret, signal },
          sessionId
        ),
      REQUEST_MS
    );
  const sendReadPair = async (sessionId: string, phase: string): Promise<void> => {
    const turn = await sendTurn(deadline, config, sessionId, prompt(phase), phase, TURN_MS);
    try {
      await awaitCorrelatedChildText({
        stream: turn.stream,
        parentMessageId: turn.messageId,
        timeoutMs: Math.min(CONTENT_CORRELATION_BUDGET_MS, deadline.remaining(phase)),
        label: phase,
        ready: matchesReadPair,
      });
      console.log(`${phase}: both workspace files verified; messageId=${turn.messageId}`);
    } finally {
      turn.stream.close();
    }
  };

  try {
    console.log(
      `staged hosted multi-repo: operationKey=${operationKey}; catalogStart=${new Date().toISOString()}`
    );
    await deadline.within(
      'repository catalog',
      signal => verifyHostedRepositoryCatalog(config, fixture, signal),
      REQUEST_MS
    );
    console.log(`catalog v1 selected repository verified; catalogEnd=${new Date().toISOString()}`);
    const create = async () => {
      const root = await deadline.within(
        'promptless workspace create',
        signal =>
          createHostedWorkspace(
            config,
            {
              operationKey,
              profileId: fixture.profileId,
              repository: {
                type: 'github',
                repo: fixture.primary.fullName,
                githubIntegrationId: fixture.integrationId,
              },
              additionalRepositoryIds: [fixture.additional.id],
            },
            signal
          ),
        REQUEST_MS
      );
      assert.match(root.workspaceId, /^worktree_[\da-f-]{36}$/i);
      workspaces.add(root.workspaceId);
      assert.match(root.cloudAgentSessionId, /^workspace_[\da-f-]{36}$/i);
      assert(root.kiloSessionId, 'Promptless create did not return a native session ID');
      assert.equal(root.messageId, undefined, 'Promptless create admitted a message');
      return root;
    };
    const root = await create();
    const { workspaceId, cloudAgentSessionId } = root;
    console.log(`promptless workspaceId=${workspaceId}; sessionId=${cloudAgentSessionId}`);
    const readStatus = () =>
      deadline.within(
        'workspace status',
        signal =>
          getHostedWorkspaceStatus(
            config,
            {
              workspaceId,
              kilocodeOrganizationId: fixture.organizationId,
            },
            signal
          ),
        REQUEST_MS
      );
    const assertUnallocated = async () => {
      const [status, snapshot, allocation] = await Promise.all([
        readStatus(),
        deadline.within(
          'promptless session state',
          signal => getSessionSnapshot(config, cloudAgentSessionId, signal),
          REQUEST_MS
        ),
        inspect(cloudAgentSessionId, 'promptless allocation'),
      ]);
      assert.equal(status.workspaceId, workspaceId);
      assert.equal(status.organizationId, fixture.organizationId);
      assert.equal(status.deletionState, 'active');
      assert.equal(status.activity.hasActiveTurn, false);
      assert.equal(
        status.billing.intervalStartedAt,
        null,
        'Promptless workspace opened a billing interval'
      );
      assert.equal(snapshot.worktreeId, workspaceId);
      assert.equal(snapshot.kiloSessionId, root.kiloSessionId);
      assert.equal(snapshot.sandboxId, allocation.logicalSandboxId);
      assert.equal(snapshot.initialMessageId, undefined);
      assert.equal(snapshot.execution, null);
      assert.equal(
        allocation.physicalProviderRef,
        null,
        'Promptless workspace acquired a provider reference'
      );
      assert.equal(
        allocation.physicalState,
        null,
        'Promptless workspace attempted a physical allocation'
      );
      return allocation.logicalSandboxId;
    };
    const logicalSandboxId = await assertUnallocated();
    const replay = await create();
    assert.equal(replay.replayed, true, 'Matching create was not replayed');
    assert.equal(replay.workspaceId, workspaceId);
    assert.equal(replay.cloudAgentSessionId, cloudAgentSessionId);
    assert.equal(replay.kiloSessionId, root.kiloSessionId);
    await deadline.within('promptless observation window', signal =>
      delay(3_000, undefined, { signal })
    );
    assert.equal(await assertUnallocated(), logicalSandboxId);
    console.log(
      `matching retry kept promptless workspace unallocated; logicalSandboxId=${logicalSandboxId}`
    );

    await sendReadPair(cloudAgentSessionId, 'first-prompt');
    const firstAllocation = await inspect(cloudAgentSessionId, 'first prompt allocation');
    assert.equal(firstAllocation.logicalSandboxId, logicalSandboxId);
    assert(
      firstAllocation.physicalProviderRef,
      'Completed first prompt has no allocation reference'
    );

    if (fixture.verifySibling) {
      const sibling = await deadline.within(
        'create sibling',
        signal =>
          createHostedWorkspaceSession(
            config,
            {
              workspaceId,
              prompt: prompt('sibling'),
            },
            signal
          ),
        REQUEST_MS
      );
      assert.equal(sibling.workspaceId, workspaceId);
      assert.notEqual(sibling.cloudAgentSessionId, cloudAgentSessionId);
      assert.notEqual(sibling.kiloSessionId, root.kiloSessionId);
      const turn = await bootToCompletion(
        deadline,
        config,
        sibling,
        'sibling',
        matchesReadPair,
        TURN_MS
      );
      turn.stream.close();
      assert.equal(turn.messageId, sibling.messageId);
      const allocation = await inspect(sibling.cloudAgentSessionId, 'sibling allocation');
      assert.equal(allocation.logicalSandboxId, logicalSandboxId);
      assert.equal(
        allocation.physicalProviderRef,
        firstAllocation.physicalProviderRef,
        'Sibling did not share the first allocation'
      );
      console.log(
        `sibling: both workspace files verified on the shared allocation; sessionId=${sibling.cloudAgentSessionId}; messageId=${turn.messageId}`
      );
    } else {
      console.log('sibling: not checked (explicitly disabled in the fixture)');
    }

    if (fixture.verifyIdle) {
      const baseline = await readStatus();
      const idleAt = baseline.compute.estimatedSleepAt;
      assert(
        baseline.compute.status === 'active' && idleAt !== null && idleAt > baseline.observedAt,
        'Stage did not report a future idle deadline for the active workspace'
      );
      await deadline.within(
        'passive idle-stop observation',
        async signal => {
          for (;;) {
            await delay(5_000, undefined, { signal });
            const status = await readStatus();
            const allocation = await inspect(cloudAgentSessionId, 'idle allocation');
            assert.equal(allocation.logicalSandboxId, logicalSandboxId);
            if (allocation.physicalProviderRef !== null) {
              assert.equal(
                allocation.physicalProviderRef,
                firstAllocation.physicalProviderRef,
                'Allocation changed before idle recovery'
              );
            }
            if (status.compute.status !== 'sleeping' || allocation.physicalProviderRef !== null)
              continue;
            assert(
              status.observedAt >= idleAt,
              'Workspace stopped before the reported idle deadline'
            );
            assert.equal(status.activity.hasActiveTurn, false);
            assert.equal(status.billing.intervalStartedAt, null);
            return;
          }
        },
        idleAt - baseline.observedAt + IDLE_GRACE_MS
      );
      await sendReadPair(cloudAgentSessionId, 'idle-recovery');
      const recovered = await inspect(cloudAgentSessionId, 'recovered allocation');
      assert.equal(recovered.logicalSandboxId, logicalSandboxId);
      assert(recovered.physicalProviderRef, 'Idle recovery did not acquire an allocation');
      assert.notEqual(
        recovered.physicalProviderRef,
        firstAllocation.physicalProviderRef,
        'Idle recovery did not replace the stopped allocation'
      );
      const snapshot = await deadline.within(
        'recovered session',
        signal => getSessionSnapshot(config, cloudAgentSessionId, signal),
        REQUEST_MS
      );
      assert.equal(snapshot.worktreeId, workspaceId);
      console.log('idle recovery: replaced the stopped allocation without replacing the workspace');
    } else {
      console.log('idle recovery: not checked (verifyIdle is disabled)');
    }
  } finally {
    const cleanup = await Promise.allSettled(
      [...workspaces].map(async worktreeId => {
        const signal = AbortSignal.timeout(60_000);
        for (;;) {
          const result = await deleteWorktree(
            config,
            { worktreeId, kilocodeOrganizationId: fixture.organizationId },
            signal
          );
          assert.equal(result.success, true, `Cleanup failed: ${worktreeId}`);
          if (result.cleanup === 'complete') {
            console.log(`cleanup completed: ${worktreeId}`);
            return;
          }
          assert.equal(result.cleanup, 'pending', `Missing cleanup status: ${worktreeId}`);
          await delay(2_000, undefined, { signal });
        }
      })
    );
    for (const result of cleanup) {
      if (result.status === 'rejected') {
        console.error('Hosted multi-repo cleanup failed:', result.reason);
        process.exitCode = 1;
      }
    }
  }
}

async function main(): Promise<void> {
  const fixtureFile = process.env.E2E_HOSTED_MULTI_REPO_FIXTURE;
  const authFile = process.env.E2E_HOSTED_MULTI_REPO_AUTH_FILE;
  if (!fixtureFile || !authFile) {
    throw new Error(
      'Set E2E_HOSTED_MULTI_REPO_FIXTURE and E2E_HOSTED_MULTI_REPO_AUTH_FILE for an approved staging fixture'
    );
  }
  const fixture = parseHostedMultiRepositoryFixture(JSON.parse(readFileSync(fixtureFile, 'utf8')));
  await runHostedMultiRepository(fixture, loadDeployedAuthFile(authFile));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => {
    console.error('Staged hosted multi-repo scenario failed:', error);
    process.exitCode = 1;
  });
}
