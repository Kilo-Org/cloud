/**
 * Owned Cloud resources for the K1 fixture provider.
 *
 * A fixture run owns exactly one local user, one environment profile, and (for
 * the Cloud lane) one hosted workspace with one root session. Ownership is
 * verified against the database before anything is deleted, so a forged or
 * stale descriptor can never remove another run's resources.
 */

import { eq } from 'drizzle-orm';
import { setTimeout as delay } from 'node:timers/promises';
import {
  agent_environment_profiles,
  cli_sessions_v2,
  cloud_agent_worktrees,
  createDrizzleClient,
} from '@kilocode/db';
import { createProfile, deleteProfile } from '@kilocode/cloud-agent-profile';
import type { CloudAgentWorkspaceSummary } from '@kilocode/session-ingest-contracts';
import {
  DRIVER_USER_EMAIL_SUFFIX,
  ensureTestUser,
  loadDevVars,
  mintApiToken,
  type TestUser,
} from './auth.js';
import {
  createHostedWorkspace,
  getHostedWorkspace,
  trpcCall,
  type DriverConfig,
} from './client.js';
import { FixtureProviderError } from './fixture-contract.js';
import { resolveFakeAdminToken } from './fake-llm-admin.js';
import type { LocalStack } from './fixture-stack.js';
import { signUserToken } from './local-kilo-stack.js';

export const FAKE_MODEL = 'kilo/fake-deterministic';
export const PROFILE_PREFIX = 'kilo-e2e-';
export const OWNER_DESCRIPTION_PREFIX = 'kilo-e2e fixture owner ';
export const GATE_POLL_MS = 100;
export const GATE_BUDGET_MS = 120_000;

export type RunIdentity = {
  user: TestUser;
  /** Modern run-scoped control token for Worker resource operations. */
  token: string;
  /** Local personal bearer the CLI exchanges for its own control token. */
  apiKey: string;
};

export type HostedResources = {
  workspaceId: string;
  cloudAgentSessionId: string;
  kiloSessionId: string;
};

export type OwnedIds = {
  profileId?: string;
  workspaceId?: string;
  cloudSessionId?: string;
  nativeSessionId?: string;
};

export type ResourceState = {
  profile: { userId: string; name: string; description: string | null } | null;
  worktree: {
    userId: string;
    deletionStartedAt: string | null;
    deletionCompletedAt: string | null;
  } | null;
  session: { userId: string; profileId: string | null } | null;
};

export type CloudObservation = {
  chatCompletions: number;
  engaged?: boolean;
};

export type FixtureCloud = {
  readonly stack: LocalStack;
  readonly model: string;
  identity(runId: string): Promise<RunIdentity>;
  createProfile(input: {
    runId: string;
    identity: RunIdentity;
    cleanupToken: string;
  }): Promise<string>;
  createWorkspace(input: {
    identity: RunIdentity;
    profileId: string;
    gitUrl: string;
    scope: string;
    seedPrompt?: string;
  }): Promise<HostedResources>;
  workspaceSummary(
    identity: RunIdentity,
    workspaceId: string
  ): Promise<CloudAgentWorkspaceSummary | null>;
  inspect(ids: OwnedIds): Promise<ResourceState>;
  deleteWorkspace(workspaceId: string, identity: RunIdentity): Promise<void>;
  deleteProfile(profileId: string, userId: string): Promise<void>;
  waitWorkspaceGone(workspaceId: string): Promise<boolean>;
  listWaiters(): Promise<string[]>;
  releaseGate(tag: string): Promise<void>;
  waitGate(tag: string, timeoutMs?: number): Promise<boolean>;
  observe(scope: string, tag?: string): Promise<CloudObservation>;
  close(): Promise<void>;
};

export function runUserEmail(): string {
  return `kilo-e2e-fixture${DRIVER_USER_EMAIL_SUFFIX}`;
}

export function profileName(runId: string): string {
  return `${PROFILE_PREFIX}${runId}`;
}

export function ownerDescription(cleanupToken: string): string {
  return `${OWNER_DESCRIPTION_PREFIX}${cleanupToken}`;
}

/** Deterministic prompt prefix for a run-scoped fake-LLM directive. */
export function scopedDirective(scope: string, conversation: string): string {
  return `__e2e_scope__:${scope}\n__fake__:${conversation}`;
}

function driverConfig(input: {
  stack: LocalStack;
  identity: RunIdentity;
  devVars: Record<string, string>;
  token?: string;
}): DriverConfig {
  return {
    workerUrl: input.stack.worker,
    user: input.identity.user,
    bearerToken: input.token ?? input.identity.token,
    skipBalanceCheck: true,
    internalApiSecret: input.devVars.INTERNAL_API_SECRET,
    expectControlPlane: true,
    gitUrl: '',
    model: FAKE_MODEL,
    fakeLlmUrl: input.stack.fake,
  };
}

function fakeAdminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${resolveFakeAdminToken()}` };
}

export function createCloudResources(input: {
  stack: LocalStack;
  workspaceDeletionTimeoutMs?: number;
}): FixtureCloud {
  const devVars = loadDevVars(input.stack.service);
  const nextAuthSecret = devVars.NEXTAUTH_SECRET;
  const drizzle = createDrizzleClient({
    connectionString: input.stack.database,
    poolConfig: { application_name: 'cloud-agent-next-fixture-provider', max: 1 },
    ssl: false,
  });
  const db = drizzle.db;
  const deletionTimeoutMs = input.workspaceDeletionTimeoutMs ?? 60_000;

  return {
    stack: input.stack,
    model: FAKE_MODEL,

    async identity(_runId) {
      const user = await ensureTestUser(input.stack.database, runUserEmail());
      // Provider operations need modern runtime admission; the descriptor key
      // stays the local personal bearer that the CLI exchanges itself.
      return {
        user,
        token: mintApiToken(user, nextAuthSecret, 60 * 60),
        apiKey: await signUserToken(nextAuthSecret, user),
      };
    },

    async createProfile({ runId, identity, cleanupToken }) {
      const created = await createProfile(
        db,
        { type: 'user', id: identity.user.id },
        identity.user.id,
        profileName(runId),
        ownerDescription(cleanupToken)
      );
      return created.id;
    },

    async createWorkspace({ identity, profileId, gitUrl, seedPrompt }) {
      const config = driverConfig({ stack: input.stack, identity, devVars });
      const repository = { type: 'git' as const, url: gitUrl };
      const created = await (seedPrompt === undefined
        ? createHostedWorkspace(config, { profileId, repository })
        : createHostedWorkspace(config, { profileId, repository, prompt: seedPrompt }));
      return {
        workspaceId: created.workspaceId,
        cloudAgentSessionId: created.cloudAgentSessionId,
        kiloSessionId: created.kiloSessionId,
      };
    },

    async workspaceSummary(identity, workspaceId) {
      return getHostedWorkspace(
        driverConfig({ stack: input.stack, identity, devVars }),
        workspaceId,
        AbortSignal.timeout(30_000)
      );
    },

    async inspect(ids) {
      const profile = ids.profileId
        ? await db
            .select({
              userId: agent_environment_profiles.owned_by_user_id,
              name: agent_environment_profiles.name,
              description: agent_environment_profiles.description,
            })
            .from(agent_environment_profiles)
            .where(eq(agent_environment_profiles.id, ids.profileId))
            .limit(1)
            .then(rows => rows[0] ?? null)
        : null;
      const worktree = ids.workspaceId
        ? await db
            .select({
              userId: cloud_agent_worktrees.kilo_user_id,
              deletionStartedAt: cloud_agent_worktrees.deletion_started_at,
              deletionCompletedAt: cloud_agent_worktrees.deletion_completed_at,
            })
            .from(cloud_agent_worktrees)
            .where(eq(cloud_agent_worktrees.worktree_id, ids.workspaceId))
            .limit(1)
            .then(rows => rows[0] ?? null)
        : null;
      const session = ids.cloudSessionId
        ? await db
            .select({
              userId: cli_sessions_v2.kilo_user_id,
              profileId: cli_sessions_v2.profile_id,
            })
            .from(cli_sessions_v2)
            .where(eq(cli_sessions_v2.cloud_agent_session_id, ids.cloudSessionId))
            .limit(1)
            .then(rows => rows[0] ?? null)
        : null;
      return {
        profile:
          profile === null
            ? null
            : {
                userId: profile.userId ?? '',
                name: profile.name,
                description: profile.description,
              },
        worktree:
          worktree === null
            ? null
            : {
                userId: worktree.userId,
                deletionStartedAt: worktree.deletionStartedAt,
                deletionCompletedAt: worktree.deletionCompletedAt,
              },
        session: session === null ? null : { userId: session.userId, profileId: session.profileId },
      };
    },

    async deleteWorkspace(workspaceId, identity) {
      await trpcCall(
        driverConfig({ stack: input.stack, identity, devVars }),
        'deleteWorktree',
        { worktreeId: workspaceId },
        { signal: AbortSignal.timeout(90_000) }
      );
    },

    async deleteProfile(profileId, userId) {
      await deleteProfile(db, profileId, { type: 'user', id: userId });
    },

    async waitWorkspaceGone(workspaceId) {
      const deadline = Date.now() + deletionTimeoutMs;
      while (Date.now() < deadline) {
        const row = await db
          .select({ deleted: cloud_agent_worktrees.deletion_completed_at })
          .from(cloud_agent_worktrees)
          .where(eq(cloud_agent_worktrees.worktree_id, workspaceId))
          .limit(1)
          .then(rows => rows[0] ?? null);
        if (row === null || row.deleted !== null) return true;
        await delay(1_000);
      }
      return false;
    },

    async listWaiters() {
      const response = await fetch(`${input.stack.fake.replace(/\/$/, '')}/test/waiters`, {
        headers: fakeAdminHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new FixtureProviderError(
          'cleanup',
          `fake-LLM waiter listing failed: HTTP ${response.status}`
        );
      }
      const body = (await response.json()) as { tags?: unknown };
      const tags: unknown[] = Array.isArray(body.tags) ? body.tags : [];
      return tags.flatMap(entry => {
        if (entry === null || typeof entry !== 'object' || !('tag' in entry)) return [];
        const tag = (entry as { tag?: unknown }).tag;
        return typeof tag === 'string' ? [tag] : [];
      });
    },

    async releaseGate(tag) {
      // A gate that is already gone is an idempotent success.
      const response = await fetch(
        `${input.stack.fake.replace(/\/$/, '')}/test/release?tag=${encodeURIComponent(tag)}`,
        {
          method: 'POST',
          headers: fakeAdminHeaders(),
          signal: AbortSignal.timeout(10_000),
        }
      );
      if (!response.ok && response.status !== 404) {
        throw new FixtureProviderError(
          'cleanup',
          `fake-LLM gate release failed: HTTP ${response.status}`
        );
      }
    },

    async waitGate(tag, timeoutMs = GATE_BUDGET_MS) {
      const base = input.stack.fake.replace(/\/$/, '');
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const response = await fetch(`${base}/test/gate-status?tag=${encodeURIComponent(tag)}`, {
          headers: fakeAdminHeaders(),
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) {
          const body = (await response.json()) as { engaged?: unknown };
          if (body.engaged === true) return true;
        }
        await delay(GATE_POLL_MS);
      }
      return false;
    },

    async observe(scope, tag) {
      const base = input.stack.fake.replace(/\/$/, '');
      const requests = await fetch(`${base}/test/requests?scope=${encodeURIComponent(scope)}`, {
        headers: fakeAdminHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!requests.ok) {
        throw new FixtureProviderError(
          'protocol',
          `fake-LLM scoped observation failed: HTTP ${requests.status}`
        );
      }
      const counts = (await requests.json()) as { chatCompletions?: unknown };
      const chatCompletions =
        typeof counts.chatCompletions === 'number' ? counts.chatCompletions : 0;
      if (tag === undefined) return { chatCompletions };
      const status = await fetch(`${base}/test/gate-status?tag=${encodeURIComponent(tag)}`, {
        headers: fakeAdminHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!status.ok) {
        throw new FixtureProviderError(
          'protocol',
          `fake-LLM gate observation failed: HTTP ${status.status}`
        );
      }
      const body = (await status.json()) as { engaged?: unknown };
      return { chatCompletions, engaged: body.engaged === true };
    },

    async close() {
      await drizzle.pool.end().catch(() => undefined);
    },
  };
}

/** A hosted workspace/session pair must belong to one owner and profile. */
export function workspaceOwnership(
  state: ResourceState,
  input: { userId: string; profileId?: string }
): { owned: boolean; reason?: string } {
  if (state.worktree === null) return { owned: true };
  if (state.worktree.userId !== input.userId) {
    return { owned: false, reason: 'workspace is owned by a different local user' };
  }
  // A completed tombstone is a removed workspace: the real deletion removes
  // the root session rows in the same transaction, so a retry must not treat
  // the missing session as a foreign resource.
  if (state.worktree.deletionCompletedAt !== null) return { owned: true };
  if (state.session === null) {
    return { owned: false, reason: 'hosted root session is missing for the owned workspace' };
  }
  if (state.session.userId !== input.userId) {
    return { owned: false, reason: 'root session is owned by a different local user' };
  }
  if (input.profileId !== undefined && state.session.profileId !== input.profileId) {
    return { owned: false, reason: 'root session was created with a different profile' };
  }
  return { owned: true };
}

export function profileOwnership(
  state: ResourceState,
  input: { userId: string; runId: string; token: string }
): { owned: boolean; reason?: string } {
  if (state.profile === null) return { owned: true };
  if (state.profile.userId !== input.userId) {
    return { owned: false, reason: 'profile is owned by a different local user' };
  }
  if (state.profile.name !== profileName(input.runId)) {
    return { owned: false, reason: 'profile name does not match this run id' };
  }
  if (state.profile.description !== ownerDescription(input.token)) {
    return { owned: false, reason: 'profile ownership marker does not match the descriptor' };
  }
  return { owned: true };
}

export function workspaceBelongsToUser(
  summary: CloudAgentWorkspaceSummary,
  userId: string
): boolean {
  return summary.userId === userId;
}
