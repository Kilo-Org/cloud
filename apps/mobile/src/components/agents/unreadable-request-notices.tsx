import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';

import { announceForA11y } from '@/lib/a11y/announce';
import { PermissionUnreadableNotice } from './permission-unreadable-notice';
import { QuestionUnreadableNotice } from './question-unreadable-notice';

/**
 * The unreadable-request notices a session shows, in the order the session
 * states them: the permission first, the question after it. Each describes a
 * different pending request this app cannot render, so neither is dropped; both
 * are shown when the session holds both.
 *
 * The announcement is centralised here because a session can hold both requests
 * at once, so both notices mount in one commit. Each notice announcing its own
 * body would read two announcements on iOS, where there is no live region and
 * the second announcement interrupts the first.
 *
 * Only the bodies that appeared since the last announcement are spoken: when
 * one of two requests resolves, its notice leaves and the other stays, and
 * repeating copy the reader has just heard tells them nothing. A body is
 * forgotten once its notice leaves, so a later request of the same kind is
 * announced again. Android needs no manual announcement: it reads each notice's
 * polite live region as the node is added.
 *
 * `inset` is forwarded unchanged to both notices, which default it to `true`;
 * pass `false` from a container that already insets its children.
 */
export function UnreadableRequestNotices({
  hasQuestions,
  hasPermissions,
  inset,
}: {
  hasQuestions: boolean;
  hasPermissions: boolean;
  inset?: boolean;
}) {
  const { t } = useTranslation();
  const shown = hasQuestions || hasPermissions;
  const bodies = useMemo(
    () => [
      ...(hasPermissions ? [t('agentChat.permissionCard.unreadableBody')] : []),
      ...(hasQuestions ? [t('agentChat.questionCard.unreadableBody')] : []),
    ],
    [hasPermissions, hasQuestions, t]
  );
  const announced = useRef<readonly string[]>([]);

  useEffect(() => {
    const fresh = bodies.filter(body => !announced.current.includes(body));
    announced.current = bodies;
    if (fresh.length === 0) {
      return;
    }
    if (Platform.OS !== 'android') {
      announceForA11y(fresh.join(' '));
    }
  }, [bodies]);

  if (!shown) {
    return null;
  }

  return (
    <>
      {hasPermissions ? <PermissionUnreadableNotice inset={inset} /> : null}
      {hasQuestions ? <QuestionUnreadableNotice inset={inset} /> : null}
    </>
  );
}
