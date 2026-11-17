import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/empty-state';
import { MessageCircle } from '@/components/ui/icons';

/**
 * The model chat's empty transcript.
 *
 * The state centers in the band its own scroller shows — the transcript area
 * between the header and the composer — not in the whole window. Centered in
 * its own band, the pending paint and the measured placement agree from the
 * first frame, whatever the surface publishes and whenever it publishes it.
 */
export function ChatEmptyState() {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon={MessageCircle}
      // i18n-dup-ok: 'modelChat.empty.title' was renamed from the base catalog's
      // quickChat.empty.title in the harness-chat rebuild; no other live key carries it.
      title={t('modelChat.empty.title')}
      // i18n-dup-ok: 'modelChat.empty.description' was renamed from the base catalog's
      // quickChat.empty.description in the harness-chat rebuild; no other live key carries it.
      description={t('modelChat.empty.description')}
    />
  );
}
