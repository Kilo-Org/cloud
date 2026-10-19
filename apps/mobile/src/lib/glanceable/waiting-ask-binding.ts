import {
  attachWaitingAskPermission,
  getWaitingAsk,
  recordWaitingAsk,
  type WaitingAsk,
} from '@/lib/glanceable/waiting-ask';
import {
  resolveCloudAgentSessionId,
  resolvePendingPermissionId,
} from '@/lib/glanceable/pending-permission';

/**
 * Capture the permission id the recorded aggregate ask displayed, at the time
 * the publisher recorded it.
 *
 * The tray rows carry no permission id — it lives only in the control plane's
 * pending-interaction projection — so the recorded ask stores the id of the
 * request it displayed. The publisher calls `bindWaitingAskPermission` for
 * every ask it records (see `create-publisher.ts`); a cloud-agent permission
 * ask gets its displayed request id attached, and the answer path answers
 * only while the live projection still shows that id.
 *
 * A question, a retry, or a non-cloud-agent ask has no single approvable
 * request; the aggregate flow answers those with `none` anyway, so no
 * capture runs for them.
 */

/** How long a failed capture waits before the next record may retry it. */
const CAPTURE_RETRY_COOLDOWN_MS = 60_000;

export type BindWaitingAskPermissionDeps = {
  resolvePermissionId?: (
    kiloSessionId: string,
    organizationId: string | null
  ) => Promise<string | null>;
  now?: () => number;
};

/** The ask identity a cooldown entry is keyed on. */
function askIdentity(ask: WaitingAsk): string {
  return `${ask.kiloSessionId}|${ask.status}|${ask.statusUpdatedAt ?? ''}`;
}

/**
 * The last capture attempt that failed for an ask identity, in epoch ms.
 * In-memory only: a headless process that dies loses the cooldown, and the
 * next one retries once — the bound is the retry cadence, not a guarantee.
 * Runtime insertion and deletion per attempt, so a `Map`, not a static table.
 */
const failedAt = new Map<string, number>();

/** Drop cooldown entries past the window, so the map cannot grow unbounded. */
function pruneFailures(now: number): void {
  for (const [identity, at] of failedAt) {
    if (now - at >= CAPTURE_RETRY_COOLDOWN_MS) {
      failedAt.delete(identity);
    }
  }
}

/**
 * The same ask the publisher re-records on every heartbeat: identical
 * session, status and status time. Only its `recordedAt` moves, so a binding
 * captured for the displayed request carries forward instead of being wiped
 * and re-opened on the control plane every few seconds.
 */
function isSameAsk(previous: WaitingAsk | null, next: WaitingAsk): boolean {
  return (
    previous !== null &&
    previous.kiloSessionId === next.kiloSessionId &&
    previous.status === next.status &&
    previous.statusUpdatedAt === next.statusUpdatedAt
  );
}

/** Default capture: the same control-plane reads the answer path performs. */
async function resolveDisplayedPermissionId(
  kiloSessionId: string,
  organizationId: string | null
): Promise<string | null> {
  const cloudAgentSessionId = await resolveCloudAgentSessionId(kiloSessionId);
  return resolvePendingPermissionId({ cloudAgentSessionId, organizationId });
}

/**
 * Run one capture and record its outcome. Fire-and-forget: the publisher must
 * never block a heartbeat on the control plane. A `null` resolution is a
 * proven-absent projection, and a rejection a transport failure; both enter
 * the cooldown so the next heartbeat does not reopen the stream for an ask
 * that cannot bind. A status change resets the identity and retries.
 */
async function runCapture(
  ask: WaitingAsk,
  resolve: (kiloSessionId: string, organizationId: string | null) => Promise<string | null>,
  now: () => number
): Promise<void> {
  try {
    const permissionId = await resolve(ask.kiloSessionId, ask.organizationId);
    attachWaitingAskPermission(ask, permissionId);
    if (permissionId === null) {
      // The projection names no pending permission for this ask. Enter the
      // cooldown so the next heartbeat does not reopen the stream; a status
      // change resets the identity and retries.
      failedAt.set(askIdentity(ask), now());
    }
  } catch {
    failedAt.set(askIdentity(ask), now());
  }
}

/**
 * Record the ask and attach the permission id it displayed. Called from the
 * publisher's `onWaitingAskChange`, in place of the bare recorder.
 *
 * `null` clears the record exactly like the bare recorder. A new ask is
 * recorded first — unbound, so the surfaces gate Approve off until the
 * capture lands — and its capture runs without blocking the publisher: the
 * attach lands when the read settles, or the ask stays unbound and the next
 * record retries after the cooldown.
 */
export function bindWaitingAskPermission(
  ask: WaitingAsk | null,
  deps: BindWaitingAskPermissionDeps = {}
): void {
  if (ask === null) {
    recordWaitingAsk(null);
    failedAt.clear();
    return;
  }
  if (!isSameAsk(getWaitingAsk(), ask)) {
    recordWaitingAsk(ask);
  }
  if (ask.status !== 'permission' || !ask.isCloudAgent) {
    return;
  }
  if ((ask.permissionId ?? null) !== null) {
    return;
  }
  const now = deps.now ?? (() => Date.now());
  pruneFailures(now());
  if (failedAt.has(askIdentity(ask))) {
    return;
  }
  void runCapture(ask, deps.resolvePermissionId ?? resolveDisplayedPermissionId, now);
}

/**
 * Test-only: drop the cooldown state, so cases cannot leak a failure into the
 * next case. Mirrors the waiting-ask store reset helpers.
 */
export function _resetWaitingAskBindingForTests(): void {
  failedAt.clear();
}
