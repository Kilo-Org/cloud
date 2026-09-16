import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { generateMessageId } from '@kilocode/cloud-agent-sdk/message-id';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { detectRepositoryPlatform } from '@/components/agents/new-session-repository-state';
import { formatGitUrlProject } from '@/components/agents/session-list-helpers';
import { resolveNewSessionPromptForCreate } from '@/components/agents/new-session-prompt-state';
import { buildActiveSessionsTrayInput, isAttentionStatus } from '@/lib/active-sessions-live';
import { contextKey, parseStoredModelPreference } from '@/lib/hooks/agent-model-preference';
import { clearDraft, isStringDraft, loadDraft, NEW_SESSION_DRAFT_KEY } from '@/lib/persist/drafts';
import {
  ACTIVE_USER_ID_KEY,
  AGENT_MODEL_PREFERENCE_KEY,
  ORGANIZATION_STORAGE_KEY,
} from '@/lib/storage-keys';
import { trpcClient } from '@/lib/trpc';
import { parseTimestamp } from '@/lib/utils';

import { newestSessionTitle } from './newest-session';
import { getLastGlanceableSnapshot } from './persist';
import { forEachSink } from './sink-registry';
import { getSurfaceExtras, setSurfaceExtras } from './surface-extras';

/**
 * The two in-place widget actions and the headless tRPC work behind them. The
 * Android widget host launches a headless JS task for a custom `clickAction`
 * (`register.ts`), so nothing here may touch React, a query client, or a toast:
 * the widget's own reserved line is the only feedback surface.
 *
 * The scope (personal vs organization) comes from SecureStore, exactly as
 * `components/agents/mobile-session-manager.ts` picks org-scoped procedures
 * from the selected organization. `trpcClient` reads the stored token headlessly
 * through `getAuthTokenForRequest`, so a task with no Activity can authenticate.
 */

export type WidgetAction = 'approve' | 'new-agent';

/**
 * `none` = nothing to act on (no waiting session, or no draft/repository to
 * start from), so the caller opens the app instead. `no-permission` = the
 * waiting agent asks a free-form question; the widget must never invent an
 * answer, so the caller opens the app.
 */
type WidgetActionResultKind = 'approved' | 'created' | 'none' | 'no-permission' | 'failed';

export type WidgetActionResult = { kind: WidgetActionResultKind };

/** One tray row, as the active-sessions cache returns it. */
export type WaitingSessionRow = {
  id: string;
  status: string;
  /** ISO 8601; when this session's status last changed. */
  statusUpdatedAt?: string | null;
  /** ISO 8601; when the session row was created. */
  createdAt?: string | null;
};

type WidgetScope = {
  organizationId: string | null;
  userId: string | null;
};

/**
 * The current wait, as the tray carries it: `statusUpdatedAt` first (when the
 * wait itself started), then `createdAt`. Null when no row stands in a
 * permission/question state.
 */
function waitingSince(row: WaitingSessionRow): number | null {
  const value = row.statusUpdatedAt ?? row.createdAt;
  if (value === undefined || value === null) {
    return null;
  }
  // `parseTimestamp`, not `Date`: `createdAt` reaches the client as raw
  // PostgreSQL text, which Hermes cannot parse on its own.
  const at = parseTimestamp(value).getTime();
  return Number.isNaN(at) ? null : at;
}

/**
 * The session to approve: the oldest row waiting on a permission or a
 * question (the attention statuses in `lib/active-sessions-live.ts`), ranked
 * by `statusUpdatedAt` then `createdAt`. An untimed row ranks after every
 * timed one, and a tie keeps the earlier row. Pure, so the widget's decision
 * is unit-tested without tRPC.
 */
export function resolveWaitingSession(
  rows: readonly WaitingSessionRow[]
): WaitingSessionRow | null {
  let waiting: WaitingSessionRow | null = null;
  let waitingAt: number | null = null;
  for (const row of rows) {
    if (isAttentionStatus(row.status)) {
      const at = waitingSince(row);
      // The earliest wait wins; a row with no usable timestamp ranks after
      // every timed one, and a tie keeps the row that came first.
      const isEarlier = waiting === null || (at !== null && (waitingAt === null || at < waitingAt));
      if (isEarlier) {
        waiting = row;
        waitingAt = at;
      }
    }
  }
  return waiting;
}

