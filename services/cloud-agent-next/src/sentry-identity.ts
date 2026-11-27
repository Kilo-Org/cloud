import type { UsageContext } from '@kilocode/container-usage';
import { computeMemberId } from '@kilocode/worker-utils/compute-member';
import type { CloudAgentSentryIdentity } from './shared/sentry.js';

/**
 * Reads the identity for each Sentry event of a Durable Object. The reader runs with `this` set to
 * the Sentry proxy (`instrumentCloudAgentDurableObject`). That proxy captures a failed
 * prototype-method call before the caller can catch it, and each capture runs the reader again.
 * Thus a reader must not call instance methods. Read fields, and use free functions for storage.
 */
export const readSentryIdentity = Symbol('readSentryIdentity');

type SentryIdentityResult = CloudAgentSentryIdentity | undefined;
export type SentryIdentityReader = () => SentryIdentityResult | Promise<SentryIdentityResult>;

export type SentryIdentitySource = {
  [readSentryIdentity]?: SentryIdentityReader;
};

export function sentryIdentityFromBilling({
  subject,
  actor,
  metadata,
  sessionId,
}: Pick<UsageContext, 'subject' | 'actor' | 'metadata' | 'sessionId'>): CloudAgentSentryIdentity {
  return {
    userId:
      subject?.type === 'user'
        ? subject.id
        : actor?.type === 'user' || actor?.type === 'bot'
          ? computeMemberId(actor, { billingUserId: metadata?.billingUserId })
          : undefined,
    orgId:
      subject?.type === 'org' ? subject.id : subject?.type === 'user' ? '(personal)' : undefined,
    sessionId,
  };
}
