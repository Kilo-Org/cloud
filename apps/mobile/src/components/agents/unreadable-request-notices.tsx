import { useEffect } from 'react';
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
 * the second announcement interrupts the first. One announcement carrying only
 * the bodies of the notices actually shown avoids that. Android needs no manual
 * announcement: it reads each notice's polite live region as the node is added.
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
  const announcement = [
    ...(hasPermissions ? [t('agentChat.permissionCard.unreadableBody')] : []),
    ...(hasQuestions ? [t('agentChat.questionCard.unreadableBody')] : []),
  ].join(' ');

  useEffect(() => {
    if (!shown) {
      return;
    }
    if (Platform.OS !== 'android') {
      announceForA11y(announcement);
    }
  }, [announcement, shown]);

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
