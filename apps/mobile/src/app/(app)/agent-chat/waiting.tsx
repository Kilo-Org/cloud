import { type Href } from 'expo-router';
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { replaceWithAgentSession } from '@/components/agents/session-detail-routes';
import { getNewAgentSessionPath } from '@/components/agents/session-list-routes';
import { CenteredState } from '@/components/centered-state';
import { EmptyState } from '@/components/empty-state';
import { QueryError, type QueryErrorVariant } from '@/components/query-error';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Button } from '@/components/ui/button';
import { Bot, Plus } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useLiveAgentSessions } from '@/lib/hooks/use-agent-sessions';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useStackSafeReplace } from '@/lib/navigation/stack-safe-replace';
import { useOrganization } from '@/lib/organization-context';
import { useSessionAttentionRevision } from '@/lib/session-attention';
import { readTrpcErrorField } from '@/lib/trpc-error';
import { pickWaitingAgent } from '@/lib/waiting-agent';

/** The escape target for a terminal failure — the same profile tab the org boundary uses. */
const PROFILE_HREF = '/(app)/(tabs)/(3_profile)' as Href;

/**
 * The `kiloapp:///cloud/sessions/waiting` destination shared by both
 * platforms' one-tap controls: resolve the agent that is waiting and hand the
 * user straight to its session screen.
 *
 * The route is a transient redirect — its visible outcomes are the session it
 * opens and the empty state that offers a new coding task — so every state
 * renders inside the same full-screen `CenteredState` frame. Loading and error
 * share it too, so nothing moves or blanks when the query settles.
 *
 * A signed-out device never reaches this route (the gate above it consumes the
 * pending href after sign-in, `lib/deep-link-launch.ts`), so the only read that
 * can fail here is the authenticated active-sessions query. A failure that
 * retrying can clear renders the retryable `QueryError` with its Retry; a
 * terminal one (`isTerminalTrpcCode`) can never be cleared that way, so it
 * renders the matching variant with an escape to the profile instead of a
 * Retry that cannot succeed.
 */
export default function WaitingAgentScreen() {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { replace } = useStackSafeReplace();
  const { organizationId, isLoaded: orgLoaded } = useOrganization();
  const { activeSessions, isError, hasAcceptedSuccess, isFetching, refetch, terminalError } =
    useLiveAgentSessions({
      organizationId,
      enabled: orgLoaded,
    });
  // Re-render when an ack lands or expires, so a raise the user just answered
  // is not reopened.
  useSessionAttentionRevision();
  const waiting = useMemo(() => pickWaitingAgent(activeSessions), [activeSessions]);
  // Provenance, not `isLoading`: a render that has not been accepted yet is not
  // an accepted empty success (see `useLiveAgentSessions`'s empty-data note).
  const error = isError && !hasAcceptedSuccess;
  const denied = error && terminalError?.kind === 'non-retryable';
  const loading = !orgLoaded || (!hasAcceptedSuccess && !error);

  // One redirect per resolved agent. `replace` is a stable callback, so this
  // effect no longer re-fires on every render, and the ref keeps a second push
  // out even if this route renders again before the native transition removes
  // it (a duplicate push would open the session twice).
  const redirectedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!orgLoaded || error || waiting === null) {
      return;
    }
    const target = `${organizationId ?? ''}:${waiting.id}`;
    if (redirectedRef.current === target) {
      return;
    }
    redirectedRef.current = target;
    replaceWithAgentSession({ replace }, waiting.id, organizationId ?? undefined);
  }, [orgLoaded, error, waiting, replace, organizationId]);

  if (loading) {
    return (
      <CenteredState>
        <ActivityIndicator size="large" />
      </CenteredState>
    );
  }

  if (error) {
    if (denied) {
      // Terminal: retrying cannot help, so the state says what happened and
      // offers the one action that can (leave for the profile tab). The variant
      // mirrors `LiveSessionFeedback`'s denied mapping.
      const code = readTrpcErrorField(terminalError.error, 'code');
      const neutral =
        code === 'NOT_FOUND' || code === 'FORBIDDEN' || code === 'UNAUTHORIZED'
          ? undefined
          : {
              title: t('home.couldNotLoadSessions'),
              message: t('home.couldNotLoadActiveSessions'),
            };
      let variant: QueryErrorVariant = 'permission';
      if (code === 'NOT_FOUND') {
        variant = 'not-found';
      } else if (neutral) {
        variant = 'neutral';
      }
      return (
        <CenteredState>
          <View className="w-full items-center gap-4">
            <QueryError
              variant={variant}
              title={neutral?.title}
              message={neutral?.message}
              placement="top"
              className="pt-0"
            />
            <Button
              variant="outline"
              accessibilityLabel={t('organization.boundary.backToProfile')}
              onPress={() => {
                replace(PROFILE_HREF);
              }}
            >
              <Text>{t('organization.boundary.backToProfile')}</Text>
            </Button>
          </View>
        </CenteredState>
      );
    }
    return (
      <QueryError
        title={t('home.couldNotLoadActiveSessions')}
        isRetrying={isFetching}
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  if (waiting === null) {
    return (
      <EmptyState
        icon={Bot}
        title={t('home.noLiveSessions')}
        description={t('agents.sessionList.noSessionsYetDescription')}
        action={
          <Button
            variant="outline"
            className="max-w-full"
            accessibilityLabel={t('home.newCodingTask')}
            onPress={() => {
              // Replace, not push: the redirect route must not stay on the
              // stack, or backing out of the composer would land here and
              // redirect again.
              replace(getNewAgentSessionPath(organizationId) as Href);
            }}
          >
            <Plus size={16} color={colors.foreground} />
            <Text className="shrink text-center">{t('home.newCodingTask')}</Text>
          </Button>
        }
      />
    );
  }

  // Happy: the effect above replaces this route with the waiting agent's
  // session. Keep the reserved frame rendered until it does, so the user never
  // sees a blank screen.
  return (
    <CenteredState>
      <ActivityIndicator size="large" />
    </CenteredState>
  );
}
