export type DeletionAttentionHint = {
  title: string;
  action: string;
};

const HTTP_STATUS_RE = /^http_(\d+)$/;

const HTTP_FALLBACK_ACTION =
  'Open the provider, confirm the resource, then Retry. If the provider UI shows the work is already done, Mark done with evidence.';

const UNKNOWN_ACTION =
  'Retry after fixing the cause, or Mark done if you completed this task outside the queue.';

const KNOWN_HINTS: Record<string, DeletionAttentionHint> = {
  protected_admin: {
    title: 'Target is a Cloud admin',
    action: 'Do not delete admins from this queue. Remove admin first, or cancel the request.',
  },
  protected_bot: {
    title: 'Target is a bot account',
    action: 'Cancel this request. Bot accounts are not deleted through this queue.',
  },
  protected_self: {
    title: 'You cannot delete your own account',
    action: 'Ask another admin to submit this request.',
  },
  protected_staff_domain: {
    title: 'Target uses a staff domain',
    action: 'Staff-domain emails can be deleted. If you see this on an old request, Retry.',
  },
  protected_hosted_domain: {
    title: 'Target uses a protected hosted domain',
    action: 'Hosted-domain staff can be deleted. If you see this on an old request, Retry.',
  },
  ambiguous_cloud_identity: {
    title: 'Multiple Cloud users match this email',
    action: 'Resolve the duplicate users, then Retry preflight.',
  },
  user_identity_mismatch: {
    title: 'Cloud user no longer matches this request',
    action: 'Confirm the target still exists and matches the request, then Retry preflight.',
  },
  user_hint_mismatch: {
    title: 'Trusted user id does not match the email',
    action: 'Re-enter the target with the matching user id, or omit the hint.',
  },
  missing_target_email: {
    title: 'Request is missing the target email',
    action: 'Cancel this request and enqueue it again with the target email.',
  },
  kilo_pass_active: {
    title: 'Kilo Pass subscription is still active',
    action: 'Cancel the Kilo Pass subscription, then Retry preflight.',
  },
  kiloclaw_subscription_active: {
    title: 'KiloClaw subscription is still active',
    action: 'Cancel the KiloClaw subscription, then Retry preflight.',
  },
  malformed_email: {
    title: 'Email is malformed',
    action: 'Fix the email and submit the request again.',
  },
  malformed_ticket: {
    title: 'Pylon ticket reference is malformed',
    action: 'Use a valid ticket id such as #123, then submit again.',
  },
  ticket_unresolved: {
    title: 'Could not read a customer email from this Pylon ticket',
    action: 'Paste the customer email next to the ticket, or confirm the ticket has a requester.',
  },
  duplicate_entry: {
    title: 'Duplicate entry in this batch',
    action: 'Remove the duplicate line and submit again.',
  },
  already_active: {
    title: 'This email is already in the queue',
    action: 'Open the existing request instead of submitting again.',
  },
  ticket_already_active: {
    title: 'This Pylon ticket is already in the queue',
    action: 'Open the existing request instead of submitting the same ticket again.',
  },
  no_cloud_user: {
    title: 'No current Cloud user for this email',
    action: 'Create or restore the Cloud user, or use an email that already has an account.',
  },
  credential_invalid: {
    title: 'Substack credential could not be parsed',
    action: 'Paste a valid session cookie or sid JSON, Test it, then Store.',
  },
  legacy_identity_unresolved: {
    title: 'No Cloud user id on this request',
    action:
      'Confirm whether this target ever had a Cloud user. If it did not, Mark done with evidence of absence. If it did, attach the user and Retry.',
  },
  authoritative_absence: {
    title: 'No Cloud user exists for this target',
    action:
      'This is expected for email-only targets. Retry if the task should have been skipped automatically.',
  },
  prior_queue_cleanup: {
    title: 'User was already removed by a prior deletion',
    action: 'Retry if the task should have been skipped automatically.',
  },
  configuration_missing: {
    title: 'Provider configuration is missing',
    action: 'Set the required env and credentials for this provider, then Retry.',
  },
  target_email_missing: {
    title: 'Target email was scrubbed or missing',
    action:
      'If the work is already done, Mark done with evidence. Otherwise cancel and re-enqueue.',
  },
  credential_missing: {
    title: 'Substack credential is missing',
    action: 'Add the Substack session credential, then Retry.',
  },
  credential_expired: {
    title: 'Substack credential expired',
    action: 'Replace the Substack session credential, then Retry.',
  },
  posthog_checkpoint_invalid: {
    title: 'PostHog deletion checkpoint is invalid',
    action:
      'Inspect the PostHog task progress, then Retry. If deletion already finished in PostHog, Mark done with evidence.',
  },
  posthog_lookup_incomplete: {
    title: 'PostHog person lookup returned an incomplete payload',
    action:
      'Retry. If PostHog still returns a partial response, look up the person in PostHog and Mark done with evidence.',
  },
  posthog_ambiguous: {
    title: 'Multiple PostHog people match this target',
    action:
      'Open PostHog, delete or merge the matching people, then Retry or Mark done with evidence.',
  },
  posthog_verify_timeout: {
    title: 'PostHog deletion did not confirm in time',
    action:
      'Check the PostHog deletion task. If it finished, Mark done with evidence. Otherwise Retry.',
  },
  substack_lookup_incomplete: {
    title: 'Substack subscriber lookup returned an incomplete payload',
    action:
      'Retry. If Substack still returns a partial response, confirm the subscriber in Substack and Mark done with evidence.',
  },
  pylon_contact_lookup_incomplete: {
    title: 'Pylon contact lookup returned an incomplete payload',
    action:
      'Retry. If Pylon still returns a partial response, confirm the contact and Mark done with evidence.',
  },
  pylon_contact_ambiguous: {
    title: 'Multiple Pylon contacts match this target',
    action:
      'Open Pylon, delete or merge the matching contacts, then Retry or Mark done with evidence.',
  },
  pylon_ticket_invalid: {
    title: 'Pylon ticket on this request is invalid',
    action: 'Set a valid Pylon ticket on the request, then Retry.',
  },
  pylon_issue_unparsed: {
    title: 'Pylon issue payload could not be parsed',
    action:
      'Open the ticket in Pylon and Retry. If the issue is already closed, Mark done with evidence.',
  },
  pylon_issue_requester_missing: {
    title: 'Pylon issue has no requester',
    action: 'Confirm the ticket in Pylon, then Retry or Mark done with evidence.',
  },
  pylon_issue_identity_mismatch: {
    title: 'Pylon ticket requester does not match this target',
    action:
      'Confirm the ticket belongs to this deletion. If it does not, fix the ticket reference. If the reply is already posted, Mark done with evidence.',
  },
  pylon_messages_unparsed: {
    title: 'Pylon messages could not be parsed',
    action:
      'Open the ticket in Pylon and Retry. If the deletion reply is already there, Mark done with evidence.',
  },
  pylon_reply_thread_missing: {
    title: 'Pylon reply thread is missing',
    action: 'Confirm the ticket still exists in Pylon, then Retry.',
  },
  pylon_reply_inconclusive: {
    title: 'Could not confirm the Pylon deletion reply',
    action: 'Open the ticket, check for the deletion reply, then Retry or Mark done with evidence.',
  },
  ownership_mismatch: {
    title: 'KiloClaw instance is not owned by this user',
    action:
      'Inspect the instance in KiloClaw. If it should not be destroyed, Mark done with evidence. If ownership is wrong, fix it then Retry.',
  },
  kiloclaw_rollback_failed: {
    title: 'KiloClaw destroy failed and rollback failed',
    action:
      'Inspect the instance. Restore or destroy it in KiloClaw, then Retry or Mark done with evidence.',
  },
  kiloclaw_destroy_failed: {
    title: 'KiloClaw destroy failed',
    action:
      'Inspect the instance in KiloClaw, then Retry. If it is already gone, Mark done with evidence.',
  },
  blob_delete_failed: {
    title: 'CLI v1 blob delete failed',
    action: 'Retry. If the blob is already gone, Mark done with evidence.',
  },
  cyclic_session_graph: {
    title: 'Session graph contains a cycle',
    action: 'Inspect the CLI v2 sessions for this user, break the cycle, then Retry.',
  },
  session_identity_mismatch: {
    title: 'Session is not owned by this user',
    action: 'Inspect the mismatched session, then Retry or Mark done with evidence.',
  },
  session_cleanup_unconfirmed: {
    title: 'Session cleanup was not confirmed',
    action: 'Retry. If the sessions are already gone, Mark done with evidence.',
  },
  teardown_incomplete: {
    title: 'Teardown tasks are not finished',
    action: 'Finish or Mark done the remaining teardown tasks, then Retry anonymize.',
  },
  user_missing: {
    title: 'Cloud user row is missing',
    action:
      'If the user was already deleted, Mark done with evidence. Otherwise restore the user id on the request and Retry.',
  },
  rate_limited_24h: {
    title: 'Provider rate limit lasted over 24 hours',
    action: 'Confirm the provider is healthy, then Retry.',
  },
  rate_limited: {
    title: 'Provider rate-limited this task',
    action: 'Wait for the cooldown, then Retry.',
  },
  http_404: {
    title: 'Provider returned HTTP 404',
    action:
      'Confirm the resource is already gone. If it is, Mark done with evidence. If it should exist, fix the id and Retry.',
  },
  http_409_needs_reconcile: {
    title: 'Provider returned a conflict',
    action: 'Reconcile the resource in the provider UI, then Retry or Mark done with evidence.',
  },
  timeout: {
    title: 'Provider request timed out',
    action: 'Retry. If the provider is slow, wait and Retry again.',
  },
  connection_failure: {
    title: 'Could not reach the provider',
    action: 'Check network and provider status, then Retry.',
  },
  unknown_transport: {
    title: 'Provider request failed in transit',
    action: 'Retry. If it keeps failing, check provider status.',
  },
  handler_throw: {
    title: 'Task handler threw an unexpected error',
    action: 'Check worker logs for this request, fix the cause, then Retry.',
  },
  claim_lost: {
    title: 'Task claim was lost',
    action: 'Retry. Another worker may have taken the claim.',
  },
  usage_prefix_page_timeout: {
    title: 'Usage prompt cleanup timed out',
    action: 'Retry. The next attempt will resume from the last committed page.',
  },
  usage_prefix_page_failed: {
    title: 'Usage prompt cleanup failed',
    action: 'Retry. If the page keeps failing, investigate the database before retrying.',
  },
  usage_prefix_progress_invalid: {
    title: 'Usage prompt cleanup progress is invalid',
    action: 'Inspect the task progress and repair it before retrying the cleanup.',
  },
};

export function deletionAttentionHint(
  code: string | null | undefined
): DeletionAttentionHint | null {
  if (!code) return null;
  const known = KNOWN_HINTS[code];
  if (known) return known;
  const httpMatch = HTTP_STATUS_RE.exec(code);
  if (httpMatch) {
    return {
      title: `Provider returned HTTP ${httpMatch[1]}`,
      action: HTTP_FALLBACK_ACTION,
    };
  }
  return {
    title: humanizeCode(code),
    action: UNKNOWN_ACTION,
  };
}

function humanizeCode(code: string): string {
  return code.replaceAll(/[_-]+/g, ' ').replace(/^./, char => char.toUpperCase());
}
