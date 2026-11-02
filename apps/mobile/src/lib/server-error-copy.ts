// Server rejections the app explains with its own localized copy.
//
// Several procedures reuse one tRPC code for unrelated failures (a FORBIDDEN
// can be a lapsed organization plan, a missing model, or a permission loss), so
// a code alone cannot pick the copy. These values are the exact server-authored
// sentences, matched whole; anything unrecognized falls back to the localized
// generic line, and a raw server sentence never reaches a screen.

import { REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY } from '@kilocode/app-shared/code-reviews';

import { i18n } from '@/i18n';
import { readTrpcErrorField } from '@/lib/trpc-error';

/** The server's denial message for an organization the caller cannot use. */
const ORGANIZATION_ACCESS_MESSAGE = 'You do not have access to this organization';

/** The worker's unavailable-model rejection, mapped to the model picker copy. */
const MODEL_UNAVAILABLE_MESSAGE = 'Selected model is not available for this cloud agent session';

/**
 * The organization subscription gate (`requireActiveSubscriptionOrTrial` in
 * `packages/web-shared`): the trial passed its enforcement window and no seat
 * subscription replaced it, so every organization mutation is refused.
 */
export const ORGANIZATION_TRIAL_EXPIRED_MESSAGE = 'Organization trial has expired.';

/** `organizations.members.invite`: the address already belongs to a member. */
export const ORGANIZATION_MEMBER_EXISTS_MESSAGE =
  'This user is already a member of this organization';

/** `organizations.members.invite`: an invitation for the address is outstanding. */
export const ORGANIZATION_PENDING_INVITATION_MESSAGE =
  'This email already has a pending invitation';

/** `organizations.members.update`: the server refuses a role change on yourself. */
const ORGANIZATION_SELF_ROLE_MESSAGE = 'You cannot change your own role';

/** Owner-only authority (`assertOwnerAuthority`): an admin touched an owner. */
const ORGANIZATION_OWNER_AUTHORITY_MESSAGE = 'Only an organization owner can manage owners';

/** `organizations.members.resendInvite`: the invitation lapsed. */
const ORGANIZATION_INVITE_EXPIRED_MESSAGE = 'This invitation has expired';

/** `organizations.members.resendInvite`: the address already joined. */
const ORGANIZATION_INVITE_ACCEPTED_MESSAGE = 'This invitation has already been accepted';

/** `organizations.members.resendInvite`: the invitation is terminal. */
const ORGANIZATION_INVITE_NOT_RESENDABLE_MESSAGE = 'This invitation can no longer be resent';

/** `organizations.members.*Invite`: the row the action read is gone. */
const ORGANIZATION_INVITE_MISSING_MESSAGE = 'Invitation not found';

/**
 * The i18n key for a server sentence the app explains, or `undefined` when it
 * has none. A `switch` keeps the mapping exhaustive and typo-free without an
 * open string dictionary.
 */
function copyKeyFor(message: string): string | undefined {
  switch (message) {
    case ORGANIZATION_ACCESS_MESSAGE: {
      return 'agentChat.newSession.checkOrganizationAccess';
    }
    case MODEL_UNAVAILABLE_MESSAGE: {
      return 'agentChat.session.modelUnavailable';
    }
    case ORGANIZATION_TRIAL_EXPIRED_MESSAGE: {
      return 'common.organizationTrialEnded';
    }
    case ORGANIZATION_MEMBER_EXISTS_MESSAGE: {
      return 'organization.inviteMember.alreadyMember';
    }
    case ORGANIZATION_PENDING_INVITATION_MESSAGE: {
      return 'organization.inviteMember.pendingInvitation';
    }
    case ORGANIZATION_SELF_ROLE_MESSAGE: {
      return 'organization.members.ownRoleChange';
    }
    case ORGANIZATION_OWNER_AUTHORITY_MESSAGE: {
      return 'organization.members.ownerAuthority';
    }
    case ORGANIZATION_INVITE_EXPIRED_MESSAGE: {
      return 'organization.members.inviteExpired';
    }
    case ORGANIZATION_INVITE_ACCEPTED_MESSAGE: {
      return 'organization.members.inviteAccepted';
    }
    case ORGANIZATION_INVITE_NOT_RESENDABLE_MESSAGE: {
      return 'organization.members.inviteNotResendable';
    }
    case ORGANIZATION_INVITE_MISSING_MESSAGE: {
      return 'queryError.notFoundDescription';
    }
    case REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY.proposal_not_found: {
      return 'queryError.notFoundDescription';
    }
    case REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY.review_memory_disabled: {
      // `assertEnabled` gates save, reject and approve alike, so this line must
      // not describe one action's outcome.
      return 'codeReviewer.reviewMemory.offAction';
    }
    case REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY.change_request_in_progress: {
      return 'codeReviewer.reviewMemory.changeRequestInProgress';
    }
    case REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY.proposal_not_actionable: {
      return 'codeReviewer.reviewMemory.changeRequestNotActionable';
    }
    case REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY.no_github_integration: {
      return 'codeReviewer.reviewMemory.changeRequestNoGitHubAccess';
    }
    case REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY.missing_github_app_permissions: {
      return 'codeReviewer.reviewMemory.changeRequestMissingPermissions';
    }
    case REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY.change_request_failed: {
      return 'codeReviewer.reviewMemory.changeRequestFailed';
    }
    case REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY.proposal_conflict: {
      return 'codeReviewer.reviewMemory.proposalConflict';
    }
    default: {
      return undefined;
    }
  }
}

/**
 * The catalog key for a server sentence the app explains, or `null` when it has
 * none. Surfaces that persist a failure (or re-translate it after a language
 * change) keep the key; everything that renders once reads
 * `knownServerErrorMessage`.
 */
export function knownServerErrorCopyKey(error: unknown): string | null {
  const message = readTrpcErrorField(error, 'message');
  return message == null ? null : (copyKeyFor(message) ?? null);
}

/**
 * The localized copy for a server rejection the app knows how to explain, or
 * `null` when it carries no explanation of its own.
 */
export function knownServerErrorMessage(error: unknown): string | null {
  const key = knownServerErrorCopyKey(error);
  return key == null ? null : i18n.t(key);
}

/**
 * The localized copy for a rejected organization mutation or query: a known
 * server sentence gets its own explanation, everything else the generic line.
 * Organization surfaces call this instead of reading `error.message`.
 */
export function organizationErrorMessage(error: unknown): string {
  return knownServerErrorMessage(error) ?? i18n.t('common.somethingWentWrong');
}
