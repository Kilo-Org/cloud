import { useQuery } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { formatGitUrlProject } from '@kilocode/app-shared/git-url-project';

import { SessionPreviewTranscript } from '@/components/agents/session-preview-transcript';
import { QueryError } from '@/components/query-error';
import { type HeaderEyebrow, ScreenHeader } from '@/components/screen-header';
import { eyebrowHeaderProps } from '@/components/ui/eyebrow-placeholder';
import { i18n } from '@/i18n';
import { isolateBidiText } from '@/lib/bidi';
import { formatDate } from '@/lib/format';
import { sessionBranchLabel } from '@/lib/session-branch-label';
import { trpcErrorVariant } from '@/lib/trpc-error';
import { useTRPC } from '@/lib/trpc';
import { parseTimestamp } from '@/lib/utils';

/**
 * Scroll identity for the shared transcript. The list only uses it to key its
 * own scroll state, and one shared session is on screen at a time, so a
 * constant keeps the read capability out of ids, test ids and scroll keys. A
 * different link mounts a new screen (`key` on the route's element).
 */
const SHARED_TRANSCRIPT_ID = 'shared-session';

function sharedCreatedDate(createdAt: string | null | undefined): Date | null {
  if (!createdAt) {
    return null;
  }
  const date = parseTimestamp(createdAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The day a shared session started, as the header subtitle prints it.
 *
 * A share can stay live for years, so a month and a day alone would date an
 * older session as this year's. The year joins the line whenever the session
 * did not start in the reader's current year. The comparison uses the years
 * the locale itself prints, not the Gregorian year: a Persian, Pashto or Thai
 * reader counts in another calendar, and the line must compare that reader's
 * own year. Every locale, non-Gregorian ones included, therefore keeps its
 * pattern from `formatDate`. A same-year session keeps the short form, where
 * the year carries nothing.
 */
function sharedStartDateLabel(date: Date): string {
  const currentYear = formatDate(new Date(), i18n.language, { year: 'numeric' });
  const sessionYear = formatDate(date, i18n.language, { year: 'numeric' });
  return formatDate(date, i18n.language, {
    month: 'short',
    day: 'numeric',
    ...(sessionYear === currentYear ? {} : { year: 'numeric' }),
  });
}

/**
 * Read-only view of a publicly shared session, opened from an `/s/<token>`
 * link.
 *
 * The token is the only thing the server needs: it resolves to the session's
 * identity and a frozen snapshot of its transcript. Three outcomes are
 * distinct on purpose:
 * - the link has no live share (expired, revoked, rotated out) — terminal, so
 *   the screen offers no retry that cannot succeed;
 * - the link is live but the read failed — retryable;
 * - the link is live and the snapshot has no messages — an empty transcript.
 */
export function SharedSessionScreen({ shareToken }: Readonly<{ shareToken: string }>) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.cliSessionsV2.getSharedSession.queryOptions({ share_token: shareToken }),
    // A dead link is decided by the server; one retry absorbs a transient
    // gateway failure without making a revoked link wait before it says so.
    retry: 1,
  });

  const metadata = query.data?.metadata;
  const ownerName = metadata?.ownerName ?? t('sharedSession.someone');
  const repoLabel = metadata?.gitUrl ? formatGitUrlProject(metadata.gitUrl) : null;
  const createdDate = sharedCreatedDate(metadata?.createdAt);
  const dateLabel = createdDate ? sharedStartDateLabel(createdDate) : null;
  // The share time is not part of the public read: the payload carries the
  // session's own `createdAt`, and the link's `shared_at` stays inside the
  // token the server resolves. So the line names the session start, and the
  // subtitle's date above gives it a day — this prints the time alone rather
  // than repeating that date under a "shared" label the payload cannot back.
  const startedAtLabel = createdDate
    ? t('sharedSession.startedAt', {
        time: formatDate(createdDate, i18n.language, { timeStyle: 'short' }),
      })
    : null;
  // Each kept segment is its own first-strong isolate, so the paragraph
  // direction cannot reorder one segment's text around a neighbour: without the
  // pair, a right-to-left screen splits the date between the day number, which
  // lands next to the sharer, and the month, which follows the branch.
  //
  // The owner is isolated inside the sharer sentence as well, because the
  // first-strong scan of that sentence skips a nested isolate: a catalog that
  // puts `{{owner}}` first (Urdu does) would otherwise take the sentence's
  // direction from a Latin name and paint the sentence from its wrong end.
  const subtitle = [
    t('sharedSession.sharedBy', { owner: isolateBidiText(ownerName) }),
    sessionBranchLabel(metadata?.gitBranch),
    dateLabel,
  ]
    .filter((value): value is string => value !== null && value !== '')
    .map(value => isolateBidiText(value))
    .join(' · ');

  const retry = () => {
    void query.refetch();
  };

  // The eyebrow names the session: its repository, which the payload carries
  // only when the session had a git URL, and otherwise the time it started.
  // A read that is pending reserves the line with the placeholder bar; a read
  // that failed, and a payload with neither a repository nor a usable
  // timestamp, keep the same line blank — the title holds its place and
  // nothing pulses on a header whose label can no longer arrive.
  let eyebrow: HeaderEyebrow = { kind: 'held' };
  if (repoLabel !== null) {
    eyebrow = { kind: 'ready', text: repoLabel };
  } else if (startedAtLabel !== null) {
    eyebrow = { kind: 'ready', text: startedAtLabel };
  } else if (query.isPending) {
    eyebrow = { kind: 'loading' };
  }

  let body: ReactNode = null;
  if (query.isError) {
    // A dead link is terminal: NOT_FOUND is the expired/revoked/rotated-out
    // answer, so the screen offers no retry that cannot succeed.
    const deadLink = query.error.data?.code === 'NOT_FOUND';
    body = (
      <QueryError
        variant={deadLink ? 'not-found' : trpcErrorVariant(query.error)}
        title={deadLink ? t('sharedSession.unavailableTitle') : undefined}
        message={deadLink ? t('sharedSession.unavailableDescription') : undefined}
        onRetry={deadLink ? undefined : retry}
        isRetrying={query.isFetching}
      />
    );
  } else if (query.data?.transcriptUnavailable) {
    // The link is live but its snapshot could not be read: not a dead link, so
    // this state keeps the retry the dead-link state omits.
    body = (
      <QueryError
        variant="server"
        title={t('sharedSession.transcriptUnavailableTitle')}
        message={t('sharedSession.transcriptUnavailableDescription')}
        onRetry={retry}
        isRetrying={query.isFetching}
      />
    );
  } else {
    body = (
      <SessionPreviewTranscript
        sessionId={SHARED_TRANSCRIPT_ID}
        messages={query.data?.messages ?? []}
        isLoading={query.isPending}
        isError={false}
        error={undefined}
        onRetry={retry}
        // The transcript is this screen's whole body, so an empty one centres
        // in the band the header leaves instead of hugging the header.
        emptyPlacement="center"
      />
    );
  }

  return (
    <View className="flex-1 bg-background" testID="shared-session-screen">
      <ScreenHeader
        title={metadata?.title ?? t('sharedSession.title')}
        {...eyebrowHeaderProps(eyebrow)}
        subtitle={query.data ? subtitle : undefined}
        reserveSubtitle
        titleNumberOfLines={2}
      />
      {body}
    </View>
  );
}
