import { sessionResumeUrl } from '@kilocode/app-shared/universal-links';
import * as Haptics from 'expo-haptics';
import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';

import { performChatLinkAction } from '@/components/agents/chat-link-actions';
import { Link2 } from '@/components/ui/icons';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type SessionCopyLinkActionProps = {
  readonly sessionId: string;
  /** Message the link resumes at; null copies the session link without a position. */
  readonly anchorMessageId: string | null;
};

/**
 * The session header's Copy-link action. It copies the same universal link the
 * OS handoff advertises (`sessionResumeUrl`), so the two can never drift, and
 * reuses the chat-link copy path for the success toast and the retryable
 * failure toast.
 */
export function SessionCopyLinkAction({ sessionId, anchorMessageId }: SessionCopyLinkActionProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('common.copyLink')}
      hitSlop={8}
      onPress={() => {
        // Selection haptic for the commit: a capability iOS and Android both
        // have, served by the one cross-platform call.
        void Haptics.selectionAsync();
        void performChatLinkAction('copy', sessionResumeUrl({ sessionId, anchorMessageId }));
      }}
      className="h-11 w-11 shrink-0 items-center justify-center active:opacity-70"
    >
      <Link2 size={20} color={colors.foreground} />
    </Pressable>
  );
}
