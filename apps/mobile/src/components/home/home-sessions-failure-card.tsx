import { type Href, useRouter } from 'expo-router';
import { type TFunction } from 'i18next';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { QueryError, type QueryErrorVariant } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { createSubmitLock } from '@/lib/submit-lock';
import { readTrpcErrorField } from '@/lib/trpc-error';

import { type LiveSessionContext, type LiveSessions } from '@/components/home/live-session-state';

type LiveSessionsFailureProps = Readonly<{
  context: LiveSessionContext;
  sessions: LiveSessions;
  failureLabel: string;
}>;

type CardFailure = Readonly<{
  variant: QueryErrorVariant;
  title?: string;
  message?: string;
  /** What the one recovery action does: retry the query, or leave for the Profile tab. */
  action: 'retry' | 'profile';
}>;

/**
 * The whole-surface failure as Home's card reads it. Same causes, titles and
 * messages as the block that stands above the rows on the Agents tab; the card
 * needs the parts, not the block, because it draws them inside a fixed frame.
 */
export function cardFailure({
  t,
  context,
  sessions,
  failureLabel,
}: LiveSessionsFailureProps & { t: TFunction }): CardFailure | null {
  if (context.isError) {
    return {
      variant: 'neutral',
      title: t('organization.boundary.loadErrorTitle'),
      message: t('organization.boundary.loadErrorMessage'),
      action: 'retry',
    };
  }
  const denied = context.isReady && sessions.terminalError?.kind === 'non-retryable';
  const unavailable = !context.isResolving && !context.isReady && !context.isError;
  if (unavailable || denied) {
    const code = readTrpcErrorField(sessions.terminalError?.error, 'code');
    if (unavailable && context.organizationId !== null) {
      return {
        variant: 'permission',
        title: t('organization.boundary.organizationUnavailable'),
        message: t('organization.boundary.unavailableSessionsDescription'),
        action: 'profile',
      };
    }
    if (denied && code === 'NOT_FOUND') {
      return { variant: 'not-found', action: 'profile' };
    }
    if (denied && code !== 'FORBIDDEN' && code !== 'UNAUTHORIZED') {
      return {
        variant: 'neutral',
        title: t('home.couldNotLoadSessions'),
        message: failureLabel,
        action: 'profile',
      };
    }
    return { variant: 'permission', message: failureLabel, action: 'profile' };
  }
  if (context.isReady && sessions.terminalError) {
    return { variant: 'neutral', message: failureLabel, action: 'retry' };
  }
  return null;
}

/** One retry affordance at a time, with the in-flight state the button shows. */
export function useLiveSessionsRetry(context: LiveSessionContext, sessions: LiveSessions) {
  const retryLock = useMemo(createSubmitLock, []);
  const [retrying, setRetrying] = useState(false);
  const retry = () => {
    if (!retryLock.acquire()) {
      return;
    }
    setRetrying(true);
    void (async () => {
      try {
        await (context.isError ? context.refetch() : sessions.refetch());
      } finally {
        retryLock.release();
        setRetrying(false);
      }
    })();
  };
  return { retrying, retry };
}

/**
 * Home's whole-surface failure, drawn as the body of the reserved card frame.
 * It replaces the card in the same slot, so the height the frame reserved while
 * the query was pending is kept and a failure that lands after the first paint
 * moves nothing below the card. The screen-reader announcement stays with
 * `LiveSessionFeedback`, which is mounted in every state, so the body itself
 * does not announce the message a second time.
 */
export function LiveSessionsCardFailure({
  context,
  sessions,
  failureLabel,
}: LiveSessionsFailureProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const { retrying, retry } = useLiveSessionsRetry(context, sessions);
  const card = cardFailure({ t, context, sessions, failureLabel });
  if (card === null) {
    return null;
  }
  return (
    <View className="flex-1 justify-center px-4 py-3">
      <QueryError
        placement="static"
        variant={card.variant}
        title={card.title}
        message={card.message}
        onRetry={card.action === 'retry' ? retry : undefined}
        isRetrying={retrying}
        announceDescription={false}
        action={
          card.action === 'profile' ? (
            <Button
              variant="outline"
              accessibilityLabel={t('organization.boundary.backToProfile')}
              onPress={() => {
                router.replace('/(app)/(tabs)/(3_profile)' as Href);
              }}
            >
              <Text>{t('organization.boundary.backToProfile')}</Text>
            </Button>
          ) : undefined
        }
      />
    </View>
  );
}
