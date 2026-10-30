import { type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import { ReviewSpectator } from '@/components/code-reviewer/review-spectator';
import { SheetHeader } from '@/components/sheet-header';

/**
 * The review's read-only transcript, presented as a sheet. The caller owns the
 * `visible` state and renders the trigger itself, so the trigger can live inside
 * the screen's scroll content: a pinned trigger above the scroll view leaves a
 * band where a vertical drag never reaches the list.
 */
export function ReviewSpectatorSheet({
  visible,
  onClose,
  ...props
}: Readonly<
  { visible: boolean; onClose: () => void } & ComponentProps<typeof ReviewSpectator>
>) {
  const { t } = useTranslation();
  return (
    <SessionPageSheet visible={visible} onClose={onClose}>
      <SheetHeader
        title={t('agentChat.session.transcriptAccessibility')}
        onDone={onClose}
        topInset="ios-page-sheet"
      />
      <ReviewSpectator {...props} />
    </SessionPageSheet>
  );
}
