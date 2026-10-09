import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { buildHomeWidgetDetails } from '@kilocode/app-shared/home-widget';
import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';

import { buildActiveSessionsTrayInput, isAttentionStatus } from '@/lib/active-sessions-live';
import { readStoredValue } from '@/lib/auth/secure-store-value';
import { dismissNeedsInputNotification } from '@/lib/needs-input-notification';
import { ackSessionAttention } from '@/lib/session-attention';
import { ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';
import { reportSecureStoreFailure } from '@/lib/telemetry/secure-store-events';
import { trpcClient } from '@/lib/trpc';
import { parseTimestamp } from '@/lib/utils';

import { getTerminalBlankEpoch, isGlanceableOrgLost } from './cleanup';
import { setHomeWidgetDetails } from './home-widget-data';
import { resolveAnsweredRaises } from './attention-rows';
import { newestSessionTitle } from './newest-session';
import { getLastGlanceableSnapshot } from './persist';
import { getGlanceableSinks, writeGlanceableFrame } from './sink-registry';
import { getSurfaceExtras, setSurfaceExtras } from './surface-extras';

/**
 * The widget's in-place Approve and the headless tRPC work behind it. The
 * Android widget host launches a headless JS task for a custom `clickAction`
 * (`register.ts`), so nothing here may touch React, a query client, or a toast:
 * the widget's own reserved line is the only feedback surface. New agent is not
 * an in-place action: it needs the composer, so both platforms open the app on
 * the new-session screen instead.
 *
 * The scope (personal vs organization) comes from SecureStore, exactly as
 * `components/agents/mobile-session-manager.ts` picks org-scoped procedures
 * from the selected organization. `expo-secure-store` exists on both iOS and
 * Android, so neither platform lacks the capability and no per-platform storage
 * branch is kept: every read goes through `readStoredValue`, the app's one
 * cross-platform entry point, the same one `lib/glanceable/scope` reads.
 * `trpcClient` reads the stored token headlessly through
 * `getAuthTokenForRequest`, so a task with no Activity can authenticate.
 */

/**
 * `none` = no waiting session to act on, so the caller opens the app instead.
 * `no-permission` = the waiting agent asks a free-form question; the widget
 * must never invent an answer, so the caller opens the app.
 * `stale` = the request the widget displayed is no longer pending; nothing is
 * answered and the caller shows the current state instead.
 */
type WidgetApproveResultKind = 'approved' | 'none' | 'no-permission' | 'stale' | 'failed';

/** Bounds the tray reads one press makes while it looks for the displayed request. */
const MAX_APPROVAL_CANDIDATES = 3;

export type WidgetApproveResult = { kind: WidgetApproveResultKind };

/**
 * One approve attempt: the outcome the widget reports, plus the tray session it
 * answered. The id is what `runWidgetApprove` retires the raise's app-owned
 * notification with; every other outcome answers nothing, so it is null.
 *
 * A successful approve also records the answer before it returns
 * (`ackSessionAttention`), the way every other answer path does after a
 * successful response — the in-app permission card (`use-interaction-handlers`),
 * the notification's Approve and Reply (`notification-action-interaction`), and
 * the wrist control (`approve-front-agent`). The republish `runWidgetApprove`
 * runs next derives its counts from the tray through `resolveAnsweredRaises`,
 * and the tray row's status trails the control plane's sync: without the ack
 * that row still counts as waiting, so the redraw `register.ts` performs right
 * after the action shows the pre-action counts — the answered session still
 * presented as waiting — until the sync lands or the user refreshes.
 */
type ApproveOutcome = {
  kind: WidgetApproveResultKind;
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
 * One read whose failure must stay observable: reported at warning level and
 * rethrown, so the widget action settles on `failed` rather than acting on a
 * value it could not read — the same report-and-rethrow shape
 * `writeStoredValue` has for the write side.
 */
async function readStoredValueReported(key: string): Promise<string | null> {
  try {
    return await readStoredValue(key);
  } catch (error) {
    reportSecureStoreFailure('read', error);
    throw error;
  }
}

async function readStoredScope(): Promise<WidgetScope> {
  const [organizationId, userId] = await Promise.all([
    readStoredValueReported(ORGANIZATION_STORAGE_KEY),
    readStoredValueReported(ACTIVE_USER_ID_KEY),
  ]);
  return { organizationId: organizationId ?? null, userId: userId ?? null };
}

/**
 * The first pending permission on `sessionId` whose hashed ids equal the key
 * the widget displayed, or null when none matches. Sequential so the search
 * stops at the first match.
 */
async function findVisiblePermissionId(
  sessionId: string,
  permissions: readonly unknown[],
  expectedApprovalKey: string
): Promise<string | null> {
  for (const permission of permissions) {
    const permissionId = permissionIdOf(permission);
    if (permissionId !== null) {
      // eslint-disable-next-line no-await-in-loop -- sequential: stops at the first match
      const approvalKey = await digestStringAsync(
        CryptoDigestAlgorithm.SHA256,
        JSON.stringify([sessionId, permissionId])
      );
      if (approvalKey === expectedApprovalKey) {
        return permissionId;
      }
    }
  }
  return null;
}

/**
 * Answer exactly the permission the widget displayed. The key is a hash of
 * the visible session and permission ids; a press whose request was answered,
 * withdrawn, or replaced matches nothing and answers nothing.
 */
async function approveVisiblePermission(
  organizationId: string | null,
  expectedApprovalKey: string | null
): Promise<ApproveOutcome> {
  const { sessions } = await trpcClient.activeSessions.list.query(
    buildActiveSessionsTrayInput(organizationId)
  );
  const candidates = sessions
    .filter(row => row.status === 'permission')
    // eslint-disable-next-line unicorn/no-array-sort -- Hermes does not implement Array.prototype.toSorted; filter already copies so nothing shared is mutated
    .sort((a, b) => (waitingSince(a) ?? Infinity) - (waitingSince(b) ?? Infinity))
    .slice(0, MAX_APPROVAL_CANDIDATES);
  if (candidates.length === 0) {
    return {
      kind: resolveWaitingSession(sessions) === null ? 'none' : 'no-permission',
      answeredSessionId: null,
    };
  }
  if (expectedApprovalKey === null) {
    return { kind: 'stale', answeredSessionId: null };
  }
  for (const row of candidates) {
    // Sequential and bounded: each read can stop the search once it matches.
    // eslint-disable-next-line no-await-in-loop -- see above
    const session = await trpcClient.cliSessionsV2.get.query({ session_id: row.id });
    const cloudAgentSessionId = session.cloud_agent_session_id;
    if (cloudAgentSessionId !== null) {
      // The personal read refuses an organization session, so an organization
      // scope uses its own twin for both the read and the answer.
      const pending = organizationId
        ? // eslint-disable-next-line no-await-in-loop -- see above
          await trpcClient.organizations.cloudAgentNext.getPendingInteractions.query({
            cloudAgentSessionId,
            organizationId,
          })
        : // eslint-disable-next-line no-await-in-loop -- see above
          await trpcClient.cloudAgentNext.getPendingInteractions.query({ cloudAgentSessionId });
      // eslint-disable-next-line no-await-in-loop -- see above
      const permissionId = await findVisiblePermissionId(
        row.id,
        pending.permissions,
        expectedApprovalKey
      );
      if (permissionId !== null) {
        const answer = { sessionId: cloudAgentSessionId, permissionId, response: 'once' as const };
        // eslint-disable-next-line no-await-in-loop -- the matching request is answered once
        await (organizationId
          ? trpcClient.organizations.cloudAgentNext.answerPermission.mutate({
              ...answer,
              organizationId,
            })
          : trpcClient.cloudAgentNext.answerPermission.mutate(answer));
        ackSessionAttention(row.id);
        return { kind: 'approved', answeredSessionId: row.id };
      }
    }
  }
  return { kind: 'stale', answeredSessionId: null };
}

/**
 * Re-derive the glanceable snapshot from the tray after a successful approve
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
  setHomeWidgetDetails(buildHomeWidgetDetails(resolveAnsweredRaises(sessions)));
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
 * Run the widget's in-place Approve. Every failure is contained here: a
 * rejected call reports `failed` so the widget can say so and keep Approve
 * offered.
 */
export async function runWidgetApprove(
  expectedApprovalKey: string | null
): Promise<WidgetApproveResult> {
  // Read the publication gate as the action starts; `republishTray` compares it
  // after the action, so a blank that lands while it runs wins the surface.
  const blankEpochAtStart = getTerminalBlankEpoch();
  try {
    // The scope read is a storage call, so it belongs inside the container: a
    // rejection must settle the widget on its failure line instead of leaving
    // the progress line up with nothing driving it.
    const scope = await readStoredScope();
    const outcome = await approveVisiblePermission(scope.organizationId, expectedApprovalKey);
    if (outcome.kind === 'approved' || outcome.kind === 'stale') {
      // A republish that fails must not turn a completed approve into `failed`:
      // the approve landed, the failure is reported by the sink guard, and the
      // next tray event redraws the counts.
      try {
        await republishTray(scope, blankEpochAtStart);
      } catch {
        // Contained: the approve's own result stands.
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
