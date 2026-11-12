import { useQuery } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { SessionPreviewTranscript } from '@/components/agents/session-preview-transcript';
import { formatGitUrlProject } from '@/components/agents/session-list-helpers';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { i18n } from '@/i18n';
import { formatDate } from '@/lib/format';
import { trpcErrorVariant } from '@/lib/trpc-error';
import { useTRPC } from '@/lib/trpc';

/**
 * Scroll identity for the shared transcript. The list only uses it to key its
 * own scroll state, and one shared session is on screen at a time, so a
 * constant keeps the read capability out of ids, test ids and scroll keys. A
 * different link mounts a new screen (`key` on the route's element).
 */
const SHARED_TRANSCRIPT_ID = 'shared-session';

function sharedDateLabel(createdAt: string | null | undefined): string | null {
  if (!createdAt) {
    return null;
  }
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return formatDate(date, i18n.language, { month: 'short', day: 'numeric' });
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
  const dateLabel = sharedDateLabel(metadata?.createdAt);
  const subtitle = [
    t('sharedSession.sharedBy', { owner: ownerName }),
    metadata?.gitBranch ?? null,
    dateLabel,
  ]
    .filter(value => value !== null && value !== '')
    .join(' · ');

  const retry = () => {
    void query.refetch();
  };

  let body: ReactNode;
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
      />
    );
  }

  return (
    <View className="flex-1 bg-background" testID="shared-session-screen">
      <ScreenHeader
        title={metadata?.title ?? t('sharedSession.title')}
        eyebrow={repoLabel ?? undefined}
        reserveEyebrow
        subtitle={query.data ? subtitle : undefined}
        reserveSubtitle
        titleNumberOfLines={2}
      />
      {body}
    </View>
  );
}