/**
 * One pending permission's request id, or null when the entry carries none.
 * The control plane types each entry as `unknown`
 * (`services/cloud-agent-next/src/shared/protocol.ts`), so decode the single
 * field the answer needs before branching.
 */
function permissionIdOf(permission: unknown): string | null {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- untyped tRPC boundary value
  if (typeof permission !== 'object' || permission === null || !('id' in permission)) {
    return null;
  }
  const id = permission.id;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- untyped tRPC boundary value
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * The oldest pending permission request id, or null when none waits. The
 * server keeps the collection in arrival order, so the first entry with a
 * usable id is the one that has waited longest.
 */
export function oldestPendingPermissionId(permissions: readonly unknown[]): string | null {
  for (const permission of permissions) {
    const id = permissionIdOf(permission);
    if (id !== null) {
      return id;
    }
  }
  return null;
}

async function readStoredScope(): Promise<WidgetScope> {
  const [organizationId, userId] = await Promise.all([
    SecureStore.getItemAsync(ORGANIZATION_STORAGE_KEY),
    SecureStore.getItemAsync(ACTIVE_USER_ID_KEY),
  ]);
  return { organizationId: organizationId ?? null, userId: userId ?? null };
}

/**
 * Answer the oldest waiting permission with `'once'`. Nothing waiting is
 * `none`; a wait with no permission pending is `no-permission` (the caller
 * opens the app for the free-form question); a rejected call is `failed`.
 */
async function approveWaitingSession(
  organizationId: string | null
): Promise<WidgetActionResultKind> {
  const { sessions } = await trpcClient.activeSessions.list.query(
    buildActiveSessionsTrayInput(organizationId)
  );
  const waiting = resolveWaitingSession(sessions);
  if (waiting === null) {
    return 'none';
  }
  // Only a cloud-agent session carries pending interactions the control plane
  // can answer; a remote CLI session has none, so the app owns it.
  const session = await trpcClient.cliSessionsV2.get.query({ session_id: waiting.id });
  const cloudAgentSessionId = session.cloud_agent_session_id;
  if (cloudAgentSessionId === null) {
    return 'none';
  }
  // The personal `getPendingInteractions` refuses an organization session (its
  // ownership check requires a null `organization_id`), so pick the
  // organization-scoped twin exactly like `answerPermission` below.
  const pending = organizationId
    ? await trpcClient.organizations.cloudAgentNext.getPendingInteractions.query({
        cloudAgentSessionId,
        organizationId,
      })
    : await trpcClient.cloudAgentNext.getPendingInteractions.query({
        cloudAgentSessionId,
      });
  const permissionId = oldestPendingPermissionId(pending.permissions);
  if (permissionId === null) {
    return 'no-permission';
  }
  const answer = { sessionId: cloudAgentSessionId, permissionId, response: 'once' as const };
  if (organizationId) {
    await trpcClient.organizations.cloudAgentNext.answerPermission.mutate({
      ...answer,
      organizationId,
    });
    return 'approved';
  }
  await trpcClient.cloudAgentNext.answerPermission.mutate(answer);
  return 'approved';
}

type RecentRepositoryField =
  | { githubRepo: string }
  | { gitlabProject: string }
  | { bitbucketRepo: { fullName: string; workspaceUuid: string; repositoryUuid: string } };

/** Matches the recents window the new-session screen queries. */
const RECENT_REPOSITORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The most recent repository as a `prepareSession` repository field. Bitbucket
 * carries provider uuids, so it is resolved against the organization's
 * connected repositories the way the new-session picker resolves a recent row.
 */
async function resolveRecentRepository(
  organizationId: string | null
): Promise<RecentRepositoryField | null> {
  const { repositories } = await trpcClient.cliSessionsV2.recentRepositories.query({
    organizationId,
    updatedSince: new Date(Date.now() - RECENT_REPOSITORY_WINDOW_MS).toISOString(),
  });
  const newest = repositories[0];
  if (newest === undefined) {
    return null;
  }
  const platform = detectRepositoryPlatform(newest.gitUrl);
  const fullName = formatGitUrlProject(newest.gitUrl);
  if (platform === undefined || fullName.length === 0) {
    return null;
  }
  if (platform === 'github') {
    return { githubRepo: fullName };
  }
  if (platform === 'gitlab') {
    return { gitlabProject: fullName };
  }
  // Bitbucket is organization-only (`personalPrepareSessionNextSchema` refuses
  // a personal Bitbucket repository), and its create field needs the uuids.
  if (organizationId === null) {
    return null;
  }
  const listing = await trpcClient.organizations.cloudAgentNext.listBitbucketRepositories.query({
    organizationId,
    forceRefresh: false,
  });
  if (listing.status !== 'available') {
    return null;
  }
  const match = listing.repositories.find(
    repository => repository.fullName.toLowerCase() === fullName.toLowerCase()
  );
  return match === undefined
    ? null
    : {
        bitbucketRepo: {
          fullName: match.fullName,
          workspaceUuid: match.workspaceUuid,
          repositoryUuid: match.id,
        },
      };
}

/** The model the user last chose in this scope, or null when none is stored. */
async function readPersistedModel(
  organizationId: string | null
): Promise<{ model: string; variant: string } | null> {
  const raw = await SecureStore.getItemAsync(AGENT_MODEL_PREFERENCE_KEY);
  const entry = parseStoredModelPreference(raw)[contextKey(organizationId ?? undefined)];
  return entry ?? null;
}

/**
 * Start a new agent from the persisted new-session draft, reusing the shipped
 * create contract: the most recent repository, the persisted model, and
 * `prepareSession` with `autoInitiate: true`. A missing draft, repository, or
 * model is `none`, so the caller opens the app's new-session screen instead.
 */
async function createAgentFromDraft(scope: WidgetScope): Promise<WidgetActionResultKind> {
  const { organizationId, userId } = scope;
  if (userId === null) {
    return 'none';
  }
  const draft = await loadDraft(userId, NEW_SESSION_DRAFT_KEY, isStringDraft);
  const prompt = resolveNewSessionPromptForCreate(draft ?? '');
  if (prompt === null) {
    return 'none';
  }
  const model = await readPersistedModel(organizationId);
  if (model === null) {
    return 'none';
  }
  const repository = await resolveRecentRepository(organizationId);
  if (repository === null) {
    return 'none';
  }
  const input = {
    prompt,
    initialMessageId: generateMessageId(),
    mode: 'code' as const,
    model: model.model,
    variant: model.variant === '' ? undefined : model.variant,
    autoCommit: false,
    autoInitiate: true,
    operationKey: Crypto.randomUUID(),
    ...repository,
  };
  await (organizationId
    ? trpcClient.organizations.cloudAgentNext.prepareSession.mutate({
        ...input,
        organizationId,
      })
    : trpcClient.cloudAgentNext.prepareSession.mutate(input));
  // The draft became a session, so the next new-session visit starts empty.
  await clearDraft(userId, NEW_SESSION_DRAFT_KEY);
  return 'created';
}

/**
 * Re-derive the glanceable snapshot from the tray after a successful action
 * and hand it to every registered sink, so the placed widget shows the new
 * counts at once instead of waiting for the next tray event.
 */
async function republishTray(scope: WidgetScope): Promise<void> {
  if (scope.userId === null) {
    return;
  }
  const { sessions } = await trpcClient.activeSessions.list.query(
    buildActiveSessionsTrayInput(scope.organizationId)
  );
  const snapshot: GlanceableAgentsSnapshot = buildGlanceableSnapshot({
    sessions,
    userId: scope.userId,
    organizationId: scope.organizationId,
    now: Date.now(),
    previousRevision: getLastGlanceableSnapshot()?.revision ?? 0,
  });
  setSurfaceExtras({
    ...getSurfaceExtras(),
    newestSessionTitle: newestSessionTitle(sessions),
  });
  forEachSink('widget_action_republish', sink => {
    sink.publish(snapshot);
  });
}

/**
 * Run one in-place widget action. Every failure is contained here: a rejected
 * call reports `failed` so the widget can say so and keep the action offered.
 */
export async function runWidgetAction(action: WidgetAction): Promise<WidgetActionResult> {
  const scope = await readStoredScope();
  try {
    const kind =
      action === 'approve'
        ? await approveWaitingSession(scope.organizationId)
        : await createAgentFromDraft(scope);
    if (kind === 'approved' || kind === 'created') {
      await republishTray(scope);
    }
    return { kind };
  } catch {
    return { kind: 'failed' };
  }
}
