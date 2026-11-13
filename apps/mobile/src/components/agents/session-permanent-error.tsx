import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { CenteredState } from '@/components/centered-state';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { AGENTS_SESSIONS_INDEX_HREF } from '@/lib/agents-sessions-route';

import { RestoredRouteFallback } from './restored-route-fallback';
import { performCopy } from './use-message-copy';

type SessionErrorVariant = 'neutral' | 'not-found' | 'permission' | 'server';

type SessionPermanentErrorProps = {
  readonly variant: SessionErrorVariant;
  readonly title: string;
  readonly message: string;
  /** The denial only a retry can clear; omitted for a permanent one. */
  readonly retry?: (() => void) | undefined;
  readonly isRetrying: boolean;
  /** The session id and denial, so the person can report what they hit. */
  readonly copyText: string;
  /** This open was the relaunch repair's automatic restore, not a choice. */
  readonly restoredRouteOpen: boolean;
};

/**
 * The session route's terminal body: a session the server refuses to answer
 * for, or one that never resolved. It keeps Copy and Back, and it never offers
 * a retry for a permanent denial.
 *
 * An automatic restore that lands here leaves instead: nobody asked for this
 * screen, so the app returns to the screen it starts on instead of holding a
 * dead end the person has to dismiss. A tap or a live link keeps the answer,
 * because that is the answer to what was asked.
 */
export function SessionPermanentError({
  variant,
  title,
  message,
  retry,
  isRetrying,
  copyText,
  restoredRouteOpen,
}: Readonly<SessionPermanentErrorProps>) {
  const router = useRouter();
  const { t } = useTranslation();
  return (
    <>
      {restoredRouteOpen ? <RestoredRouteFallback /> : null}
      <CenteredState>
        <View className="items-center gap-3 px-6">
          <QueryError
            variant={variant}
            placement="top"
            className="px-0 pt-0"
            title={title}
            message={message}
            onRetry={retry}
            isRetrying={isRetrying}
          />
          <View className="flex-row gap-3">
            <Button
              variant="ghost"
              accessibilityLabel={t('agentChat.session.copyErrorDetails')}
              onPress={() => {
                void performCopy(copyText);
              }}
            >
              <Text>{t('common.copy')}</Text>
            </Button>
            <Button
              variant="ghost"
              onPress={() => {
                // POP_TO reuses the `(tabs)` route under this screen and
                // truncates every `agent-chat` route above it, so a composer
                // still on the stack under a missing session is gone with it.
                router.dismissTo(AGENTS_SESSIONS_INDEX_HREF);
              }}
            >
              <Text>{t('agentChat.session.backToSessions')}</Text>
            </Button>
          </View>
        </View>
      </CenteredState>
    </>
  );
}
