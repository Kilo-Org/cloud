import { sessionResumeUrl } from '@kilocode/app-shared/universal-links';

/**
 * What a session screen advertises to the OS so another device can continue it.
 *
 * The link is built by `sessionResumeUrl` (s1, `@kilocode/app-shared/universal-links`),
 * the same function behind the copy-link action: the advertised value and the
 * copied value cannot drift. A session with no id has nothing to advertise, so
 * `url` is null and both platforms skip the entry point instead of publishing a
 * link that opens the session list.
 */
export type SessionHandoffAdvertiserProps = {
  readonly sessionId: string;
  readonly anchorMessageId?: string | null;
  readonly title: string;
};

export type SessionHandoff = {
  readonly url: string | null;
  readonly title: string;
  readonly isEligibleForHandoff: true;
};

export function buildSessionHandoff({
  sessionId,
  anchorMessageId,
  title,
}: SessionHandoffAdvertiserProps): SessionHandoff {
  if (sessionId.length === 0) {
    return { url: null, title, isEligibleForHandoff: true };
  }

  return {
    url: sessionResumeUrl({ sessionId, anchorMessageId }),
    title,
    isEligibleForHandoff: true,
  };
}
