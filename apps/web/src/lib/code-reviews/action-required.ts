import * as z from 'zod';
import { captureException } from '@sentry/nextjs';
import { and, eq, type SQL } from 'drizzle-orm';
import { agent_configs } from '@kilocode/db/schema';
import { db, sql, type DrizzleTransaction } from '@/lib/drizzle';
import { NEXTAUTH_URL } from '@/lib/config.server';
import { sendCodeReviewDisabledEmail } from '@/lib/email';
import { getOrganizationMembers } from '@/lib/organizations/organizations';
import { findUserById } from '@/lib/user';
import { logExceptInTest } from '@/lib/utils.server';
import type { Owner } from '@/lib/code-reviews/core';
import type { CodeReviewPlatform } from '@/lib/code-reviews/core/schemas';
import {
  CODE_REVIEW_ACTION_REQUIRED_REASONS,
  CODE_REVIEW_ACTION_REQUIRED_RUNTIME_STATE_KEY,
  type CodeReviewActionRequiredReason,
  type CodeReviewActionRequiredState,
  getCodeReviewActionRequiredCopy,
  getCodeReviewActionRequiredRecoveryHref,
  isCodeReviewActionRequiredReason,
} from './action-required-shared';

export type { CodeReviewActionRequiredReason, CodeReviewActionRequiredState };
export {
  getCodeReviewActionRequiredCopy,
  getCodeReviewActionRequiredRecoveryHref,
  isCodeReviewActionRequiredReason,
};

const CodeReviewActionRequiredStateSchema = z.object({
  reason: z.enum(CODE_REVIEW_ACTION_REQUIRED_REASONS),
  detectedAt: z.string(),
  lastSeenAt: z.string(),
  triggeringReviewId: z.string().optional(),
  lastErrorMessage: z.string(),
  emailSentAt: z.string().optional(),
});

const SELECTED_MODEL_UNAVAILABLE_MESSAGE =
  'selected model is not available for this cloud agent session';
const REQUESTED_MODEL_NOT_ALLOWED_FOR_TEAM_MESSAGE =
  'the requested model is not allowed for your team';

type AgentConfigWithRuntimeState = {
  runtime_state?: Record<string, unknown> | null;
};

type DisableCodeReviewForActionRequiredFailureArgs = {
  owner: Owner;
  platform: CodeReviewPlatform;
  reviewId?: string;
  reason: CodeReviewActionRequiredReason;
  errorMessage: string;
};

type ClearCodeReviewActionRequiredStateArgs = {
  owner: Owner;
  platform: CodeReviewPlatform;
};

type MarkActionRequiredEmailSentArgs = {
  owner: Owner;
  platform: CodeReviewPlatform;
  reason: CodeReviewActionRequiredReason;
  sentAt: string;
};

function stripKnownErrorPrefixes(errorMessage: string): string {
  let message = errorMessage.trim();
  let next = message.replace(/^dispatch failed:\s*/i, '').trim();

  while (next !== message) {
    message = next;
    next = message.replace(/^dispatch failed:\s*/i, '').trim();
  }

  return message;
}

export function classifyCodeReviewActionRequiredFailure(
  errorMessage?: string | null
): CodeReviewActionRequiredReason | null {
  if (!errorMessage) return null;

  const stripped = stripKnownErrorPrefixes(errorMessage);
  const normalized = stripped.toLowerCase();

  if (
    normalized.includes('github token or active app installation required for this repository') &&
    normalized.includes('no_installation_found')
  ) {
    return 'github_installation_required';
  }

  if (
    normalized.includes(
      '[byok] your api key is invalid or has been revoked. please check your api key configuration.'
    )
  ) {
    return 'byok_invalid_key';
  }

  if (
    normalized.includes('although you appear to have the correct authorization credentials') &&
    normalized.includes('organization has an ip allow list enabled')
  ) {
    return 'github_ip_allow_list';
  }

  if (
    normalized.includes(SELECTED_MODEL_UNAVAILABLE_MESSAGE) ||
    normalized.includes(REQUESTED_MODEL_NOT_ALLOWED_FOR_TEAM_MESSAGE)
  ) {
    return 'selected_model_unavailable';
  }

  return null;
}

