import { useTranslation } from 'react-i18next';

import { CenteredState } from '@/components/centered-state';
import { EmptyState } from '@/components/empty-state';
import { MessageCircle } from '@/components/ui/icons';

/**
 * The model chat's empty transcript.
 *
 * The state centers in the transcript area it fills (`band="viewport"` through
 * `EmptyState`'s inner `CenteredState`), not in the whole window: the screen's
 * header and composer leave that area half a header-plus-composer away from the
 * window's centre, so the measured centring against the surface moved the state
 * by 14.5dp after it first drew. Centered in its own band, the pending paint and
 * the measured placement agree from the first frame, whatever the surface
 * publishes and whenever it publishes it.
 */
export function ChatEmptyState() {
  const { t } = useTranslation();
  return (
    <CenteredState band="viewport">
      <EmptyState
        icon={MessageCircle}
        band="viewport"
        // i18n-dup-ok: 'modelChat.empty.title' was renamed from the base catalog's
        // quickChat.empty.title in the harness-chat rebuild; no other live key carries it.
        title={t('modelChat.empty.title')}
        // i18n-dup-ok: 'modelChat.empty.description' was renamed from the base catalog's
        // quickChat.empty.description in the harness-chat rebuild; no other live key carries it.
        description={t('modelChat.empty.description')}
      />
    </CenteredState>
  );
}
