import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { generateMessageId } from '@kilocode/cloud-agent-sdk/message-id';
import * as Crypto from 'expo-crypto';

import { detectRepositoryPlatform } from '@/components/agents/new-session-repository-state';
import { formatGitUrlProject } from '@/components/agents/session-list-helpers';
import { resolveNewSessionPromptForCreate } from '@/components/agents/new-session-prompt-state';
import { buildActiveSessionsTrayInput, isAttentionStatus } from '@/lib/active-sessions-live';
import { readStoredValue } from '@/lib/auth/secure-store-value';
import { contextKey, parseStoredModelPreference } from '@/lib/hooks/agent-model-preference';
import { dismissNeedsInputNotification } from '@/lib/needs-input-notification';
import { clearDraft, isStringDraft, loadDraft, NEW_SESSION_DRAFT_KEY } from '@/lib/persist/drafts';
import { ackSessionAttention } from '@/lib/session-attention';
import {
  ACTIVE_USER_ID_KEY,
  AGENT_MODEL_PREFERENCE_KEY,
  ORGANIZATION_STORAGE_KEY,
} from '@/lib/storage-keys';
import { reportSecureStoreFailure } from '@/lib/telemetry/secure-store-events';
import { trpcClient } from '@/lib/trpc';
import { parseTimestamp } from '@/lib/utils';

import { getTerminalBlankEpoch, isGlanceableOrgLost } from './cleanup';
import { pickFrontApprovableSession } from './front-approval';
import { resolveAnsweredRaises } from './attention-rows';
import { newestSessionTitle } from './newest-session';
import { getLastGlanceableSnapshot } from './persist';
import { getGlanceableSinks, writeGlanceableFrame } from './sink-registry';
import {
  getSurfaceExtras,
  type GlanceableActionFeedback,
  setSurfaceExtras,
} from './surface-extras';

/**
 * The two in-place widget actions and the headless tRPC work behind them. The
 * Android widget host launches a headless JS task for a custom `clickAction`
 * (`register.ts`), so nothing here may touch React, a query client, or a toast:
 * the widget's own reserved line is the only feedback surface.
 *
 * The scope (personal vs organization) comes from SecureStore, exactly as
 * `components/agents/mobile-session-manager.ts` picks org-scoped procedures
 * from the selected organization. `expo-secure-store` exists on both iOS and
 * Android, so neither platform lacks the capability and no per-platform storage
 * branch is kept: every read goes through `readStoredValue`, the app's one
 * cross-platform entry point, the same one `lib/glanceable/scope` reads.
 * `expo-crypto`'s `randomUUID` is also the same call on iOS and Android, so the
 * create's operation key needs no per-platform branch either.
 * `trpcClient` reads the stored token headlessly through
 * `getAuthTokenForRequest`, so a task with no Activity can authenticate.
 */

export type WidgetAction = 'approve' | 'new-agent';

/**
 * The reserved line's feedback while `action` runs. The copy key, not the text:
 * the props builder translates it, and both platforms call this so a tapped
 * approve and a tapped create can never claim the same progress.
 */
export function runningFeedback(action: WidgetAction): GlanceableActionFeedback {
  return action === 'approve' ? 'approving' : 'starting';
}

/**
 * The reserved line's feedback after `action` failed. The failed row stays
 * offered as the retry, so the line says what failed instead of the generic
 * none copy — a create included, which the widget otherwise answers with the
 * newest-session line as if nothing had happened.
 */
export function failureFeedback(action: WidgetAction): GlanceableActionFeedback {
  return action === 'approve' ? 'couldNotApprove' : 'couldNotStart';
}

/**
 * `none` = nothing to act on (no waiting session, or no draft/repository to
 * start from), so the caller opens the app instead. `no-permission` = the
 * waiting agent asks a free-form question; the widget must never invent an
 * answer, so the caller opens the app.
 */
type WidgetActionResultKind = 'approved' | 'created' | 'none' | 'no-permission' | 'failed';

export type WidgetActionResult = { kind: WidgetActionResultKind };

/**
 * One approve attempt: the outcome the widget reports, plus the tray session it
 * answered. The id is what `runWidgetAction` retires the raise's app-owned
 * notification with; every other outcome answers nothing, so it is null.
 */
