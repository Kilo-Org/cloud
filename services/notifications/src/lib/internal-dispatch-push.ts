/**
 * Pure core for internal dispatch of low-balance and security-finding pushes.
 * IO is injected via deps so unit tests can substitute in-memory fakes.
 */

import type {
  DispatchPushInput,
  DispatchPushOutcome,
  InternalDispatchRequest,
  PerRecipientResult,
} from '@kilocode/notifications';

import type { UserNotificationPreferences } from './cloud-agent-session-push';

type RecipientDOStub = {
  dispatchPush: (input: DispatchPushInput) => Promise<DispatchPushOutcome>;
};

export type InternalDispatchDeps = {
  getRecipientDOStub: (userId: string) => RecipientDOStub;
  /**
   * Read the per-recipient notification preferences. Throw = fail-closed
   * (suppress the recipient without calling dispatchPush). `null` = successful
   * read with no row → default-on for every category.
   */
  readPreferences: (userId: string) => Promise<UserNotificationPreferences | null>;
};

const DEFAULT_PREFERENCES: UserNotificationPreferences = {
  agentPushEnabled: true,
  chatMessagesEnabled: true,
  agentAttentionEnabled: true,
  sessionStatusEnabled: true,
  kiloclawActivityEnabled: true,
  balanceAlertsEnabled: true,
  securityFindingsEnabled: true,
};

function securityFindingTitle(
  notificationKind: 'new_finding' | 'sla_warning' | 'sla_breach',
  severity: string
): string {
  switch (notificationKind) {
    case 'new_finding':
      return `New security finding (${severity})`;
    case 'sla_warning':
      return 'SLA warning';
    case 'sla_breach':
      return 'SLA breach';
  }
}

function buildDispatchInput(userId: string, input: InternalDispatchRequest): DispatchPushInput {
  if (input.kind === 'low_balance') {
    return {
      userId,
      presenceContext: null,
      idempotencyKey: `low-balance:${input.organizationId}`,
      badge: null,
      push: {
        title: 'Low balance alert',
        body: `${input.organizationName} balance fell below $${input.minimumBalanceUsd}`,
        data: {
          type: 'low_balance',
          organizationId: input.organizationId,
        },
        sound: 'default',
        priority: 'high',
      },
    } satisfies DispatchPushInput;
  }

  const title = securityFindingTitle(input.notificationKind, input.severity);
  return {
    userId,
    presenceContext: null,
    idempotencyKey: `security-finding:${input.notificationId}`,
    badge: null,
    push: {
      title,
      body: `${input.title} in ${input.repoFullName}`,
      data: {
        type: 'security_finding',
        findingId: input.findingId,
        scope: input.scope,
      },
      sound: 'default',
      priority: 'high',
    },
  } satisfies DispatchPushInput;
}

function categoryEnabled(
  prefs: UserNotificationPreferences,
  kind: InternalDispatchRequest['kind']
): boolean {
  return kind === 'low_balance' ? prefs.balanceAlertsEnabled : prefs.securityFindingsEnabled;
}

/** Narrow DO outcomes that cannot occur with null presence / no rate limit. */
function mapOutcome(kind: DispatchPushOutcome['kind']): PerRecipientResult['outcome'] {
  if (kind === 'suppressed_presence' || kind === 'suppressed_rate_limit') {
    return 'failed';
  }
  return kind;
}

/**
 * Dispatch a low-balance or security-finding push to one or more recipients.
 * Per-recipient preference gate runs before any DO call; preference-read
 * throws fail closed without calling dispatchPush.
 */
export async function dispatchInternalPushCore(
  input: InternalDispatchRequest,
  deps: InternalDispatchDeps
): Promise<{ perRecipient: PerRecipientResult[] }> {
  const recipients: string[] = [];
  const seen = new Set<string>();

  if (input.kind === 'low_balance') {
    for (const id of input.recipientUserIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      recipients.push(id);
    }
  } else {
    recipients.push(input.recipientUserId);
  }

  const results = await Promise.allSettled(
    recipients.map(async userId => {
      let prefs: UserNotificationPreferences;
      try {
        const row = await deps.readPreferences(userId);
        prefs = row ?? DEFAULT_PREFERENCES;
      } catch {
        return 'failed' as const;
      }

      if (!categoryEnabled(prefs, input.kind)) {
        return 'suppressed_preference' as const;
      }

      const stub = deps.getRecipientDOStub(userId);
      const dispatchInput = buildDispatchInput(userId, input);
      const outcome = await stub.dispatchPush(dispatchInput);
      return mapOutcome(outcome.kind);
    })
  );

  const perRecipient: PerRecipientResult[] = recipients.map((userId, index) => {
    const result = results[index];
    return {
      userId,
      outcome: result?.status === 'fulfilled' ? result.value : 'failed',
    };
  });

  return { perRecipient };
}
