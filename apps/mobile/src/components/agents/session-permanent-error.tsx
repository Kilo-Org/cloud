import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { StateAction } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { DirectionalArrowLeft } from '@/components/ui/directional-icons';
import { AGENTS_SESSIONS_INDEX_HREF } from '@/lib/agents-sessions-route';

import { RestoredRouteFallback } from './restored-route-fallback';

type SessionErrorVariant = 'neutral' | 'not-found' | 'permission' | 'server';

type SessionPermanentErrorProps = {
  readonly variant: SessionErrorVariant;
  readonly title: string;
  readonly message: string;
  /** The denial only a retry can clear; omitted for a permanent one. */
  readonly retry?: (() => void) | undefined;
  readonly isRetrying: boolean;
  /** This open was the relaunch repair's automatic restore, not a choice. */
  readonly restoredRouteOpen: boolean;
};

/**
 * The session route's terminal body: a session the server refuses to answer
 * for, or one that never resolved. A retryable denial offers its retry; a
 * permanent one offers the way back to the sessions the person does have, and
 * never a retry.
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
      <QueryError
        variant={variant}
        title={title}
        message={message}
        onRetry={retry}
        isRetrying={isRetrying}
        action={
          retry === undefined ? (
            <StateAction
              label={t('agentChat.session.backToSessions')}
              icon={DirectionalArrowLeft}
              onPress={() => {
                // POP_TO reuses the `(tabs)` route under this screen and
                // truncates every `agent-chat` route above it, so a composer
                // still on the stack under a missing session is gone with it.
                router.dismissTo(AGENTS_SESSIONS_INDEX_HREF);
              }}
            />
          ) : undefined
        }
      />
    </>
  );
}