type ApproveOutcome = {
  kind: WidgetActionResultKind;
  answeredSessionId: string | null;
};

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
 * The oldest row the user has to act on: the attention statuses in
 * `lib/active-sessions-live.ts` (`question`/`permission`), ranked by
 * `statusUpdatedAt` then `createdAt`. An untimed row ranks after every timed
 * one, and a tie keeps the earlier row. Used to tell a tray with a wait the
 * widget cannot answer from one with nothing waiting; the row the widget
 * approves is `pickFrontApprovableSession`'s oldest `permission`. Pure, so the
 * decision is unit-tested without tRPC.
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
  try {
    const [organizationId, userId] = await Promise.all([
      readStoredValue(ORGANIZATION_STORAGE_KEY),
      readStoredValue(ACTIVE_USER_ID_KEY),
    ]);
    return { organizationId: organizationId ?? null, userId: userId ?? null };
  } catch (error) {
    // Reported at warning level and rethrown: the widget action must settle on
    // `failed` rather than act on a scope it could not read.
    reportSecureStoreFailure('read', error);
    throw error;
  }
}

/**
 * Answer the longest-waiting permission with `'once'`. A rejected call is
 * `failed`; a tray with no permission waiting is `no-permission` when a
 * free-form question waits, and `none` otherwise — the caller opens the app for
 * either.
 */
async function approveWaitingSession(organizationId: string | null): Promise<ApproveOutcome> {
  const { sessions } = await trpcClient.activeSessions.list.query(
    buildActiveSessionsTrayInput(organizationId)
  );
  // The Approve chip is offered on `needsApproval`, which counts exactly the
  // `permission` rows, so the press must answer one of the rows that count
  // describes: the longest-waiting permission, the same pick the wrist and
  // notification controls make (`pickFrontApprovableSession`). Ranking every
  // attention row instead would let an older `question` or `retry` shadow a
  // newer permission — the chip would draw, and the press would only open the
  // app instead of approving the permission the chip was offered for.
  const waiting = pickFrontApprovableSession(sessions);
  if (waiting === null) {
    // Nothing approvable: a free-form question opens the app for an answer,
    // while a tray with nothing to act on needs only the agents list.
    return {
      kind: resolveWaitingSession(sessions) === null ? 'none' : 'no-permission',
      answeredSessionId: null,
    };
  }
  // Only a cloud-agent session carries pending interactions the control plane
  // can answer; a remote CLI session has none, so the app owns it.
  const session = await trpcClient.cliSessionsV2.get.query({ session_id: waiting.id });
  const cloudAgentSessionId = session.cloud_agent_session_id;
  if (cloudAgentSessionId === null) {
    return { kind: 'none', answeredSessionId: null };
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
    return { kind: 'no-permission', answeredSessionId: null };
  }
  const answer = { sessionId: cloudAgentSessionId, permissionId, response: 'once' as const };
  if (organizationId) {
    await trpcClient.organizations.cloudAgentNext.answerPermission.mutate({
      ...answer,
      organizationId,
    });
    return { kind: approved(waiting.id), answeredSessionId: waiting.id };
  }
  await trpcClient.cloudAgentNext.answerPermission.mutate(answer);
  return { kind: approved(waiting.id), answeredSessionId: waiting.id };
}

/**
 * Record the answer and report it. Every other answer path performs the same
 * ack after a successful response — the in-app permission card
 * (`use-interaction-handlers`), the notification's Approve and Reply
 * (`notification-action-interaction`), and the wrist control
 * (`approve-front-agent`) — so the widget's in-place Approve must too.
 *
 * The republish `runWidgetAction` runs next derives its counts from the tray
 * through `resolveAnsweredRaises`, and the tray row's status trails the
 * control plane's sync. Without the ack that row still counts as waiting, so
 * the redraw `register.ts` performs right after the action shows the
 * pre-action counts — the answered session still presented as waiting — until
 * the sync lands or the user refreshes.
 */
function approved(kiloSessionId: string): WidgetActionResultKind {
  ackSessionAttention(kiloSessionId);
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
  const raw = await readPersistedModelRaw();
  const entry = parseStoredModelPreference(raw)[contextKey(organizationId ?? undefined)];
  return entry ?? null;
}

async function readPersistedModelRaw(): Promise<string | null> {
  try {
    return await readStoredValue(AGENT_MODEL_PREFERENCE_KEY);
  } catch (error) {
    reportSecureStoreFailure('read', error);
    throw error;
  }
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
  await clearConsumedDraft(userId);
  return 'created';
}

/**
 * Clear the new-session draft a create just consumed. `clearDraft` reports its
 * own failure to Sentry and returns false, and a draft that survives would make
 * the next New agent press start the same prompt a second time, so retry once.
 * The create itself already succeeded either way, so this reports nothing: the
 * caller must not answer a created session with the failed-action copy.
 */