export function getCodeReviewActionRequiredState(
  config: AgentConfigWithRuntimeState | null | undefined
): CodeReviewActionRequiredState | null {
  const runtimeState = config?.runtime_state;
  if (!runtimeState) return null;

  const parsed = CodeReviewActionRequiredStateSchema.safeParse(
    runtimeState[CODE_REVIEW_ACTION_REQUIRED_RUNTIME_STATE_KEY]
  );

  return parsed.success ? parsed.data : null;
}

function ownerConditions(owner: Pick<Owner, 'type' | 'id'>, platform: CodeReviewPlatform): SQL[] {
  return [
    eq(agent_configs.agent_type, 'code_review'),
    eq(agent_configs.platform, platform),
    owner.type === 'org'
      ? eq(agent_configs.owned_by_organization_id, owner.id)
      : eq(agent_configs.owned_by_user_id, owner.id),
  ];
}

async function updateActionRequiredRuntimeState(
  tx: DrizzleTransaction,
  conditions: SQL[],
  state: CodeReviewActionRequiredState
): Promise<void> {
  await tx
    .update(agent_configs)
    .set({
      is_enabled: false,
      runtime_state: sql`jsonb_set(COALESCE(${agent_configs.runtime_state}, '{}'::jsonb), '{${sql.raw(CODE_REVIEW_ACTION_REQUIRED_RUNTIME_STATE_KEY)}}', ${JSON.stringify(state)}::jsonb, true)`,
      updated_at: new Date().toISOString(),
    })
    .where(and(...conditions));
}

async function getRecipientEmails(owner: Owner): Promise<string[]> {
  if (owner.type === 'user') {
    const user = await findUserById(owner.id);
    return user?.google_user_email ? [user.google_user_email] : [];
  }

  const members = await getOrganizationMembers(owner.id);
  return [
    ...new Set(
      members
        .filter(member => member.status === 'active' && member.role === 'owner')
        .map(member => member.email)
    ),
  ];
}

function toEmailRecoveryUrl(href: string): string {
  if (href.startsWith('mailto:')) return href;
  return `${NEXTAUTH_URL}${href}`;
}

async function sendActionRequiredEmailNotifications(
  owner: Owner,
  platform: CodeReviewPlatform,
  reason: CodeReviewActionRequiredReason
): Promise<boolean> {
  const recipients = await getRecipientEmails(owner);
  if (recipients.length === 0) {
    logExceptInTest('[code-review-action-required] No notification recipients found', {
      ownerType: owner.type,
      ownerId: owner.id,
      platform,
      reason,
    });
    return false;
  }

  const copy = getCodeReviewActionRequiredCopy(reason);
  const recoveryHref = getCodeReviewActionRequiredRecoveryHref(
    reason,
    owner.type === 'org' ? owner.id : undefined
  );
  const recoveryUrl = toEmailRecoveryUrl(recoveryHref);

  const results = await Promise.all(
    recipients.map(recipient =>
      sendCodeReviewDisabledEmail(recipient, {
        reason: copy.emailReason,
        recoveryUrl,
        recoveryLabel: copy.recoveryLabel,
      })
    )
  );

  const failedCount = results.filter(result => !result.sent).length;
  if (failedCount > 0) {
    const error = new Error('Failed to send Code Reviewer disabled email');
    logExceptInTest('[code-review-action-required] Email notification failed', {
      ownerType: owner.type,
      ownerId: owner.id,
      platform,
      reason,
      failedCount,
      recipientCount: recipients.length,
    });
    captureException(error, {
      tags: { source: 'code-review-action-required-email' },
      extra: {
        ownerType: owner.type,
        ownerId: owner.id,
        platform,
        reason,
        failedCount,
        recipientCount: recipients.length,
      },
    });
    return false;
  }

  return true;
}

