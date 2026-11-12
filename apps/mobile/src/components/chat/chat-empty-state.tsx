import { useTranslation } from 'react-i18next';

import { StateSurface } from '@/components/centered-state-surface';
import { EmptyState } from '@/components/empty-state';
import { MessageCircle } from '@/components/ui/icons';

/**
 * The model chat's empty transcript.
 *
 * The state is measured against the transcript area it fills, with the surface
 * scoped to that area — the same way `ChatTranscriptFailure` is. The shared
 * centring against the whole window lands half the header-plus-composer
 * difference away from where the state first drew, so the state ordered itself
 * against the window and then lifted by 14.5dp when the measurement arrived.
 * Scoped to the area, the first frame and the measured placement agree.
 */
export function ChatEmptyState() {
  const { t } = useTranslation();
  return (
    <StateSurface className="flex-1">
      <EmptyState
        icon={MessageCircle}
        // i18n-dup-ok: 'modelChat.empty.title' was renamed from the base catalog's
        // quickChat.empty.title in the harness-chat rebuild; no other live key carries it.
        title={t('modelChat.empty.title')}
        // i18n-dup-ok: 'modelChat.empty.description' was renamed from the base catalog's
        // quickChat.empty.description in the harness-chat rebuild; no other live key carries it.
        description={t('modelChat.empty.description')}
      />
    </StateSurface>
  );
}
