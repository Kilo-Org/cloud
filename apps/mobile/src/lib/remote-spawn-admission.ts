import { i18n } from '@/i18n';
import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { type SharePayload } from '@/lib/share-payload';

export const remoteSpawnFilesNotSupportedToast = () =>
  i18n.t('kiloclaw.remoteSpawnFilesNotSupported');

/** The plan-state fields of one membership row from `organizations.list`. */
export type OrganizationPlanState = {
  organizationId: string;
  isTrialExpiredForEnforcement: boolean;
};

/** A spawn's organization scope and the membership verdicts behind it. */
export type RemoteStartPlanInput = {
  /** `null`/omitted is a personal start. */
  organizationId?: string | null;
  organizations?: readonly OrganizationPlanState[];
};

/**
 * The organization subscription gate's verdict for a remote start.
 *
 * Starting a session on a remote CLI is a relay command, not an organization
 * mutation, so the server never runs `requireActiveSubscriptionOrTrial` for it
 * and the session is created before the model request is refused. The app reads
 * the gate's own verdict from `organizations.list` and refuses the spawn here,
 * with the explanation the cloud start path shows for the same state. Only the
 * server's boolean is trusted: nothing re-derives the plan from seats or
 * balance. A personal start and an unsettled or stale membership list (the
 * organization is not in it) never refuse: the app does not block a start on a
 * verdict it does not have.
 */
export function resolveRemoteStartPlan(input: RemoteStartPlanInput):
  | {
      allowed: true;
    }
  | { allowed: false; toast: string } {
  const { organizationId, organizations } = input;
  if (organizationId == null || organizations === undefined) {
    return { allowed: true };
  }
  const organization = organizations.find(row => row.organizationId === organizationId);
  if (organization === undefined || !organization.isTrialExpiredForEnforcement) {
    return { allowed: true };
  }
  return { allowed: false, toast: i18n.t('common.organizationTrialEnded') };
}

/**
 * The plan explanation the new-session form shows under the composer before any
 * press, or `null` when the selected account may start. It answers for every
 * run target: a Cloud Agent create is `organizations.cloudAgentNext.prepareSession`,
 * an organization mutation that `requireActiveSubscriptionOrTrial` refuses for
 * the same state, and a remote spawn is refused by `resolveRemoteStartPlan` at
 * the press. Reading the verdict before the press is what keeps a lapsed
 * organization's Start disabled with its reason on screen, instead of failing
 * after a create or naming a step (a provider connect) that cannot fix it.
 */
export function startPlanRefusal(input: RemoteStartPlanInput): string | null {
  const plan = resolveRemoteStartPlan(input);
  return plan.allowed ? null : plan.toast;
}

/**
 * Whether a remote spawn may proceed from the press-time state. The
 * organization's plan is checked first: a lapsed organization cannot run the
 * session at all, so its explanation wins over a capability refusal.
 */
export function resolveRemoteSpawnAdmission(input: {
  instance: InstancePickerInstance;
  payload: SharePayload | null;
  /** The spawn's press-time organization scope and the membership verdicts. */
  plan?: RemoteStartPlanInput;
}): { allowed: true } | { allowed: false; toast: string } {
  const { payload, instance } = input;
  const plan = resolveRemoteStartPlan(input.plan ?? {});
  if (!plan.allowed) {
    return plan;
  }
  if (payload === null) {
    return { allowed: true };
  }
  // Optimistic CLI-capability gate: an instance whose `attachments`
  // capability is still unknown (`undefined`) may receive files; only an
  // explicit `attachments: false` blocks the file payload.
  if (payload.files.length > 0 && instance.capabilities?.attachments === false) {
    return { allowed: false, toast: remoteSpawnFilesNotSupportedToast() };
  }

  return { allowed: true };
}
