import { useTranslation } from 'react-i18next';

import { StateAction } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { RotateCcw } from '@/components/ui/icons';

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
 * for, or one that never resolved. The body never repeats the header's way out;
 * the header's back chevron is its only exit, so the body draws only a retry,
 * and only when the denial is one a retry can clear.
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
  restoredRouteOpen,
}: Readonly<SessionPermanentErrorProps>) {
  const { t } = useTranslation();
  return (
    <>
      {restoredRouteOpen ? <RestoredRouteFallback /> : null}
      <QueryError
        variant={variant}
        title={title}
        message={message}
        action={
          retry === undefined ? undefined : (
            <StateAction
              label={t('common.retry')}
              icon={RotateCcw}
              loading={isRetrying}
              onPress={retry}
            />
          )
        }
      />
    </>
  );
}