async function clearConsumedDraft(userId: string): Promise<void> {
  if (await clearDraft(userId, NEW_SESSION_DRAFT_KEY)) {
    return;
  }
  // Last attempt: its result cannot change what the caller reports, and a
  // second failure is reported to Sentry by `clearDraft` itself.
  await clearDraft(userId, NEW_SESSION_DRAFT_KEY);
}

/**
 * Re-derive the glanceable snapshot from the tray after a successful action
 * and hand it to every registered sink, so the placed widget shows the new
 * counts at once instead of waiting for the next tray event.
 *
 * Gated exactly like `GlanceablePublisher.isGated`: a terminal blank that lands
 * while the action runs — sign-out, an account or org switch, or a confirmed
 * lost org — owns the surface, and publishing here would put the counts it
 * blanked back on screen. `blankEpochAtStart` is the epoch the action saw when
 * it started, so an epoch that advanced before this press (an earlier
 * sign-out, long since republished) never silences it.
 */
async function republishTray(scope: WidgetScope, blankEpochAtStart: number): Promise<void> {
  if (scope.userId === null) {
    return;
  }
  const { sessions } = await trpcClient.activeSessions.list.query(
    buildActiveSessionsTrayInput(scope.organizationId)
  );
  // Checked after the read, not before: the tray fetch is another window in
  // which a blank can land, and it owns the surface over this republish.
  if (isGlanceableOrgLost() || getTerminalBlankEpoch() !== blankEpochAtStart) {
    return;
  }
  const snapshot: GlanceableAgentsSnapshot = buildGlanceableSnapshot({
    // A raise the user answered from the needs-input notification is no longer
    // waiting: count it the way the in-app list does.
    sessions: resolveAnsweredRaises(sessions),
    userId: scope.userId,
    organizationId: scope.organizationId,
    now: Date.now(),
    previousRevision: getLastGlanceableSnapshot()?.revision ?? 0,
  });
  setSurfaceExtras({
    ...getSurfaceExtras(),
    newestSessionTitle: newestSessionTitle(sessions),
  });
  // `writeGlanceableFrame` with the action's scope, never a bare `publish`: the
  // ongoing card outlives the JS process, and a widget press runs in a fresh
  // headless one, where the sink has no card it started itself. Only
  // `startOrUpdate` re-posts the fixed native id from the post-action counts —
  // `publish` alone only updates a card this process already started, so the
  // shade would keep the pre-action snapshot.
  writeGlanceableFrame(getGlanceableSinks(), snapshot, scope);
}

/**
 * Run one in-place widget action. Every failure is contained here: a rejected
 * call reports `failed` so the widget can say so and keep the action offered.
 */
export async function runWidgetAction(action: WidgetAction): Promise<WidgetActionResult> {
  // Read the publication gate as the action starts; `republishTray` compares it
  // after the action, so a blank that lands while it runs wins the surface.
  const blankEpochAtStart = getTerminalBlankEpoch();
  try {
    // The scope read is a storage call, so it belongs inside the container: a
    // rejection must settle the widget on its failure line instead of leaving
    // the progress line up with nothing driving it.
    const scope = await readStoredScope();
    const outcome =
      action === 'approve'
        ? await approveWaitingSession(scope.organizationId)
        : { kind: await createAgentFromDraft(scope), answeredSessionId: null };
    if (outcome.kind === 'approved' || outcome.kind === 'created') {
      // A republish that fails must not turn a completed action into `failed`:
      // the approve or create landed, the failure is reported by the sink
      // guard, and the next tray event redraws the counts.
      try {
        await republishTray(scope, blankEpochAtStart);
      } catch {
        // Contained: the action's own result stands.
      }
    }
    if (outcome.answeredSessionId !== null) {
      // Retire the raise's app-owned notification. The mount that re-plans the
      // posted set is not mounted on this headless path, and a widget press
      // posts no result notification the way the notification's own Approve
      // does, so nothing else takes the answered raise off the shade: it would
      // keep presenting an idle session as needs-input with its Approve action.
      // Awaited — the headless task ends with this promise — and contained,
      // because the approve already landed and a failed dismissal must not turn
      // it into the widget's failure line.
      await dismissNeedsInputNotification(outcome.answeredSessionId);
    }
    return { kind: outcome.kind };
  } catch {
    return { kind: 'failed' };
  }
}