async function markActionRequiredEmailSent(args: MarkActionRequiredEmailSentArgs): Promise<void> {
  await db.transaction(async tx => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`code-review-action-required:${args.owner.type}:${args.owner.id}:${args.platform}`}))`
    );

    const conditions = ownerConditions(args.owner, args.platform);
    const [config] = await tx
      .select()
      .from(agent_configs)
      .where(and(...conditions))
      .for('update')
      .limit(1);

    if (!config) {
      throw new Error(
        `Code Review agent config not found for owner ${args.owner.type}:${args.owner.id} on ${args.platform}`
      );
    }

    const existingState = getCodeReviewActionRequiredState(config);
    if (!existingState || existingState.reason !== args.reason || existingState.emailSentAt) return;

    await updateActionRequiredRuntimeState(tx, conditions, {
      ...existingState,
      emailSentAt: args.sentAt,
    });
  });
}

export async function disableCodeReviewForActionRequiredFailure(
  args: DisableCodeReviewForActionRequiredFailureArgs
): Promise<void> {
  const copy = getCodeReviewActionRequiredCopy(args.reason);

  const shouldSendEmail = await db.transaction(async tx => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`code-review-action-required:${args.owner.type}:${args.owner.id}:${args.platform}`}))`
    );

    const conditions = ownerConditions(args.owner, args.platform);
    const [config] = await tx
      .select()
      .from(agent_configs)
      .where(and(...conditions))
      .for('update')
      .limit(1);

    if (!config) {
      logExceptInTest('[code-review-action-required] Agent config not found', {
        ownerType: args.owner.type,
        ownerId: args.owner.id,
        platform: args.platform,
        reason: args.reason,
        reviewId: args.reviewId,
      });
      throw new Error(
        `Code Review agent config not found for owner ${args.owner.type}:${args.owner.id} on ${args.platform}`
      );
    }

    const now = new Date().toISOString();
    const existingState = getCodeReviewActionRequiredState(config);
    const shouldSendEmail =
      !existingState || existingState.reason !== args.reason || !existingState.emailSentAt;

    const nextState: CodeReviewActionRequiredState = {
      reason: args.reason,
      detectedAt:
        existingState?.reason === args.reason && existingState.detectedAt
          ? existingState.detectedAt
          : now,
      lastSeenAt: now,
      ...(args.reviewId ? { triggeringReviewId: args.reviewId } : {}),
      lastErrorMessage: copy.description,
      ...(!shouldSendEmail && existingState?.emailSentAt
        ? { emailSentAt: existingState.emailSentAt }
        : {}),
    };

    await updateActionRequiredRuntimeState(tx, conditions, nextState);

    return shouldSendEmail;
  });

  if (!shouldSendEmail) return;

  try {
    const sent = await sendActionRequiredEmailNotifications(args.owner, args.platform, args.reason);
    if (sent) {
      await markActionRequiredEmailSent({
        owner: args.owner,
        platform: args.platform,
        reason: args.reason,
        sentAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    logExceptInTest('[code-review-action-required] Failed to send notification email', {
      ownerType: args.owner.type,
      ownerId: args.owner.id,
      platform: args.platform,
      reason: args.reason,
      reviewId: args.reviewId,
    });
    captureException(error, {
      tags: { source: 'code-review-action-required-email' },
      extra: {
        ownerType: args.owner.type,
        ownerId: args.owner.id,
        platform: args.platform,
        reason: args.reason,
        reviewId: args.reviewId,
      },
    });
  }
}

export async function clearCodeReviewActionRequiredState(
  args: ClearCodeReviewActionRequiredStateArgs
): Promise<void> {
  const conditions = ownerConditions(args.owner, args.platform);
  await db
    .update(agent_configs)
    .set({
      runtime_state: sql`COALESCE(${agent_configs.runtime_state}, '{}'::jsonb) - ${CODE_REVIEW_ACTION_REQUIRED_RUNTIME_STATE_KEY}`,
      updated_at: new Date().toISOString(),
    })
    .where(and(...conditions));
}
