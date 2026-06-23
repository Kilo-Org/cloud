import * as z from 'zod';
import { captureException } from '@sentry/nextjs';
import { and, count, eq, gte, lt, type SQL } from 'drizzle-orm';
import { agent_configs, cloud_agent_code_reviews } from '@kilocode/db/schema';
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
const BYOK_INVALID_KEY_MESSAGE =
  '[byok] your api key is invalid or has been revoked. please check your api key configuration.';
const BYOK_PERMISSION_DENIED_MESSAGE =
  '[byok] your api key does not have permission to access this resource. please check your api key permissions.';
const REPEATED_REPOSITORY_CLONE_TIMEOUT_REASON =
  'repeated_repository_clone_timeout' satisfies CodeReviewActionRequiredReason;
const REPOSITORY_CLONE_TIMEOUT_MESSAGE_FRAGMENT = 'repository clone timed out';
const REPEATED_REPOSITORY_CLONE_TIMEOUT_THRESHOLD = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

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

type DisableCodeReviewForRepeatedCloneTimeoutsTodayArgs = {
  owner: Owner;
  platform: CodeReviewPlatform;
  reviewId: string;
  errorMessage?: string | null;
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

type PersistActionRequiredDisableArgs = {
  owner: Owner;
  platform: CodeReviewPlatform;
  reviewId?: string;
  reason: CodeReviewActionRequiredReason;
};

type PersistActionRequiredBeforeUpdate = (tx: DrizzleTransaction) => Promise<boolean>;

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
    (normalized.includes('no_installation_found') ||
      normalized.includes('repository_not_installed'))
  ) {
    return 'github_installation_required';
  }

  if (
    normalized.includes(BYOK_INVALID_KEY_MESSAGE) ||
    normalized.includes(BYOK_PERMISSION_DENIED_MESSAGE)
  ) {
    return 'byok_invalid_key';
  }

  if (
    normalized.includes('project access token') &&
    (normalized.includes('failed to create project access token for gitlab code review') ||
      normalized.includes('cannot create project access token for gitlab code review') ||
      normalized.includes('insufficient permissions to create project access token') ||
      normalized.includes('requires maintainer role or higher') ||
      normalized.includes('project access tokens are disabled for this project'))
  ) {
    return 'gitlab_project_access_required';
  }

  if (
    normalized.includes('although you appear to have the correct authorization credentials') &&
    normalized.includes('organization has an ip allow list enabled')
  ) {
    return 'github_ip_allow_list';
  }

  if (
    normalized.includes(SELECTED_MODEL_UNAVAILABLE_MESSAGE) ||
    normalized.includes(REQUESTED_MODEL_NOT_ALLOWED_FOR_TEAM_MESSAGE) ||
    normalized.includes('provider_not_allowed') ||
    normalized.includes('no eligible provider can serve the selected model.') ||
    normalized.includes('no allowed providers are specified.') ||
    normalized.includes('no allowed providers are available for the selected model.') ||
    normalized.includes('no endpoints found matching your data policy')
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

function reviewOwnerConditions(
  owner: Pick<Owner, 'type' | 'id'>,
  platform: CodeReviewPlatform
): SQL[] {
  return [
    eq(cloud_agent_code_reviews.platform, platform),
    owner.type === 'org'
      ? eq(cloud_agent_code_reviews.owned_by_organization_id, owner.id)
      : eq(cloud_agent_code_reviews.owned_by_user_id, owner.id),
  ];
}

function getUtcDayBounds(now = new Date()): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + DAY_MS).toISOString(),
  };
}

function isRepositoryCloneTimeoutMessage(errorMessage?: string | null): boolean {
  return errorMessage
    ? errorMessage.toLowerCase().includes(REPOSITORY_CLONE_TIMEOUT_MESSAGE_FRAGMENT)
    : false;
}

async function countRepositoryCloneTimeoutFailuresToday(
  tx: DrizzleTransaction,
  owner: Owner,
  platform: CodeReviewPlatform
): Promise<number> {
  const dayBounds = getUtcDayBounds();
  const [row] = await tx
    .select({ timeoutCount: count() })
    .from(cloud_agent_code_reviews)
    .where(
      and(
        ...reviewOwnerConditions(owner, platform),
        eq(cloud_agent_code_reviews.status, 'failed'),
        gte(cloud_agent_code_reviews.completed_at, dayBounds.start),
        lt(cloud_agent_code_reviews.completed_at, dayBounds.end),
        sql`LOWER(${cloud_agent_code_reviews.error_message}) LIKE ${`%${REPOSITORY_CLONE_TIMEOUT_MESSAGE_FRAGMENT}%`}`
      )
    );

  return row?.timeoutCount ?? 0;
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

async function persistActionRequiredDisable(
  args: PersistActionRequiredDisableArgs,
  beforeUpdate?: PersistActionRequiredBeforeUpdate
): Promise<boolean | null> {
  const copy = getCodeReviewActionRequiredCopy(args.reason);

  return await db.transaction(async tx => {
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

    if (beforeUpdate) {
      const shouldPersist = await beforeUpdate(tx);
      if (!shouldPersist) return null;
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
}

async function sendAndMarkActionRequiredEmailNotifications(
  args: PersistActionRequiredDisableArgs,
  shouldSendEmail: boolean
): Promise<void> {
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

export async function disableCodeReviewForActionRequiredFailure(
  args: DisableCodeReviewForActionRequiredFailureArgs
): Promise<void> {
  const shouldSendEmail = await persistActionRequiredDisable(args);
  if (shouldSendEmail === null) return;
  await sendAndMarkActionRequiredEmailNotifications(args, shouldSendEmail);
}

export async function disableCodeReviewForRepeatedCloneTimeoutsToday(
  args: DisableCodeReviewForRepeatedCloneTimeoutsTodayArgs
): Promise<CodeReviewActionRequiredReason | null> {
  if (!isRepositoryCloneTimeoutMessage(args.errorMessage)) return null;

  const shouldSendEmail = await persistActionRequiredDisable(
    {
      owner: args.owner,
      platform: args.platform,
      reviewId: args.reviewId,
      reason: REPEATED_REPOSITORY_CLONE_TIMEOUT_REASON,
    },
    async tx => {
      const timeoutCount = await countRepositoryCloneTimeoutFailuresToday(
        tx,
        args.owner,
        args.platform
      );
      if (timeoutCount < REPEATED_REPOSITORY_CLONE_TIMEOUT_THRESHOLD) return false;

      // Temporarily disabled until after focus week: this is too sensitive to
      // GitHub clone outages and could disable many cloud reviews at once.
      // await tx
      //   .update(cloud_agent_code_reviews)
      //   .set({
      //     terminal_reason: REPEATED_REPOSITORY_CLONE_TIMEOUT_REASON,
      //     updated_at: new Date().toISOString(),
      //   })
      //   .where(eq(cloud_agent_code_reviews.id, args.reviewId));
      // return true;
      return false;
    }
  );

  if (shouldSendEmail === null) return null;
  await sendAndMarkActionRequiredEmailNotifications(
    {
      owner: args.owner,
      platform: args.platform,
      reviewId: args.reviewId,
      reason: REPEATED_REPOSITORY_CLONE_TIMEOUT_REASON,
    },
    shouldSendEmail
  );
  return REPEATED_REPOSITORY_CLONE_TIMEOUT_REASON;
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
